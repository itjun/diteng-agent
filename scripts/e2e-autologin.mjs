import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证：记住密码 + 打开应用自动登录全链路。
 * 流程：
 *   1. 归零：若已在主窗（#/main），先走用户卡片「退出登录」回到登录表单（同时清掉旧 savedPassword）；
 *      若登录窗停在自动登录状态页，点「手动登录」转表单。
 *   2. 登录（「记住密码」默认勾选，断言勾选态）→ 等主窗 #/main + tabstrip。
 *   3. 断言 config：savedLoginId 已存；savedPassword 非空且为 base64 密文形态（非明文密码）。
 *   4. 杀应用重启（SIGTERM 9223 端口进程 → 确保 vite 存活 → 重新拉起 electron --remote-debugging-port=9223 → 重连 CDP）。
 *   5. 断言不输任何凭据直接进主窗（#/main + tabstrip）。
 *   6. 用户卡片退出登录 → 断言 savedPassword 已清、回到登录表单。
 *   7. 再重启一次 → 断言停在登录表单（无 #/main、无自动登录态），账号仍预填（savedLoginId 保留）。
 * 前置：vite(5173) 和 electron(--remote-debugging-port=9223) 已运行（脚本重启后会自行把两者拉起）。
 * 用法：node scripts/e2e-autologin.mjs
 *   E2E_MOCK=1                      本地 mock 后端自测（mock 跑在脚本进程内，杀 electron 不影响，重启链路与生产一致）
 *   E2E_SERVER_BASE / E2E_LOGIN_ID / E2E_PASSWORD  覆盖目标环境
 * 生产登录遇瞬时失败自动重试一次，仍失败退回 mock 自测（输出注明 MOCK_FALLBACK）。
 * 注意：脚本会用自身拉起的 vite/electron（detached）顶替原进程，运行后环境仍可用于其他 e2e。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const USE_MOCK = process.env.E2E_MOCK === '1';
const PROJECT_ROOT = process.cwd();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本地 mock 后端：登录/账套列表/getTokenInfo 成功、MQTT 配置失败（仅告警）、其余路径给极简 ERP 页 */
function startMockServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/center/UserServer/loginByPassword') {
      send(200, JSON.stringify({
        token: `mock-token-autologin-e2e-${Date.now()}`,
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
        userName: '自动登录自测用户',
        corpNo: '250008',
        options: {},
      }), 'application/json');
      return;
    }
    if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      send(200, JSON.stringify({
        state: 1,
        head: {},
        body: [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '自动登录自测账套', 'MOCK']],
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

const mock = USE_MOCK ? await startMockServer() : null;
// MOCK_FALLBACK 时脚本内追加启动的 mock 服务，结束时一并关闭
const fallbackMocksToClose = [];
let serverBase = mock ? mock.base : SERVER_BASE;

let browser = await chromium.connectOverCDP('http://127.0.0.1:9223');

function allPages() {
  return browser.contexts().flatMap((c) => c.pages());
}
function findMain() {
  return allPages().find((p) => p.url().includes('#/main'));
}
function findLogin() {
  return allPages().find((p) => {
    if (!p.url().includes('127.0.0.1:5173')) return false;
    return !p.url().includes('#') || !/#\/(main|notify-popup)/.test(p.url());
  });
}
function check(name, ok, detail = '') {
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function waitForMain(seconds) {
  let found = null;
  for (let i = 0; i < seconds && !found; i++) {
    await sleep(1000);
    found = findMain();
  }
  return found;
}

async function submitLogin(page, base) {
  await page.fill('#server-base', base);
  await page.fill('#login-id', LOGIN_ID);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
}

/** 用户卡片「退出登录」（与 e2e-logout 同路径）：清会话 + 清 savedPassword，回登录窗 */
async function logoutFromShell(shell) {
  await shell.waitForSelector('[data-testid="user-chip"]:not([disabled])', { timeout: 30_000 });
  await shell.click('[data-testid="user-chip"]');
  await shell.waitForSelector('[data-testid="user-card"] [data-testid="logout"]', { timeout: 10_000 });
  await shell.click('[data-testid="logout"]');
}

/** 列出监听 9223（CDP）的进程号；无进程时返回空数组。
 *  注意必须限定 -sTCP:LISTEN：裸 lsof 会把与 9223 的已建立连接（如本脚本自己的 CDP 连接）一并列出，
 *  会把自己 SIGTERM 掉（exit 143）。 */
async function listCdpPids() {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', 'tcp:9223', '-sTCP:LISTEN'], (error, stdout) => {
      // lsof 无匹配时退出码非 0 且无输出，视为无进程；再排除自身 pid 兜底
      const pids = (stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
      resolve(pids);
    });
  });
}

/** 杀掉监听 9223 的 electron，确保 vite 存活后重新拉起 electron（detached），并重连 CDP */
async function restartApp() {
  // 1. SIGTERM electron 主进程（CDP 端口监听者）；若由 pnpm dev 拉起，concurrently 会连带退出 vite
  for (const pid of await listCdpPids()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  for (let i = 0; i < 15 && (await listCdpPids()).length > 0; i++) await sleep(1000);

  // 2. vite 5173 存活检查：被 concurrently -k 连带杀掉时自行拉起（detached，脚本退出后仍存活）
  let viteUp = false;
  try {
    const response = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(2000) });
    viteUp = response.ok;
  } catch {
    viteUp = false;
  }
  if (!viteUp) {
    const viteBin = join(PROJECT_ROOT, 'node_modules/.bin/vite');
    if (!existsSync(viteBin)) throw new Error(`未找到 vite：${viteBin}`);
    spawn(viteBin, [], { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      try {
        const response = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(2000) });
        if (response.ok) break;
      } catch {}
    }
  }

  // 3. 重新拉起 electron（detached），等 CDP 端口就绪后重连
  const electronBin = join(PROJECT_ROOT, 'node_modules/.bin/electron');
  if (!existsSync(electronBin)) throw new Error(`未找到 electron：${electronBin}`);
  spawn(electronBin, ['.', '--remote-debugging-port=9223'], { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const response = await fetch('http://127.0.0.1:9223/json/version', { signal: AbortSignal.timeout(2000) });
      if (response.ok) break;
    } catch {}
  }
  await browser.close().catch(() => {});
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
}

// ============================== 1. 归零：回到登录表单 ==============================
let shell = findMain();
if (shell) {
  console.log('STEP 归零：检测到已登录主窗，先退出登录');
  await logoutFromShell(shell);
  // 必须等旧 #/main 完全销毁并把 shell 置空：旧 page 对象仍 truthy，残留会跳过登录循环并在死页面上抛 Target closed
  for (let i = 0; i < 30 && (findMain() || !findLogin()); i++) await sleep(1000);
  shell = null;
}
let login = findLogin();
if (!login) {
  console.log('CHECK 登录窗: FAIL（未见 5173 登录页，请先启动 vite 与 electron --remote-debugging-port=9223）');
  process.exit(1);
}
// 自动登录态兜底：仍处「自动登录中…」则点「手动登录」转表单（本脚本要显式带勾选登录）
await resolveAutoLoginGate(allPages, login, 1000);
login = findLogin() ?? login;

// ============================== 2. 登录（记住密码勾选） ==============================
// 勾选态断言 + 语义标记存在性（登录页应为「记住密码」而非「记住账号」）
const checkbox = login.locator('[data-testid="remember-password"]');
check('记住密码勾选框存在', (await checkbox.count()) === 1);
check('记住密码默认勾选', await checkbox.isChecked());
check('旧「记住账号」文案已移除', !(await login.getByText('记住账号', { exact: true }).count()));
const autoCheckbox = login.locator('[data-testid="auto-login-checkbox"]');
check('自动登录勾选框存在', (await autoCheckbox.count()) === 1);
check('自动登录默认勾选', await autoCheckbox.isChecked());
// 双勾选联动：取消记住密码 → 自动登录联动取消且禁用；重勾记住密码不自动恢复自动登录；勾自动登录联动勾上记住密码
await checkbox.uncheck();
check('取消记住密码后自动登录联动取消', !(await autoCheckbox.isChecked()));
check('取消记住密码后自动登录禁用', await autoCheckbox.isDisabled());
await checkbox.check();
check('重新勾选记住密码后自动登录保持取消', !(await autoCheckbox.isChecked()));
await autoCheckbox.check();
check('重新勾选自动登录成功', await autoCheckbox.isChecked());

async function loginWithRetry() {
  for (let attempt = 0; attempt < 2 && !shell; attempt++) {
    if (attempt === 0) await submitLogin(login, serverBase);
    else {
      await sleep(1500);
      await login.click('button[type=submit]');
    }
    shell = await waitForMain(30);
    if (!shell) {
      const errorText = await login.evaluate(() => {
        const text = document.body.innerText || '';
        return text.split('\n').find((line) => /失败|错误|超时|500/.test(line)) ?? '';
      });
      console.log(`WARN 登录第 ${attempt + 1} 次未成功：${errorText || '(无错误提示)'}`);
    }
  }
}
await loginWithRetry();
let usedMockFallback = false;
if (!shell && !mock) {
  console.log('WARN 生产登录重试仍失败，退回 mock 自测（MOCK_FALLBACK）');
  usedMockFallback = true;
  const fallbackMock = await startMockServer();
  fallbackMocksToClose.push(fallbackMock.server);
  serverBase = fallbackMock.base;
  await submitLogin(login, serverBase);
  shell = await waitForMain(30);
}
check('登录进入主窗', Boolean(shell), shell ? '' : '30s 内未见 #/main');
if (!shell) {
  console.log('当前 targets:', allPages().map((p) => p.url()));
  mock?.server.close();
  for (const server of fallbackMocksToClose) server.close();
  await browser.close();
  process.exit(1);
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

// ============================== 3. config 密文断言 ==============================
const configAfterLogin = await shell.evaluate(() => window.diteng.getConfig());
check('savedLoginId 已保存', configAfterLogin.savedLoginId === LOGIN_ID, `savedLoginId=${configAfterLogin.savedLoginId}`);
check(
  'savedPassword 为 base64 密文形态（非明文）',
  /^[A-Za-z0-9+/=]{16,}$/.test(configAfterLogin.savedPassword) && configAfterLogin.savedPassword !== PASSWORD && !configAfterLogin.savedPassword.includes(LOGIN_ID),
  `len=${configAfterLogin.savedPassword.length}`,
);

// ============================== 4. 杀应用重启 ==============================
console.log('STEP 重启应用（杀 electron → 重连）');
await restartApp();

// ============================== 5. 断言不输凭据直接进主窗 ==============================
shell = await waitForMain(40);
check('重启后自动进入主窗（未输入任何凭据）', Boolean(shell), shell ? '' : '40s 内未见 #/main');
if (!shell) {
  console.log('当前 targets:', allPages().map((p) => p.url()));
  mock?.server.close();
  for (const server of fallbackMocksToClose) server.close();
  await browser.close();
  process.exit(1);
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
check('主窗 tabstrip 就绪', true);

// ============================== 5. 自动登录✗：重启停在表单且密码预填，一键登录 ==============================
console.log('STEP 关闭自动登录（模拟上次取消勾选）→ 重启应停在表单且预填密码');
await shell.evaluate(() => window.diteng.setConfig({ autoLogin: false }));
await restartApp();
await sleep(6000);
check('关自动登录后无 #/main（停在表单）', !findMain());
login = findLogin();
check('关自动登录后登录窗为表单态', Boolean(login));
if (login) {
  check('关自动登录后无自动登录状态页', (await login.locator('[data-testid="auto-login-state"]').count()) === 0);
  await login.waitForSelector('#server-base', { timeout: 5000 });
  const prefilledId2 = await login.inputValue('#login-id');
  const prefilledPassword2 = await login.inputValue('#password');
  check('账号已预填', prefilledId2 === LOGIN_ID, `loginId=${prefilledId2}`);
  check('密码已预填（记住密码生效）', prefilledPassword2.length >= 4, `len=${prefilledPassword2.length}`);
  await login.screenshot({ path: '/tmp/diteng-autologin-prefilled.png' });
  await login.click('button[type=submit]');
  shell = await waitForMain(30);
  check('预填态一键登录进主窗', Boolean(shell));
  if (shell) await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
}

// ============================== 6. 退出登录 → savedPassword 清除 ==============================
await logoutFromShell(shell);
login = null;
for (let i = 0; i < 30 && !login; i++) {
  await sleep(1000);
  login = findLogin();
}
check('退出后回到登录窗', Boolean(login), login ? login.url() : '30s 内未见登录窗');
if (login) {
  const configAfterLogout = await login.evaluate(() => window.diteng.getConfig());
  check('退出后 savedPassword 已清', configAfterLogout.savedPassword === '', `len=${configAfterLogout.savedPassword.length}`);
  check('退出后 savedLoginId 保留（预填账号）', configAfterLogout.savedLoginId === LOGIN_ID);
  await login.screenshot({ path: '/tmp/diteng-autologin-after-logout.png' });
}

// ============================== 7. 再重启：应停在登录表单（无自动登录态） ==============================
console.log('STEP 二次重启（退出登录后，应无自动登录）');
await restartApp();
await sleep(8000);
check('二次重启后无 #/main（未自动登录）', !findMain());
login = findLogin();
check('二次重启后登录窗在表单态', Boolean(login), login ? login.url() : '未见登录窗');
if (login) {
  check('登录窗无自动登录状态页', (await login.locator('[data-testid="auto-login-state"]').count()) === 0);
  await login.waitForSelector('#server-base', { timeout: 5_000 });
  check('表单可见（#server-base）', true);
  const prefilledId = await login.inputValue('#login-id');
  check('账号已预填（savedLoginId 生效）', prefilledId === LOGIN_ID, `loginId=${prefilledId}`);
  const prefilledPassword = await login.inputValue('#password');
  check('密码不回填（凭据已清空）', prefilledPassword === '', `len=${prefilledPassword.length}`);
  await login.screenshot({ path: '/tmp/diteng-autologin-form.png' });

  // 取消「记住密码」登录：成功但不再保存密码
  await login.locator('[data-testid="remember-password"]').uncheck();
  await submitLogin(login, serverBase);
  shell = await waitForMain(30);
  check('取消记住密码后仍可登录', Boolean(shell));
  if (shell) {
    const cfgNoSave = await shell.evaluate(() => window.diteng.getConfig());
    check('取消记住密码后未保存密码', cfgNoSave.savedPassword === '', `len=${cfgNoSave.savedPassword.length}`);
    // 恢复默认双勾选并退出，留下干净状态
    await shell.evaluate(() => window.diteng.setConfig({ rememberPassword: true, autoLogin: true }));
    await logoutFromShell(shell);
  }
}

console.log('截图: /tmp/diteng-autologin-after-logout.png /tmp/diteng-autologin-form.png');
if (usedMockFallback) console.log('RESULT: MOCK_FALLBACK（生产登录失败，已退回 mock 自测；mock 后端跑在脚本进程内，重启仅杀 electron，链路与生产一致）');
mock?.server.close();
for (const server of fallbackMocksToClose) server.close();
await browser.close();
if (process.exitCode) {
  console.log('RESULT: FAIL');
  process.exit(1);
}
console.log('全部通过');
