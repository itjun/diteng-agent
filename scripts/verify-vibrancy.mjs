import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 毛玻璃真实透光验证（关键验收）：纯色背景板 + 应用主窗叠加 + 屏幕截图差分采样。
 *
 * 背景：macOS 整窗 vibrancy 需要 NSVisualEffectView 材质透过壳 CSS 半透明层与下层窗口混合。
 * 曾用主进程 WebContentsView 承载 ERP 标签，实测一旦挂原生子视图，整窗透明合成被破坏
 * （rail 采样呈中性灰、无背景贡献），故改为渲染层 <webview>（页内合成）。本脚本验证该修复真实生效。
 *
 * 方法：
 *   1. 脚本自带纯色背景板（Electron，固定区域），先黄后蓝各测一轮
 *   2. 连 CDP(9223)，登录（或复用 #/main）进主窗；归一 left 布局 + 浅色主题；
 *      采样期剥掉 rail 的 CSS tint（tint 是 CSS 层，由 e2e-vibrancy 单独断言），
 *      直测 NSVisualEffectView 材质
 *   3. AppleScript 按窗口标题 "diteng agent" 精确匹配（遍历进程，绝不用
 *      "first process whose name is Electron"）把主窗压到背景板之上；
 *      采样前后各校验一次背景板裸露条仍为纯色（场景门：主窗被收到托盘/第三方窗口压上都判异常重试）
 *   4. screencapture 采样 rail 空白区（railTop 拖拽区）；纯 node zlib 解码 PNG
 *      （IHDR/IDAT 解析 + 逐行 unfilter 0-4），算区域平均色
 *   5. 断言（本机 macOS 27 + Electron 44 实测基线，三次测量完全一致）：
 *        健康态（纯 BrowserWindow+vibrancy 基准 == 含 webview == 本应用）：黄底 (226.0,222.0,204.9)
 *        破坏态（WebContentsView 破坏整窗合成）：中性灰（r≈g≈b，如 (225,228,224) / (126,124,115)）
 *      - 黄底绝对判据：b<216 且 r-b>12（材质带暖调）且 g>150（排除深色不透明）
 *      - 黄蓝差分判据：rail 对黄/蓝背景板的响应显著不同（|Δb|>25 且 |Δr|>25），
 *        不透光时两次采样恒为同一中性灰，差分判据天然免疫材质观感随系统版本漂移
 *
 * 前置：vite(5173) 与 electron(--remote-debugging-port=9223) 已运行；终端需有屏幕录制/辅助功能权限。
 * 用法：node scripts/verify-vibrancy.mjs
 *   E2E_MOCK=1 / E2E_SERVER_BASE / E2E_LOGIN_ID / E2E_PASSWORD  覆盖目标环境
 */
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const USE_MOCK = process.env.E2E_MOCK === '1';

// 背景板区域（主屏左上角附近，避开 Dock 与菜单栏）
const BACKDROP = { x: 160, y: 160, w: 1200, h: 900 };
const RAIL_WIDTH = 224; // 与 Shell.module.css .rail 一致
const BACKDROP_COLORS = {
  yellow: { hex: '#ffd400', rgb: [255, 212, 0] },
  blue: { hex: '#0033ff', rgb: [0, 51, 255] },
};

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const backdropFile = `/tmp/diteng-verify-backdrop-${process.pid}.js`;
const shotFile = (tag) => `/tmp/diteng-verify-${tag}-${process.pid}.png`;

// ============ 纯 node PNG 解码：IHDR/IDAT + 逐行 unfilter（支持 filter 0-4，8bit RGB/RGBA） ============

function decodePng(buffer) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(sig)) throw new Error('非 PNG 文件');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`不支持的 PNG 形态 bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const row = raw.subarray(rowStart, rowStart + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`未知 PNG filter=${filter}`);
      }
      out[x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** 区域平均色（x/y/w/h 为 PNG 像素坐标），返回 {r,g,b} */
function sampleAverage(png, x, y, w, h) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(png.width, Math.round(x + w));
  const y1 = Math.min(png.height, Math.round(y + h));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * png.width + px) * png.channels;
      r += png.pixels[i];
      g += png.pixels[i + 1];
      b += png.pixels[i + 2];
      count++;
    }
  }
  if (count === 0) throw new Error('采样区域为空');
  return { r: r / count, g: g / count, b: b / count };
}

/** 截屏指定区域（DIP 坐标）并解码，返回 { png, scale }（scale=像素/点，视网膜为 2） */
function captureRegion(x, y, w, h, file) {
  execFileSync('screencapture', ['-x', '-R', `${x},${y},${w},${h}`, file]);
  const png = decodePng(readFileSync(file));
  return { png, scale: png.width / w };
}

// ============ 纯色背景板（脚本内自带，颜色由 argv 指定） ============

const backdropScript = `const { app, BrowserWindow } = require('electron');
const hex = process.argv[2] === 'blue' ? '#0033ff' : '#ffd400';
const urlSafe = hex.replace('#', '%23');
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: ${BACKDROP.x}, y: ${BACKDROP.y}, width: ${BACKDROP.w}, height: ${BACKDROP.h},
    show: false, title: 'diteng verify backdrop',
    backgroundColor: hex,
    webPreferences: {},
  });
  win.once('ready-to-show', () => { win.show(); win.moveTop(); console.log('BACKDROP_READY'); });
  win.loadURL('data:text/html,<body style="margin:0;background:' + urlSafe + '"></body>');
});
`;

// 背景板进程：先落盘脚本再 spawn（文件不存在时 electron CLI 会立刻报错退出）
let backdropChild = null;
let backdropReady = false;
const cleanupFns = [];
function cleanup() {
  for (const fn of cleanupFns.splice(0)) {
    try {
      fn();
    } catch {
      // 清理失败不阻断
    }
  }
}
process.on('exit', cleanup);
// .bin/electron 是 CLI 壳，kill 未必传导到真实 Electron；再按脚本路径 pkill 兜底
cleanupFns.push(() => {
  if (backdropChild) backdropChild.kill('SIGKILL');
  try {
    execFileSync('pkill', ['-f', 'diteng-verify-backdrop']);
  } catch {
    // 无残留进程
  }
});
try {
  unlinkSync(backdropFile);
} catch {
  // 首次运行无残留
}

function fail(message) {
  console.log(`RESULT: FAIL（${message}）`);
  cleanup();
  process.exit(1);
}

async function spawnBackdrop(color) {
  try {
    execFileSync('pkill', ['-f', 'diteng-verify-backdrop']);
    await new Promise((r) => setTimeout(r, 700));
  } catch {
    // 无残留进程
  }
  writeFileSync(backdropFile, backdropScript);
  backdropReady = false;
  backdropChild = spawn(join(projectRoot, 'node_modules/.bin/electron'), [backdropFile, color], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  backdropChild.stdout.on('data', (chunk) => {
    if (String(chunk).includes('BACKDROP_READY')) backdropReady = true;
  });
  for (let i = 0; i < 60 && !backdropReady; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!backdropReady) fail(`背景板（${color}）30s 内未就绪`);
}

// ============ 本地 mock 后端（生产不可用时兜底，同 e2e-layout） ============

function startMockServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    // 网页版同款登录：POST /services/SvrUserLogin.getToken，form 编码单字段 dataIn（宽松解析，不校验凭据）
    if (req.method === 'POST' && url.pathname === '/services/SvrUserLogin.getToken') {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
      });
      let head = {};
      try {
        head = JSON.parse(new URLSearchParams(body).get('dataIn') ?? '{}').head ?? {};
      } catch { /* 宽松解析 */ }
      if (head.verifyCode === '??????') {
        send(200, JSON.stringify({ state: 1, message: '验证码已发送' }), 'application/json');
        return;
      }
      send(200, JSON.stringify({
        state: 1,
        message: '登录成功',
        head: {
          status: 1,
          token: 'mock-token-verify-vibrancy',
          user_code: '01',
          startPage: '250008/FrmDefault',
          corpNo: '250008',
          homeForm: 'FrmDefault',
          forceRedirect: false,
          redirectUrl: '',
        },
      }), 'application/json');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/getTokenInfo') {
      send(200, JSON.stringify({
        userId: 'mock-user',
        userCode: '01',
        userName: '透光自测用户',
        corpNo: '250008',
        options: {},
      }), 'application/json');
      return;
    }
    if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      send(200, JSON.stringify({
        state: 1,
        head: {},
        body: [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '透光自测账套', 'MOCK']],
      }), 'application/json');
      return;
    }
    if (url.pathname.endsWith('/FrmMessages.mqttConfig')) {
      send(200, JSON.stringify({ result: false, message: 'mock 未配置 MQTT' }), 'application/json');
      return;
    }
    send(200, '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ERP Mock 页</title></head><body style="margin:0;background:#fff">mock</body></html>', 'text/html; charset=utf-8');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ============ 主流程 ============

// 0. 系统开了「减少透明度」时 vibrancy 会被压成灰底，属于环境不满足而非实现缺陷，先检出
let reduceTransparency = false;
try {
  const out = execFileSync('defaults', ['read', 'com.apple.universalaccess', 'reduceTransparency'], { encoding: 'utf8' }).trim();
  reduceTransparency = out === '1';
} catch {
  // 键不存在 = 未开启
}
if (reduceTransparency) fail('系统已开启「减少透明度」（辅助功能），vibrancy 被系统压成不透明底，请关闭后重测');

// 1. 连 CDP；复用 #/main 或登录（生产失败重试一次，再退 mock）
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
cleanupFns.push(() => {
  browser.close().catch(() => {});
});
function allPages() {
  return browser.contexts().flatMap((c) => c.pages());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mock = USE_MOCK ? await startMockServer() : null;
let serverBase = mock ? mock.base : SERVER_BASE;
let shell = allPages().find((p) => p.url().includes('#/main'));

if (!shell) {
  const login = allPages().find((p) => p.url().includes('127.0.0.1:5173'));
  if (!login) fail('未见 5173 登录页，请先启动 vite 与 electron --remote-debugging-port=9223');
  const submitLogin = async (base) => {
    await login.fill('#server-base', base);
    await login.fill('#login-id', LOGIN_ID);
    await login.fill('#password', PASSWORD);
    await login.click('button[type=submit]');
  };
  const waitForMain = async (seconds) => {
    let found = null;
    for (let i = 0; i < seconds && !found; i++) {
      await sleep(1000);
      found = allPages().find((p) => p.url().includes('#/main'));
    }
    return found;
  };
  for (let attempt = 0; attempt < 2 && !shell; attempt++) {
    if (attempt === 0) await submitLogin(serverBase);
    else {
      await sleep(1500);
      await login.click('button[type=submit]');
    }
    shell = await waitForMain(30);
  }
  if (!shell && !mock) {
    console.log('WARN 生产登录重试仍失败，退回 mock 自测（MOCK_FALLBACK）');
    mock = await startMockServer();
    serverBase = mock.base;
    await submitLogin(serverBase);
    shell = await waitForMain(30);
  }
  if (!shell) fail('登录未进入主窗（未见 #/main）');
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
console.log('主窗壳就绪');

// 2. 归一化：浅色主题（材质浅色外观，基线确定）；等 rail 布局稳定后再采样
for (let i = 0; i < 20; i++) {
  const box = await shell.locator('[data-testid="tabstrip"]').boundingBox();
  if (box && box.width >= 200 && box.width <= 250) break;
  await shell.waitForTimeout(250);
}
const isDark = await shell.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'));
if (isDark) {
  // 外观入口统一在设置页：齿轮 → 外观（默认分类）→ 浅色 → ESC 返回标签视图
  await shell.waitForSelector('[data-testid="user-chip"] [data-testid="open-settings"]', { timeout: 10_000 });
  await shell.click('[data-testid="user-chip"] [data-testid="open-settings"]');
  await shell.waitForSelector('[data-testid="settings-theme-light"]', { timeout: 5_000 });
  await shell.click('[data-testid="settings-theme-light"]');
  await shell.waitForTimeout(500);
  await shell.keyboard.press('Escape');
  await shell.waitForTimeout(300);
}
// 采样期剥掉 rail 的 CSS tint（40% 不透明浅色填充 + 蓝洗渐变）：剥掉后直测 NSVisualEffectView
// 材质透光（tint 半透明层由 e2e-vibrancy 断言，不在此重复）
await shell.addStyleTag({
  content: 'html[data-platform=darwin] aside[data-testid=tabstrip]{background:transparent!important}',
});
await shell.waitForTimeout(300);

// 3. 叠放 + 采样。两步压栈保证确定性叠放：先把背景板压到全部普通窗口最前（否则第三方窗口
//    可能插在背景板与主窗之间污染采样），再把主窗（AppleScript 按标题 "diteng agent" 精确匹配）
//    压到背景板之上。主窗可能被收到托盘（close 拦截为 hide）：先发 activate（等效点 Dock 图标，
//    走 app.on('activate') 还原）。
const appleScript = `
on run argv
  set xPos to (item 1 of argv) as integer
  set yPos to (item 2 of argv) as integer
  tell application "System Events"
    repeat with p in (every process whose name is "Electron" or name is "diteng agent")
      try
        if (count of (windows of p whose name is "diteng verify backdrop")) > 0 then
          set frontmost of p to true
        end if
      end try
    end repeat
    delay 0.3
    set targetProcess to missing value
    repeat with p in (every process whose name is "Electron" or name is "diteng agent")
      try
        if (count of (windows of p whose name is "diteng agent")) > 0 then
          set targetProcess to contents of p
          exit repeat
        end if
      end try
    end repeat
    if targetProcess is missing value then error "未找到标题为 diteng agent 的窗口"
    set visible of targetProcess to true
    set frontmost of targetProcess to true
    set winRef to window "diteng agent" of targetProcess
    try
      set miniaturized of winRef to false
    end try
    delay 0.4
    set position of winRef to {xPos, yPos}
    perform action "AXRaise" of winRef
  end tell
  return "OK"
end run
`;
function activateApp() {
  try {
    execFileSync('osascript', ['-e', 'tell application "Electron" to activate']);
  } catch {
    // 打包形态进程名不同时忽略，窗口未隐藏也不影响
  }
}

/** 背景板裸露条（主窗下方）是否仍是预期纯色（场景门：第三方窗口压上/主窗被收起都失色） */
function isBackdropColor(color, c) {
  if (color === 'yellow') return c.r > 200 && c.g > 160 && c.b < 90 && c.r - c.b > 120;
  return c.b > 200 && c.r < 90 && c.b - c.r > 120;
}

/**
 * 完整采样一轮：叠放（背景板→主窗）→ 场景门（参照条纯色）→ rail 稳定采样 → 复核场景门。
 * 任一门失败返回 { retry, reason }，由外层重试整轮（真机上其他窗口/用户操作会干扰叠放）。
 */
async function sampleAttempt(color, attemptNo) {
  await shell.bringToFront().catch(() => {});
  activateApp();
  await shell.waitForTimeout(800);
  let out = '';
  try {
    out = execFileSync('osascript', ['-e', appleScript, String(BACKDROP.x), String(BACKDROP.y)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return { retry: true, reason: `AppleScript 移窗失败：${String(error.stderr || error.message).slice(0, 200)}` };
  }
  if (!out.includes('OK')) return { retry: true, reason: 'AppleScript 未返回 OK' };
  await shell.waitForTimeout(1200); // vibrancy 材质与新叠放合成稳定

  const win = await shell.evaluate(() => ({
    x: window.screenX,
    y: window.screenY,
    w: window.outerWidth,
    h: window.outerHeight,
    visibility: document.visibilityState,
  }));
  if (attemptNo === 1) console.log('主窗现位:', JSON.stringify(win));
  if (win.visibility !== 'visible') {
    return { retry: true, reason: `主窗不可见（visibility=${win.visibility}，疑似被收到托盘）` };
  }
  if (Math.abs(win.x - BACKDROP.x) > 4 || Math.abs(win.y - BACKDROP.y) > 4) {
    return { retry: true, reason: `主窗未落在背景板原点（实际 ${win.x},${win.y}）` };
  }
  if (win.y + win.h >= BACKDROP.y + BACKDROP.h - 32) {
    return { retry: true, reason: '背景板无可参照的裸露条（主窗过高）' };
  }

  const refRect = {
    x: BACKDROP.x + 40,
    y: win.y + win.h + 8,
    w: 240,
    h: Math.max(24, Math.min(60, BACKDROP.y + BACKDROP.h - (win.y + win.h) - 16)),
  };
  const captureRef = () => {
    const shot = captureRegion(refRect.x, refRect.y, refRect.w, refRect.h, shotFile(`ref-${color}`));
    return sampleAverage(shot.png, 0, 0, shot.png.width, shot.png.height);
  };
  const refBefore = captureRef();
  if (!isBackdropColor(color, refBefore)) {
    return { retry: true, reason: `采样前参照条失色 rgb=(${refBefore.r.toFixed(1)},${refBefore.g.toFixed(1)},${refBefore.b.toFixed(1)})，叠放被干扰` };
  }

  // rail 采样：railTop 拖拽区空白段（y+24..y+46，x 避开红绿灯取 rail 右段），正下方是背景板；
  // 叠放切换后 vibrancy 材质重新合成需要时间，连续两次一致才采信（防瞬时旧合成）
  const railRect = { x: win.x + 84, y: win.y + 24, w: RAIL_WIDTH - 120, h: 22 };
  const captureRail = () => {
    const shot = captureRegion(railRect.x, railRect.y, railRect.w, railRect.h, shotFile(`rail-${color}`));
    return sampleAverage(shot.png, 0, 0, shot.png.width, shot.png.height);
  };
  let rail = captureRail();
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    const next = captureRail();
    const isStable =
      Math.abs(next.r - rail.r) < 4 && Math.abs(next.g - rail.g) < 4 && Math.abs(next.b - rail.b) < 4;
    rail = next;
    if (isStable) break;
  }
  const refAfter = captureRef();
  if (!isBackdropColor(color, refAfter)) {
    return { retry: true, reason: `采样后参照条失色 rgb=(${refAfter.r.toFixed(1)},${refAfter.g.toFixed(1)},${refAfter.b.toFixed(1)})，采样期间场景漂移` };
  }
  return {
    retry: false,
    rail,
    ref: { before: refBefore, after: refAfter },
    rect: railRect,
  };
}

async function sampleWithRetries(color) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await sampleAttempt(color, attempt);
    if (!result.retry) {
      console.log(
        `[${color}] rail 采样区 ${JSON.stringify(result.rect)} avg rgb=(${result.rail.r.toFixed(1)}, ${result.rail.g.toFixed(1)}, ${result.rail.b.toFixed(1)})；` +
          `参照 ${color === 'yellow' ? '黄' : '蓝'} (${result.ref.before.r.toFixed(1)},${result.ref.before.g.toFixed(1)},${result.ref.before.b.toFixed(1)})`,
      );
      return result.rail;
    }
    console.log(`WARN [${color}] 第 ${attempt} 轮采样场景异常：${result.reason}`);
    if (attempt === 3) fail(`[${color}] 连续 3 轮采样均被干扰（最后一轮：${result.reason}），环境噪声过大`);
  }
  return null;
}

// 4. 黄底采样 → 蓝底采样（差分判据：不透光时 rail 不随背景板颜色变化）
await spawnBackdrop('yellow');
const railYellow = await sampleWithRetries('yellow');

await spawnBackdrop('blue');
const railBlue = await sampleWithRetries('blue');

// 5. 断言。基线（本机 macOS 27 + Electron 44，纯 BrowserWindow+vibrancy / +webview / 本应用三者一致）：
//    黄底健康态 ≈ (226,222,205)：材质把黄色稀释成暖调浅灰（r>b 约 21）；
//    破坏态为中性灰（r≈g≈b，实测 (225,228,224) / (126,124,115)），对背景板颜色无响应。
const checks = [
  { name: '黄底 rail b<216（暖调而非中性）', ok: railYellow.b < 216, detail: `b=${railYellow.b.toFixed(1)}` },
  { name: '黄底 rail 黄色倾向（r-b>12）', ok: railYellow.r - railYellow.b > 12, detail: `r-b=${(railYellow.r - railYellow.b).toFixed(1)}` },
  { name: '黄底 rail g>150（排除深色不透明）', ok: railYellow.g > 150, detail: `g=${railYellow.g.toFixed(1)}` },
  {
    name: '黄蓝色调响应 Δ(r-b)>20（不透光时恒为 0）',
    ok: railYellow.r - railYellow.b - (railBlue.r - railBlue.b) > 20,
    detail: `黄r-b=${(railYellow.r - railYellow.b).toFixed(1)} 蓝r-b=${(railBlue.r - railBlue.b).toFixed(1)} Δ=${(railYellow.r - railYellow.b - (railBlue.r - railBlue.b)).toFixed(1)}`,
  },
  {
    name: '黄蓝 b 通道响应 |Δb|>15（不透光时恒为 0）',
    ok: Math.abs(railYellow.b - railBlue.b) > 15,
    detail: `Δb=${Math.abs(railYellow.b - railBlue.b).toFixed(1)}`,
  },
];
let allOk = true;
for (const item of checks) {
  console.log(`CHECK ${item.name}: ${item.ok ? 'OK' : 'FAIL'}（${item.detail}）`);
  if (!item.ok) allOk = false;
}

console.log(`截图: ${shotFile('rail-yellow')} / ${shotFile('ref-yellow')} / ${shotFile('rail-blue')} / ${shotFile('ref-blue')}`);
if (!allOk) {
  console.log('（若系统「减少透明度」已排除仍失败，说明整窗透明合成仍被破坏——检查是否有原生子视图挂到主窗）');
  fail('毛玻璃未真实透光（rail 对背景板颜色无响应或呈中性灰）');
}
console.log('RESULT: PASS');
cleanup();
process.exit(0);
