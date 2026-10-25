/** 构建环境验收：临时 userData，主进程与网页网络均用桩，不访问实际服务器。 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';

const { environment } = JSON.parse(readFileSync('dist/build-environment.json', 'utf8'));
const expectedServer = { main: 'https://m.cdcp.site', dev: 'http://rc.local.lan' }[environment];
assert.ok(expectedServer, '先运行 pnpm build 或 pnpm build:dev');
const directory = mkdtempSync(join(tmpdir(), 'diteng-environment-e2e-'));
const userData = join(directory, 'userData');
mkdirSync(userData);
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  configVersion: 2, serverBase: 'http://old.invalid', machineCode: 'environment-test-device',
  savedLoginId: 'old-account', savedPassword: 'must-not-be-used', autoLogin: true,
  savedAccounts: [
    { loginId: 'current-account', serverBase: expectedServer, passwordCipher: '', lastLoginAt: 1 },
    { loginId: 'old-account', serverBase: 'http://old.invalid', passwordCipher: '', lastLoginAt: 2 },
  ],
}));
const bootstrap = join(directory, 'bootstrap.cjs');
writeFileSync(bootstrap, `
const { app, session, dialog } = require('electron');
Object.defineProperty(app, 'isPackaged', { value: true });
globalThis.__requests = [];
globalThis.__confirmation = null;
globalThis.fetch = async (url, options) => {
  const target = new URL(url);
  globalThis.__requests.push(target.href);
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (target.pathname === '/services/SvrUserLogin.getToken') {
    const head = JSON.parse(new URLSearchParams(options.body).get('dataIn')).head;
    if (head.verifyCode === '??????') return json({ state: 1, message: '测试验证码', head: {} });
    return json({ state: 1, head: { token: 'test-token', corpNo: '100001', homeForm: 'FrmDefault' } });
  }
  if (target.pathname.endsWith('/getTokenInfo')) return json({ userId: 'test-user', userCode: '10000101', userName: '测试用户', corpNo: '100001' });
  if (target.pathname.endsWith('listMyLivingUsers')) return json({ state: 1, head: {}, body: [{ CorpNo_: '100001', Code_: '10000101', Name_: '测试账套' }] });
  if (target.pathname.endsWith('mqttConfig')) return json({ broker: '' });
  if (target.pathname.endsWith('getUnreadMessage')) return json({ state: 1, data: 0 });
  if (target.pathname === '/public/desktop-agent/notifications') return json({ items: [], nextCursor: null });
  if (target.pathname.endsWith('/logout')) return json({});
  throw new Error('未预期的测试请求：' + target.pathname);
};
dialog.showMessageBox = async (_owner, options) => {
  globalThis.__confirmation = options.detail;
  return { response: 1 };
};
app.whenReady().then(() => {
  for (const scheme of ['http', 'https']) session.defaultSession.protocol.handle(scheme, () =>
    new Response('<!doctype html><html><head><title>测试首页</title></head><body>测试页面</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
});
require(${JSON.stringify(resolve('dist/main/index.js'))});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DITENG_AGENT_DEV_URL;
let electron;
try {
  electron = await _electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], env, timeout: 25000 });
  electron.context().setDefaultTimeout(15000);
  const login = await electron.firstWindow();
  await login.locator('#login-id').waitFor();
  assert.equal(await login.locator('#server-base').count(), 0);
  assert.equal(await electron.evaluate(() => globalThis.__requests.length), 0, '跨环境不得自动登录');
  const config = await login.evaluate(() => window.diteng.setConfig({ serverBase: 'http://override.invalid' }));
  assert.equal(config.serverBase, expectedServer);
  assert.equal(config.savedPassword, '');
  assert.equal(config.machineCode, 'environment-test-device');
  await login.getByTestId('account-history-toggle').click();
  assert.equal(await login.getByTestId('account-history-item').count(), 1);
  await login.getByTestId('account-history-item').click();
  assert.equal(await login.locator('#login-id').inputValue(), 'current-account');
  const sms = await login.evaluate(() => window.diteng.loginSendCode({ serverBase: 'http://override.invalid', loginId: 'test-user', password: 'test-only' }));
  assert.equal(sms.ok, true);
  const mainPromise = electron.waitForEvent('window', { predicate: page => page !== login });
  await login.evaluate(() => { void window.diteng.login({ serverBase: 'http://override.invalid', loginId: 'test-user', password: 'test-only', rememberPassword: false }); });
  const main = await mainPromise;
  await main.getByTestId('shell-rail').waitFor();
  assert.equal((await main.evaluate(() => window.diteng.getSession())).serverBase, expectedServer);
  await main.getByTestId('app-menu-button').click();
  await main.getByTestId('open-settings').click();
  await main.getByTestId('settings-nav-connection').click();
  await main.waitForFunction(server => document.querySelector('[data-testid="settings-server-base"]')?.textContent === server, expectedServer);
  assert.equal(await main.getByTestId('settings-change-server').count(), 0);
  assert.equal(await main.locator('input').count(), 0);
  if (process.env.DITENG_QA_OUTPUT) {
    mkdirSync(process.env.DITENG_QA_OUTPUT, { recursive: true });
    await main.screenshot({ path: join(process.env.DITENG_QA_OUTPUT, `connection-${environment}.png`) });
  }
  await main.getByTestId('settings-nav-account').click();
  const nextLoginPromise = electron.waitForEvent('window', { predicate: page => page !== main });
  await main.getByTestId('settings-relogin').click();
  const nextLogin = await nextLoginPromise;
  await nextLogin.locator('#login-id').waitFor();
  assert.equal(await nextLogin.locator('#server-base').count(), 0);
  assert.equal((await nextLogin.evaluate(() => window.diteng.getConfig())).serverBase, expectedServer);
  const requests = await electron.evaluate(() => globalThis.__requests);
  assert.equal(requests.filter(url => url.endsWith('/services/SvrUserLogin.getToken')).length, 2);
  assert.ok(requests.every(url => new URL(url).origin === expectedServer));
  assert.ok(!(await electron.evaluate(() => globalThis.__confirmation)).includes('更换账号或服务器'));
  console.log(`PASS ${environment}: 固定地址、跨环境凭据隔离、历史选择、短信/登录 IPC、只读设置、重新登录`);
} finally {
  if (electron) await electron.close();
  rmSync(directory, { recursive: true, force: true });
}
