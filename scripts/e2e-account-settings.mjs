/** 本机账号管理：临时 userData + 隔离网络，验证实际 Electron IPC、表格与原生确认流程。运行前 pnpm build:app。 */
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
  configVersion: 3, serverBase: expectedServer, machineCode: 'account-settings-test-device',
  autoLogin: false, rememberPassword: true, autoCheckUpdates: false, theme: 'light', chromeColor: 'auto',
}));
const output = process.env.DITENG_QA_OUTPUT || directory;
mkdirSync(output, { recursive: true });
const bootstrap = join(directory, 'bootstrap.cjs');
writeFileSync(bootstrap, `
const { app, session, dialog } = require('electron');
Object.defineProperty(app, 'isPackaged', { value: true });
globalThis.__requests = [];
globalThis.__require = require;
globalThis.__confirmations = [];
globalThis.__confirmationResponse = 0;
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
  if (target.pathname.endsWith('getUnreadMessage')) return json({ state: 1, data: 7 });
  if (target.pathname === '/public/desktop-agent/notifications') return json({ items: [], nextCursor: null });
  if (target.pathname.endsWith('/logout')) return json({});
  throw new Error('未预期的测试请求：' + target.pathname);
};
dialog.showMessageBox = async (_owner, options) => {
  globalThis.__confirmations.push(options);
  if (globalThis.__confirmationResponse === 'wait') return new Promise(resolve => { globalThis.__resolveConfirmation = resolve; });
  if (globalThis.__confirmationResponse === 'error') throw new Error('测试对话框失败');
  return { response: globalThis.__confirmationResponse };
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
const errors = [];
const configModule = resolve('dist/main/config.js');
const sessionModule = resolve('dist/main/session-store.js');
const currentLogin = '13900005902';
const previousLogin = 'finance@example.test';
const currentPassword = 'Sample-login-2';
const start = Date.now();
async function openSettings(main) {
  await main.getByTestId('app-menu-button').click();
  await main.getByTestId('open-settings').click();
  await main.getByTestId('settings-saved-accounts').waitFor();
  await main.waitForFunction(() => document.querySelector('table[aria-busy="false"]'));
}
async function setConfirmation(response) {
  await electron.evaluate((_electron, response) => { globalThis.__confirmationResponse = response; }, response);
}
const disk = () => JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8'));
try {
  electron = await _electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], env, timeout: 25000 });
  electron.context().setDefaultTimeout(15000);
  const login = await electron.firstWindow();
  await login.locator('#login-id').waitFor();
  await electron.evaluate(({ safeStorage }, { configModule, expectedServer, previousLogin }) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('验收需要系统密码加密服务');
    globalThis.__require(configModule).persistSavedAccounts([
      { loginId: previousLogin, serverBase: expectedServer, passwordCipher: safeStorage.encryptString('Previous-sample-8').toString('base64'), lastLoginAt: Date.now() - 86400000 },
      { loginId: '13800001234', serverBase: expectedServer, passwordCipher: '', lastLoginAt: Date.now() - 172800000 },
      { loginId: 'legacy-account', serverBase: expectedServer, passwordCipher: '', lastLoginAt: 0 },
      { loginId: 'other-environment', serverBase: 'https://other.invalid', passwordCipher: '', lastLoginAt: 1 },
    ]);
  }, { configModule, expectedServer, previousLogin });
  await login.reload();
  await login.locator('#login-id').fill(currentLogin);
  await login.locator('#password').fill(currentPassword);
  const mainPromise = electron.waitForEvent('window', { predicate: page => page !== login });
  await login.locator('button[type="submit"]').click();
  let main = await mainPromise;
  main.on('pageerror', error => errors.push(error.message));
  await main.getByTestId('shell-rail').waitFor();
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).setSize(1706, 1073));
  await openSettings(main);
  const table = main.getByTestId('settings-saved-accounts');
  assert.equal(await table.locator('tbody tr').count(), 4);
  assert.match(await table.locator('tbody tr').first().innerText(), /13900005902.*使用中/s);
  assert.equal(await main.getByRole('button', { name: `删除账号 ${currentLogin}`, exact: true }).isDisabled(), true);
  assert.match(await table.innerText(), /S••••••2/);
  assert.match(await table.innerText(), /P••••••8/);
  assert.match(await table.innerText(), /未保存/);
  assert.match(await table.innerText(), /暂无记录/);
  assert.ok(!(await main.locator('body').innerText()).includes(currentPassword));
  const currentRecord = disk().savedAccounts.find(account => account.loginId === currentLogin);
  assert.ok(currentRecord.lastLoginAt >= start);
  assert.notEqual(currentRecord.passwordCipher, currentPassword);
  const currentKey = { loginId: currentLogin, serverBase: expectedServer };
  assert.equal((await main.evaluate(key => window.diteng.removeSavedAccount(key), currentKey)).ok, false);
  assert.equal((await main.evaluate(() => window.diteng.clearSavedAccounts())).ok, false);
  assert.equal((await main.evaluate(key => window.diteng.getSavedAccountPassword(key), currentKey)).ok, false);
  assert.equal(await electron.evaluate(() => globalThis.__confirmations.length), 0);
  console.log('PASS 实际登录、加密落盘、脱敏表格、当前账号保护与跨环境隔离');

  await main.screenshot({ path: join(output, 'account-settings-light.png') });
  await main.evaluate(() => window.diteng.setConfig({ theme: 'dark' }));
  await main.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  await main.screenshot({ path: join(output, 'account-settings-dark.png') });
  await main.evaluate(() => window.diteng.setConfig({ theme: 'light' }));
  await main.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).setSize(940, 640));
  assert.equal(await main.getByTestId('settings-content').evaluate(element => element.scrollWidth > element.clientWidth), false);
  await main.screenshot({ path: join(output, 'account-settings-narrow.png') });
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).setSize(1706, 1073));

  const removePrevious = main.getByRole('button', { name: `删除账号 ${previousLogin}`, exact: true });
  await removePrevious.click();
  await main.waitForFunction(() => !document.querySelector('button[aria-label="删除账号 finance@example.test"]').disabled);
  assert.equal(disk().savedAccounts.length, 5);
  const confirmation = await electron.evaluate(() => globalThis.__confirmations[0]);
  assert.ok(confirmation.message.includes(previousLogin));
  assert.deepEqual(confirmation.buttons, ['取消', '删除']);
  assert.equal(confirmation.defaultId, 0);
  assert.equal(confirmation.cancelId, 0);
  assert.ok(!JSON.stringify(confirmation).includes(currentPassword));
  console.log('PASS 删除弹窗明确账号，默认取消且取消不改变磁盘');

  await setConfirmation('wait');
  await removePrevious.evaluate(button => { button.click(); button.click(); });
  await main.waitForFunction(() => document.querySelector('button[aria-label="删除账号 finance@example.test"]').disabled);
  const blocked = await main.evaluate(key => window.diteng.removeSavedAccount(key), { loginId: 'legacy-account', serverBase: expectedServer });
  assert.equal(blocked.ok, false);
  assert.equal(await electron.evaluate(() => globalThis.__confirmations.length), 2);
  assert.equal(disk().savedAccounts.length, 5);
  await electron.evaluate(() => globalThis.__resolveConfirmation({ response: 1 }));
  await main.waitForFunction(() => !document.querySelector('button[aria-label="删除账号 finance@example.test"]'));
  assert.equal(disk().savedAccounts.some(account => account.loginId === previousLogin), false);
  assert.equal(disk().savedAccounts.some(account => account.loginId === 'other-environment'), true);
  console.log('PASS 慢确认和快速连点只弹一次，确认后仅删除目标记录');

  await setConfirmation('error');
  await main.getByRole('button', { name: '删除账号 legacy-account', exact: true }).click();
  await main.getByRole('alert').waitFor();
  assert.ok(disk().savedAccounts.some(account => account.loginId === 'legacy-account'));
  await setConfirmation('wait');
  await main.getByRole('button', { name: '删除账号 legacy-account', exact: true }).click();
  await electron.evaluate((_electron, sessionModule) => {
    const store = globalThis.__require(sessionModule);
    globalThis.__originalSession = store.getSession();
    store.saveSession({ ...store.getSession(), loginId: 'legacy-account' });
    globalThis.__resolveConfirmation({ response: 1 });
  }, sessionModule);
  await main.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('不能删除'));
  assert.ok(disk().savedAccounts.some(account => account.loginId === 'legacy-account'));
  await electron.evaluate((_electron, sessionModule) => globalThis.__require(sessionModule).saveSession(globalThis.__originalSession), sessionModule);
  await setConfirmation(1);
  await main.getByRole('button', { name: '删除账号 legacy-account', exact: true }).click();
  await main.waitForFunction(() => !document.querySelector('button[aria-label="删除账号 legacy-account"]'));
  console.log('PASS 失败后可重试，确认等待期间登录身份改变时重新校验');

  // 自动登录同样刷新上次使用时间，删除记录重启后不会恢复。
  const beforeRestart = disk().savedAccounts.find(account => account.loginId === currentLogin).lastLoginAt;
  await main.evaluate(() => window.diteng.setConfig({ autoLogin: true }));
  await electron.close();
  electron = await _electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], env, timeout: 25000 });
  electron.context().setDefaultTimeout(15000);
  main = electron.windows().find(page => page.url().includes('#/main'));
  if (!main) main = await electron.waitForEvent('window', { predicate: page => page.url().includes('#/main') });
  await main.getByTestId('shell-rail').waitFor();
  await openSettings(main);
  assert.ok(disk().savedAccounts.find(account => account.loginId === currentLogin).lastLoginAt > beforeRestart);
  assert.equal(await main.getByTestId('settings-saved-accounts').locator('tbody tr').count(), 2);
  assert.equal(await main.getByRole('button', { name: `删除账号 ${currentLogin}`, exact: true }).isDisabled(), true);
  console.log('PASS 重启自动登录刷新时间，已删除账号不再出现');

  // 返回登录页后，删除和清空也统一走原生二次确认。
  await setConfirmation(1);
  const loginPromise = electron.waitForEvent('window', { predicate: page => page !== main });
  await main.getByTestId('settings-relogin').click();
  const nextLogin = await loginPromise;
  await nextLogin.locator('#login-id').waitFor();
  await nextLogin.getByTestId('account-history-toggle').click();
  await setConfirmation(0);
  await nextLogin.getByTestId('account-history-remove').first().click();
  await nextLogin.waitForFunction(() => !document.querySelector('[data-testid="account-history-remove"]').disabled);
  assert.equal(disk().savedAccounts.length, 3);
  await nextLogin.getByTestId('account-history-clear').click();
  await nextLogin.waitForFunction(() => !document.querySelector('[data-testid="account-history-clear"]').disabled);
  assert.equal(disk().savedAccounts.length, 3);
  await setConfirmation(1);
  await nextLogin.getByTestId('account-history-clear').click();
  await nextLogin.getByTestId('account-history-list').waitFor({ state: 'hidden' });
  assert.deepEqual(disk().savedAccounts.map(account => account.loginId), ['other-environment']);
  assert.equal(disk().savedLoginId, '');
  assert.equal(disk().savedPassword, '');
  assert.deepEqual(errors, []);
  console.log('PASS 登录页删除/清空均需弹窗确认，取消保留，确认清空不影响其他环境');
} finally {
  if (electron) await electron.close();
  rmSync(directory, { recursive: true, force: true });
}
