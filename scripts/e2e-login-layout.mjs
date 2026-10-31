/** 登录页回归：隔离 userData、模拟网络及钥匙串，不访问真实账号或发送短信。 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';

const { environment } = JSON.parse(readFileSync('dist/build-environment.json', 'utf8'));
const serverBase = { main: 'https://m.cdcp.site', dev: 'http://rc.local.lan' }[environment];
assert.ok(serverBase, '请先构建应用');
const directory = mkdtempSync(join(tmpdir(), 'diteng-login-layout-'));
const output = process.env.DITENG_QA_OUTPUT || mkdtempSync(join(tmpdir(), 'diteng-login-shots-'));
mkdirSync(output, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DITENG_AGENT_DEV_URL;
const errors = [];
let electron;

async function launch(name, { isAutoLogin = false, result = 'error', delay = 0, workArea = null } = {}) {
  const userData = join(directory, name);
  mkdirSync(userData);
  const cipher = Buffer.from('test:layout-password').toString('base64');
  writeFileSync(join(userData, 'config.json'), JSON.stringify({
    configVersion: 3, serverBase, machineCode: 'layout-device', theme: 'light',
    rememberPassword: true, autoLogin: isAutoLogin,
    savedLoginId: isAutoLogin ? 'layout-account' : '', savedPassword: isAutoLogin ? cipher : '',
    savedAccounts: [{ loginId: 'layout-account', serverBase, passwordCipher: cipher, lastLoginAt: 1 }],
  }));
  const bootstrap = join(userData, 'bootstrap.cjs');
  writeFileSync(bootstrap, `
const { app, session, safeStorage, BrowserWindow, screen } = require('electron');
Object.defineProperty(app, 'isPackaged', { value: true });
// 仅测试进程替换钥匙串，避免系统授权弹窗；不验证生产加密实现。
safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = text => Buffer.from('test:' + text);
safeStorage.decryptString = bytes => bytes.toString().slice(5);
globalThis.__scenario = ${JSON.stringify({ result, delay })};
globalThis.__loginRequests = [];
globalThis.__holdLoginClose = false;
const close = BrowserWindow.prototype.close;
BrowserWindow.prototype.close = function () {
  if (globalThis.__holdLoginClose && !this.webContents.getURL().includes('#/main')) {
    globalThis.__releaseLogin = () => close.call(this);
    return;
  }
  return close.call(this);
};
globalThis.fetch = async (url, options) => {
  const target = new URL(url);
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (target.pathname === '/services/SvrUserLogin.getToken') {
    const head = JSON.parse(new URLSearchParams(options.body).get('dataIn')).head;
    const scenario = { ...globalThis.__scenario };
    globalThis.__loginRequests.push({ userCode: head.userCode, verifyCode: head.verifyCode });
    if (scenario.delay) await new Promise(resolve => setTimeout(resolve, scenario.delay));
    if (head.verifyCode === '??????') return json({ state: 1, message: '验证码已发送' });
    if (scenario.result === 'error') return json({ state: 0, head: { status: -1 }, message: '账号或密码错误，请重新输入后再试' });
    if (scenario.result === 'sms' && head.verifyCode !== '123456') return json({ state: 0, head: { status: -8 }, message: '设备未验证' });
    return json({ state: 1, head: { token: 'layout-test-token', corpNo: '100001', homeForm: 'FrmDefault' } });
  }
  if (target.pathname.endsWith('/getTokenInfo')) return json({ userId: 'layout-user', userCode: '10000101', userName: '布局测试', corpNo: '100001' });
  if (target.pathname.endsWith('listMyLivingUsers')) return json({ state: 1, body: [{ CorpNo_: '100001', Code_: '10000101', Name_: '测试账套' }] });
  if (target.pathname.endsWith('mqttConfig')) return json({ broker: '' });
  if (target.pathname.endsWith('getUnreadMessage')) return json({ state: 1, data: 0 });
  if (target.pathname === '/public/desktop-agent/notifications') return json({ items: [], nextCursor: null });
  throw new Error('未预期的测试请求：' + target.pathname);
};
app.whenReady().then(() => {
  const workArea = ${JSON.stringify(workArea)};
  if (workArea) {
    const display = screen.getPrimaryDisplay();
    screen.getPrimaryDisplay = () => ({ ...display, workArea });
  }
  for (const scheme of ['http', 'https']) session.defaultSession.protocol.handle(scheme, () =>
    new Response('<!doctype html><html><head><title>测试首页</title></head><body>本地模拟页面</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
});
const deviceInfo = require(${JSON.stringify(resolve('dist/main/device-info.js'))});
deviceInfo.getDeviceInfo = async clientId => ({
  hostname: '演示电脑', model: '测试设备', hardwareId: null, hardwareError: '模拟环境', clientId,
  system: 'macOS', architecture: 'arm64', cpu: '测试处理器', cpuCores: 8,
  memoryTotal: 17179869184, memoryFree: 8589934592, storage: null, storageError: '模拟环境',
  displays: [], networks: [], dnsServers: [], appVersion: 'test',
});
deviceInfo.getPublicIp = async () => ({ ok: true, data: '192.0.2.1' });
require(${JSON.stringify(resolve('dist/main/index.js'))});
`);
  electron = await _electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], env, timeout: 25000 });
  electron.context().setDefaultTimeout(10000);
  const page = await electron.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  return page;
}

async function shot(page, name) {
  assert.equal(await page.getByRole('heading', { name: 'diteng agent', exact: true }).count(), 0);
  assert.equal(await page.getByText('DESKTOP', { exact: true }).count(), 0);
  assert.equal(await page.getByTestId('login-close').count(), 0);
  assert.equal(await page.getByText(/设备码/).count(), 0);
  await page.screenshot({ path: join(output, `${name}.png`), scale: 'css' });
}

async function setSize(width, height) {
  await electron.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
}

async function checkLayout(page, isIllustrationVisible) {
  const layout = await page.evaluate(() => {
    const image = document.querySelector('main img');
    const page = document.querySelector('main').parentElement;
    const form = document.querySelector('form');
    const imageBox = image.getBoundingClientRect();
    const input = document.querySelector('#login-id').getBoundingClientRect();
    const card = document.querySelector('main').getBoundingClientRect();
    return {
      isOverflowing: page.scrollWidth > page.clientWidth,
      isIllustrationVisible: imageBox.width > 0,
      isLocalImage: image.src.startsWith('file:') && image.naturalWidth === 703 && image.naturalHeight === 611,
      isUndistorted: !imageBox.width || Math.abs(imageBox.width / imageBox.height - 703 / 611) < 0.01,
      isVerticallyScrollable: page.scrollHeight > page.clientHeight,
      margins: [card.x, card.y, innerWidth - card.right, innerHeight - card.bottom],
      isDesktopVisible: document.body.textContent.includes('DESKTOP'),
      isFormInteractive: getComputedStyle(form.parentElement.parentElement).webkitAppRegion === 'no-drag',
      isFieldInBounds: input.x >= 0 && input.right <= innerWidth,
    };
  });
  assert.equal(layout.isOverflowing, false);
  assert.equal(layout.isIllustrationVisible, isIllustrationVisible);
  assert.equal(layout.isLocalImage, true);
  assert.equal(layout.isUndistorted, true);
  if (!layout.isVerticallyScrollable) {
    assert.ok(layout.margins.every(value => Math.abs(value - layout.margins[0]) < 1), '卡片四边留白应等宽');
  }
  assert.equal(layout.isDesktopVisible, false);
  assert.equal(layout.isFormInteractive, true);
  assert.equal(layout.isFieldInBounds, true);
}

try {
  let login = await launch('manual');
  await login.locator('#login-id').waitFor();
  await login.locator('#login-id').fill('');
  await login.waitForFunction(() => document.querySelector('main img').complete);
  const bounds = await electron.evaluate(({ BrowserWindow, screen }) => ({ bounds: BrowserWindow.getAllWindows()[0].getBounds(), workArea: screen.getPrimaryDisplay().workArea }));
  assert.equal(bounds.bounds.width, Math.min(960, bounds.workArea.width));
  assert.equal(bounds.bounds.height, Math.min(640, bounds.workArea.height));
  assert.equal(bounds.bounds.x, Math.round(bounds.workArea.x + (bounds.workArea.width - bounds.bounds.width) / 2));
  assert.equal(bounds.bounds.y, Math.round(bounds.workArea.y + (bounds.workArea.height - bounds.bounds.height) / 2));
  await checkLayout(login, true);
  await shot(login, 'light');
  await setSize(1280, 720);
  await shot(login, 'web-comparison');
  await setSize(960, 640);
  await login.evaluate(() => window.diteng.setConfig({ theme: 'dark' }));
  await login.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  await shot(login, 'dark');
  await login.evaluate(() => window.diteng.setConfig({ theme: 'light' }));
  await login.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));

  await setSize(800, 640);
  await checkLayout(login, true);
  await setSize(799, 640);
  await checkLayout(login, false);
  await setSize(400, 480);
  await checkLayout(login, false);
  await login.locator('button[type=submit]').click();
  await login.getByRole('alert').waitFor();
  await login.getByTestId('auto-login-checkbox').scrollIntoViewIfNeeded();
  assert.equal(await login.getByTestId('auto-login-checkbox').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), true);
  await shot(login, 'small-scrolled');
  await setSize(960, 640);

  await login.getByTestId('account-history-toggle').click();
  await shot(login, 'history');
  await login.getByTestId('account-history-item').click();
  await login.waitForFunction(() => document.querySelector('#password').value === 'layout-password');
  assert.equal(await login.locator('#login-id').inputValue(), 'layout-account');
  await login.getByTestId('remember-password').uncheck();
  assert.equal(await login.getByTestId('auto-login-checkbox').isChecked(), false);
  assert.equal(await login.getByTestId('auto-login-checkbox').isDisabled(), true);
  await login.getByTestId('remember-password').check();
  await login.locator('#login-id').focus();
  await login.keyboard.press('Tab');
  assert.equal(await login.getByTestId('account-history-toggle').evaluate(element => element === document.activeElement), true);
  await login.keyboard.press('Tab');
  assert.equal(await login.locator('#password').evaluate(element => element === document.activeElement), true);

  await electron.evaluate(() => { globalThis.__scenario = { result: 'error', delay: 600 }; });
  await login.locator('button[type=submit]').click();
  await login.locator('#password').press('Enter');
  await login.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await login.getByRole('alert').filter({ hasText: '账号或密码错误' }).waitFor();
  assert.equal(await electron.evaluate(() => globalThis.__loginRequests.length), 1, '慢请求期间多入口只能提交一次');
  await shot(login, 'error');

  await electron.evaluate(() => { globalThis.__scenario = { result: 'sms', delay: 0 }; });
  await login.locator('#password').press('Enter');
  await login.locator('#sms-code').waitFor();
  await login.getByRole('button', { name: '发送验证码', exact: true }).click();
  await login.getByText('验证码已发送，请查收短信').waitFor();
  assert.equal(await login.getByRole('button', { name: /分\d+秒/ }).isDisabled(), true);
  await shot(login, 'sms');
  await login.getByRole('button', { name: '重新登录', exact: true }).click();
  await login.locator('#password').waitFor();
  await login.locator('#password').press('Enter');
  await login.locator('#sms-code').waitFor();
  await electron.evaluate(() => { globalThis.__holdLoginClose = true; });
  await login.locator('#sms-code').fill('123456');
  const mainPromise = electron.waitForEvent('window', { predicate: page => page !== login });
  await login.locator('#sms-code').press('Enter');
  const main = await mainPromise;
  await login.getByRole('status').filter({ hasText: '登录成功' }).waitFor();
  await shot(login, 'success');
  await main.getByTestId('shell-rail').waitFor();
  await electron.evaluate(() => { globalThis.__holdLoginClose = false; globalThis.__releaseLogin(); });
  // 版本更新与本机信息合并为设置页「关于应用」分类：经功能菜单直达
  await main.getByTestId('app-menu-button').click();
  await main.getByTestId('menu-open-about-app').click();
  await main.getByTestId('device-client-id').waitFor();
  assert.equal(await main.getByTestId('device-client-id').textContent(), 'layout-device');
  assert.equal(await main.getByText('设备码（CLIENTID）', { exact: true }).count(), 1);
  assert.equal(await main.getByRole('button', { name: '复制设备码（CLIENTID）', exact: true }).isEnabled(), true);
  await main.screenshot({ path: join(output, 'device-info.png'), scale: 'css' });
  await electron.close();
  electron = null;

  login = await launch('auto-cancel', { isAutoLogin: true, delay: 1500 });
  await login.getByTestId('auto-login-state').waitFor();
  assert.equal(await login.locator('form').count(), 0);
  await shot(login, 'auto-login');
  await login.getByTestId('auto-login-cancel').click();
  await login.locator('#login-id').waitFor();
  await login.waitForTimeout(1600);
  assert.equal(await login.getByRole('alert').count(), 0, '取消后迟到失败不覆盖手动表单');
  assert.equal(await electron.evaluate(() => globalThis.__loginRequests.length), 1);
  await electron.close();
  electron = null;

  login = await launch('auto-failure', { isAutoLogin: true, delay: 300 });
  await login.getByRole('alert').filter({ hasText: '自动登录失败' }).waitFor();
  await login.locator('#login-id').waitFor();
  await electron.close();
  electron = null;

  login = await launch('auto-success', { isAutoLogin: true, result: 'success', delay: 300 });
  const autoMain = await electron.waitForEvent('window', { predicate: page => page !== login });
  await autoMain.getByTestId('shell-rail').waitFor();
  assert.equal(await electron.evaluate(() => globalThis.__loginRequests.length), 1);
  await electron.close();
  electron = null;

  login = await launch('small-display', { workArea: { x: 20, y: 40, width: 720, height: 480 } });
  await login.locator('#login-id').waitFor();
  assert.deepEqual(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), { x: 20, y: 40, width: 720, height: 480 });
  await checkLayout(login, false);
  await shot(login, 'small-display');
  assert.deepEqual(errors, []);
  console.log('PASS 登录窗口尺寸与居中、四边等距、无品牌/关闭按钮/设备码、离线插画、深浅色、小屏滚动、历史账号、键盘、防重、短信验证、自动登录、关于本机设备码');
  console.log(`截图：${output}`);
  // 可选原生交互检查：保留一个独立模拟窗口，关闭后自动清理测试进程和数据。
  if (process.env.DITENG_QA_PREVIEW === '1') {
    await electron.close();
    electron = null;
    login = await launch('preview');
    await login.locator('#login-id').waitFor();
    await login.locator('#login-id').fill('');
    console.log('PREVIEW_READY：可检查原生拖拽，通过系统退出应用结束预览');
    await electron.waitForEvent('close', { timeout: 0 });
    electron = null;
  }
} finally {
  if (electron) await electron.close();
  rmSync(directory, { recursive: true, force: true });
}
