/** 先 pnpm build；真实 Electron 生命周期，临时 userData 与全网络桩，不访问业务服务器。 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';

const { environment } = JSON.parse(readFileSync('dist/build-environment.json', 'utf8'));
const serverBase = { main: 'https://m.cdcp.site', dev: 'http://rc.local.lan' }[environment];
assert.ok(serverBase);
const directory = mkdtempSync(join(tmpdir(), 'diteng-heartbeat-e2e-'));
const userData = join(directory, 'userData');
const quitReport = join(directory, 'quit.json');
mkdirSync(userData);
writeFileSync(join(userData, 'config.json'), JSON.stringify({ configVersion: 3, serverBase,
  machineCode: 'heartbeat-fixture-device', autoLogin: false, rememberPassword: false, autoCheckUpdates: false }));
const bootstrap = join(directory, 'bootstrap.cjs');
writeFileSync(bootstrap, `
const { app, session, dialog, powerMonitor } = require('electron');
Object.defineProperty(app, 'isPackaged', { value: true });
globalThis.__heartbeats = [];
globalThis.__heartbeatMode = 'ok';
globalThis.fetch = async (url, options) => {
  const target = new URL(url);
  if (target.origin !== ${JSON.stringify(serverBase)}) throw new Error('测试禁止外部请求');
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  if (target.pathname === '/services/TAppHeartbeat.Hello') {
    const request = { sid: target.searchParams.get('sid'), clientId: target.searchParams.get('CLIENTID'), method: options.method,
      at: Date.now(), mode: globalThis.__heartbeatMode, isAborted: false };
    globalThis.__heartbeats.push(request);
    options.signal.addEventListener('abort', () => { request.isAborted = true; }, { once: true });
    if (globalThis.__heartbeatMode === 'offline') return json({}, 503);
    if (globalThis.__heartbeatMode === 'slow') return new Promise((resolve, reject) => {
      globalThis.__finishHeartbeat = () => resolve(json({ state: 1 }));
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return json({ state: 1 });
  }
  if (target.pathname === '/services/SvrUserLogin.getToken') return json({ state: 1, head: { token: 'initial-fixture-sid', corpNo: '100001', homeForm: 'FrmDefault' } });
  if (target.pathname.endsWith('/getTokenInfo')) {
    const isSwitched = JSON.parse(options.body).token === 'switched-fixture-sid';
    return json({ userId: 'fixture-user', userCode: isSwitched ? '10000201' : '10000101', userName: '测试用户', corpNo: isSwitched ? '100002' : '100001' });
  }
  if (target.pathname.endsWith('listMyLivingUsers')) return json({ state: 1, body: [
    { CorpNo_: '100001', Code_: '10000101', Name_: '原始账套' }, { CorpNo_: '100002', Code_: '10000201', Name_: '目标账套' }] });
  if (target.pathname.endsWith('mqttConfig')) return json({ broker: '' });
  if (target.pathname.endsWith('getUnreadMessage')) return json({ state: 1, data: 0 });
  if (target.pathname === '/public/desktop-agent/notifications') return json({ items: [], nextCursor: null });
  if (target.pathname.endsWith('/logout')) return json({});
  throw new Error('未预期的测试请求：' + target.pathname);
};
dialog.showMessageBox = async () => ({ response: 1 });
app.whenReady().then(() => {
  for (const scheme of ['http', 'https']) session.defaultSession.protocol.handle(scheme, () =>
    new Response('<!doctype html><html><head><title>心跳测试</title></head><body>隔离测试页面</body></html>', { headers: { 'content-type': 'text/html' } }));
});
require(${JSON.stringify(resolve('dist/main/index.js'))});
app.on('before-quit', () => require('node:fs').writeFileSync(${JSON.stringify(quitReport)}, JSON.stringify({
  last: globalThis.__heartbeats.at(-1), resumeListeners: powerMonitor.listenerCount('resume'),
})));
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DITENG_AGENT_DEV_URL;
let electron;
const waitFor = async (check, timeout = 20_000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('等待心跳验收条件超时');
};
const heartbeats = () => electron.evaluate(() => globalThis.__heartbeats);
const resume = () => electron.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume'); });
async function login() {
  let page;
  await waitFor(() => { page = electron.windows().find(item => item.url().startsWith('file:') && !new URL(item.url()).hash); return Boolean(page); });
  await page.waitForFunction(() => Boolean(window.diteng));
  const result = await page.evaluate(() => window.diteng.login({ loginId: 'heartbeat-fixture-user', password: 'fixture-password', rememberPassword: false }));
  assert.equal(result.ok, true);
  let main;
  await waitFor(() => { main = electron.windows().find(item => item.url().includes('#/main')); return Boolean(main); });
  await main.getByTestId('shell-rail').waitFor();
  return main;
}

try {
  const executablePath = process.env.DITENG_E2E_EXECUTABLE;
  electron = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : [bootstrap]), `--user-data-dir=${userData}`], env, timeout: 25_000 });
  if (executablePath) {
    const source = readFileSync(bootstrap, 'utf8').replace(/Object.defineProperty\(app, 'isPackaged'.*\n/, '').replace(/^require\(.*dist\/main\/index.js.*\n/m, '');
    await electron.evaluate((electron, source) => {
      new Function('require', source)(name => name === 'electron' ? electron : process.mainModule.require(name));
    }, source);
  }
  await electron.firstWindow();
  assert.equal((await heartbeats()).length, 0);
  let main = await login();
  await waitFor(async () => (await heartbeats()).length === 1);
  const first = (await heartbeats())[0];
  assert.equal(first.sid, 'initial-fixture-sid');
  assert.equal(first.clientId, 'heartbeat-fixture-device');
  assert.equal(first.method, 'POST');
  await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('#/main'));
    window.minimize();

  });
  await waitFor(async () => (await heartbeats()).length >= 2);
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('#/main')).isMinimized()), true);
  console.log('PASS 安装版最小化后继续心跳');
  const beforeHide = (await heartbeats()).length;
  await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('#/main'));
    window.close();
    if (window.isDestroyed() || window.isVisible()) throw new Error('主窗没有隐藏到托盘');
  });
  await waitFor(async () => (await heartbeats()).length > beforeHide);
  const second = (await heartbeats())[1];
  assert.ok(second.at - first.at >= 14_900);
  console.log('PASS 登录立即续期，最小化并隐藏到托盘后按真实 15 秒周期继续心跳');

  await electron.evaluate(() => { globalThis.__heartbeatMode = 'offline'; });
  await resume();
  await waitFor(async () => (await heartbeats()).at(-1).mode === 'offline');
  const offlineCount = (await heartbeats()).length;
  await electron.evaluate(() => { globalThis.__heartbeatMode = 'ok'; });
  await waitFor(async () => (await heartbeats()).length > offlineCount);
  assert.equal((await heartbeats()).at(-1).mode, 'ok');
  console.log('PASS 唤醒立即补发，断网失败后无需页面操作即可按周期恢复');

  const beforeSwitch = (await heartbeats()).length;
  await electron.evaluate(({ webContents }, serverBase) => {
    const guest = webContents.getAllWebContents().find(item => item.getType() === 'webview');
    if (!guest) throw new Error('缺少 ERP 页面');
    void guest.loadURL(serverBase + '/100002/FrmDefault?sid=switched-fixture-sid&CLIENTID=heartbeat-fixture-device');
  }, serverBase);
  await waitFor(async () => (await main.evaluate(() => window.diteng.getSession())).corpNo === '100002');
  await waitFor(async () => (await heartbeats()).length >= beforeSwitch + 2);
  assert.deepEqual((await heartbeats()).slice(beforeSwitch).map(item => item.sid), ['initial-fixture-sid', 'switched-fixture-sid']);
  console.log('PASS 真实网页换票核验提交后，同时保活原始 sid 和当前 sid');

  await electron.evaluate(() => { globalThis.__heartbeatMode = 'slow'; });
  await resume();
  await waitFor(async () => (await heartbeats()).at(-1).mode === 'slow');
  const beforeLogout = (await heartbeats()).length;
  await main.evaluate(() => window.diteng.logout());
  assert.equal((await heartbeats()).at(-1).isAborted, true);
  await electron.evaluate(() => { globalThis.__finishHeartbeat(); });
  await resume();
  await new Promise(resolve => setTimeout(resolve, 15_200));
  assert.equal((await heartbeats()).length, beforeLogout);
  console.log('PASS 退出登录中止在途请求，迟到回包、唤醒及下一周期都不会恢复旧心跳');

  await electron.evaluate(() => { globalThis.__heartbeatMode = 'ok'; });
  main = await login();
  await waitFor(async () => (await heartbeats()).length === beforeLogout + 1);
  await electron.evaluate(() => { globalThis.__heartbeatMode = 'slow'; });
  await resume();
  await waitFor(async () => (await heartbeats()).at(-1).mode === 'slow');
  await electron.close();
  electron = null;
  const quit = JSON.parse(readFileSync(quitReport, 'utf8'));
  assert.equal(quit.last.isAborted, true);
  assert.equal(quit.resumeListeners, 0);
  console.log('PASS 重新登录恢复心跳，真正退出取消请求并释放唤醒监听');
} finally {
  if (electron) await electron.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
