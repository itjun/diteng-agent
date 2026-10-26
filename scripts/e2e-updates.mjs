/** 隔离 Electron + 本地真实更新清单/文件。只替换安装与确认，不替换检查、HTTP 下载和校验。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import semver from 'semver';
import { _electron } from 'playwright-core';

const directory = mkdtempSync(join(tmpdir(), 'diteng-update-e2e-'));
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const next = semver.inc(current, 'patch');
const extension = { darwin: 'zip', win32: 'exe', linux: 'deb' }[process.platform];
const filename = `update-${process.arch}.${extension}`;
const payload = Buffer.alloc(32768, 'local-update-fixture');
const sha512 = createHash('sha512').update(payload).digest('base64');
let minimum = current, version = current, isOffline = false, isCorrupt = false;
let checks = 0, downloads = 0;
const backend = createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (pathname === '/services/SvrUserLogin.getToken') return json({ state: 1, head: { status: 1, token: 'test-only', corpNo: '100001', homeForm: 'FrmDefault', startPage: '100001/FrmDefault' }, body: [[]] });
  if (pathname === '/center/UserServer/getTokenInfo') return json({ userId: 'local-user', userCode: '10000102', userName: '测试用户', corpNo: '100001' });
  if (pathname === '/services/SvrAccountManage.listMyLivingUsers') return json({ state: 1, head: {}, body: [{ CorpNo_: '100001', Code_: '10000102', Name_: '测试企业' }] });
  if (pathname.endsWith('FrmMessages.mqttConfig')) return json({ broker: '' });
  if (pathname.endsWith('ImServer.getUnreadMessage')) return json({ state: 1, data: 0 });
  if (pathname === '/public/desktop-agent/notifications') return json({ items: [], nextCursor: null });
  if (pathname.includes('FrmDefault')) { res.setHeader('content-type', 'text/html'); res.end('<html><body>Local update test</body></html>'); return; }
  if (isOffline) { res.writeHead(503); res.end('offline'); return; }
  if (req.url.split('?')[0].endsWith('.yml')) {
    checks++;
    res.end(JSON.stringify({ version, minimumVersion: minimum, releaseDate: '2026-10-26T00:00:00Z',
      files: [{ url: filename, sha512, size: payload.length }], path: filename, sha512 }));
  } else {
    downloads++; res.setHeader('content-length', payload.length);
    res.end(isCorrupt ? Buffer.alloc(payload.length, 'corrupt') : payload);
  }
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${backend.address().port}/`;
writeFileSync(join(directory, 'config.json'), JSON.stringify({ configVersion: 3, serverBase: 'https://m.cdcp.site',
  autoLogin: false, autoCheckUpdates: false, autoDownloadUpdates: false }));
const config = join(directory, 'app-update.yml');
writeFileSync(config, JSON.stringify({ provider: 'generic', url: base, updaterCacheDirName: `diteng-test-${Date.now()}` }));
const bootstrap = join(directory, 'bootstrap.cjs');
writeFileSync(bootstrap, `
const { app, dialog, session } = require('electron');
Object.defineProperty(app, 'isPackaged', { value: true });
app.setPath('cache', ${JSON.stringify(directory)});
app.getVersion = () => ${JSON.stringify(current)};
const updaterModule = require(${JSON.stringify(resolve('node_modules/electron-updater'))});
const updater = process.platform === 'linux' ? new updaterModule.DebUpdater() : updaterModule.autoUpdater;
require.cache[require.resolve(${JSON.stringify(resolve('node_modules/electron-updater'))})].exports = { ...updaterModule, autoUpdater: updater };
updater.updateConfigPath = ${JSON.stringify(config)};
updater.setFeedURL({ provider: 'generic', url: ${JSON.stringify(base)} });
updater.disableDifferentialDownload = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => { const parsed = new URL(url); return originalFetch(${JSON.stringify(base)} + parsed.pathname.slice(1) + parsed.search, options); };
app.whenReady().then(() => {
  session.defaultSession.protocol.handle('https', request => { const parsed = new URL(request.url); return originalFetch(${JSON.stringify(base)} + parsed.pathname.slice(1) + parsed.search); });
});
globalThis.__updateInstalls = 0;
updater.quitAndInstall = () => { globalThis.__updateInstalls++; };
globalThis.__approveInstall = false;
dialog.showMessageBox = async () => ({ response: globalThis.__approveInstall ? 0 : 1 });
require(${JSON.stringify(resolve('dist/main/index.js'))});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let electron;
async function launch() {
  electron = await _electron.launch({ args: [bootstrap, `--user-data-dir=${directory}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], env, timeout: 30000 });
  return electron.firstWindow();
}
try {
  let page = await launch();
  await page.locator('#login-id').waitFor();
  let state = await page.evaluate(() => window.diteng.checkForUpdates());
  assert.equal(state.status, 'latest'); assert.equal(state.currentVersion, current);
  console.log('PASS 真实更新协议识别当前最新版本');

  version = next;
  const beforeChecks = checks;
  const results = await page.evaluate(() => Promise.all(Array.from({ length: 8 }, () => window.diteng.checkForUpdates())));
  assert.ok(results.every(result => result.status === 'available'));
  assert.equal(checks, beforeChecks + 1);
  assert.equal(await page.getByTestId('update-status').textContent(), `新版本 ${next} 可用`);
  isCorrupt = true;
  state = await page.evaluate(() => window.diteng.downloadUpdate());
  assert.equal(state.status, 'error');
  console.log('PASS 连续检查只发一份请求；篡改下载被真实 SHA-512 校验拒绝');

  isCorrupt = false;
  await page.evaluate(() => window.diteng.checkForUpdates());
  const beforeDownloads = downloads;
  const downloaded = await page.evaluate(() => Promise.all(Array.from({ length: 6 }, () => window.diteng.downloadUpdate())));
  assert.ok(downloaded.every(result => result.status === 'downloaded'));
  assert.equal(downloads, beforeDownloads + 1);
  state = await page.evaluate(() => window.diteng.installUpdate());
  assert.equal(state.status, 'downloaded');
  assert.equal(await electron.evaluate(() => globalThis.__updateInstalls), 0);
  await page.evaluate(() => { void window.diteng.login({ loginId: 'local-test', ['pass' + 'word']: 'test-only', rememberPassword: false }); });
  await poll(async () => electron.windows().some(window => window.url().includes('#/main')));
  page = electron.windows().find(window => window.url().includes('#/main'));
  await page.getByTestId('app-menu-button').click();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-nav-about').click();
  await page.getByTestId('update-minimum-version').waitFor();
  assert.equal(await page.getByTestId('update-minimum-version').textContent(), current);
  await page.getByRole('switch', { name: '自动检查更新', exact: true }).click();
  await poll(async () => (await page.evaluate(() => window.diteng.getConfig())).autoCheckUpdates === true);
  await page.getByRole('switch', { name: '自动检查更新', exact: true }).click();
  await poll(async () => (await page.evaluate(() => window.diteng.getConfig())).autoCheckUpdates === false);
  await page.getByRole('switch', { name: '自动下载更新', exact: true }).click();
  await poll(async () => (await page.evaluate(() => window.diteng.getConfig())).autoDownloadUpdates === true);
  await page.getByRole('switch', { name: '自动下载更新', exact: true }).click();
  await poll(async () => (await page.evaluate(() => window.diteng.getConfig())).autoDownloadUpdates === false);
  if (process.env.DITENG_QA_OUTPUT) {
    mkdirSync(process.env.DITENG_QA_OUTPUT, { recursive: true });
    await page.screenshot({ path: join(process.env.DITENG_QA_OUTPUT, 'update-settings.png') });
  }
  console.log('PASS 设置页显示真实版本状态；自动检查、自动下载开关持久化且可恢复');
  await electron.evaluate(() => { globalThis.__approveInstall = true; });
  await page.evaluate(() => Promise.all(Array.from({ length: 6 }, () => window.diteng.installUpdate())));
  assert.equal(await electron.evaluate(() => globalThis.__updateInstalls), 1);
  console.log('PASS 真实下载成功并防重；取消安装保持就绪，确认后仅安装一次');
  await electron.close(); electron = null;

  // 新进程解除已安装状态，重新取得强制更新策略，再验证离线重启。
  minimum = next;
  page = await launch();
  state = await page.evaluate(() => window.diteng.checkForUpdates());
  assert.equal(state.isRequired, true);
  await page.getByRole('alertdialog', { name: '需要更新客户端' }).waitFor();
  assert.equal(await page.evaluate(() => document.getElementById('root').inert), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[role="alertdialog"]'))), true);
  if (process.env.DITENG_QA_OUTPUT) await page.screenshot({ path: join(process.env.DITENG_QA_OUTPUT, 'update-required.png') });
  assert.equal(await page.getByText('稍后', { exact: true }).count(), 0);
  const result = await page.evaluate(() => window.diteng.autoLogin());
  assert.equal(result.ok, false); assert.match(result.message, /版本过低/);
  // 直接走 IPC 时，子框架也不能冒用主窗口执行更新。
  await electron.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0].webContents;
    const handler = ipcMain._invokeHandlers.get('update:install');
    let isRejected = false;
    try { await handler({ sender: owner, senderFrame: null }); } catch { isRejected = true; }
    if (!isRejected) throw new Error('子框架绕过更新权限校验');
  });
  await electron.close(); electron = null;
  isOffline = true;
  page = await launch();
  await page.getByRole('alertdialog', { name: '需要更新客户端' }).waitFor();
  state = await page.evaluate(() => window.diteng.checkForUpdates());
  assert.equal(state.status, 'error'); assert.equal(state.isRequired, true);
  console.log('PASS 最低版本阻断登录且不可跳过；IPC 校验；离线重启保留最低版本限制');
} finally {
  if (electron) await electron.close();
  await new Promise(resolve => backend.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}

async function poll(test) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待更新 UI 状态超时');
}
