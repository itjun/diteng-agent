/** 自定义右键菜单：临时 userData、本地页面，验证样式、编辑操作、定位与 IPC 边界。运行前 pnpm build:app。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import { createServer as createViteServer } from 'vite';

const directory = mkdtempSync(join(tmpdir(), 'diteng-context-menu-'));
const output = process.env.DITENG_QA_OUTPUT || directory;
mkdirSync(output, { recursive: true });
let pageLoads = 0;
const backend = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  for await (const _chunk of req) { /* 消费本地请求 */ }
  const json = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/services/SvrUserLogin.getToken') return json({ state: 1, head: { status: 1, token: 'local-test-token', corpNo: '100001', homeForm: 'FrmDefault', startPage: '100001/FrmDefault' }, body: [[]] });
  if (url.pathname === '/center/UserServer/getTokenInfo') return json({ userId: 'local-user', userCode: '10000102', userName: '测试用户', corpNo: '100001' });
  if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') return json({ state: 1, head: {}, body: [{ CorpNo_: '100001', Code_: '10000102', Name_: '测试企业' }] });
  if (url.pathname.endsWith('FrmMessages.mqttConfig')) return json({ broker: '' });
  if (url.pathname.endsWith('ImServer.getUnreadMessage')) return json({ state: 1, data: 0 });
  if (url.pathname === '/public/desktop-agent/notifications') return json({ items: [], nextCursor: null });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (url.pathname === '/frame') {
    res.end('<!doctype html><html><body><input id="frame-input" value="框架内文本"></body></html>');
    return;
  }
  pageLoads++;
  res.end('<!doctype html><html><head><title>右键菜单验收</title></head><body style="margin:32px;font:16px sans-serif;background:#fff;color:#222"><h1>本地测试页面</h1><p id="text">可复制的网页文本</p><input id="input" value="编辑测试内容"><p><a id="link" href="/help">帮助链接</a></p><iframe id="frame" src="/frame" style="width:400px;height:100px"></iframe><div id="blank" style="height:80px"></div></body></html>');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${backend.address().port}`;
writeFileSync(join(directory, 'config.json'), JSON.stringify({ configVersion: 2, serverBase: base, aiBase: base, machineCode: 'local-test-device', autoLogin: false, rememberPassword: false, chromeColor: 'pink', theme: 'light' }));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const reservedPort = createServer();
await new Promise(resolve => reservedPort.listen(0, '127.0.0.1', resolve));
const vitePort = reservedPort.address().port;
await new Promise(resolve => reservedPort.close(resolve));
const vite = await createViteServer({ server: { host: '127.0.0.1', port: vitePort, strictPort: true } });
await vite.listen();
env.DITENG_AGENT_DEV_URL = `http://127.0.0.1:${vite.httpServer.address().port}`;
// 构建环境会固定服务地址，必须在应用启动前同时隔离主进程 fetch 与网页协议。
const bootstrap = join(directory, 'bootstrap.cjs');
writeFileSync(bootstrap, `
const { app, session, net } = require('electron');
const localFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const target = new URL(url);
  return localFetch(${JSON.stringify(base)} + target.pathname + target.search, options);
};
app.whenReady().then(() => {
  for (const scheme of ['http', 'https']) session.defaultSession.protocol.handle(scheme, request => {
    const target = new URL(request.url);
    if (target.origin === ${JSON.stringify(env.DITENG_AGENT_DEV_URL)}) return net.fetch(request, { bypassCustomProtocolHandlers: true });
    return localFetch(${JSON.stringify(base)} + target.pathname + target.search);
  });
});
require(${JSON.stringify(resolve('dist/main/index.js'))});
`);
let electron;
try {
  electron = await _electron.launch({ args: [bootstrap, `--user-data-dir=${directory}`], cwd: resolve('.'), env, timeout: 25000 });
  await electron.evaluate(async ({ clipboard, Menu }) => {
    globalThis.__contextClipboard = await clipboard.read();
    globalThis.__nativeMenuCount = 0;
    Menu.prototype.popup = () => { globalThis.__nativeMenuCount++; };
  });
  const login = await electron.firstWindow();
  await login.locator('#login-id').fill('本地账号');
  await login.locator('#login-id').evaluate(input => input.select());
  await login.locator('#login-id').click({ button: 'right' });
  await login.getByTestId('context-menu').waitFor();
  assert.equal(await login.getByTestId('context-menu-reload').count(), 0);
  await login.getByTestId('context-menu-copy').click();
  await assertEventually(async () => await electron.evaluate(({ clipboard }) => clipboard.readText()) === '本地账号');
  assert.equal(await login.locator('#login-id').evaluate(input => input === document.activeElement), true);
  console.log('PASS 登录窗使用自定义菜单，复制后恢复输入焦点，外壳不提供刷新');

  await login.evaluate(base => {
    void window.diteng.login({ serverBase: base, loginId: 'local-test', ['pass' + 'word']: 'local-only', rememberPassword: false })
      .then(result => { if (!result.ok) window.__loginFailure = result.message; });
  }, base);
  let main;
  await assertEventually(async () => {
    main = electron.windows().find(page => page.url().includes('#/main'));
    if (main) return true;
    const failure = await login.evaluate(() => window.__loginFailure);
    if (failure) throw new Error(failure);
    return false;
  });
  await main.getByTestId('app-menu-button').waitFor();
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).setSize(1200, 800));
  let guestId;
  await assertEventually(async () => {
    guestId = await electron.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getType() === 'webview')?.id);
    return guestId && await guestEval('Boolean(document.querySelector("#input"))');
  });
  await main.evaluate(() => window.diteng.onContextMenuChanged(request => { if (request) window.__contextRequest = request; }));
  async function guestEval(code) {
    return electron.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code), { id: guestId, code });
  }
  async function rightClickGuest(selector, isSelect = false) {
    const offset = await main.locator('webview').evaluate(view => { const bounds = view.getBoundingClientRect(); return { x: bounds.x, y: bounds.y }; });
    const point = await guestEval(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); ${isSelect ? 'element.focus(); element.select();' : ''} const bounds = element.getBoundingClientRect(); return { x: bounds.x + 10, y: bounds.y + 10 }; })()`);
    await main.mouse.click(offset.x + point.x, offset.y + point.y, { button: 'right' });
    await main.getByTestId('context-menu').waitFor();
    const bounds = await main.getByTestId('context-menu').boundingBox();
    const viewport = await main.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(Math.abs(bounds.x - Math.max(8, Math.min(offset.x + point.x, viewport.width - bounds.width - 8))) <= 1);
    assert.ok(Math.abs(bounds.y - Math.max(8, Math.min(offset.y + point.y, viewport.height - bounds.height - 8))) <= 1);
  }
  const menuStyle = testId => main.getByTestId(testId).evaluate(menu => {
    const style = getComputedStyle(menu), row = getComputedStyle(menu.querySelector('button'));
    return { background: style.backgroundColor, border: style.border, radius: style.borderRadius, shadow: style.boxShadow, padding: style.padding, color: style.color, rowHeight: row.minHeight, rowRadius: row.borderRadius, font: row.fontSize };
  });
  await main.getByTestId('app-menu-button').click();
  const lightStyle = await menuStyle('app-menu');
  await main.keyboard.press('Escape');
  await rightClickGuest('#blank');
  assert.equal(await main.getByTestId('context-menu-copy').isDisabled(), true);
  assert.equal(await main.getByTestId('context-menu-reload').isEnabled(), true);
  assert.deepEqual(await menuStyle('context-menu'), lightStyle);
  const requestId = await main.evaluate(() => window.__contextRequest.id);
  const loadsBeforeInvalidActions = pageLoads;
  await main.evaluate(id => {
    window.diteng.runContextMenuAction(id + 1000, 'reload');
    window.diteng.runContextMenuAction(id, 'copy'); // 禁用项不能绕过 UI 执行。
    window.diteng.runContextMenuAction(id, 'unknown');
  }, requestId);
  await electron.evaluate(({ ipcMain, webContents, BrowserWindow }, { id, requestId }) => {
    const guest = webContents.fromId(id);
    const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main')).webContents;
    ipcMain.emit('context-menu:action', { sender: guest, senderFrame: guest.mainFrame }, requestId, 'reload');
    ipcMain.emit('context-menu:action', { sender: owner, senderFrame: guest.mainFrame }, requestId, 'reload');
  }, { id: guestId, requestId });
  assert.equal(pageLoads, loadsBeforeInvalidActions);
  assert.equal(await electron.evaluate(({ clipboard }) => clipboard.readText()), '本地账号');
  assert.equal(await main.getByTestId('context-menu').isVisible(), true);
  await main.screenshot({ path: join(output, 'context-menu-light.png') });
  await main.keyboard.press('End');
  assert.equal(await main.getByTestId('context-menu-reload').evaluate(button => button === document.activeElement), true);
  await main.keyboard.press('ArrowDown');
  assert.equal(await main.getByTestId('context-menu-select-all').evaluate(button => button === document.activeElement), true);
  await main.keyboard.press('Escape');
  assert.equal(await main.getByTestId('context-menu').count(), 0);
  console.log('PASS 网页右键与三点菜单样式一致，禁用态、键盘循环导航与 Esc 关闭');

  await rightClickGuest('#input', true);
  const completedRequestId = await main.evaluate(() => window.__contextRequest.id);
  await main.getByTestId('context-menu-copy').click();
  await assertEventually(async () => await electron.evaluate(({ clipboard }) => clipboard.readText()) === '编辑测试内容');
  await main.evaluate(id => window.diteng.runContextMenuAction(id, 'cut'), completedRequestId);
  assert.equal(await guestEval('document.querySelector("#input").value'), '编辑测试内容');
  await rightClickGuest('#input', true);
  await main.getByTestId('context-menu-cut').click();
  await assertEventually(async () => await guestEval('document.querySelector("#input").value') === '');
  await rightClickGuest('#input');
  await main.getByTestId('context-menu-paste').click();
  await assertEventually(async () => await guestEval('document.querySelector("#input").value') === '编辑测试内容');
  await rightClickGuest('#input');
  await main.getByTestId('context-menu-select-all').click();
  await assertEventually(async () => await guestEval('document.querySelector("#input").selectionEnd - document.querySelector("#input").selectionStart') === '编辑测试内容'.length);
  await rightClickGuest('#link');
  await main.getByTestId('context-menu-copy-link').click();
  const helpUrl = await guestEval('new URL("/help", location.href).href');
  await assertEventually(async () => await electron.evaluate(({ clipboard }) => clipboard.readText()) === helpUrl);
  console.log('PASS 网页复制、剪切、粘贴、全选与复制链接操作原有目标');

  // 子框架的输入焦点与上下文操作也必须保留。
  const offset = await main.locator('webview').boundingBox();
  const framePoint = await guestEval('(() => { const frame = document.querySelector("#frame"), input = frame.contentDocument.querySelector("input"); input.focus(); input.select(); const outer = frame.getBoundingClientRect(), inner = input.getBoundingClientRect(); return { x: outer.x + inner.x + 5, y: outer.y + inner.y + 5 }; })()');
  await main.mouse.click(offset.x + framePoint.x, offset.y + framePoint.y, { button: 'right' });
  await main.getByTestId('context-menu-copy').click();
  await assertEventually(async () => await electron.evaluate(({ clipboard }) => clipboard.readText()) === '框架内文本');

  const beforeRefresh = pageLoads;
  await rightClickGuest('#blank');
  await main.getByTestId('context-menu-reload').click();
  await assertEventually(() => pageLoads > beforeRefresh);
  await assertEventually(() => guestEval('Boolean(document.querySelector("#input"))'));
  await main.mouse.click(1180, 775, { button: 'right' });
  const bounds = await main.getByTestId('context-menu').boundingBox();
  const viewport = await main.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= viewport.width - 7 && bounds.y + bounds.height <= viewport.height - 7);
  await main.mouse.click(400, 400);
  assert.equal(await main.getByTestId('context-menu').count(), 0);
  console.log('PASS 子框架复制、仅刷新网页、窗口边缘避让、点击外部关闭');

  await main.getByTestId('app-menu-button').click();
  await main.getByTestId('open-settings').click();
  await main.getByTestId('settings-nav-appearance').click();
  await main.getByTestId('settings-theme-dark').click();
  await main.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  await assertEventually(async () => (await main.evaluate(() => window.diteng.getConfig())).theme === 'dark');
  await main.getByTestId('settings-chrome-purple').click();
  await assertEventually(async () => (await main.evaluate(() => window.diteng.getConfig())).chromeColor === 'purple');
  await main.getByTestId('settings-back').click();
  await main.getByTestId('app-menu-button').click();
  const darkStyle = await menuStyle('app-menu');
  await main.keyboard.press('Escape');
  await rightClickGuest('#input', true);
  assert.deepEqual(await menuStyle('context-menu'), darkStyle);
  assert.notEqual(darkStyle.background, lightStyle.background);
  await main.screenshot({ path: join(output, 'context-menu-dark.png') });
  await main.keyboard.press('Escape');
  await main.getByTestId('url-bar-text').click({ button: 'right' });
  await main.getByTestId('context-menu').waitFor();
  assert.equal(await main.getByTestId('context-menu-reload').count(), 0);
  await main.keyboard.press('Escape');
  const tab = main.locator('[role="tab"]').first();
  await tab.click({ button: 'right' });
  await main.getByRole('menu', { name: /标签菜单/ }).waitFor();
  assert.equal(await main.getByTestId('context-menu').count(), 0);
  await main.keyboard.press('Escape');
  await rightClickGuest('#blank');
  await guestEval('location.hash = "context-menu-navigation"');
  await main.getByTestId('context-menu').waitFor({ state: 'detached' });
  await main.getByTestId('feedback-button').click();
  await main.getByTestId('feedback-editor').waitFor();
  await main.getByTestId('feedback-editor').locator('strong').click({ button: 'right' });
  await main.getByTestId('context-menu').waitFor();
  await main.keyboard.press('Escape');
  await main.getByTestId('context-menu').waitFor({ state: 'detached' });
  assert.equal(await main.getByTestId('feedback-editor').isVisible(), true);
  await main.getByTestId('feedback-cancel').click();
  assert.equal(await electron.evaluate(() => globalThis.__nativeMenuCount), 0);
  console.log('PASS 深浅主题一致，保留标签专用菜单，全程未调用系统右键菜单');
  console.log('PASS 拒绝错误请求编号、禁用项、未知动作、网页或子框架冒用外壳、重复执行已关闭的菜单');
  console.log('PASS 导航时自动关闭菜单；截图编辑器内 Esc 只关闭右键菜单');
  console.log(`PASS 自定义右键菜单验收完成；截图目录 ${output}`);
} finally {
  if (electron) {
    await electron.evaluate(async ({ clipboard }) => {
      if (!globalThis.__contextClipboard) return;
      if (globalThis.__contextClipboard.length) await clipboard.write(globalThis.__contextClipboard);
      else clipboard.clear();
    }).catch(() => {});
    const timer = setTimeout(() => electron.process().kill('SIGKILL'), 5000);
    try { await electron.close().catch(() => {}); } finally { clearTimeout(timer); }
  }
  await new Promise(resolve => backend.close(resolve));
  await vite.close();
  rmSync(directory, { recursive: true, force: true });
}

async function assertEventually(test, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('等待条件超时');
}
