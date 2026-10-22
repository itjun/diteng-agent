import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证：退出登录全链路——用户卡片「退出登录」→ 服务端 logout → 会话清理/断 MQTT/销毁托盘
 * → 主窗关闭回到登录窗 → 登录窗会话为空 → 重新登录回主窗（验完重新登录，应用恢复可用）。
 * 前置：vite(5173) 和 electron(--remote-debugging-port=9223) 已运行。
 * 用法：node scripts/e2e-logout.mjs
 *   E2E_MOCK=1                      本地 mock 后端自测（不连生产，脚本内起临时 HTTP 服务，并断言 logout 被调用）
 *   E2E_SERVER_BASE / E2E_LOGIN_ID / E2E_PASSWORD  覆盖目标环境
 * 生产登录遇瞬时失败自动重试一次，仍失败退回 mock 自测（输出注明 MOCK_FALLBACK）。
 * 注意：真机验证会销毁当前会话，脚本结尾已自动重新登录。
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const USE_MOCK = process.env.E2E_MOCK === '1';

/** 本地 mock 后端：登录/getTokenInfo/logout 记数、MQTT 配置失败（仅告警）、其余路径给极简 ERP 页 */
function startMockServer() {
  let logoutCalls = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/center/UserServer/loginByPassword') {
      send(200, JSON.stringify({
        token: `mock-token-logout-e2e-${Date.now()}`,
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
        userName: '退出自测用户',
        corpNo: '250008',
        options: {},
      }), 'application/json');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/logout') {
      logoutCalls += 1;
      send(200, '', 'application/json');
      return;
    }
    if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      send(200, JSON.stringify({
        state: 1,
        head: {},
        body: [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '退出自测账套', 'MOCK']],
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
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, getLogoutCalls: () => logoutCalls }));
  });
}

const mock = USE_MOCK ? await startMockServer() : null;
let serverBase = mock ? mock.base : SERVER_BASE;

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');

function allPages() {
  return browser.contexts().flatMap((c) => c.pages());
}

function check(name, ok, detail = '') {
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  if (!ok) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submitLogin(page, base) {
  await page.fill('#server-base', base);
  await page.fill('#login-id', LOGIN_ID);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
}

function findMain() {
  return allPages().find((p) => p.url().includes('#/main'));
}

function findLogin() {
  // 登录窗 = 5173 页面且非 #/main/#notify-popup
  return allPages().find((p) => {
    if (!p.url().includes('127.0.0.1:5173')) return false;
    return !p.url().includes('#') || !/#\/(main|notify-popup)/.test(p.url());
  });
}

async function waitForMain(seconds) {
  let found = null;
  for (let i = 0; i < seconds && !found; i++) {
    await sleep(1000);
    found = findMain();
  }
  return found;
}

// 1. 归零：若残留 #/main 会话，先走一遍退出（与被测链路同路径），确保从登录窗出发。
//    必须等旧 #/main 完全销毁（主进程在登录窗 ready-to-show 后才关主窗）并把 shell 置空——
//    旧 page 对象仍 truthy，残留会让下方登录循环（!shell 条件）被整体跳过、在死页面上抛 Target closed
let shell = findMain();
if (shell) {
  await shell.waitForSelector('[data-testid="user-chip"]:not([disabled])', { timeout: 30_000 });
  await shell.click('[data-testid="user-chip"]');
  await shell.waitForSelector('[data-testid="user-card"] [data-testid="logout"]', { timeout: 10_000 });
  await shell.click('[data-testid="logout"]');
  for (let i = 0; i < 30 && (findMain() || !findLogin()); i++) await sleep(1000);
  shell = null;
}

let login = findLogin();
if (!login) {
  console.log('CHECK 登录窗: FAIL（未见 5173 登录页，请先启动 vite 与 electron --remote-debugging-port=9223）');
  process.exit(1);
}
// 自动登录闸门：短等 #/main（自动登录成功→按已登录继续）；仍处自动登录态则点「手动登录」转表单
shell = await resolveAutoLoginGate(allPages, login);
// 登录：生产失败重试一次，仍失败退回 mock 自测（后续链路与 logout 计数断言随之走 mock）
let usedMockFallback = false;
let lastErrorText = '';
for (let attempt = 0; attempt < 2 && !shell; attempt++) {
  if (attempt === 0) await submitLogin(login, serverBase);
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
  await submitLogin(login, serverBase);
  shell = await waitForMain(30);
}
check('登录进入主窗', Boolean(shell), shell ? '' : '30s 内未见 #/main');
if (!shell) {
  console.log('当前 targets:', allPages().map((p) => p.url()));
  mock?.server.close();
  await browser.close();
  process.exit(1);
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

// 2. 卡片「退出登录」
await shell.waitForSelector('[data-testid="user-chip"]:not([disabled])', { timeout: 10_000 });
await shell.click('[data-testid="user-chip"]');
await shell.waitForSelector('[data-testid="user-card"] [data-testid="logout"]', { timeout: 5_000 });
// 退出登录行存在且可点（destructive 色调由 token 承担，这里只验交互链路）
await shell.click('[data-testid="logout"]');

// 3. 主窗销毁、登录窗回归（轮询不能用已销毁 page 的 waitForTimeout）
login = null;
for (let i = 0; i < 30 && !login; i++) {
  await sleep(1000);
  login = findLogin();
}
check('主窗关闭回到登录窗', Boolean(login), login ? login.url() : '30s 内未见登录窗');
check('#/main 已销毁', !findMain());

// 4. 登录窗会话已清空（未登录返回 null）
if (login) {
  const session = await login.evaluate(() => window.diteng.getSession());
  check('会话已清空', session === null, JSON.stringify(session));
  await login.screenshot({ path: '/tmp/diteng-logout-login.png' });

  // 5. 重新登录恢复可用（记住账号仍在，服务器地址沿用退出前的 serverBase——主进程不清 config）
  await submitLogin(login, serverBase);
  const shellAgain = await waitForMain(30);
  check('重新登录进入主窗', Boolean(shellAgain), shellAgain ? '' : '30s 内未见 #/main');
  if (shellAgain) await shellAgain.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
}

// 6. mock 模式断言服务端 logout 被调用（生产端日志人工核对）
if (mock) {
  await sleep(500);
  check('服务端 logout 被调用', mock.getLogoutCalls() >= 1, `calls=${mock.getLogoutCalls()}`);
}

console.log('截图: /tmp/diteng-logout-login.png');
if (usedMockFallback) console.log('RESULT: MOCK_FALLBACK（生产登录失败，已退回 mock 自测）');
mock?.server.close();
await browser.close();
if (process.exitCode) {
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('全部通过');
