/** 核心外壳验收：临时 userData + 本地 HTTP，不读取或更改真实登录资料。运行前 pnpm build。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

const directory = mkdtempSync(join(tmpdir(), 'diteng-shell-core-'));
const output = process.env.DITENG_QA_OUTPUT || directory;
mkdirSync(output, { recursive: true });
let isUnreadFailure = false;
let isOffline = false;
let unread = 7;
let requests = 0;
let logoutRequests = 0;
const backend = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  for await (const chunk of req) body += chunk;
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (isOffline) { res.destroy(); return; }
  if (url.pathname === '/services/SvrUserLogin.getToken') return json({ state: 1, head: { status: 1, token: 'local-test-token', corpNo: '100001', homeForm: 'FrmDefault', startPage: '100001/FrmDefault' }, body: [[]] });
  if (url.pathname === '/center/UserServer/getTokenInfo') return json({ userId: 'local-user', userCode: '10000102', userName: '测试用户', corpNo: '100001' });
  if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') return json({ state: 1, head: {}, body: [{ CorpNo_: '100001', Code_: '10000102', Name_: '测试企业', ShortName_: '测试企业' }] });
  if (url.pathname.endsWith('FrmMessages.mqttConfig')) return json({ broker: '' });
  if (url.pathname.endsWith('ImServer.getUnreadMessage')) { requests++; await new Promise(resolve => setTimeout(resolve, 120)); return json(isUnreadFailure ? { message: '测试同步失败' } : { state: 1, data: unread }, isUnreadFailure ? 503 : 200); }
  if (url.pathname === '/public/desktop-agent/notifications') return json({ items: [], nextCursor: null });
  if (url.pathname === '/center/UserServer/logout') { logoutRequests++; return json({}); }
  if (url.pathname === '/100001/FrmMyMessage') {
    res.writeHead(302, { location: `/client/100001/FrmMyMessage${url.search}` }); res.end(); return;
  }
  const title = url.pathname.endsWith('TFrmChooseAccount') ? '选择账套' : url.pathname.endsWith('FrmMyMessage') ? '消息中心' : url.pathname.endsWith('/chat') ? 'AI 助手' : 'ERP 首页';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body style="font:16px sans-serif;padding:32px;background:#fff;color:#222"><h1>${title}</h1><p>这是本地验收环境，不连接真实业务服务器。</p><input aria-label="未保存的表单" value="需要保留的内容"></body></html>`);
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${backend.address().port}`;
writeFileSync(join(directory, 'config.json'), JSON.stringify({ configVersion: 2, serverBase: base, aiBase: base, machineCode: 'local-test-device', autoLogin: false, rememberPassword: false, chromeColor: 'pink', theme: 'light' }));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DITENG_AGENT_DEV_URL;
const executablePath = process.env.DITENG_E2E_EXECUTABLE;
const reservedPort = createServer();
await new Promise(resolve => reservedPort.listen(0, '127.0.0.1', resolve));
const vitePort = reservedPort.address().port;
await new Promise(resolve => reservedPort.close(resolve));
const vite = executablePath ? null : await createViteServer({ server: { host: '127.0.0.1', port: vitePort, strictPort: true } });
if (vite) { await vite.listen(); env.DITENG_AGENT_DEV_URL = `http://127.0.0.1:${vite.httpServer.address().port}`; }
let electron;
const openNewTab = () => electron.evaluate(({ BrowserWindow }) => {
  const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main'));
  const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
  owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers });
  owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers });
});
const waitFor = async (test, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('等待条件超时');
};
try {
  electron = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${directory}`], cwd: resolve('.'), env, timeout: 25000 });
  await electron.evaluate(({ dialog, Notification }) => {
    globalThis.__confirmationResponse = 0;
    globalThis.__confirmationCount = 0;
    globalThis.__confirmationResolvers = [];
    globalThis.__testNotificationCount = 0;
    dialog.showMessageBox = async () => {
      globalThis.__confirmationCount++;
      if (globalThis.__confirmationResponse === 'wait') return new Promise(resolve => globalThis.__confirmationResolvers.push(resolve));
      return { response: globalThis.__confirmationResponse };
    };
    Notification.prototype.show = function () { globalThis.__testNotificationCount++; };
  });
  const login = await electron.firstWindow();
  await login.waitForFunction(() => Boolean(window.diteng));
  const loginEntryUrl = login.url();
  await login.evaluate(base => { void window.diteng.login({ serverBase: base, loginId: 'test-login', password: 'local-only', rememberPassword: false }); }, base);
  let main;
  await waitFor(() => { main = electron.windows().find(page => page.url().includes('#/main')); return Boolean(main); });
  await main.getByTestId('shell-rail').waitFor();
  await electron.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).setSize(1360, 900); });
  await main.getByTestId('unread-badge').waitFor();
  assert.equal(await main.getByTestId('unread-badge').innerText(), '7');
  assert.equal(await main.getByTestId('user-chip').count(), 0);
  assert.equal(await main.getByTestId('sidebar-footer').count(), 0);
  assert.equal(await main.getByTestId('app-menu-button').isVisible(), true);
  assert.equal(await main.getByTestId('switch-account').count(), 0);
  assert.equal(await main.getByTestId('new-tab').count(), 0);
  const openMenuItem = async (testId) => {
    await main.getByTestId('app-menu-button').click();
    await main.getByTestId(testId).click();
  };
  await main.getByTestId('app-menu-button').focus();
  await main.keyboard.press('ArrowDown');
  assert.equal(await main.getByTestId('new-tab').evaluate(element => element === document.activeElement), true);
  await main.keyboard.press('End');
  assert.equal(await main.getByTestId('open-settings').evaluate(element => element === document.activeElement), true);
  await main.keyboard.press('ArrowDown');
  assert.equal(await main.getByTestId('new-tab').evaluate(element => element === document.activeElement), true);
  await main.keyboard.press('Escape');
  assert.equal(await main.getByTestId('app-menu').count(), 0);
  assert.equal(await main.getByTestId('app-menu-button').evaluate(element => element === document.activeElement), true);
  await main.getByTestId('app-menu-button').click();
  await main.screenshot({ path: join(output, '00-app-menu.png') });
  await main.keyboard.press('Escape');
  for (const id of ['url-bar-copy', 'feedback-button']) {
    assert.equal(await main.locator(`[data-testid="browser-toolbar"] > [role="group"][aria-label="页面操作"] [data-testid="${id}"]`).isVisible(), true);
  }
  await main.evaluate(() => { navigator.clipboard.writeText = async (value) => { window.__copiedPageUrl = value; }; });
  await main.getByTestId('url-bar-copy').click();
  await waitFor(async () => await main.getByTestId('url-bar-copy').getAttribute('aria-label') === '已复制');
  const copiedUrl = await main.evaluate(() => window.__copiedPageUrl);
  assert.equal(new URL(copiedUrl).searchParams.has('sid'), false);
  assert.equal(new URL(copiedUrl).pathname, '/100001/FrmDefault');
  await main.mouse.click(650, 450);
  assert.equal(await main.getByTestId('app-menu').count(), 0);
  const tabCount = (await main.evaluate(() => window.__ditengTabsList())).tabs.length;
  await openMenuItem('new-tab');
  await waitFor(async () => (await main.evaluate(() => window.__ditengTabsList())).tabs.length === tabCount + 1);
  assert.equal(await main.getByTestId('app-menu').count(), 0);
  await main.getByTestId('feedback-button').click();
  await main.getByTestId('feedback-editor').waitFor();
  assert.equal(await main.getByTestId('app-menu').count(), 0);
  await main.getByTestId('feedback-cancel').click();
  console.log('PASS 三点菜单、键盘导航与焦点恢复、点击网页区域收起、复制安全链接、新标签与截图反馈');
  await openMenuItem('open-settings');
  await main.getByTestId('settings-nav-account').click();
  assert.match(await main.getByTestId('settings-login-id').innerText(), /test-login/);
  assert.equal(await main.getByTestId('settings-user-code').innerText(), '10000102');
  assert.equal((await main.evaluate(() => window.diteng.getSession())).loginId, 'test-login');
  await main.screenshot({ path: join(output, '01-account.png') });
  console.log('PASS 登录身份、实际登录账号、账套与业务账号独立展示，未读数常驻');

  const guests = () => electron.evaluate(({ webContents }) => webContents.getAllWebContents().filter(item => item.getType() === 'webview').map(item => ({ id: item.id, url: item.getURL() })));
  await main.getByTestId('settings-switch-account').click();
  await waitFor(async () => (await guests()).some(item => item.url && new URL(item.url).pathname.endsWith('TFrmChooseAccount')));
  const countWithAccounts = (await guests()).length;
  await openMenuItem('open-settings');
  await main.getByTestId('settings-nav-account').click();
  await main.evaluate(() => { const button = document.querySelector('[data-testid="settings-switch-account"]'); button.click(); button.click(); });
  await main.waitForTimeout(200);
  assert.equal((await guests()).length, countWithAccounts);
  const webSnapshot = await guests();
  for (const [entry, suffix] of [['open-messages', 'FrmMyMessage'], ['open-ai', '/chat']]) {
    const count = (await guests()).length;
    await main.evaluate(id => { const button = document.querySelector(`[data-testid="${id}"]`); button.click(); button.click(); }, entry);
    await waitFor(async () => (await guests()).some(item => new URL(item.url).pathname.endsWith(suffix)));
    assert.equal((await guests()).length, count + 1);
    const opened = (await guests()).find(item => new URL(item.url).pathname.endsWith(suffix));
    const url = new URL(opened.url);
    assert.equal(url.searchParams.get('sid'), 'local-test-token');
    assert.equal(url.searchParams.get('CLIENTID'), 'local-test-device');
    assert.equal(url.searchParams.get('device'), 'pc');
    await electron.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id).executeJavaScript('document.querySelector("input").value = "保留聊天草稿"');
    }, opened.id);
    await main.getByTestId(entry).click();
    await waitFor(async () => await main.getByTestId(entry).getAttribute('aria-pressed') === 'true');
    assert.equal((await guests()).length, count + 1);
    assert.equal(await electron.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.querySelector("input").value'), opened.id), '保留聊天草稿');
    assert.equal(await main.getByTestId('nav-reload').isEnabled(), true);
  }
  assert.deepEqual((await guests()).filter(item => webSnapshot.some(original => original.id === item.id)), webSnapshot);
  await openMenuItem('open-settings');
  await main.getByTestId('settings-nav-notifications').click();
  const countBeforeMessages = (await guests()).length;
  await main.getByRole('button', { name: '查看消息', exact: true }).click();
  await waitFor(async () => await main.getByTestId('open-messages').getAttribute('aria-pressed') === 'true');
  assert.equal((await guests()).length, countBeforeMessages);
  console.log('PASS 消息重定向与 AI Chat 携带当前会话、连点和设置入口复用标签、保留网页草稿');

  await openMenuItem('open-settings');
  await main.getByTestId('settings-nav-notifications').click();
  await main.getByRole('switch', { name: '系统通知', exact: true }).waitFor();
  assert.match(await main.getByTestId('notification-unread').innerText(), /7 条未读/);
  await electron.evaluate(({ BrowserWindow }) => {
    globalThis.__saveCount = 0;
    const contents = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args) => { if (channel === 'theme:changed') globalThis.__saveCount++; return send(channel, ...args); };
  });
  await main.evaluate(() => {
    const target = document.querySelector('[role="switch"][aria-label="系统通知"]');
    target.click(); target.click();
  });
  await waitFor(async () => (await main.evaluate(() => window.diteng.getConfig())).systemNotifications === false);
  assert.equal(await electron.evaluate(() => globalThis.__saveCount), 1);
  await main.getByTestId('settings-nav-account').click();
  await main.getByTestId('settings-nav-notifications').click();
  assert.equal(await main.getByRole('switch', { name: '系统通知', exact: true }).getAttribute('aria-checked'), 'false');
  unread = 9;
  await main.getByTestId('refresh-messages').click();
  await main.getByRole('status').filter({ hasText: '未读数已同步' }).waitFor();
  assert.match(await main.getByTestId('notification-unread').innerText(), /9 条未读/);
  await main.getByTestId('settings-back').click();
  assert.equal(await main.getByTestId('unread-badge').innerText(), '9');
  await openMenuItem('open-settings');
  await main.getByTestId('settings-nav-notifications').click();
  isUnreadFailure = true;
  await main.getByTestId('refresh-messages').click();
  await main.getByRole('alert').filter({ hasText: '同步失败' }).waitFor();
  assert.match(await main.getByTestId('notification-unread').innerText(), /9 条未读/);
  const state = await main.evaluate(() => window.diteng.getMqttState());
  assert.equal(state.unreadError, true);
  assert.ok(state.unreadUpdatedAt);
  isUnreadFailure = false;
  await main.getByTestId('refresh-messages').click();
  await main.getByRole('status').filter({ hasText: '未读数已同步' }).waitFor();
  await main.getByTestId('test-notification').click();
  await main.getByRole('status').filter({ hasText: '已请求系统显示测试通知' }).waitFor();
  assert.equal(await electron.evaluate(() => globalThis.__testNotificationCount), 1);
  assert.equal((await main.evaluate(() => window.diteng.getMqttState())).unread, 9);
  await main.screenshot({ path: join(output, '02-notifications.png') });
  console.log('PASS 提醒开关连点防重与持久化，未读刷新、失败保留旧值、恢复与本机通知测试');

  await main.evaluate(() => window.diteng.setConfig({ theme: 'dark' }));
  await main.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  await main.screenshot({ path: join(output, '03-notifications-dark.png') });
  await electron.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).setSize(960, 640); });
  await main.screenshot({ path: join(output, '04-narrow.png') });
  assert.equal(await main.getByTestId('settings-content').evaluate(element => element.scrollWidth > element.clientWidth), false);
  await main.getByTestId('settings-back').click();
  for (const id of ['url-bar-copy', 'feedback-button']) {
    const box = await main.getByTestId(id).boundingBox();
    const toolbar = await main.getByTestId('browser-toolbar').boundingBox();
    assert.ok(box.x >= toolbar.x && box.x + box.width <= toolbar.x + toolbar.width && box.y >= toolbar.y && box.y + box.height <= toolbar.y + toolbar.height);
  }
  await main.screenshot({ path: join(output, '04-narrow-toolbar.png') });
  await main.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await main.getByTestId('app-menu-button').click();
  assert.equal(await main.getByTestId('menu-open-messages').isVisible(), true);
  assert.equal(await main.getByTestId('menu-open-ai').isVisible(), true);
  assert.equal(await main.getByTestId('open-settings').isVisible(), true);
  await main.screenshot({ path: join(output, '05-compact-menu.png') });
  await main.keyboard.press('Escape');
  assert.equal(await main.getByTestId('switch-account').count(), 0);
  assert.equal(await main.getByTestId('user-chip').count(), 0);
  assert.equal(await main.getByTestId('open-settings').count(), 0);
  await main.screenshot({ path: join(output, '05-compact.png') });
  await main.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await main.evaluate(() => window.diteng.setConfig({ theme: 'light' }));
  await electron.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).setSize(1360, 900); });
  await openNewTab();
  await main.screenshot({ path: join(output, '06-start.png') });
  console.log('PASS 深浅色、960×640 窄窗无横向溢出、收起后核心入口可达');

  await openMenuItem('open-settings');
  await main.getByTestId('settings-nav-account').click();
  const beforeRelogin = (await guests()).length;
  await main.getByTestId('settings-relogin').click();
  await waitFor(() => electron.evaluate(() => globalThis.__confirmationCount === 1));
  assert.equal((await guests()).length, beforeRelogin);
  assert.ok(await main.evaluate(() => window.diteng.getSession()));
  assert.equal(logoutRequests, 0);
  await waitFor(() => main.getByTestId('settings-relogin').isEnabled());
  await electron.evaluate(() => { globalThis.__confirmationResponse = 'wait'; });
  await main.evaluate(() => { const button = document.querySelector('[data-testid="settings-relogin"]'); button.click(); button.click(); });
  await waitFor(() => electron.evaluate(() => globalThis.__confirmationResolvers.length === 1));
  assert.equal(await electron.evaluate(() => globalThis.__confirmationCount), 2);
  isOffline = true;
  await electron.evaluate(() => { globalThis.__confirmationResolvers.shift()({ response: 1 }); });
  let nextLogin;
  await waitFor(() => { nextLogin = electron.windows().find(page => page !== login && !page.isClosed() && page.url() === loginEntryUrl); return Boolean(nextLogin); });
  await nextLogin.locator('#server-base').waitFor();
  await waitFor(() => electron.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows().some(window => window.webContents.getURL().includes('#/main'))));
  assert.equal(await nextLogin.evaluate(() => window.diteng.getSession()), null);
  assert.equal((await nextLogin.evaluate(() => window.diteng.getConfig())).autoLogin, false);
  assert.equal((await nextLogin.evaluate(() => window.diteng.listSavedAccounts()))[0].loginId, 'test-login');
  assert.equal((await guests()).length, 0);
  await nextLogin.screenshot({ path: join(output, '07-relogin.png') });
  console.log('PASS 重新登录取消保留页面、慢确认防重；断网时确认仍回登录页并清会话、关闭旧页，保留历史账号');
  console.log(`PASS 核心外壳验收完成；未读请求 ${requests} 次；截图目录 ${output}`);
} finally {
  if (electron) {
    const timer = setTimeout(() => electron.process().kill('SIGKILL'), 5000);
    try { await electron.close().catch(() => {}); } finally { clearTimeout(timer); }
  }
  await new Promise(resolve => backend.close(resolve));
  await vite?.close();
  rmSync(directory, { recursive: true, force: true });
}
