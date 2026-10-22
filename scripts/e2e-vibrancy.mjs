import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证：macOS 主窗 rail vibrancy 半透明 + 登录窗保持不透明。
 * 断言：
 *   1. 登录窗 body 计算样式背景不透明（不受 vibrancy 改动影响）
 *   2. 主窗（仅 macOS）html 标 data-platform=darwin，body/壳根背景透明
 *   3. rail 计算背景带透明度（半透明 tint）；Windows 下保持实心（alpha=1）
 *   4. 主进程日志 /tmp/diteng-electron.log 无未捕获报错
 * 前置：vite(5173) 与 electron(--remote-debugging-port=9223) 已运行，日志重定向到 /tmp/diteng-electron.log。
 * 用法：node scripts/e2e-vibrancy.mjs
 *   E2E_MOCK=1                      本地 mock 后端自测（不连生产，脚本内起临时 HTTP 服务）
 *   E2E_SERVER_BASE / E2E_LOGIN_ID / E2E_PASSWORD  覆盖目标环境
 * 生产登录遇瞬时失败自动重试一次，仍失败退回 mock 自测（输出注明 MOCK_FALLBACK）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const USE_MOCK = process.env.E2E_MOCK === '1';
const ELECTRON_LOG = '/tmp/diteng-electron.log';

/** 本地 mock 后端：登录/账套列表成功、MQTT 配置失败（仅告警）、其余路径给极简 ERP 页（同 e2e-layout） */
function startMockServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/center/UserServer/loginByPassword') {
      send(200, JSON.stringify({
        token: 'mock-token-vibrancy-e2e',
        forceRedirect: false,
        redirectUrl: '',
        corpNo: '250008',
        homeForm: 'FrmDefault',
        userId: 'mock-user',
        machineCode: 'mock-machine',
      }), 'application/json');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/getTokenInfo') {
      send(200, JSON.stringify({
        userId: 'mock-user',
        userCode: '01',
        userName: '毛玻璃自测用户',
        corpNo: '250008',
        options: {},
      }), 'application/json');
      return;
    }
    if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      send(200, JSON.stringify({
        state: 1,
        head: {},
        body: [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '毛玻璃自测账套', 'MOCK']],
      }), 'application/json');
      return;
    }
    if (url.pathname === '/favicon.ico') {
      send(404, '', 'text/plain');
      return;
    }
    if (url.pathname.endsWith('/FrmMessages.mqttConfig')) {
      send(200, JSON.stringify({ result: false, message: 'mock 未配置 MQTT' }), 'application/json');
      return;
    }
    send(200, '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ERP Mock 页</title></head><body>mock erp content page</body></html>', 'text/html; charset=utf-8');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * 计算样式颜色 → alpha：rgb()=1、rgba()/color(srgb … / a)=a、transparent=0、其余 null（未知格式按失败处理）。
 * color-mix 计算值 Chromium 序列化为 color(srgb r g b / a)。
 */
function parseAlpha(color) {
  if (typeof color !== 'string') return null;
  if (color === 'transparent') return 0;
  const rgba = color.match(/^rgba\([^)]+,\s*([\d.]+)\)$/);
  if (rgba) return Number(rgba[1]);
  if (/^rgb\(/.test(color)) return 1;
  const modern = color.match(/\/\s*([\d.]+)\)$/);
  if (modern) return Number(modern[1]);
  return null;
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');

function allPages() {
  return browser.contexts().flatMap((c) => c.pages());
}

function check(name, ok, detail = '') {
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  if (!ok) process.exitCode = 1;
}

let mock = USE_MOCK ? await startMockServer() : null;
let serverBase = mock ? mock.base : SERVER_BASE;
let usedMockFallback = false;

let shell = allPages().find((p) => p.url().includes('#/main'));

// 1. 登录窗断言（登录前）：body 背景必须不透明（登录窗不挂 Shell，无 data-platform 标记）
if (!shell) {
  const login = allPages().find((p) => p.url().includes('127.0.0.1:5173'));
  if (!login) {
    console.log('CHECK 登录窗: FAIL（未见 5173 登录页，请先启动 vite 与 electron --remote-debugging-port=9223）');
    process.exit(1);
  }
  const loginInfo = await login.evaluate(() => ({
    platform: document.documentElement.getAttribute('data-platform'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  check('登录窗无平台标记', loginInfo.platform === null, `platform=${loginInfo.platform}`);
  check('登录窗 body 不透明', parseAlpha(loginInfo.bodyBg) === 1, `backgroundColor=${loginInfo.bodyBg}`);
  await login.screenshot({ path: '/tmp/diteng-vibrancy-login.png' });

  // 2. 登录：生产失败重试一次，仍失败退回 mock（不中断冒烟）
  async function submitLogin(base) {
    await login.fill('#server-base', base);
    await login.fill('#login-id', LOGIN_ID);
    await login.fill('#password', PASSWORD);
    await login.click('button[type=submit]');
  }
  // 登录成功后登录窗即关闭，轮询不能用 page.waitForTimeout（页面销毁会抛 Target closed）
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitForMain(seconds) {
    let found = null;
    for (let i = 0; i < seconds && !found; i++) {
      await sleep(1000);
      found = allPages().find((p) => p.url().includes('#/main'));
    }
    return found;
  }
  let lastErrorText = '';
  for (let attempt = 0; attempt < 2 && !shell; attempt++) {
    if (attempt === 0) await submitLogin(serverBase);
    else {
      await sleep(1500);
      await login.click('button[type=submit]');
    }
    shell = await waitForMain(30);
    if (!shell) {
      lastErrorText = await login.evaluate(() => {
        const text = document.body.innerText || '';
        return text.split('\n').find((line) => /失败|错误|超时|500/.test(line)) ?? '';
      });
      console.log(`WARN 登录第 ${attempt + 1} 次未成功：${lastErrorText || '(无错误提示)'}`);
    }
  }
  if (!shell && !mock) {
    console.log(`WARN 生产登录重试仍失败（${lastErrorText}），退回 mock 自测（MOCK_FALLBACK）`);
    usedMockFallback = true;
    mock = await startMockServer();
    serverBase = mock.base;
    await submitLogin(serverBase);
    shell = await waitForMain(30);
  }
  check('登录进入主窗', Boolean(shell), shell ? '' : '未见 #/main');
  if (!shell) {
    console.log('当前 targets:', allPages().map((p) => p.url()));
    mock?.server.close();
    await browser.close();
    process.exit(1);
  }
}

await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

// 3. 主窗样式断言：平台分支（macOS 半透明 / Windows 实心）
const info = await shell.evaluate(() => {
  const rail = document.querySelector('[data-testid="tabstrip"]');
  const shellRoot = document.querySelector('[data-testid="shell-rail"]');
  const style = getComputedStyle(rail);
  return {
    isMac: /Macintosh/.test(navigator.userAgent),
    platform: document.documentElement.getAttribute('data-platform'),
    darkTheme: document.body.hasAttribute('data-ds-dark-theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    shellBg: shellRoot ? getComputedStyle(shellRoot).backgroundColor : '',
    railBg: style.backgroundColor,
    railBorderRightWidth: style.borderRightWidth,
    bodyBgLeft: getComputedStyle(document.querySelector('main')).backgroundColor,
  };
});

if (info.isMac) {
  check('主窗 html 标 data-platform=darwin', info.platform === 'darwin', `platform=${info.platform}`);
  check('主窗 body 透明', parseAlpha(info.bodyBg) === 0, `backgroundColor=${info.bodyBg}`);
  check('壳根透明', parseAlpha(info.shellBg) === 0, `backgroundColor=${info.shellBg}`);
  const railAlpha = parseAlpha(info.railBg);
  check(
    'rail 半透明 tint（0<alpha<1）',
    railAlpha !== null && railAlpha > 0 && railAlpha < 1,
    `backgroundColor=${info.railBg} alpha=${railAlpha}`,
  );
  check('rail 右缘分隔线移除（移到不透明内容区）', info.railBorderRightWidth === '0px', `borderRightWidth=${info.railBorderRightWidth}`);
  check('内容区铺实底', parseAlpha(info.bodyBgLeft) === 1, `backgroundColor=${info.bodyBgLeft}`);
} else {
  // Windows：无平台标记，rail 保持实心
  check('主窗无平台标记（Windows 实心）', info.platform === null, `platform=${info.platform}`);
  check('rail 保持实心', parseAlpha(info.railBg) === 1, `backgroundColor=${info.railBg}`);
}

// 4. 用户卡片浮层盖住 webview 内容区：卡片从 rail 底部行向上弹出、横向超出 rail 右缘，
//    矩形与内容区（webview 所在 viewport）相交（页内合成 webview 之上），DOM 断言 + 截图留档
{
  await shell.waitForSelector('[data-testid="user-chip"]:not([disabled])', { timeout: 10_000 });
  await shell.click('[data-testid="user-chip"]');
  await shell.waitForSelector('[data-testid="user-card"]', { timeout: 5_000 });
  const overlay = await shell.evaluate(() => {
    const rail = document.querySelector('[data-testid="tabstrip"]');
    const card = document.querySelector('[data-testid="user-card"]');
    const viewport = document.querySelector('main');
    if (!rail || !card || !viewport) return null;
    const railBox = rail.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const viewportBox = viewport.getBoundingClientRect();
    return {
      railRight: railBox.right,
      cardLeft: cardBox.left,
      cardRight: cardBox.right,
      cardTop: cardBox.top,
      cardBottom: cardBox.bottom,
      cardZ: getComputedStyle(card).zIndex,
      viewportLeft: viewportBox.left,
      viewportTop: viewportBox.top,
      viewportBottom: viewportBox.bottom,
    };
  });
  // 盖住内容区：卡片右缘深入内容区 40px+、左缘起于 rail 内、纵向落在内容区跨度内
  const coversContent =
    overlay !== null &&
    overlay.cardRight > overlay.railRight + 40 &&
    overlay.cardLeft < overlay.viewportLeft &&
    overlay.cardTop > overlay.viewportTop &&
    overlay.cardBottom < overlay.viewportBottom;
  check(
    '用户卡片浮层盖住 webview 内容区',
    coversContent && Number(overlay.cardZ) > 0,
    overlay
      ? `railRight=${overlay.railRight.toFixed(0)} card=[${overlay.cardLeft.toFixed(0)},${overlay.cardTop.toFixed(0)}→${overlay.cardRight.toFixed(0)},${overlay.cardBottom.toFixed(0)}] viewport=[${overlay.viewportLeft.toFixed(0)},${overlay.viewportTop.toFixed(0)}→,${overlay.viewportBottom.toFixed(0)}] z=${overlay.cardZ}`
      : '元素缺失',
  );
  await shell.screenshot({ path: '/tmp/diteng-vibrancy-card.png' });
  await shell.keyboard.press('Escape');
  await shell.waitForTimeout(300);
  check('卡片 ESC 收起', (await shell.locator('[data-testid="user-card"]').count()) === 0);
}

// 5. 截图存档（毛玻璃透桌面效果由人工肉眼把关）
await shell.screenshot({ path: '/tmp/diteng-vibrancy-rail.png' });
console.log('截图: /tmp/diteng-vibrancy-login.png /tmp/diteng-vibrancy-rail.png /tmp/diteng-vibrancy-card.png');

// 6. 主进程日志无未捕获报错
if (existsSync(ELECTRON_LOG)) {
  const lines = readFileSync(ELECTRON_LOG, 'utf8').split('\n');
  const fatal = lines.filter((line) => /Uncaught|TypeError|ReferenceError|SyntaxError/.test(line));
  check('主进程日志无未捕获报错', fatal.length === 0, fatal.slice(0, 3).join(' | ').slice(0, 200) || `${ELECTRON_LOG} 清洁`);
} else {
  console.log(`WARN 未找到 ${ELECTRON_LOG}，跳过日志断言`);
}

if (usedMockFallback) console.log('RESULT: MOCK_FALLBACK（生产登录失败，已退回 mock 自测）');
mock?.server.close();
await browser.close();
if (process.exitCode) {
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('全部通过');
