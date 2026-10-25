/**
 * 一键反馈 e2e：真实 Electron 主窗点击「反馈」→ 主进程整窗截图回渲染层 → 壳内标注编辑器
 * （箭头 / 撤销重做 / 矩形马赛克）→ 复制到系统剪贴板 → 可选「复制并打开微信/企业微信」。
 *
 * 校验分三层：渲染层（playwright/CDP）看编辑器与交互；主进程 inspector（--inspect=9230）读回
 * 剪贴板 PNG 做尺寸/不透明度/像素断言、用桩拦截聊天应用启动；electron 日志确认只截图一次。
 *
 * 用法：node scripts/e2e-feedback.mjs
 * 前置：无需手动起 vite/electron；脚本会先 tsc 主进程与 preload，再拉起隔离测试实例。
 *
 * 安全边界（硬性）：
 *   1. 临时 userData（mkdtemp + --user-data-dir），绝不读写用户真实目录
 *      ~/Library/Application Support/diteng-agent（用户此刻运行着打包版真实应用，绝不接管）；
 *   2. CDP 固定 9224、主进程 inspector 固定 9230，绝不使用 9223；
 *      启动/清理只动命令行属于本仓库 electron 的测试进程；
 *   3. 登录等全部请求只发往脚本进程内的 127.0.0.1 mock 后端，不访问任何真实服务器；
 *   4. 系统剪贴板是全局资源：测试前备份 text/png，结束时尽力还原（测试期间的截图内容会被覆盖）；
 *   5. 「打开微信/企业微信」用主进程 execFile 桩拦截，不真正拉起用户应用，也不模拟粘贴。
 *
 * 产物：/tmp/diteng-feedback-editor.png（编辑器截图，最终交付证据）
 *       /tmp/diteng-feedback-clip.png（标注后剪贴板图，最终交付证据）
 *       /tmp/diteng-feedback-toast.png（复制成功 toast）
 *       失败/诊断时另有 /tmp/diteng-feedback-*.png；主进程日志 /tmp/diteng-electron-feedback.log
 * 退出码：0=全部通过；1=存在 FAIL 或异常；3=harness 就绪但 [data-testid=feedback-button] 尚未落盘
 *        （等待 Lead 通知后重跑；不影响本轮其它结论）。
 *
 * 参考（只读复用）：scripts/e2e-app-control.mjs（ensureVite/startElectron/killElectron 等）、
 * scripts/e2e-account-history.mjs（mock 后端 + 隔离 userData + 登录自动化）、
 * scripts/e2e-webview-switch.mjs（webview guest 的原生 CDP 通道）。
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  PROJECT_ROOT,
  ensureVite,
  isHttpOk,
  killElectron,
  listCdpPids,
  sleep,
  startElectron,
} from './e2e-app-control.mjs';

// ============================== 常量与状态 ==============================

/** 独立 CDP 端口：绝不使用 9223（可能被用户真实 dev 应用占用） */
const TEST_CDP_PORT = 9224;
const TEST_CDP_ENDPOINT = `http://127.0.0.1:${TEST_CDP_PORT}`;
/** 主进程 Node inspector 端口：用于 Runtime.evaluate 读取系统剪贴板图片 */
const TEST_INSPECT_PORT = 9230;
const TEST_INSPECT_ENDPOINT = `http://127.0.0.1:${TEST_INSPECT_PORT}`;

const USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'diteng-agent-e2e-feedback-'));
const ELECTRON_LOG = '/tmp/diteng-electron-feedback.log';

const CLIP_PATH = '/tmp/diteng-feedback-clip.png';
const TOAST_PATH = '/tmp/diteng-feedback-toast.png';
const RAPID_CLIP_PATH = '/tmp/diteng-feedback-clip-rapid.png';
const DIAG_CLIP_PATH = '/tmp/diteng-feedback-diag-clip.png';
const EDITOR_PATH = '/tmp/diteng-feedback-editor.png';
const CLIPBOARD_BACKUP_PNG = '/tmp/diteng-feedback-clipboard-backup.png';
const CLIPBOARD_BACKUP_TEXT = '/tmp/diteng-feedback-clipboard-backup.txt';

/** mock ERP 页：醒目底色 + guest 内独有紫色标记（只可能来自 webview guest，用来证明截图包含页内合成内容） */
const MOCK_BG = { r: 253, g: 230, b: 138 }; // #fde68a
const MOCK_MARKER = { r: 124, g: 58, b: 237 }; // #7c3aed
const MOCK_MARKER_RECT = { left: 24, top: 24, width: 200, height: 120 };
const COLOR_TOLERANCE = 40;

const checks = [];
const state = {
  browser: null,
  cdp: null,
  mainInspector: null,
  mockServer: null,
  mockBase: '',
  shell: null,
  clipboardBackedUp: false,
  electronLogOffset: 0,
};

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  return Boolean(ok);
}

function skip(name, detail = '') {
  checks.push({ name, ok: null, detail });
  console.log(`CHECK ${name}: SKIP${detail ? `（${detail}）` : ''}`);
}

function logInfo(message) {
  console.log(`INFO ${message}`);
}

/** 轮询等待：predicate 可返回 Promise；超时返回 null */
async function waitUntil(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // 页面/进程切换期读取失败，继续轮询
    }
    await sleep(intervalMs);
  }
  return null;
}

function commandOf(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => resolve((stdout ?? '').trim()));
  });
}

/** 只杀占用测试端口且命令行属于本仓库 electron 的残留实例；绝不误杀其它进程 */
async function clearStaleTestInstance() {
  for (const port of [TEST_CDP_PORT, TEST_INSPECT_PORT]) {
    for (const pid of await listCdpPids(port)) {
      const command = await commandOf(pid);
      const isTestElectron = command.includes('node_modules') && command.includes('electron');
      if (!isTestElectron) {
        console.log(`WARN 端口 ${port} 被非本仓库 electron 进程占用，跳过清理：${command.slice(0, 160)}`);
        continue;
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 已退出
      }
    }
  }
  await killElectron(20, TEST_CDP_PORT);
  for (let i = 0; i < 20 && (await listCdpPids(TEST_INSPECT_PORT)).length > 0; i++) await sleep(500);
}

/** 编译主进程 + preload（electron 运行 dist 产物；renderer 由已在运行的 vite 提供实时源码） */
function compileMainAndPreload() {
  const tscBin = join(PROJECT_ROOT, 'node_modules/.bin/tsc');
  for (const config of ['tsconfig.main.json', 'tsconfig.preload.json']) {
    let result = spawnSync(tscBin, ['-p', config], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    // 兜底：本地 tsc 不存在时走 pnpm exec（与项目命令一致）
    if (result.error?.code === 'ENOENT') {
      result = spawnSync('pnpm', ['exec', 'tsc', '-p', config], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    }
    if (result.error || result.status !== 0) {
      const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim() || result.error?.message || '未知错误';
      return { ok: false, detail: `${config}: ${output.split('\n').slice(-6).join(' | ')}` };
    }
  }
  return { ok: true, detail: 'dist/main + dist/preload 已刷新' };
}

// ============================== mock 后端（仅 127.0.0.1） ==============================

/** mock ERP 页：整页醒目底色 + guest 独有紫色标记 + 文案，便于像素断言与人工核对 */
function erpPageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>mock erp feedback</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #fde68a; }
  #erp-marker { position: fixed; left: ${MOCK_MARKER_RECT.left}px; top: ${MOCK_MARKER_RECT.top}px; width: ${MOCK_MARKER_RECT.width}px; height: ${MOCK_MARKER_RECT.height}px; background: #7c3aed; }
  #erp-title { position: fixed; left: 24px; top: 180px; font: 600 28px/1.4 -apple-system, "PingFang SC", sans-serif; color: #7c2d12; }
</style></head>
<body><div id="erp-marker"></div><div id="erp-title">MOCK ERP 反馈页</div></body></html>`;
}

/** 本地 mock 后端：只实现登录页/主窗会话所需端点，任何凭据都登录成功（与现有 e2e mock 一致） */
function startMockServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks).toString();
    };
    const readDataIn = async () => {
      const form = new URLSearchParams(await readBody());
      return JSON.parse(form.get('dataIn') ?? '{}');
    };
    const dataSet = (head, body = [[]]) => ({ state: 1, message: '', head, body });

    if (req.method === 'POST' && url.pathname === '/services/SvrUserLogin.getToken') {
      const dataIn = await readDataIn();
      if (dataIn.head?.verifyCode === '??????') return send(200, dataSet({ status: 1 }));
      return send(
        200,
        dataSet({
          status: 1,
          token: 'T_E2E_FEEDBACK_ROOT',
          user_code: '01',
          startPage: '250008/FrmDefault',
          corpNo: '250008',
          homeForm: 'FrmDefault',
          forceRedirect: false,
          redirectUrl: '',
        }),
      );
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/getTokenInfo') {
      return send(200, {
        userId: 'U_E2E_FEEDBACK',
        userCode: '01',
        userName: '反馈自测用户',
        corpNo: '250008',
        options: {},
      });
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/logout') return send(200, {});
    if (req.method === 'POST' && url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      return send(
        200,
        dataSet({}, [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '反馈自测账套', 'E2E']]),
      );
    }
    if (req.method === 'POST' && /FrmMessages\.mqttConfig$/.test(url.pathname)) {
      return send(200, { result: false, message: 'mock 未启用 MQTT' });
    }
    if (req.method === 'POST' && /ImServer\.getUnreadMessage$/.test(url.pathname)) {
      return send(200, { result: true, data: 0 });
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(404, '', 'text/plain');
    if (req.method === 'GET' && /^\/\d{5,8}\//.test(url.pathname)) {
      return send(200, erpPageHtml(), 'text/html; charset=utf-8');
    }
    return send(404, { message: 'mock 未实现该端点' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// ============================== WebSocket / CDP / inspector 通道 ==============================

/**
 * 原生 CDP 通道（webview guest 用）。注意不能复用 e2e-app-control.mjs 的 createCdpLink：
 * 它硬编码连接 9223（用户真实 dev 应用），本脚本必须固定 9224 的隔离实例。
 */
async function createCdpLink() {
  const version = await waitUntil(async () => {
    try {
      const response = await fetch(`${TEST_CDP_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(1500) });
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }, 60_000, 500);
  if (!version?.webSocketDebuggerUrl) throw new Error(`未拿到 CDP ${TEST_CDP_PORT} 的 webSocketDebuggerUrl`);
  return createWsLink(version.webSocketDebuggerUrl, 'CDP');
}

/** 主进程 Node inspector 通道：Runtime.evaluate 里 require('electron') 读写系统剪贴板 */
async function createMainInspector() {
  const entry = await waitUntil(async () => {
    try {
      const response = await fetch(`${TEST_INSPECT_ENDPOINT}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return null;
      const list = await response.json();
      return Array.isArray(list) ? list.find((item) => item.webSocketDebuggerUrl) ?? null : null;
    } catch {
      return null;
    }
  }, 30_000, 500);
  if (!entry?.webSocketDebuggerUrl) throw new Error(`未拿到主进程 inspector ${TEST_INSPECT_PORT} 的 webSocketDebuggerUrl`);
  return createWsLink(entry.webSocketDebuggerUrl, 'main inspector');
}

async function createWsLink(webSocketDebuggerUrl, label) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`${label} WebSocket 连接失败`)), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  socket.addEventListener('close', () => {
    for (const [id, pendingEntry] of pending) {
      pendingEntry.reject(new Error(`${label} 连接已关闭（请求 ${id}）`));
      pending.delete(id);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${label} ${method} 超时`));
        }, 30_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(`${method}: ${message.error.message}`));
          else resolve(message.result);
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve) => {
        socket.addEventListener('close', resolve, { once: true });
        socket.close();
      });
    },
  };
}

/** 在 guest 内执行表达式（attach → Runtime.evaluate → detach） */
async function evalInGuest(expression) {
  const targetId = await waitUntil(async () => {
    const { targetInfos } = await state.cdp.send('Target.getTargets');
    return (
      targetInfos.find((target) => {
        if (target.type !== 'webview' && target.type !== 'page') return false;
        try {
          const url = new URL(target.url);
          return url.host === new URL(state.mockBase).host && /^\/\d{5,8}\//.test(url.pathname);
        } catch {
          return false;
        }
      })?.targetId ?? null
    );
  }, 10_000, 300);
  if (!targetId) throw new Error('未找到 mock ERP 的 webview target');
  const { sessionId } = await state.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const result = await state.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '';
      throw new Error(`guest 内执行失败：${description}`);
    }
    return result.result?.value;
  } finally {
    await state.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

/** 主进程 inspector 求值：异常显式抛出，避免把失败当成普通返回值 */
async function mainEval(expression) {
  const result = await state.mainInspector.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知异常';
    throw new Error(`主进程 inspector 执行失败：${description}`);
  }
  return result.result?.value;
}

/** 取主窗窗口信息（内容区 DIP 尺寸 + 屏幕缩放），剪贴板图片物理尺寸期望值由二者相乘得到 */
function windowInfo() {
  return mainEval(`(async () => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { BrowserWindow, screen } = req('electron');
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    const visible = windows.filter((win) => win.isVisible());
    // 主窗至少 940px 宽（登录窗 420px），按宽度挑出主窗
    const target = visible.find((win) => win.getContentBounds().width > 500) ?? visible[0] ?? windows[0];
    if (!target) return { ok: false, error: '主进程没有可用窗口' };
    return {
      ok: true,
      windowCount: windows.length,
      titles: windows.map((win) => win.getTitle()),
      contentBounds: target.getContentBounds(),
      bounds: target.getBounds(),
      scaleFactor: screen.getPrimaryDisplay().scaleFactor,
      isVisible: target.isVisible(),
    };
  })()`);
}

// ============================== 剪贴板：备份/清空/还原/读图 ==============================

function backupClipboard() {
  return mainEval(`(async () => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { clipboard } = req('electron');
    const fs = req('fs');
    const items = await clipboard.read();
    const imageItem = items.find((item) => item.types.includes('image/png'));
    const textItem = items.find((item) => item.types.includes('text/plain'));
    let hasImage = false;
    let hasText = false;
    if (imageItem) {
      const blob = await imageItem.getType('image/png');
      fs.writeFileSync(${JSON.stringify(CLIPBOARD_BACKUP_PNG)}, Buffer.from(await blob.arrayBuffer()));
      hasImage = true;
    }
    if (textItem) {
      const blob = await textItem.getType('text/plain');
      fs.writeFileSync(${JSON.stringify(CLIPBOARD_BACKUP_TEXT)}, await blob.text(), 'utf8');
      hasText = true;
    }
    return { hasImage, hasText, types: items.map((item) => item.types) };
  })()`);
}

function clearClipboard() {
  return mainEval(`(() => {
    const req = process.mainModule.require.bind(process.mainModule);
    req('electron').clipboard.clear();
    return true;
  })()`);
}

function restoreClipboard() {
  return mainEval(`(async () => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { clipboard, ClipboardItem } = req('electron');
    const fs = req('fs');
    const hasImage = fs.existsSync(${JSON.stringify(CLIPBOARD_BACKUP_PNG)});
    const hasText = fs.existsSync(${JSON.stringify(CLIPBOARD_BACKUP_TEXT)});
    if (!hasImage && !hasText) {
      clipboard.clear();
      return { restored: false, reason: '测试前剪贴板为空，已清空' };
    }
    // 图片走异步 ClipboardItem（与功能实现同一条路径）；纯文本走 writeText 并回读校验，
    // 实测异步 ClipboardItem 写 text/plain 在 macOS 不落系统剪贴板。
    if (hasImage) {
      const png = fs.readFileSync(${JSON.stringify(CLIPBOARD_BACKUP_PNG)});
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      return { restored: true, types: ['image/png'], verified: clipboard.has('image/png') };
    }
    const text = fs.readFileSync(${JSON.stringify(CLIPBOARD_BACKUP_TEXT)}, 'utf8');
    clipboard.writeText(text);
    // macOS 系统剪贴板落盘是异步的：写入后立即回读可能是旧值，重试最多 1s 再判定
    let readBack = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      readBack = clipboard.readText();
      if (readBack === text) break;
    }
    return { restored: true, types: ['text/plain'], verified: readBack === text, textLength: text.length };
  })()`);
}

/**
 * 读取剪贴板 image/png、落盘到 filePath，并在主进程内完成像素统计与采样。
 * 采样点由调用方按窗口布局算成物理像素坐标（capturePage 输出为内容区物理像素）。
 */
function clipboardImageProbe(filePath, samples) {
  return mainEval(`(async () => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { clipboard, nativeImage } = req('electron');
    const fs = req('fs');
    const items = await clipboard.read();
    const entry = items.find((item) => item.types.includes('image/png'));
    if (!entry) return { hasImage: false, types: items.map((item) => item.types) };
    const blob = await entry.getType('image/png');
    const png = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(${JSON.stringify(filePath)}, png);
    const image = nativeImage.createFromBuffer(png);
    const size = image.getSize();
    const bitmap = image.toBitmap();
    let transparent = 0;
    let minAlpha = 255;
    for (let index = 3; index < bitmap.length; index += 4) {
      const alpha = bitmap[index];
      if (alpha !== 255) transparent += 1;
      if (alpha < minAlpha) minAlpha = alpha;
    }
    const points = ${JSON.stringify(samples)}.map(({ group, x, y }) => {
      const px = Math.round(x);
      const py = Math.round(y);
      const index = (py * size.width + px) * 4;
      return { group, x: px, y: py, r: bitmap[index + 2], g: bitmap[index + 1], b: bitmap[index], a: bitmap[index + 3] };
    });
    return { hasImage: true, pngBytes: png.length, width: size.width, height: size.height, transparent, minAlpha, points };
  })()`);
}

/** 统计某组采样点命中目标颜色的数量（用于证明截图里确实有 mock ERP 底色/guest 独有标记） */
function countColorHits(points, group, target) {
  const groupPoints = points.filter((point) => point.group === group);
  const hits = groupPoints.filter(
    (point) =>
      Math.abs(point.r - target.r) <= COLOR_TOLERANCE &&
      Math.abs(point.g - target.g) <= COLOR_TOLERANCE &&
      Math.abs(point.b - target.b) <= COLOR_TOLERANCE,
  );
  return { hits: hits.length, total: groupPoints.length, sample: groupPoints.slice(0, 3) };
}

function countOpaque(points, group) {
  const groupPoints = points.filter((point) => point.group === group);
  const opaque = groupPoints.filter((point) => point.a === 255);
  return { hits: opaque.length, total: groupPoints.length, sample: groupPoints.slice(0, 3) };
}

function formatPoints(points) {
  return points
    .slice(0, 4)
    .map((point) => `[${point.x},${point.y}] rgba(${point.r},${point.g},${point.b},${point.a})`)
    .join(' ');
}

// ============================== 渲染层（playwright）辅助 ==============================

function allPages() {
  return state.browser.contexts().flatMap((context) => context.pages());
}

function findMainPage() {
  return allPages().find((page) => page.url().includes('#/main')) ?? null;
}

function findLoginPage() {
  return (
    allPages().find((page) => {
      if (!page.url().includes('127.0.0.1:5173')) return false;
      return !/#\/(main|notify-popup)/.test(page.url());
    }) ?? null
  );
}

async function waitForMainPage(seconds = 60) {
  return waitUntil(findMainPage, seconds * 1000, 500);
}

async function waitForLoginPage(seconds = 40) {
  const page = await waitUntil(findLoginPage, seconds * 1000, 500);
  if (page) await page.waitForSelector('#server-base', { timeout: 20_000 }).catch(() => {});
  return page;
}

/** 登录（只打本脚本的 127.0.0.1 mock）→ 等主窗 #/main + tabstrip */
async function loginWithMock() {
  const login = await waitForLoginPage(40);
  check('隔离实例登录窗就绪', Boolean(login), `mock=${state.mockBase}`);
  if (!login) throw new Error('40s 内未见登录窗');
  if ((await login.locator('[data-testid="auto-login-state"]').count()) > 0) {
    await login.click('[data-testid="auto-login-cancel"]');
  }
  await login.waitForSelector('#server-base', { timeout: 20_000 });
  await login.fill('#server-base', state.mockBase);
  await login.fill('#login-id', 'e2e-feedback');
  await login.fill('#password', 'e2e-feedback-password');
  await login.click('button[type=submit]');
  const shell = await waitForMainPage(60);
  check('mock 登录进入主窗', Boolean(shell));
  if (!shell) {
    const errorText = await login
      .evaluate(() => {
        const text = document.body.innerText || '';
        return text.split('\n').find((line) => /失败|错误|超时|500/.test(line)) ?? '(无错误提示)';
      })
      .catch(() => '(登录页已关闭)');
    throw new Error(`登录后 60s 未见 #/main：${errorText}`);
  }
  state.shell = shell;
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
}

/** 等 ERP webview guest 真正加载出 mock 页面（DOM ready + 标记元素存在） */
async function waitForErpGuest() {
  return waitUntil(async () => {
    const info = await evalInGuest(
      `({ readyState: document.readyState, hasMarker: Boolean(document.getElementById('erp-marker')), bodyBg: getComputedStyle(document.body).backgroundColor, title: document.title })`,
    );
    return info?.readyState === 'complete' && info.hasMarker ? info : null;
  }, 45_000, 500);
}

/** 读当前主窗布局（CSS px，相对内容区左上角）与反馈按钮状态 */
async function readLayout() {
  return state.shell.evaluate(() => {
    const rectOf = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    };
    const activeWebview = Array.from(document.querySelectorAll('webview')).find(
      (element) => element.style.display !== 'none',
    );
    const feedback = document.querySelector('[data-testid="feedback-button"]');
    return {
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      platformMarker: document.documentElement.getAttribute('data-platform'),
      rail: rectOf(document.querySelector('[data-testid="tabstrip"]')),
      toolbar: rectOf(document.querySelector('[data-testid="browser-toolbar"]')),
      webview: rectOf(activeWebview),
      chat: rectOf(document.querySelector('[data-testid="open-ai"]')),
      feedbackButton: feedback
        ? {
            disabled: Boolean(feedback.disabled),
            rect: rectOf(feedback),
            title: feedback.getAttribute('title') ?? '',
            text: (feedback.textContent ?? '').trim(),
            ariaBusy: feedback.getAttribute('aria-busy'),
          }
        : null,
    };
  });
}

/** 按布局算物理像素采样点：webview 底色 / guest 独有标记 / rail / 工具栏 */
function buildSamples(layout, expectedWidth, expectedHeight, scale) {
  const toPhysical = (cssX, cssY) => [
    Math.min(expectedWidth - 1, Math.max(0, Math.round(cssX * scale))),
    Math.min(expectedHeight - 1, Math.max(0, Math.round(cssY * scale))),
  ];
  const samples = [];
  const webview = layout.webview;
  if (!webview) throw new Error('布局读取失败：没有激活的 webview');
  // webview 中部/下部：避开 guest 左上角的紫色标记与标题文字，应稳定命中 mock 底色
  for (const [fx, fy] of [
    [0.25, 0.55],
    [0.5, 0.55],
    [0.75, 0.55],
    [0.3, 0.7],
    [0.5, 0.7],
    [0.7, 0.7],
    [0.35, 0.85],
    [0.55, 0.85],
    [0.75, 0.85],
  ]) {
    const [x, y] = toPhysical(webview.left + webview.width * fx, webview.top + webview.height * fy);
    samples.push({ group: 'webviewBg', x, y });
  }
  // guest 内独有紫色标记：位置是 mock 页面 CSS 像素（guest 与宿主同缩放、无偏移）
  for (const [fx, fy] of [
    [0.25, 0.25],
    [0.5, 0.25],
    [0.75, 0.25],
    [0.25, 0.5],
    [0.5, 0.5],
    [0.75, 0.5],
    [0.25, 0.75],
    [0.5, 0.75],
    [0.75, 0.75],
  ]) {
    const [x, y] = toPhysical(
      webview.left + MOCK_MARKER_RECT.left + MOCK_MARKER_RECT.width * fx,
      webview.top + MOCK_MARKER_RECT.top + MOCK_MARKER_RECT.height * fy,
    );
    samples.push({ group: 'marker', x, y });
  }
  if (layout.rail) {
    for (const fy of [0.25, 0.5, 0.75]) {
      const [x, y] = toPhysical(layout.rail.left + layout.rail.width * 0.5, layout.rail.top + layout.rail.height * fy);
      samples.push({ group: 'rail', x, y });
    }
  }
  if (layout.toolbar) {
    for (const fx of [0.3, 0.5, 0.7]) {
      const [x, y] = toPhysical(layout.toolbar.left + layout.toolbar.width * fx, layout.toolbar.top + layout.toolbar.height * 0.5);
      samples.push({ group: 'toolbar', x, y });
    }
  }
  return samples;
}

/** 主进程日志新增片段（用于确认主进程确实执行了截图写入，且没有报错分支） */
function readNewElectronLog() {
  if (!existsSync(ELECTRON_LOG)) return '';
  const buffer = readFileSync(ELECTRON_LOG);
  if (buffer.length <= state.electronLogOffset) return '';
  const chunk = buffer.subarray(state.electronLogOffset).toString('utf8');
  state.electronLogOffset = buffer.length;
  return chunk;
}

function electronLogSize() {
  if (!existsSync(ELECTRON_LOG)) return 0;
  return readFileSync(ELECTRON_LOG).length;
}

// ============================== 剪贴板 write 探针（防重计数） ==============================

/** 给主进程 clipboard.write 打计数/延时包装：验证连续点击只触发一次截图写入、且截图期间按钮被禁用 */
function installClipboardProbe(delayMs) {
  return mainEval(`(async () => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { clipboard } = req('electron');
    if (!globalThis.__ditengFeedbackProbe) {
      const original = clipboard.write.bind(clipboard);
      const wrapped = async (...args) => {
        const probe = globalThis.__ditengFeedbackProbe;
        probe.writes += 1;
        if (probe.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, probe.delayMs));
        if (probe.isFail) throw new Error('e2e clipboard failure');
        return original(...args);
      };
      try {
        clipboard.write = wrapped;
      } catch (error) {
        return { ok: false, error: String(error) };
      }
      globalThis.__ditengFeedbackProbe = {
        writes: 0,
        delayMs: ${delayMs},
        isPatched: clipboard.write !== original,
        originalWrite: original,
      };
      return { ok: true, isPatched: clipboard.write !== original };
    }
    globalThis.__ditengFeedbackProbe.writes = 0;
    globalThis.__ditengFeedbackProbe.delayMs = ${delayMs};
    globalThis.__ditengFeedbackProbe.isFail = false;
    return { ok: true, isPatched: globalThis.__ditengFeedbackProbe.isPatched };
  })()`);
}

function readClipboardProbe() {
  return mainEval(`(() => {
    const probe = globalThis.__ditengFeedbackProbe;
    return probe ? { writes: probe.writes, delayMs: probe.delayMs, isPatched: probe.isPatched } : null;
  })()`);
}

function restoreClipboardProbe() {
  return mainEval(`(() => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { clipboard } = req('electron');
    const probe = globalThis.__ditengFeedbackProbe;
    if (!probe?.originalWrite) return { restored: false };
    try {
      clipboard.write = probe.originalWrite;
    } catch {
      // 还原失败也不影响退出：测试实例即将销毁
    }
    delete globalThis.__ditengFeedbackProbe;
    return { restored: true };
  })()`);
}

// ============================== 反馈入口检查 ==============================

async function feedbackButtonExists() {
  return (await state.shell.locator('[data-testid="feedback-button"]').count()) > 0;
}

/** 入口契约：存在、可用、文案/标题可读、位于 Chat 左侧且同一行 */
async function checkFeedbackEntry(layout) {
  const button = layout.feedbackButton;
  check('一键反馈入口存在（data-testid=feedback-button）', Boolean(button));
  if (!button) return false;
  check('反馈按钮默认可用', button.disabled === false, `disabled=${button.disabled}`);
  check(
    '反馈按钮文案/标题可读（低强调「反馈」入口）',
    /反馈/.test(button.text) || /反馈/.test(button.title),
    `text="${button.text}" title="${button.title}"`,
  );
  const isLeftOfChat =
    Boolean(button.rect && layout.chat) &&
    button.rect.left + button.rect.width <= layout.chat.left + 2 &&
    Math.abs(button.rect.top + button.rect.height / 2 - (layout.chat.top + layout.chat.height / 2)) <=
      layout.chat.height / 2;
  check(
    '反馈按钮位于 Chat 左侧同一行',
    isLeftOfChat,
    button.rect && layout.chat
      ? `feedback=[${button.rect.left.toFixed(0)},${button.rect.top.toFixed(0)}→${(button.rect.left + button.rect.width).toFixed(0)},${(button.rect.top + button.rect.height).toFixed(0)}] chat=[${layout.chat.left.toFixed(0)},${layout.chat.top.toFixed(0)}→${(layout.chat.left + layout.chat.width).toFixed(0)},${(layout.chat.top + layout.chat.height).toFixed(0)}]`
      : '元素缺失',
  );
  return true;
}

// ============================== 反馈标注编辑器辅助 ==============================

/** 标注红（编辑器默认色 #e5484d）：e2e 画箭头后按此校验剪贴板像素 */
const ARROW_RED = { r: 0xe5, g: 0x48, b: 0x4d };
/** 判定「像素颜色明显变化」的容差（马赛克用例） */
const CHANGE_TOLERANCE = 24;

/** 读编辑器是否存在、画布是否就绪（canvas 像素尺寸 = 截图原始像素） */
function readEditorGeometry() {
  return state.shell.evaluate(() => {
    const editor = document.querySelector('[data-testid="feedback-editor"]');
    const canvas = document.querySelector('[data-testid="feedback-editor-canvas"]');
    if (!editor) return { hasEditor: false, hasCanvas: Boolean(canvas) };
    if (!canvas) return { hasEditor: true, hasCanvas: false };
    const rect = canvas.getBoundingClientRect();
    return {
      hasEditor: true,
      hasCanvas: true,
      isCanvasVisible: getComputedStyle(canvas).visibility !== 'hidden',
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  });
}

/** 等编辑器出现且画布解码完成（canvas 像素尺寸 > 0 且可见） */
async function waitForEditorReady(timeoutMs = 20_000) {
  return waitUntil(async () => {
    const geometry = await readEditorGeometry().catch(() => null);
    if (!geometry?.hasEditor || !geometry.hasCanvas) return null;
    if (!geometry.isCanvasVisible || geometry.canvasWidth <= 0 || geometry.rect.width <= 0) return null;
    return geometry;
  }, timeoutMs, 100);
}

/** 点「反馈」并等编辑器就绪 */
async function openFeedbackEditor() {
  await state.shell.click('[data-testid="feedback-button"]');
  await confirmFreshScreenshot();
  return waitForEditorReady(20_000);
}

async function confirmFreshScreenshot() {
  const choice = state.shell.locator('[data-testid="feedback-replace"]');
  if (await choice.count()) await choice.click();
}

/** 等编辑器关闭（复制成功 / 取消后） */
async function waitForEditorClosed(timeoutMs = 20_000) {
  return waitUntil(
    async () => (await state.shell.locator('[data-testid="feedback-editor"]').count()) === 0,
    timeoutMs,
    100,
  );
}

/** 等 toast 出现并返回文案/状态 */
async function waitForFeedbackToast(timeoutMs = 20_000) {
  const appeared = await waitUntil(
    async () => (await state.shell.locator('[data-testid="feedback-toast"]').count()) > 0,
    timeoutMs,
    100,
  );
  if (!appeared) return null;
  const toastText = ((await state.shell.textContent('[data-testid="feedback-toast"]')) ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const toastState = await state.shell
    .getAttribute('[data-testid="feedback-toast"]', 'data-state')
    .catch(() => null);
  return { text: toastText, state: toastState };
}

/** 关闭 toast 并等它消失，避免遮挡下一次截图 */
async function closeFeedbackToast() {
  await state.shell.click('[data-testid="feedback-toast-close"]').catch(() => {});
  await state.shell
    .waitForSelector('[data-testid="feedback-toast"]', { state: 'detached', timeout: 10_000 })
    .catch(() => {});
}

/** 图片坐标 → 画布显示坐标（viewport / CSS px） */
function imagePointToClient(geometry, point) {
  return {
    x: geometry.rect.left + point.x * (geometry.rect.width / geometry.canvasWidth),
    y: geometry.rect.top + point.y * (geometry.rect.height / geometry.canvasHeight),
  };
}

/** 在画布上拖一条线（箭头/矩形/椭圆/马赛克共用） */
async function dragOnCanvas(geometry, fromImage, toImage, steps = 10) {
  const from = imagePointToClient(geometry, fromImage);
  const to = imagePointToClient(geometry, toImage);
  await state.shell.mouse.move(from.x, from.y);
  await state.shell.mouse.down();
  for (let index = 1; index <= steps; index += 1) {
    await state.shell.mouse.move(
      from.x + ((to.x - from.x) * index) / steps,
      from.y + ((to.y - from.y) * index) / steps,
    );
  }
  await state.shell.mouse.up();
}

/**
 * 在真实 Electron 主进程里合成一次 before-input-event，验证「主进程拦截 → shortcut:action →
 * 编辑器执行」这条链路。真实 OS 按键由 Electron 原生输入触发同一监听（⌘B/⌘, 已依赖该机制）；
 * Playwright 的 CDP 合成按键不经过 before-input-event，因此这里不用 keyboard.press。
 */
function emitEditorInput(key, { shift = false } = {}) {
  return mainEval(`(() => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { BrowserWindow } = req('electron');
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    const target = windows.find((win) => win.getContentBounds().width > 500) ?? windows[0];
    if (!target) return { ok: false, error: '没有可用主窗' };
    let isPrevented = false;
    const event = { preventDefault: () => { isPrevented = true; } };
    const input = {
      type: 'keyDown',
      key: ${JSON.stringify(key)},
      meta: process.platform === 'darwin',
      control: process.platform !== 'darwin',
      shift: ${shift ? 'true' : 'false'},
      alt: false,
      isAutoRepeat: false,
      isComposing: false,
    };
    target.webContents.emit('before-input-event', event, input);
    return { ok: true, isPrevented };
  })()`);
}

/** 读取画布指定图片坐标的像素（确认标注/撤销/马赛克确实落到画布） */
function readCanvasPixels(points) {
  return state.shell.evaluate((list) => {
    const canvas = document.querySelector('[data-testid="feedback-editor-canvas"]');
    if (!canvas) return null;
    const context = canvas.getContext('2d');
    if (!context) return null;
    return list.map(({ group, x, y }) => {
      const px = Math.round(x);
      const py = Math.round(y);
      const data = context.getImageData(px, py, 1, 1).data;
      return { group, x: px, y: py, r: data[0], g: data[1], b: data[2], a: data[3] };
    });
  }, points);
}

/** 颜色是否接近目标色 */
function isNearColor(point, target, tolerance = COLOR_TOLERANCE) {
  return (
    Math.abs(point.r - target.r) <= tolerance &&
    Math.abs(point.g - target.g) <= tolerance &&
    Math.abs(point.b - target.b) <= tolerance
  );
}

/** 两点颜色是否明显不同 */
function isColorChanged(before, after) {
  return (
    Math.abs(before.r - after.r) > CHANGE_TOLERANCE ||
    Math.abs(before.g - after.g) > CHANGE_TOLERANCE ||
    Math.abs(before.b - after.b) > CHANGE_TOLERANCE
  );
}

/** 等剪贴板出现 PNG（复制后 macOS 剪贴板落盘可能滞后） */
async function waitForClipboardImage(filePath, samples, timeoutMs = 8_000) {
  return waitUntil(async () => {
    const probe = await clipboardImageProbe(filePath, samples);
    return probe?.hasImage ? probe : null;
  }, timeoutMs, 150);
}

// ============================== 聊天应用启动桩（主进程 execFile） ==============================

/**
 * 主进程启动器在 macOS 走 execFile('open', ['-b', bundleId])。这里替换 node:child_process
 * 的 execFile 为桩：记录调用参数、可模拟失败，绝不真正拉起用户的微信/企业微信。
 */
function installExecFileProbe() {
  return mainEval(`(() => {
    const req = process.mainModule.require.bind(process.mainModule);
    const childProcess = req('node:child_process');
    const original = childProcess.execFile;
    const probe = { calls: [], isFail: false, isPatched: false, original };
    const stub = (command, args, options, callback) => {
      const done = typeof options === 'function' ? options : callback;
      probe.calls.push({ command, args: Array.isArray(args) ? args : [] });
      const error = probe.isFail ? new Error('e2e stubbed launcher failure') : null;
      if (typeof done === 'function') setImmediate(() => done(error, '', ''));
    };
    try {
      childProcess.execFile = stub;
    } catch (error) {
      return { ok: false, error: String(error) };
    }
    probe.isPatched = childProcess.execFile === stub;
    globalThis.__ditengFeedbackExecProbe = probe;
    return { ok: true, isPatched: probe.isPatched };
  })()`);
}

function readExecFileProbe() {
  return mainEval(`(() => {
    const probe = globalThis.__ditengFeedbackExecProbe;
    if (!probe) return null;
    return { calls: probe.calls, isFail: probe.isFail, isPatched: probe.isPatched };
  })()`);
}

function setExecFileProbeFailure(isFail) {
  return mainEval(`(() => {
    const probe = globalThis.__ditengFeedbackExecProbe;
    if (!probe) return { ok: false };
    probe.isFail = ${isFail ? 'true' : 'false'};
    return { ok: true };
  })()`);
}

function restoreExecFileProbe() {
  return mainEval(`(() => {
    const req = process.mainModule.require.bind(process.mainModule);
    const probe = globalThis.__ditengFeedbackExecProbe;
    if (!probe) return { restored: false };
    try {
      req('node:child_process').execFile = probe.original;
    } catch {
      // 还原失败不影响退出：测试实例即将销毁
    }
    delete globalThis.__ditengFeedbackExecProbe;
    return { restored: true };
  })()`);
}


/** 新版反馈交互：仅使用隔离 mock 页，断言可观察的编辑、缩放与导出行为。 */
async function runEditingChecks() {
  const shell = state.shell;
  const editor = shell.locator('[data-testid="feedback-editor"]');
  const consoleErrors = [];
  const recordError = (error) => consoleErrors.push(error.message);
  shell.on('pageerror', recordError);
  const originalUrl = await evalInGuest('location.href');
  const originalWindow = await windowInfo();
  await mainEval(`(() => { const req = process.mainModule.require.bind(process.mainModule); const win = req('electron').BrowserWindow.getAllWindows().find((item) => item.getContentBounds().width > 500); win.setSize(940, 700); })()`);
  const longBusinessQuery = 'section=' + 'abc123'.repeat(65) + '&billNo=42&sid=synthetic-private';
  await evalInGuest(`history.replaceState(null, '', location.pathname + '?' + ${JSON.stringify(longBusinessQuery)})`);
  await shell.waitForFunction(() => document.querySelector('[data-testid="url-bar-text"]')?.textContent?.includes('billNo=42'));
  const urlState = await shell.evaluate(() => {
    const text = document.querySelector('[data-testid="url-bar-text"]');
    const bar = document.querySelector('[data-testid="browser-toolbar"]');
    const rect = text.getBoundingClientRect();
    return { text: text.textContent, height: rect.height, scrollWidth: text.scrollWidth, clientWidth: text.clientWidth, toolbarHeight: bar.getBoundingClientRect().height, hasHome: Boolean(document.querySelector('[data-testid="nav-home"]')), feedbackRight: document.querySelector('[data-testid="feedback-button"]').getBoundingClientRect().right, viewportWidth: innerWidth };
  });
  check('最小窗口完整网址自动换行且保留末尾业务条件', urlState.height > 19 && urlState.scrollWidth <= urlState.clientWidth + 1 && urlState.text.endsWith('billNo=42') && !urlState.text.includes('synthetic-private'));
  check('Dia 导航移除常驻主页，长网址不挤出反馈入口', !urlState.hasHome && urlState.feedbackRight <= urlState.viewportWidth);
  await shell.screenshot({ path: '/tmp/diteng-feedback-url-wrapped.png' });
  await evalInGuest(`history.replaceState(null, '', ${JSON.stringify(originalUrl)})`);
  await mainEval(`(() => { const req = process.mainModule.require.bind(process.mainModule); const win = req('electron').BrowserWindow.getAllWindows().find((item) => item.getContentBounds().width > 500); win.setBounds(${JSON.stringify(originalWindow.bounds)}); })()`);
  await openFeedbackEditor();
  let geometry = await readEditorGeometry();
  const from = { x: geometry.canvasWidth * 0.4, y: geometry.canvasHeight * 0.55 };
  const to = { x: geometry.canvasWidth * 0.65, y: geometry.canvasHeight * 0.55 };
  await dragOnCanvas(geometry, from, to);
  check('画完自动选中箭头并提供端点手柄', await editor.getAttribute('data-selected-type') === 'arrow' && await shell.locator('[data-testid="feedback-handle-to"]').count() === 1);
  const handle = await shell.locator('[data-testid="feedback-handle-to"]').boundingBox();
  await shell.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 45, { steps: 8 });
  await shell.mouse.up();
  const endpoint = await shell.locator('[data-testid="feedback-handle-to"]').boundingBox();
  check('箭头终点可独立拖动且不新增标注', endpoint.y > handle.y + 35 && await editor.getAttribute('data-shape-count') === '1');
  await shell.click('[data-testid="feedback-undo"]');
  const originalSamples = [{ x: (from.x + to.x) / 2, y: from.y }];
  check('端点调整可以撤销回原箭头', isNearColor((await readCanvasPixels(originalSamples))[0], ARROW_RED));
  await shell.click('[data-testid="feedback-tool-select"]');
  const middle = { x: (from.x + to.x) / 2, y: from.y };
  const moveTo = { x: middle.x + geometry.canvasWidth * 0.08, y: middle.y + geometry.canvasHeight * 0.06 };
  await dragOnCanvas(geometry, middle, moveTo);
  const movedSamples = [{ x: moveTo.x, y: moveTo.y }];
  check('已有箭头可以整体移动', isNearColor((await readCanvasPixels(movedSamples))[0], ARROW_RED) && await editor.getAttribute('data-shape-count') === '1');

  await shell.click('[data-testid="feedback-tool-text"]');
  const textPoint = { x: geometry.canvasWidth * 0.4, y: geometry.canvasHeight * 0.3 };
  const textClient = imagePointToClient(geometry, textPoint);
  await shell.mouse.click(textClient.x, textClient.y);
  const input = shell.locator('[data-testid="feedback-text-input"]');
  await input.fill('第一行');
  await input.press('Enter');
  await input.press('End');
  await shell.keyboard.insertText('第二行');
  check('文字 Enter 换行，不误触发复制', await input.inputValue() === '第一行\n第二行' && await editor.count() === 1);
  await shell.click('[data-testid="feedback-text-done"]');
  check('多行文字作为一条标注提交', await editor.getAttribute('data-shape-count') === '2');
  await shell.mouse.dblclick(textClient.x + 6, textClient.y - 3);
  check('双击已有文字载入原文而非新建空框', await input.inputValue() === '第一行\n第二行');
  await input.fill('已修改\n仍为两行');
  await shell.click('[data-testid="feedback-text-done"]');
  check('修改文字不增加标注数量', await editor.getAttribute('data-shape-count') === '2');
  await shell.selectOption('[data-testid="feedback-font-size"]', '32');
  await shell.click('[data-testid="feedback-color-blue"]');
  await shell.mouse.dblclick(textClient.x + 6, textClient.y - 3);
  check('字号与颜色修改后原文字仍可继续编辑', await input.inputValue() === '已修改\n仍为两行');
  await input.fill('不应保留的临时修改');
  await input.press('Escape');
  await shell.mouse.dblclick(textClient.x + 6, textClient.y - 3);
  check('取消本次文字修改会保留原文', await input.inputValue() === '已修改\n仍为两行');
  await shell.click('[data-testid="feedback-text-done"]');
  await shell.click('[data-testid="feedback-delete"]');
  check('删除选中文字只删除该标注', await editor.getAttribute('data-shape-count') === '1');
  await shell.click('[data-testid="feedback-undo"]');
  check('删除操作可撤销', await editor.getAttribute('data-shape-count') === '2');

  await shell.click('[data-testid="feedback-zoom-100"]');
  geometry = await readEditorGeometry();
  const dpr = await shell.evaluate(() => devicePixelRatio);
  check('100% 按原页面尺寸显示', Math.abs(geometry.rect.width * dpr - geometry.canvasWidth) < 2);
  await shell.click('[data-testid="feedback-zoom-in"]');
  const zoomed = await readEditorGeometry();
  check('放大改变显示尺寸而不改变图片像素', zoomed.rect.width > geometry.rect.width && zoomed.canvasWidth === geometry.canvasWidth);
  const stage = shell.locator('[data-testid="feedback-stage"]');
  const stageBox = await stage.boundingBox();
  await shell.click('[data-testid="feedback-tool-hand"]');
  const scrollBefore = await stage.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  await shell.mouse.move(stageBox.x + stageBox.width * 0.55, stageBox.y + stageBox.height * 0.55);
  await shell.mouse.down();
  await shell.mouse.move(stageBox.x + stageBox.width * 0.35, stageBox.y + stageBox.height * 0.4, { steps: 8 });
  await shell.mouse.up();
  const scrollAfter = await stage.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  check('平移只移动视口、不新增标注', (scrollAfter.left > scrollBefore.left || scrollAfter.top > scrollBefore.top) && await editor.getAttribute('data-shape-count') === '2');
  await shell.click('[data-testid="feedback-fit"]');
  geometry = await readEditorGeometry();
  check('适合窗口后整张图片可见', geometry.rect.width <= stageBox.width && geometry.rect.height <= stageBox.height);
  await mainEval(`(() => { const req = process.mainModule.require.bind(process.mainModule); const win = req('electron').BrowserWindow.getAllWindows().find((item) => item.getContentBounds().width > 500); win.setSize(940, 700); })()`);
  await shell.waitForFunction(() => innerWidth === 940);
  const narrow = await shell.evaluate(() => ({
    width: innerWidth,
    titleLeft: document.querySelector('[data-testid="feedback-editor"] strong').getBoundingClientRect().left,
    controls: ['feedback-copy', 'feedback-open-wechat', 'feedback-open-wecom', 'feedback-cancel'].map((id) => {
      const rect = document.querySelector('[data-testid="' + id + '"]').getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }), height: innerHeight,
  }));
  check('940px 编辑器的复制、聊天和退出按钮全部可见', narrow.controls.every((rect) => rect.left >= 0 && rect.right <= narrow.width && rect.top >= 0 && rect.bottom <= narrow.height));
  check('macOS 编辑器标题避开原生窗口按钮', process.platform !== 'darwin' || narrow.titleLeft >= 80);
  await shell.screenshot({ path: '/tmp/diteng-feedback-narrow-editor.png' });
  await mainEval(`(() => { const req = process.mainModule.require.bind(process.mainModule); const win = req('electron').BrowserWindow.getAllWindows().find((item) => item.getContentBounds().width > 500); win.setBounds(${JSON.stringify(originalWindow.bounds)}); })()`);
  await shell.waitForFunction((width) => innerWidth === width, originalWindow.contentBounds.width);
  await shell.screenshot({ path: '/tmp/diteng-feedback-edited.png' });

  await installClipboardProbe(0);
  await mainEval('globalThis.__ditengFeedbackProbe.isFail = true');
  await shell.click('[data-testid="feedback-copy"]');
  await shell.waitForSelector('[data-testid="feedback-error"]');
  check('复制失败保留标注并恢复按钮可重试', await editor.getAttribute('data-shape-count') === '2' && await shell.locator('[data-testid="feedback-copy"]').isEnabled());
  await installClipboardProbe(1200);
  await shell.click('[data-testid="feedback-tool-select"]');
  geometry = await readEditorGeometry();
  const selectPoint = imagePointToClient(geometry, moveTo);
  await shell.mouse.click(selectPoint.x, selectPoint.y);
  check('导出前已有选框，验证会排除编辑手柄', await shell.locator('[data-testid="feedback-selection"]').count() === 1);
  const exportSamples = [...movedSamples, { group: 'selectionHandle', x: Math.round(from.x + moveTo.x - middle.x), y: Math.round(from.y + moveTo.y - middle.y - 12) }];
  const pixelsBeforeExport = await readCanvasPixels(exportSamples);
  await shell.click('[data-testid="feedback-zoom-in"]');
  await shell.evaluate(() => {
    document.querySelector('[data-testid="feedback-editor-canvas"]').focus();
    const button = document.querySelector('[data-testid="feedback-copy"]');
    button.click(); button.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await waitUntil(async () => (await readClipboardProbe())?.writes === 1, 5000, 50);
  check('慢复制期间禁用所有完成入口', await shell.locator('[data-testid="feedback-copy"]').isDisabled() && await shell.locator('[data-testid="feedback-open-wechat"]').isDisabled() && await shell.locator('[data-testid="feedback-cancel"]').isDisabled());
  await waitForEditorClosed();
  const exported = await waitForClipboardImage('/tmp/diteng-feedback-edited-export.png', exportSamples);
  check('缩放后导出仍为完整原分辨率且箭头坐标不偏移', exported.width === geometry.canvasWidth && exported.height === geometry.canvasHeight && isNearColor(exported.points[0], ARROW_RED), JSON.stringify({ width: exported.width, height: exported.height, expected: [geometry.canvasWidth, geometry.canvasHeight], pixel: exported.points[0] }));
  check('复制按钮连点与 Enter 交替触发只写入一次', (await readClipboardProbe()).writes === 1);
  check('导出图不含选框和白色编辑手柄', !isColorChanged(exported.points[1], pixelsBeforeExport[1]));
  await shell.click('[data-testid="feedback-resume"]');
  await waitForEditorReady();
  check('复制后继续编辑保留全部标注与撤销历史', await editor.getAttribute('data-shape-count') === '2' && await shell.locator('[data-testid="feedback-undo"]').isEnabled());
  await shell.click('[data-testid="feedback-cancel"]');
  await shell.click('[data-testid="feedback-button"]');
  check('重新截图前明确提示替换标注并提供继续编辑', await shell.locator('[data-testid="feedback-replace"]').count() === 1 && await shell.locator('[data-testid="feedback-resume-choice"]').count() === 1);
  await shell.click('[data-testid="feedback-resume-choice"]');
  await waitForEditorReady();
  check('从再次反馈入口也能找回原标注', await editor.getAttribute('data-shape-count') === '2');
  await shell.click('[data-testid="feedback-cancel"]');
  shell.off('pageerror', recordError);
  check('新版编辑操作没有 renderer 异常', consoleErrors.length === 0, consoleErrors.join(' | '));
}

// ============================== 主流程 ==============================

async function run() {
  console.log(`隔离 userData：${USER_DATA_DIR}`);
  console.log(`主进程日志：${ELECTRON_LOG}`);
  console.log(`测试端口：CDP ${TEST_CDP_PORT} / inspector ${TEST_INSPECT_PORT}（不使用 9223）`);
  state.electronLogOffset = electronLogSize();

  // ---------- 0. 清理残留测试实例 + 编译 + vite + 拉起隔离实例 ----------
  await clearStaleTestInstance();
  const compile = compileMainAndPreload();
  check('编译 dist/main + dist/preload（tsc）', compile.ok, compile.detail);
  if (!compile.ok) return 1;

  state.mockServer = await startMockServer();
  state.mockBase = state.mockServer.base;
  console.log(`mock 后端：${state.mockBase}`);
  if (await isHttpOk(`${TEST_CDP_ENDPOINT}/json/version`)) {
    console.log(`WARN ${TEST_CDP_PORT} 上仍有测试实例，先收掉`);
    await clearStaleTestInstance();
  }
  await ensureVite();
  await startElectron(
    ELECTRON_LOG,
    [`--user-data-dir=${USER_DATA_DIR}`, `--inspect=${TEST_INSPECT_PORT}`],
    TEST_CDP_PORT,
  );
  state.browser = await chromium.connectOverCDP(TEST_CDP_ENDPOINT);

  // ---------- 1. 登录 → 主窗 → ERP webview guest ----------
  await loginWithMock();
  const shell = state.shell;
  state.cdp = await createCdpLink();
  const guest = await waitForErpGuest();
  check(
    'ERP webview guest 加载 mock 页面',
    Boolean(guest),
    guest ? `title="${guest.title}" bodyBg=${guest.bodyBg}` : '45s 内 guest 未加载出 #erp-marker',
  );
  const layout = await readLayout();
  check('主窗布局可读（rail / 工具栏 / webview 矩形）', Boolean(layout.rail && layout.toolbar && layout.webview));
  if (!layout.rail || !layout.toolbar || !layout.webview) throw new Error('主窗布局元素缺失');

  // ---------- 2. inspector / 剪贴板通路 ----------
  state.mainInspector = await createMainInspector();
  const win = await windowInfo();
  check(
    '主进程 inspector 通路可用（Runtime.evaluate + require electron）',
    Boolean(win?.ok) && win.scaleFactor > 0,
    win?.ok ? `窗口数=${win.windowCount} 标题=${JSON.stringify(win.titles)}` : win?.error,
  );
  if (!win?.ok) throw new Error('主进程 inspector 取窗口信息失败');
  check(
    '主窗内容区尺寸可读',
    win.contentBounds.width > 500 && win.contentBounds.height > 300,
    `contentBounds=${win.contentBounds.width}x${win.contentBounds.height} DIP scale=${win.scaleFactor}`,
  );
  check(
    '渲染层与主进程缩放一致（采样坐标可信）',
    Math.abs(layout.devicePixelRatio - win.scaleFactor) < 0.01,
    `devicePixelRatio=${layout.devicePixelRatio} scaleFactor=${win.scaleFactor}`,
  );
  const clipboardItems = await mainEval(`(async () => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { clipboard } = req('electron');
    const items = await clipboard.read();
    return { ok: true, types: items.map((item) => item.types) };
  })()`);
  check('主进程剪贴板读取通路可用', Boolean(clipboardItems?.ok), JSON.stringify(clipboardItems?.types ?? []));

  // 备份用户剪贴板（测试会覆盖系统剪贴板，结束时尽力还原）
  rmSync(CLIPBOARD_BACKUP_PNG, { force: true });
  rmSync(CLIPBOARD_BACKUP_TEXT, { force: true });
  const backup = await backupClipboard();
  state.clipboardBackedUp = true;
  logInfo(`用户剪贴板已备份：${JSON.stringify(backup)}`);

  // ---------- 3. 功能入口存在性：未落盘则验证完 harness 通路，报告等待功能 ----------
  if (!(await feedbackButtonExists())) {
    skip('一键反馈入口存在（data-testid=feedback-button）', '功能尚未落盘（Shell 未渲染反馈按钮），本轮只验证 harness 通路');
    logInfo('harness 通路：隔离实例启动 → mock 登录 → 主窗 → mock ERP webview guest → 主进程 inspector → 剪贴板读取 已全部打通');
    await diagnoseCapturePipeline(layout, win);
    console.log('RESULT: HARNESS_READY（脚手架就绪，等待 feedback-button 落盘后重跑）');
    return 3;
  }

  // ---------- 4. 点击「反馈」→ 标注编辑器出现，此时不写剪贴板 ----------
  console.log('STEP 点击反馈按钮 → 校验标注编辑器、截图字节与剪贴板未写入');
  const layoutWithButton = await readLayout();
  await checkFeedbackEntry(layoutWithButton);
  const scale = win.scaleFactor;
  const expectedWidth = Math.round(win.contentBounds.width * win.scaleFactor);
  const expectedHeight = Math.round(win.contentBounds.height * win.scaleFactor);
  const samples = buildSamples(layoutWithButton, expectedWidth, expectedHeight, scale);
  const probeInstalled = await installClipboardProbe(0);
  check('clipboard.write 计数探针可用', Boolean(probeInstalled?.isPatched), JSON.stringify(probeInstalled));
  await clearClipboard();
  state.electronLogOffset = electronLogSize();
  const editorGeometry = await openFeedbackEditor();
  check(
    '点击反馈后打开标注编辑器（data-testid=feedback-editor）',
    Boolean(editorGeometry?.hasEditor),
    editorGeometry ? '编辑器已出现' : '20s 内未出现编辑器',
  );
  check(
    '编辑器画布像素尺寸 = 截图原始物理像素',
    Boolean(editorGeometry) &&
      Math.abs(editorGeometry.canvasWidth - expectedWidth) <= 1 &&
      Math.abs(editorGeometry.canvasHeight - expectedHeight) <= 1,
    editorGeometry
      ? `canvas=${editorGeometry.canvasWidth}x${editorGeometry.canvasHeight} expected=${expectedWidth}x${expectedHeight}`
      : '编辑器未就绪',
  );
  const layoutInEditor = await readLayout();
  check(
    '打开编辑器后 data-platform 已恢复（vibrancy 标记未被污染）',
    layoutInEditor.platformMarker === layoutWithButton.platformMarker,
    `before=${layoutWithButton.platformMarker} after=${layoutInEditor.platformMarker}`,
  );
  const probeAfterOpen = await readClipboardProbe();
  check(
    '打开编辑器阶段不写剪贴板（截图只回渲染层）',
    probeAfterOpen?.writes === 0,
    `clipboard.write 次数=${probeAfterOpen?.writes}`,
  );
  const clipboardAtOpen = await clipboardImageProbe('/tmp/diteng-feedback-clip-open.png', []);
  check(
    '打开编辑器阶段剪贴板没有图片',
    !clipboardAtOpen?.hasImage,
    `types=${JSON.stringify(clipboardAtOpen?.types ?? [])}`,
  );
  const openLog = readNewElectronLog();
  check(
    '主进程日志记录整窗截图完成（[feedback] 整窗截图完成）',
    /\[feedback\] 整窗截图完成：\d+x\d+/.test(openLog),
    openLog.trim().split('\n').slice(-2).join(' | ').slice(0, 200) || '(无新增日志)',
  );
  check(
    '截图阶段主进程无失败日志',
    !/\[feedback\][^\n]*失败/.test(openLog),
    openLog.trim().slice(0, 200) || '(无新增日志)',
  );
  try {
    await shell.screenshot({ path: EDITOR_PATH });
    logInfo(`编辑器截图：${EDITOR_PATH}`);
  } catch (error) {
    logInfo(`编辑器截图失败：${error?.message ?? error}`);
  }
  const webview = layoutWithButton.webview;
  if (!editorGeometry?.hasEditor || !webview) throw new Error('编辑器或 webview 布局缺失');

  // ---------- 5. 画箭头 → 仅复制 → 剪贴板图片包含标注且内容完整 ----------
  console.log('STEP 画箭头 → 仅复制 → 校验剪贴板图片尺寸/不透明度/标注像素');
  const arrowFromCss = { x: webview.left + webview.width * 0.3, y: webview.top + webview.height * 0.6 };
  const arrowToCss = { x: webview.left + webview.width * 0.7, y: webview.top + webview.height * 0.6 };
  const arrowFromImage = { x: arrowFromCss.x * scale, y: arrowFromCss.y * scale };
  const arrowToImage = { x: arrowToCss.x * scale, y: arrowToCss.y * scale };
  const arrowSamples = [0.3, 0.45, 0.6].map((fraction) => ({
    group: 'arrow',
    x: Math.round(arrowFromImage.x + (arrowToImage.x - arrowFromImage.x) * fraction),
    y: Math.round(arrowFromImage.y),
  }));
  const bgProbePoint = {
    group: 'editorBg',
    x: Math.round((webview.left + webview.width * 0.5) * scale),
    y: Math.round((webview.top + webview.height * 0.5) * scale),
  };
  const editorBgPixels = await readCanvasPixels([bgProbePoint]);
  check(
    '编辑器底图来自整窗截图（webview 底色像素命中）',
    Boolean(editorBgPixels?.[0]) && isNearColor(editorBgPixels[0], MOCK_BG),
    editorBgPixels?.[0]
      ? `[${editorBgPixels[0].x},${editorBgPixels[0].y}] rgba(${editorBgPixels[0].r},${editorBgPixels[0].g},${editorBgPixels[0].b})`
      : '读取画布失败',
  );
  await dragOnCanvas(editorGeometry, arrowFromImage, arrowToImage);
  const canvasArrow = await readCanvasPixels(arrowSamples);
  check(
    '画箭头后画布出现标注红（像素校验）',
    Array.isArray(canvasArrow) && canvasArrow.filter((point) => isNearColor(point, ARROW_RED)).length >= 2,
    canvasArrow
      ? canvasArrow.map((point) => `[${point.x},${point.y}] rgba(${point.r},${point.g},${point.b})`).join(' ')
      : '读取画布失败',
  );
  await shell.click('[data-testid="feedback-copy"]');
  const editorClosed = await waitForEditorClosed();
  check('点击「仅复制」后编辑器关闭', Boolean(editorClosed));
  const copyProbe = await readClipboardProbe();
  check('复制操作恰好写入一次剪贴板', copyProbe?.writes === 1, `clipboard.write 次数=${copyProbe?.writes}`);
  const toastAfterCopy = await waitForFeedbackToast();
  check(
    '复制后出现成功 toast（data-state=ok）',
    Boolean(toastAfterCopy) && toastAfterCopy.state === 'ok',
    `state=${toastAfterCopy?.state ?? '(无 toast)'} text="${toastAfterCopy?.text ?? ''}"`,
  );
  check(
    '成功 toast 引导粘贴（含「已复制」「粘贴」）',
    Boolean(toastAfterCopy) && toastAfterCopy.text.includes('已复制') && toastAfterCopy.text.includes('粘贴'),
    `text="${toastAfterCopy?.text ?? ''}"`,
  );
  try {
    await shell.screenshot({ path: TOAST_PATH });
    logInfo(`toast 截图：${TOAST_PATH}`);
  } catch (error) {
    logInfo(`toast 截图失败：${error?.message ?? error}`);
  }
  const clip = await waitForClipboardImage(CLIP_PATH, [...samples, ...arrowSamples]);
  check(
    '系统剪贴板存在 image/png 图片',
    Boolean(clip?.hasImage),
    clip?.hasImage
      ? `图片=${clip.width}x${clip.height} ${clip.pngBytes} 字节`
      : `types=${JSON.stringify(clip?.types ?? [])}`,
  );
  if (!clip?.hasImage) return 1;
  check(
    '剪贴板图片尺寸 = 窗口内容区物理像素',
    Math.abs(clip.width - expectedWidth) <= 1 && Math.abs(clip.height - expectedHeight) <= 1,
    `clip=${clip.width}x${clip.height} expected=${expectedWidth}x${expectedHeight}（contentBounds=${win.contentBounds.width}x${win.contentBounds.height} × scale=${win.scaleFactor}）`,
  );
  check(
    '剪贴板图片完全不透明（全图像素 alpha=255）',
    clip.transparent === 0 && clip.minAlpha === 255,
    `透明像素=${clip.transparent} minAlpha=${clip.minAlpha}`,
  );
  const bgHits = countColorHits(clip.points, 'webviewBg', MOCK_BG);
  check(
    '标注后截图仍包含 webview guest 内容（mock ERP 底色命中，未把编辑器遮罩截进去）',
    bgHits.hits >= 7,
    `${bgHits.hits}/${bgHits.total} ${formatPoints(bgHits.sample)}`,
  );
  const markerHits = countColorHits(clip.points, 'marker', MOCK_MARKER);
  check(
    '标注后截图仍包含 guest 独有标记（紫色块）',
    markerHits.hits >= 7,
    `${markerHits.hits}/${markerHits.total} ${formatPoints(markerHits.sample)}`,
  );
  const arrowHits = countColorHits(clip.points, 'arrow', ARROW_RED);
  check(
    '剪贴板图片包含箭头标注红（复制的是标注后的图）',
    arrowHits.hits >= 2,
    `${arrowHits.hits}/${arrowHits.total} ${formatPoints(arrowHits.sample)}`,
  );
  const railOpaque = countOpaque(clip.points, 'rail');
  check('rail 区域不透明（alpha=255）', railOpaque.hits === railOpaque.total, `${railOpaque.hits}/${railOpaque.total}`);
  const toolbarOpaque = countOpaque(clip.points, 'toolbar');
  check(
    '内容工具栏区域不透明（alpha=255）',
    toolbarOpaque.hits === toolbarOpaque.total,
    `${toolbarOpaque.hits}/${toolbarOpaque.total}`,
  );
  logInfo(`剪贴板图片已保存：${CLIP_PATH}（${clip.pngBytes} 字节）`);
  await closeFeedbackToast();

  // ---------- 6. 撤销/重做：画布与导出图保持同步 ----------
  console.log('STEP 撤销/重做 → 校验画布与剪贴板导出同步');
  await installClipboardProbe(0);
  await clearClipboard();
  const undoGeometry = await openFeedbackEditor();
  if (!undoGeometry) throw new Error('撤销用例：编辑器未打开');
  await dragOnCanvas(undoGeometry, arrowFromImage, arrowToImage);
  let canvasPixels = await readCanvasPixels([arrowSamples[1]]);
  check(
    '撤销前画布有箭头',
    Boolean(canvasPixels?.[0]) && isNearColor(canvasPixels[0], ARROW_RED),
    canvasPixels?.[0] ? `rgba(${canvasPixels[0].r},${canvasPixels[0].g},${canvasPixels[0].b})` : '读取画布失败',
  );
  const undoEmit = await emitEditorInput('z');
  check(
    '主进程捕获 ⌘Z 并转发 editor-undo（合成 before-input-event）',
    Boolean(undoEmit?.ok) && undoEmit.isPrevented === true,
    JSON.stringify(undoEmit),
  );
  await sleep(150);
  canvasPixels = await readCanvasPixels([arrowSamples[1]]);
  check(
    '撤销后画布箭头消失（主进程转发生效）',
    Boolean(canvasPixels?.[0]) && !isNearColor(canvasPixels[0], ARROW_RED),
    canvasPixels?.[0] ? `rgba(${canvasPixels[0].r},${canvasPixels[0].g},${canvasPixels[0].b})` : '读取画布失败',
  );
  const redoEmit = await emitEditorInput('z', { shift: true });
  check(
    '主进程捕获 ⇧⌘Z 并转发 editor-redo（合成 before-input-event）',
    Boolean(redoEmit?.ok) && redoEmit.isPrevented === true,
    JSON.stringify(redoEmit),
  );
  await sleep(150);
  canvasPixels = await readCanvasPixels([arrowSamples[1]]);
  check(
    '重做后画布箭头恢复（主进程转发生效）',
    Boolean(canvasPixels?.[0]) && isNearColor(canvasPixels[0], ARROW_RED),
    canvasPixels?.[0] ? `rgba(${canvasPixels[0].r},${canvasPixels[0].g},${canvasPixels[0].b})` : '读取画布失败',
  );
  await shell.click('[data-testid="feedback-undo"]');
  await shell.click('[data-testid="feedback-copy"]');
  await waitForEditorClosed();
  await waitForFeedbackToast();
  const undoClip = await waitForClipboardImage('/tmp/diteng-feedback-clip-undo.png', [arrowSamples[1]]);
  check(
    '撤销后导出图不含箭头（画布与导出同步）',
    Boolean(undoClip?.hasImage) && !isNearColor(undoClip.points[0], ARROW_RED),
    undoClip?.hasImage
      ? `[${undoClip.points[0].x},${undoClip.points[0].y}] rgba(${undoClip.points[0].r},${undoClip.points[0].g},${undoClip.points[0].b})`
      : '剪贴板无图片',
  );
  await closeFeedbackToast();
  await installClipboardProbe(0);
  await clearClipboard();
  const redoGeometry = await openFeedbackEditor();
  if (!redoGeometry) throw new Error('重做用例：编辑器未打开');
  await dragOnCanvas(redoGeometry, arrowFromImage, arrowToImage);
  await shell.click('[data-testid="feedback-undo"]');
  await shell.click('[data-testid="feedback-redo"]');
  await shell.click('[data-testid="feedback-copy"]');
  await waitForEditorClosed();
  await waitForFeedbackToast();
  const redoClip = await waitForClipboardImage('/tmp/diteng-feedback-clip-redo.png', [arrowSamples[1]]);
  check(
    '撤销再重做后导出图恢复箭头',
    Boolean(redoClip?.hasImage) && isNearColor(redoClip.points[0], ARROW_RED),
    redoClip?.hasImage
      ? `[${redoClip.points[0].x},${redoClip.points[0].y}] rgba(${redoClip.points[0].r},${redoClip.points[0].g},${redoClip.points[0].b})`
      : '剪贴板无图片',
  );
  await closeFeedbackToast();

  // ---------- 7. 矩形马赛克：边界像素被像素化并进入导出图 ----------
  console.log('STEP 矩形马赛克 → 校验边界像素变化并进入导出图');
  await installClipboardProbe(0);
  await clearClipboard();
  const mosaicGeometry = await openFeedbackEditor();
  if (!mosaicGeometry) throw new Error('马赛克用例：编辑器未打开');
  const markerLeftCss = webview.left + MOCK_MARKER_RECT.left;
  const markerTopCss = webview.top + MOCK_MARKER_RECT.top;
  const boundaryPoints = [0.2, 0.5, 0.8].flatMap((fraction) => [
    {
      group: 'mosaicBoundary',
      x: (markerLeftCss - 4) * scale,
      y: (markerTopCss + MOCK_MARKER_RECT.height * fraction) * scale,
    },
    {
      group: 'mosaicBoundary',
      x: (markerLeftCss + 4) * scale,
      y: (markerTopCss + MOCK_MARKER_RECT.height * fraction) * scale,
    },
  ]);
  const boundaryBefore = await readCanvasPixels(boundaryPoints);
  await shell.click('[data-testid="feedback-tool-mosaic"]');
  const mosaicFromCss = {
    x: markerLeftCss - 20,
    y: markerTopCss + MOCK_MARKER_RECT.height * 0.1,
  };
  const mosaicToCss = {
    x: markerLeftCss + 80,
    y: markerTopCss + MOCK_MARKER_RECT.height * 0.9,
  };
  await dragOnCanvas(
    mosaicGeometry,
    { x: mosaicFromCss.x * scale, y: mosaicFromCss.y * scale },
    { x: mosaicToCss.x * scale, y: mosaicToCss.y * scale },
  );
  const boundaryAfter = await readCanvasPixels(boundaryPoints);
  const changedOnCanvas =
    boundaryBefore && boundaryAfter
      ? boundaryBefore.filter((point, index) => isColorChanged(point, boundaryAfter[index])).length
      : 0;
  check(
    '马赛克改变画布边界像素（像素化生效）',
    changedOnCanvas >= 2,
    `变化点=${changedOnCanvas}/${boundaryPoints.length}`,
  );
  await shell.click('[data-testid="feedback-copy"]');
  await waitForEditorClosed();
  await waitForFeedbackToast();
  const mosaicClip = await waitForClipboardImage('/tmp/diteng-feedback-clip-mosaic.png', boundaryPoints);
  const changedInClip =
    mosaicClip?.hasImage && boundaryBefore
      ? mosaicClip.points.filter((point, index) => isColorChanged(point, boundaryBefore[index])).length
      : 0;
  check(
    '马赛克效果进入剪贴板导出图',
    changedInClip >= 2,
    `变化点=${changedInClip}/${boundaryPoints.length}`,
  );
  await closeFeedbackToast();

  // ---------- 8. Esc 取消：不写剪贴板、不产生成功 toast ----------
  console.log('STEP Esc 取消 → 校验剪贴板未被写入');
  await installClipboardProbe(0);
  await clearClipboard();
  const escGeometry = await openFeedbackEditor();
  if (!escGeometry) throw new Error('Esc 用例：编辑器未打开');
  await dragOnCanvas(escGeometry, arrowFromImage, arrowToImage);
  const escEmit = await emitEditorInput('Escape');
  check(
    '主进程捕获 Esc 并转发 editor-cancel（合成 before-input-event）',
    Boolean(escEmit?.ok) && escEmit.isPrevented === true,
    JSON.stringify(escEmit),
  );
  const escClosed = await waitForEditorClosed();
  check('Esc 后编辑器关闭', Boolean(escClosed));
  const escProbe = await readClipboardProbe();
  check('Esc 取消不写剪贴板', escProbe?.writes === 0, `clipboard.write 次数=${escProbe?.writes}`);
  const escClip = await clipboardImageProbe('/tmp/diteng-feedback-clip-esc.png', []);
  check('Esc 取消后剪贴板没有图片', !escClip?.hasImage, `types=${JSON.stringify(escClip?.types ?? [])}`);
  check(
    'Esc 取消不出现成功 toast',
    (await shell.locator('[data-testid="feedback-toast"]').count()) === 0,
  );
  // ⌘W 在编辑器打开时应取消编辑器，而不是关闭主窗（防误关）
  await installClipboardProbe(0);
  await clearClipboard();
  const closeGeometry = await openFeedbackEditor();
  if (!closeGeometry) throw new Error('⌘W 用例：编辑器未打开');
  const wEmit = await emitEditorInput('w');
  const wClosed = await waitForEditorClosed();
  const windowAfterW = await windowInfo();
  check(
    '主进程捕获 ⌘W 并改为取消编辑器（不关闭主窗）',
    Boolean(wEmit?.ok) &&
      wEmit.isPrevented === true &&
      Boolean(wClosed) &&
      Boolean(windowAfterW?.ok) &&
      (await readClipboardProbe())?.writes === 0,
    JSON.stringify({ wEmit, wClosed, windowAlive: Boolean(windowAfterW?.ok) }),
  );

  // ---------- 9. 「复制并打开微信/企业微信」：启动器调用被桩拦截，不真拉起应用 ----------
  console.log('STEP 复制并打开微信/企业微信 → 校验启动器调用参数与失败提示');
  if (process.platform !== 'darwin') {
    skip('macOS 用 open -b 启动微信', `当前平台 ${process.platform} 不走 macOS 启动分支`);
    skip('启动器失败时提示已复制但没能打开企业微信', '依赖 macOS 启动分支');
  } else {
    const execProbeInstalled = await installExecFileProbe();
    check('主进程 execFile 启动器探针可用', Boolean(execProbeInstalled?.isPatched), JSON.stringify(execProbeInstalled));
    if (execProbeInstalled?.isPatched) {
      try {
        await installClipboardProbe(0);
        await clearClipboard();
        const wechatGeometry = await openFeedbackEditor();
        check('打开微信用例：编辑器出现', Boolean(wechatGeometry?.hasEditor));
        if (wechatGeometry) {
          await shell.click('[data-testid="feedback-open-wechat"]');
          await waitForEditorClosed();
          const wechatToast = await waitForFeedbackToast();
          check(
            '打开微信后 toast 提示已复制并打开',
            Boolean(wechatToast) && wechatToast.text.includes('微信') && wechatToast.text.includes('已复制'),
            `state=${wechatToast?.state ?? '(无 toast)'} text="${wechatToast?.text ?? ''}"`,
          );
          const wechatProbe = await readClipboardProbe();
          check('打开微信前先写入剪贴板（恰好一次）', wechatProbe?.writes === 1, `clipboard.write 次数=${wechatProbe?.writes}`);
          const wechatClip = await waitForClipboardImage('/tmp/diteng-feedback-clip-wechat.png', samples);
          check(
            '打开微信后剪贴板仍是完整整窗截图',
            Boolean(wechatClip?.hasImage) &&
              Math.abs(wechatClip.width - expectedWidth) <= 1 &&
              Math.abs(wechatClip.height - expectedHeight) <= 1,
            wechatClip?.hasImage ? `${wechatClip.width}x${wechatClip.height}` : '剪贴板无图片',
          );
          const execProbe = await readExecFileProbe();
          const wechatCall = (execProbe?.calls ?? []).find(
            (call) =>
              call.command === 'open' &&
              Array.isArray(call.args) &&
              call.args[0] === '-b' &&
              call.args[1] === 'com.tencent.xinWeChat',
          );
          check(
            'macOS 用 open -b com.tencent.xinWeChat 启动微信',
            Boolean(wechatCall),
            JSON.stringify(execProbe?.calls ?? []),
          );
          await closeFeedbackToast();
        }
        await setExecFileProbeFailure(true);
        await installClipboardProbe(0);
        await clearClipboard();
        const wecomGeometry = await openFeedbackEditor();
        check('打开企业微信失败用例：编辑器出现', Boolean(wecomGeometry?.hasEditor));
        if (wecomGeometry) {
          await shell.click('[data-testid="feedback-open-wecom"]');
          await waitForEditorClosed();
          const wecomToast = await waitForFeedbackToast();
          check(
            '启动器失败时提示已复制但没能打开企业微信',
            Boolean(wecomToast) &&
              wecomToast.state === 'fail' &&
              wecomToast.text.includes('企业微信') &&
              wecomToast.text.includes('已复制'),
            `state=${wecomToast?.state ?? '(无 toast)'} text="${wecomToast?.text ?? ''}"`,
          );
          const wecomClip = await waitForClipboardImage('/tmp/diteng-feedback-clip-wecom.png', []);
          check('启动器失败时剪贴板仍保留复制结果', Boolean(wecomClip?.hasImage));
          await closeFeedbackToast();
        }
      } finally {
        const restored = await restoreExecFileProbe().catch(() => ({ restored: false }));
        logInfo(`execFile 启动器桩已还原：${JSON.stringify(restored)}`);
      }
    } else {
      skip('macOS 用 open -b com.tencent.xinWeChat 启动微信', 'execFile 属性不可写，无法安装启动桩');
      skip('启动器失败时提示已复制但没能打开企业微信', '依赖启动桩');
    }
  }

  // ---------- 10. 连续点击：只截图一次、只开一个编辑器、不写剪贴板 ----------
  console.log('STEP 连续点击反馈按钮 → 校验截图防重');
  await closeFeedbackToast();
  await installClipboardProbe(0);
  await clearClipboard();
  state.electronLogOffset = electronLogSize();
  await shell.evaluate(() => {
    const button = document.querySelector('[data-testid="feedback-button"]');
    button?.click();
    button?.click();
    button?.click();
  });
  await confirmFreshScreenshot();
  const rapidGeometry = await waitForEditorReady(20_000);
  const rapidEditorCount = await shell.locator('[data-testid="feedback-editor"]').count();
  check(
    '连续点击后只出现一个编辑器',
    Boolean(rapidGeometry?.hasEditor) && rapidEditorCount === 1,
    `editor 数量=${rapidEditorCount}`,
  );
  check('连续点击不写剪贴板', (await readClipboardProbe())?.writes === 0, '截图阶段不应写剪贴板');
  await sleep(600);
  const rapidLog = readNewElectronLog();
  const rapidCaptureCount = (rapidLog.match(/\[feedback\] 整窗截图完成/g) ?? []).length;
  check(
    '连续点击只截图一次（主进程日志计数=1）',
    rapidCaptureCount === 1,
    `截图次数=${rapidCaptureCount}`,
  );
  await shell.keyboard.press('Escape');
  await waitForEditorClosed();

  // ---------- 11. 失败路径：注入 capturePage 异常 → 中文失败 toast、不打开编辑器 ----------
  console.log('STEP 注入截图异常 → 校验中文失败提示（失败路径）');
  const injection = await mainEval(`(() => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { BrowserWindow } = req('electron');
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    const target = windows.find((win) => win.getContentBounds().width > 500) ?? windows[0];
    if (!target) return { ok: false, error: '没有可用主窗' };
    const original = target.webContents.capturePage.bind(target.webContents);
    try {
      target.webContents.capturePage = async () => {
        throw new Error('e2e injected capture failure');
      };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
    globalThis.__ditengFeedbackCapturePageBackup = { webContents: target.webContents, original };
    return { ok: true, isPatched: target.webContents.capturePage !== original };
  })()`);
  if (injection?.ok && injection.isPatched) {
    try {
      await clearClipboard();
      await shell.click('[data-testid="feedback-button"]');
      await confirmFreshScreenshot();
      const failToast = await waitForFeedbackToast();
      const editorCountAfterFail = await shell.locator('[data-testid="feedback-editor"]').count();
      check(
        '截图异常时展示失败 toast（data-state=fail）',
        Boolean(failToast) && failToast.state === 'fail',
        `state=${failToast?.state ?? '(无 toast)'} text="${failToast?.text ?? ''}"`,
      );
      check(
        '失败 toast 为中文错误提示',
        Boolean(failToast) && /[\u4e00-\u9fa5]/.test(failToast.text) && failToast.text.includes('失败'),
        `text="${failToast?.text ?? ''}"`,
      );
      check('截图失败时不打开标注编辑器', editorCountAfterFail === 0, `editor 数量=${editorCountAfterFail}`);
      await closeFeedbackToast();
    } finally {
      const restored = await mainEval(`(() => {
        const backup = globalThis.__ditengFeedbackCapturePageBackup;
        if (!backup) return { restored: false };
        backup.webContents.capturePage = backup.original;
        delete globalThis.__ditengFeedbackCapturePageBackup;
        return { restored: true };
      })()`).catch(() => ({ restored: false }));
      logInfo(`capturePage 异常注入已撤销：${JSON.stringify(restored)}`);
    }
    const recoveredGeometry = await openFeedbackEditor();
    check('失败路径后恢复正常（再次点击可打开编辑器）', Boolean(recoveredGeometry?.hasEditor));
    await shell.keyboard.press('Escape');
    await waitForEditorClosed();
  } else {
    skip('截图异常时展示失败 toast（data-state=fail）', `无法注入 capturePage 异常：${injection?.error ?? '属性不可写'}`);
    skip('失败 toast 为中文错误提示', '依赖失败注入');
    skip('截图失败时不打开标注编辑器', '依赖失败注入');
  }

  await runEditingChecks();
  logInfo(`编辑器截图：${EDITOR_PATH}`);
  logInfo(`Toast 截图：${TOAST_PATH}`);
  logInfo(`剪贴板截图：${CLIP_PATH}`);

  return 0;
}

/**
 * 功能未落盘时的主进程链路诊断（不计入 CHECK）：直接调 preload API，验证 capturePage
 * 能截到 webview guest、尺寸正确、摘除 data-platform 后不透明。用于提前暴露主进程侧问题。
 */
async function diagnoseCapturePipeline(layout, win) {
  try {
    const apiReady = await state.shell.evaluate(
      () => typeof window.diteng?.captureFeedbackScreenshot === 'function',
    );
    logInfo(`诊断：渲染层 captureFeedbackScreenshot API ${apiReady ? '已暴露' : '未暴露'}`);
    if (!apiReady) return;
    await clearClipboard();
    const result = await state.shell.evaluate(async () => {
      const root = document.documentElement;
      const platformMarker = root.getAttribute('data-platform');
      if (platformMarker) root.removeAttribute('data-platform');
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const captured = await window.diteng.captureFeedbackScreenshot();
        if (!captured.ok) return { ok: false, message: captured.message };
        const bytes = captured.png;
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }));
        const copied = await window.diteng.copyFeedbackImage(bytes);
        return {
          ok: true,
          byteLength: bytes.length,
          width: bitmap.width,
          height: bitmap.height,
          copied: copied.ok,
          copiedMessage: copied.ok ? '' : copied.message,
        };
      } finally {
        if (platformMarker) root.setAttribute('data-platform', platformMarker);
      }
    });
    logInfo(`诊断：截图/复制返回 ${JSON.stringify(result)}`);
    if (result?.ok) {
      const scale = layout.devicePixelRatio;
      const expectedWidth = Math.round(win.contentBounds.width * win.scaleFactor);
      const expectedHeight = Math.round(win.contentBounds.height * win.scaleFactor);
      const samples = buildSamples(layout, expectedWidth, expectedHeight, scale);
      const probe = await clipboardImageProbe(DIAG_CLIP_PATH, samples);
      if (probe?.hasImage) {
        const bgHits = countColorHits(probe.points, 'webviewBg', MOCK_BG);
        const markerHits = countColorHits(probe.points, 'marker', MOCK_MARKER);
        logInfo(
          `诊断：剪贴板图片 ${probe.width}x${probe.height}（期望 ${expectedWidth}x${expectedHeight}）透明像素=${probe.transparent} minAlpha=${probe.minAlpha}`,
        );
        logInfo(
          `诊断：webview 底色命中 ${bgHits.hits}/${bgHits.total}，guest 独有标记命中 ${markerHits.hits}/${markerHits.total}；图片 ${DIAG_CLIP_PATH}`,
        );
      } else {
        logInfo(`诊断：剪贴板无 image/png（types=${JSON.stringify(probe?.types ?? [])}）`);
      }
    }
    await clearClipboard();
  } catch (error) {
    logInfo(`诊断失败（不影响 HARNESS_READY 结论）：${error?.message ?? error}`);
  }
}

// ============================== 清理与汇总 ==============================

async function cleanup() {
  // 先还原用户剪贴板（依赖主进程仍存活）
  let clipboardRestored = false;
  try {
    if (state.mainInspector) await restoreClipboardProbe().catch(() => {});
    if (state.clipboardBackedUp && state.mainInspector) {
      const restored = await restoreClipboard();
      clipboardRestored = Boolean(restored?.verified);
      logInfo(`用户剪贴板还原：${JSON.stringify(restored)}`);
    }
  } catch (error) {
    console.log(`WARN 剪贴板还原失败：${error?.message ?? error}`);
  }
  // 兜底：原剪贴板是纯文本且主进程还原未通过回读校验时，直接用系统 pbcopy 还原
  if (!clipboardRestored && state.clipboardBackedUp && existsSync(CLIPBOARD_BACKUP_TEXT) && !existsSync(CLIPBOARD_BACKUP_PNG)) {
    const fallback = spawnSync('pbcopy', [], { input: readFileSync(CLIPBOARD_BACKUP_TEXT) });
    logInfo(`用户剪贴板 pbcopy 兜底还原：${fallback.status === 0 ? 'OK' : `FAIL（${fallback.error?.message ?? fallback.status}）`}`);
  }
  await state.mainInspector?.close().catch(() => {});
  await state.cdp?.close().catch(() => {});
  if (state.browser) {
    await Promise.race([state.browser.close().catch(() => {}), sleep(3000)]);
  }
  try {
    await killElectron(20, TEST_CDP_PORT);
  } catch {
    // 清理失败不掩盖主结果
  }
  for (const pid of await listCdpPids(TEST_INSPECT_PORT).catch(() => [])) {
    const command = await commandOf(pid);
    if (command.includes('electron')) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 已退出
      }
    }
  }
  state.mockServer?.server.close();
  // vite 由 ensureVite 拉起且可能被其他 e2e 复用，保持运行（与仓库现有脚本约定一致）
}

let exitCode = 1;
try {
  exitCode = await run();
} catch (error) {
  console.error('E2E 异常：', error);
  check('脚本执行完成（无未捕获异常）', false, `${error?.message ?? error}`);
  exitCode = 1;
} finally {
  await cleanup();
  // 若有 FAIL，无条件置 1（HARNESS_READY 仅在全部 harness 检查通过时成立）
  const failed = checks.filter((item) => item.ok === false);
  const skipped = checks.filter((item) => item.ok === null);
  if (failed.length > 0) exitCode = 1;
  const passCount = checks.filter((item) => item.ok === true).length;
  console.log(`—— 汇总：${passCount}/${checks.length} 通过，失败 ${failed.length}，跳过 ${skipped.length} ——`);
  if (failed.length > 0) {
    console.log('失败明细：');
    for (const item of failed) console.log(`- ${item.name}：${item.detail}`);
  }
  console.log(`产物：${EDITOR_PATH} / ${CLIP_PATH} / ${TOAST_PATH}`);
  console.log(`主进程日志：${ELECTRON_LOG}`);
  console.log(`隔离 userData（保留供排查）：${USER_DATA_DIR}`);
  console.log(exitCode === 0 ? 'RESULT: PASS' : exitCode === 3 ? 'RESULT: HARNESS_READY' : 'RESULT: FAIL');
}
process.exit(exitCode);
