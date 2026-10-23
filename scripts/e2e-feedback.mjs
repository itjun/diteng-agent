/**
 * 一键反馈 e2e：真实 Electron 主窗点击「反馈」→ 整窗截图写入系统剪贴板 → toast 引导粘贴给客服，
 * 并通过主进程 Node inspector（--inspect=9230）读回剪贴板 PNG，做尺寸 / 不透明度 / webview guest 内容像素校验。
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
 *   4. 系统剪贴板是全局资源：测试前备份 text/png，结束时尽力还原（测试期间的截图内容会被覆盖）。
 *
 * 产物：/tmp/diteng-feedback-clip.png（单次点击后的剪贴板图片，最终交付证据）
 *       /tmp/diteng-feedback-toast.png（成功 toast 截图）
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
      const index = (y * size.width + x) * 4;
      return { group, x, y, r: bitmap[index + 2], g: bitmap[index + 1], b: bitmap[index], a: bitmap[index + 3] };
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
      railHeader: rectOf(document.querySelector('[data-testid="sidebar-toolbar"]')),
      webview: rectOf(activeWebview),
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
  if (layout.railHeader) {
    for (const fx of [0.3, 0.5, 0.7]) {
      const [x, y] = toPhysical(
        layout.railHeader.left + layout.railHeader.width * fx,
        layout.railHeader.top + layout.railHeader.height * 0.5,
      );
      samples.push({ group: 'railHeader', x, y });
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

/** 入口契约：存在、可用、文案/标题可读、位于 rail 顶栏内 */
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
  const isInRailHeader =
    Boolean(button.rect && layout.railHeader) &&
    button.rect.left >= layout.railHeader.left - 1 &&
    button.rect.left + button.rect.width <= layout.railHeader.left + layout.railHeader.width + 1 &&
    button.rect.top >= layout.railHeader.top - 1 &&
    button.rect.top + button.rect.height <= layout.railHeader.top + layout.railHeader.height + 1;
  check(
    '反馈按钮位于 rail 顶栏内',
    isInRailHeader,
    button.rect && layout.railHeader
      ? `feedback=[${button.rect.left.toFixed(0)},${button.rect.top.toFixed(0)}→${(button.rect.left + button.rect.width).toFixed(0)},${(button.rect.top + button.rect.height).toFixed(0)}] railHeader=[${layout.railHeader.left.toFixed(0)},${layout.railHeader.top.toFixed(0)}→${(layout.railHeader.left + layout.railHeader.width).toFixed(0)},${(layout.railHeader.top + layout.railHeader.height).toFixed(0)}]`
      : '元素缺失',
  );
  return true;
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
  check('主窗布局可读（rail / rail 顶栏 / webview 矩形）', Boolean(layout.rail && layout.railHeader && layout.webview));
  if (!layout.rail || !layout.railHeader || !layout.webview) throw new Error('主窗布局元素缺失');

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

  // ---------- 4. 单次点击：toast + 剪贴板像素契约 ----------
  console.log('STEP 单次点击反馈按钮 → 校验 toast、主进程日志与剪贴板图片');
  const layoutWithButton = await readLayout();
  await checkFeedbackEntry(layoutWithButton);
  await clearClipboard();
  state.electronLogOffset = electronLogSize();
  await shell.click('[data-testid="feedback-button"]');
  const toastAppeared = await waitUntil(
    async () => (await shell.locator('[data-testid="feedback-toast"]').count()) > 0,
    20_000,
    200,
  );
  check('点击反馈按钮后出现 toast（data-testid=feedback-toast）', Boolean(toastAppeared));
  const toastText = toastAppeared
    ? ((await shell.textContent('[data-testid="feedback-toast"]')) ?? '').replace(/\s+/g, ' ').trim()
    : '';
  const toastState = toastAppeared
    ? await shell.getAttribute('[data-testid="feedback-toast"]', 'data-state').catch(() => null)
    : null;
  check(
    'toast 成功文案含「截图已复制到系统剪贴板」「粘贴」「客服」',
    toastText.includes('截图已复制到系统剪贴板') && toastText.includes('粘贴') && toastText.includes('客服'),
    `text="${toastText}" state=${toastState}`,
  );
  check('toast 状态为成功（data-state=ok）', toastState === 'ok', `data-state=${toastState}`);
  try {
    await shell.screenshot({ path: TOAST_PATH });
    logInfo(`toast 截图：${TOAST_PATH}`);
  } catch (error) {
    logInfo(`toast 截图失败：${error?.message ?? error}`);
  }

  const newLog = readNewElectronLog();
  check(
    '主进程日志记录截图写入成功（[feedback] 整窗截图已写入系统剪贴板）',
    /\[feedback\] 整窗截图已写入系统剪贴板：\d+x\d+/.test(newLog),
    newLog.trim().split('\n').slice(-3).join(' | ').slice(0, 240) || '(无新增日志)',
  );
  check('主进程日志无截图失败分支（[feedback] 截图失败/写入失败）', !/\[feedback\][^\n]*(失败)/.test(newLog), newLog.trim().slice(0, 240));

  // 读取剪贴板 PNG 并做像素校验（此时渲染层已恢复 data-platform，用布局里的 rect 采样）
  const layoutAfterCapture = await readLayout();
  check(
    '截图后 data-platform 已恢复（vibrancy 标记未被污染）',
    layoutAfterCapture.platformMarker === layout.platformMarker,
    `before=${layout.platformMarker} after=${layoutAfterCapture.platformMarker}`,
  );
  const scale = layoutAfterCapture.devicePixelRatio;
  const expectedWidth = Math.round(win.contentBounds.width * win.scaleFactor);
  const expectedHeight = Math.round(win.contentBounds.height * win.scaleFactor);
  const samples = buildSamples(layoutAfterCapture, expectedWidth, expectedHeight, scale);
  const clip = await clipboardImageProbe(CLIP_PATH, samples);
  check(
    '系统剪贴板存在 image/png 图片',
    Boolean(clip?.hasImage),
    clip?.hasImage ? `图片=${clip.width}x${clip.height} ${clip.pngBytes} 字节` : `types=${JSON.stringify(clip?.types ?? [])}`,
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
    '截图包含 webview guest 内容（mock ERP 底色 #fde68a 命中）',
    bgHits.hits >= 7,
    `${bgHits.hits}/${bgHits.total} ${formatPoints(bgHits.sample)}`,
  );
  const markerHits = countColorHits(clip.points, 'marker', MOCK_MARKER);
  check(
    '截图包含 guest 独有标记（紫色块，证明页内合成内容被截入）',
    markerHits.hits >= 7,
    `${markerHits.hits}/${markerHits.total} ${formatPoints(markerHits.sample)}`,
  );
  const railOpaque = countOpaque(clip.points, 'rail');
  check('rail 区域不透明（alpha=255）', railOpaque.hits === railOpaque.total, `${railOpaque.hits}/${railOpaque.total}`);
  const railHeaderOpaque = countOpaque(clip.points, 'railHeader');
  check(
    'rail 顶栏区域不透明（alpha=255）',
    railHeaderOpaque.hits === railHeaderOpaque.total,
    `${railHeaderOpaque.hits}/${railHeaderOpaque.total}`,
  );
  logInfo(`剪贴板图片已保存：${CLIP_PATH}（${clip.pngBytes} 字节）`);

  // 关闭 toast，避免遮挡下一次截图
  await shell.click('[data-testid="feedback-toast-close"]').catch(() => {});
  await shell.waitForSelector('[data-testid="feedback-toast"]', { state: 'detached', timeout: 10_000 }).catch(() => {});

  // ---------- 5. 连续快速点击：只发起一次截图、截图期间禁用入口、data-platform 临时摘除 ----------
  console.log('STEP 连续快速点击反馈按钮 → 校验防重与截图期间状态');
  const probeInstalled = await installClipboardProbe(400);
  if (!probeInstalled?.isPatched) {
    logInfo(`clipboard.write 计数探针不可用：${probeInstalled?.error ?? JSON.stringify(probeInstalled)}`);
  }
  await clearClipboard();
  const markerBeforeRapid = (await readLayout()).platformMarker;
  await shell.evaluate(() => {
    const button = document.querySelector('[data-testid="feedback-button"]');
    button?.click();
    button?.click();
    button?.click();
  });
  // 在 400ms 写入延时窗口内轮询：按钮应禁用、data-platform 应临时摘除
  let sawDisabled = false;
  let sawMarkerRemoved = false;
  for (let i = 0; i < 60; i++) {
    const observed = await shell
      .evaluate(() => ({
        disabled: Boolean(document.querySelector('[data-testid="feedback-button"]')?.disabled),
        ariaBusy: document.querySelector('[data-testid="feedback-button"]')?.getAttribute('aria-busy'),
        platformMarker: document.documentElement.getAttribute('data-platform'),
      }))
      .catch(() => null);
    if (observed?.disabled || observed?.ariaBusy === 'true') sawDisabled = true;
    if (observed && observed.platformMarker === null) sawMarkerRemoved = true;
    if (sawDisabled && sawMarkerRemoved) break;
    await sleep(20);
  }
  const rapidToast = await waitUntil(
    async () => (await shell.locator('[data-testid="feedback-toast"]').count()) > 0,
    20_000,
    200,
  );
  check('连续快速点击后仍出现成功 toast', Boolean(rapidToast));
  const rapidToastText = rapidToast
    ? ((await shell.textContent('[data-testid="feedback-toast"]')) ?? '').replace(/\s+/g, ' ').trim()
    : '';
  check('连续快速点击无失败提示', rapidToastText.includes('截图已复制到系统剪贴板') && !rapidToastText.includes('失败'), `text="${rapidToastText}"`);
  if (probeInstalled?.isPatched) {
    const probe = await readClipboardProbe();
    check('连续快速点击只发起一次剪贴板写入（截图防重）', probe?.writes === 1, `clipboard.write 次数=${probe?.writes}`);
  } else {
    skip('连续快速点击只发起一次剪贴板写入（截图防重）', 'clipboard.write 无法在主进程内包装计数');
  }
  if (sawDisabled) {
    check('截图期间反馈按钮进入禁用/忙碌态', true, '400ms 写入延时窗口内观察到 disabled/aria-busy');
  } else {
    skip(
      '截图期间反馈按钮进入禁用/忙碌态',
      '当前实现用 ref 防重、不设置 disabled（Lead 注释：避免禁用态被截进画面）；防重由「只写入一次」断言覆盖，是否补 disabled 由 Lead 裁决',
    );
  }
  check(
    '截图期间临时摘除 data-platform（vibrancy 透明底），截图后恢复',
    sawMarkerRemoved && (await readLayout()).platformMarker === markerBeforeRapid,
    `before=${markerBeforeRapid} 摘除观察=${sawMarkerRemoved} after=${(await readLayout()).platformMarker}`,
  );
  const buttonEnabledAgain = await waitUntil(
    async () => (await shell.evaluate(() => !document.querySelector('[data-testid="feedback-button"]')?.disabled)) === true,
    15_000,
    200,
  );
  check('截图完成后反馈按钮恢复可用', Boolean(buttonEnabledAgain));
  const rapidClip = await clipboardImageProbe(RAPID_CLIP_PATH, samples);
  check(
    '连续快速点击后剪贴板仍是有效的整窗截图',
    Boolean(rapidClip?.hasImage) &&
      rapidClip.width === expectedWidth &&
      rapidClip.height === expectedHeight &&
      rapidClip.transparent === 0,
    rapidClip?.hasImage
      ? `${rapidClip.width}x${rapidClip.height} 透明像素=${rapidClip.transparent}`
      : '剪贴板无 image/png',
  );
  await restoreClipboardProbe();
  await shell.click('[data-testid="feedback-toast-close"]').catch(() => {});
  await shell.waitForSelector('[data-testid="feedback-toast"]', { state: 'detached', timeout: 10_000 }).catch(() => {});

  // ---------- 6. 失败路径：注入 capturePage 异常 → 中文失败 toast（不改 src，走主进程 inspector 注入） ----------
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
      const failToast = await waitUntil(
        async () => (await shell.locator('[data-testid="feedback-toast"]').count()) > 0,
        20_000,
        200,
      );
      const failText = failToast
        ? ((await shell.textContent('[data-testid="feedback-toast"]')) ?? '').replace(/\s+/g, ' ').trim()
        : '';
      const failState = failToast
        ? await shell.getAttribute('[data-testid="feedback-toast"]', 'data-state').catch(() => null)
        : null;
      check('截图异常时展示失败 toast（data-state=fail）', Boolean(failToast) && failState === 'fail', `state=${failState} text="${failText}"`);
      check(
        '失败 toast 为中文错误提示',
        /[\u4e00-\u9fa5]/.test(failText) && failText.includes('失败'),
        `text="${failText}"`,
      );
      await shell.click('[data-testid="feedback-toast-close"]').catch(() => {});
      await shell.waitForSelector('[data-testid="feedback-toast"]', { state: 'detached', timeout: 10_000 }).catch(() => {});
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
    // 失败后再次点击应恢复成功（证明异常注入不残留、正常链路仍可用）
    await shell.click('[data-testid="feedback-button"]');
    const recovered = await waitUntil(
      async () => {
        if ((await shell.locator('[data-testid="feedback-toast"]').count()) === 0) return null;
        const text = ((await shell.textContent('[data-testid="feedback-toast"]')) ?? '').replace(/\s+/g, ' ');
        return text.includes('截图已复制到系统剪贴板') ? text : null;
      },
      20_000,
      200,
    );
    check('失败路径后恢复正常截图（toast 成功）', Boolean(recovered));
    await shell.click('[data-testid="feedback-toast-close"]').catch(() => {});
    await shell.waitForSelector('[data-testid="feedback-toast"]', { state: 'detached', timeout: 10_000 }).catch(() => {});
  } else {
    skip('截图异常时展示失败 toast（data-state=fail）', `无法注入 capturePage 异常：${injection?.error ?? '属性不可写'}`);
    skip('失败 toast 为中文错误提示', '依赖失败注入');
  }

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
        return await window.diteng.captureFeedbackScreenshot();
      } finally {
        if (platformMarker) root.setAttribute('data-platform', platformMarker);
      }
    });
    logInfo(`诊断：captureFeedbackScreenshot 返回 ${JSON.stringify(result)}`);
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
  console.log(`产物：${CLIP_PATH} / ${TOAST_PATH}`);
  console.log(`主进程日志：${ELECTRON_LOG}`);
  console.log(`隔离 userData（保留供排查）：${USER_DATA_DIR}`);
  console.log(exitCode === 0 ? 'RESULT: PASS' : exitCode === 3 ? 'RESULT: HARNESS_READY' : 'RESULT: FAIL');
}
process.exit(exitCode);
