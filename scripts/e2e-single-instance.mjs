/** 单实例验收：真实 Electron 进程、临时 userData、全网络桩。运行前 pnpm build。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'diteng-single-instance-'));
const userData = join(directory, 'userData');
mkdirSync(userData);
writeFileSync(join(userData, 'config.json'), JSON.stringify({ autoLogin: false }));
const bootstrap = join(directory, 'bootstrap.cjs');
const entry = resolve(process.env.DITENG_QA_MAIN || 'dist/main/index.js');
writeFileSync(bootstrap, `
const { app, session } = require('electron');
const { appendFileSync } = require('node:fs');
Object.defineProperty(app, 'isPackaged', { value: true });
globalThis.__repeatLaunches = 0;
globalThis.__createdWindows = 0;
app.on('second-instance', () => { globalThis.__repeatLaunches += 1; });
app.on('browser-window-created', () => {
  globalThis.__createdWindows += 1;
  const probe = app.commandLine.getSwitchValue('single-instance-probe');
  if (probe) appendFileSync(probe, 'window\\n');
});
globalThis.fetch = async (url) => {
  const target = new URL(url);
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (target.pathname === '/services/SvrUserLogin.getToken') {
    return json({ state: 1, head: { token: 'test-token', corpNo: '100001', homeForm: 'FrmDefault' } });
  }
  // 两份登录都先进入异步补齐阶段，覆盖原有会话检查与开窗之间的竞态。
  if (target.pathname.endsWith('/getTokenInfo')) {
    await new Promise(resolve => setTimeout(resolve, 150));
    return json({ userId: 'test-user', userCode: '10000101', userName: '测试用户', corpNo: '100001' });
  }
  if (target.pathname.endsWith('listMyLivingUsers')) return json({ state: 1, head: {}, body: [{ CorpNo_: '100001', Code_: '10000101', Name_: '测试账套' }] });
  if (target.pathname.endsWith('mqttConfig')) return json({ broker: '' });
  if (target.pathname.endsWith('getUnreadMessage')) return json({ state: 1, data: 0 });
  if (target.pathname === '/public/desktop-agent/notifications') return json({ items: [], nextCursor: null });
  if (target.pathname.endsWith('/logout')) return json({});
  throw new Error('未预期的测试请求：' + target.pathname);
};
app.whenReady().then(() => {
  for (const scheme of ['http', 'https']) session.defaultSession.protocol.handle(scheme, () =>
    new Response('<!doctype html><title>测试首页</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
});
require(${JSON.stringify(entry)});
`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DITENG_AGENT_DEV_URL;
const args = [bootstrap, `--user-data-dir=${userData}`];
let electron;
const children = new Set();

async function waitFor(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}

async function repeatLaunch() {
  const probe = join(directory, `probe-${Date.now()}-${Math.random()}.txt`);
  writeFileSync(probe, '');
  const child = spawn(require('electron'), [...args, `--single-instance-probe=${probe}`], { env, stdio: 'ignore' });
  children.add(child);
  try {
    const [code, signal] = await once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    assert.equal(signal, null, '重复启动应自行退出');
    assert.equal(code, 0, '重复启动应正常退出');
    assert.equal(readFileSync(probe, 'utf8'), '', '第二个进程不得创建窗口');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    children.delete(child);
  }
}

const windows = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
  id: window.id, url: window.webContents.getURL(), isVisible: window.isVisible(),
  isMinimized: window.isMinimized(), isFocused: window.isFocused(),
})));

try {
  electron = await _electron.launch({ args, env, timeout: 25000 });
  await electron.firstWindow();
  await waitFor(async () => (await windows())[0]?.url.startsWith('file:'), '登录窗未加载');
  const pid = electron.process().pid;
  const loginId = (await windows())[0].id;
  assert.equal(await electron.evaluate(({ app }) => app.hasSingleInstanceLock()), true, '首个进程必须持锁');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await Promise.all([repeatLaunch(), repeatLaunch(), repeatLaunch()]);
  await waitFor(async () => {
    const items = await windows();
    return items.length === 1 && items[0].id === loginId && items[0].isVisible && items[0].isFocused;
  }, '重复启动未复用并聚焦登录窗');
  assert.equal(await electron.evaluate(() => globalThis.__repeatLaunches), 3);
  console.log('PASS 连续重复启动：第二进程退出，复用并聚焦登录窗');

  await electron.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const owner = BrowserWindow.getAllWindows()[0].webContents;
    const login = ipcMain._invokeHandlers.get('auth:login');
    const event = { sender: owner };
    await Promise.all([
      login(event, { loginId: 'test-user', password: 'test-only' }),
      login(event, { loginId: 'test-user', password: 'test-only' }),
    ]);
  });
  await waitFor(async () => {
    const items = await windows();
    return items.length === 1 && items[0].url.endsWith('#/main') && items[0].isVisible;
  }, '并发登录后应仅有一个主窗');
  assert.equal(await electron.evaluate(() => globalThis.__createdWindows), 2, '并发登录只能新建一个主窗');
  const mainId = (await windows())[0].id;
  console.log('PASS 并发登录：只创建一个主窗');

  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await waitFor(async () => (await windows())[0].isMinimized, '主窗未最小化');
  await repeatLaunch();
  await waitFor(async () => {
    const [window] = await windows();
    return window.id === mainId && !window.isMinimized && window.isVisible && window.isFocused;
  }, '重复启动未还原最小化主窗');
  console.log('PASS 最小化主窗：重复启动还原并聚焦');

  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal((await windows())[0].isVisible, false, '关闭主窗应隐藏到托盘');
  await repeatLaunch();
  await waitFor(async () => {
    const items = await windows();
    return items.length === 1 && items[0].id === mainId && items[0].isVisible && items[0].isFocused;
  }, '重复启动未显示托盘中的原主窗');
  assert.equal(electron.process().pid, pid, '首次启动的主进程必须保持不变');
  assert.equal(await electron.evaluate(() => globalThis.__createdWindows), 2);
  console.log('PASS 托盘隐藏：重复启动显示原主窗，主进程与窗口均未增加');

  await electron.close();
  electron = await _electron.launch({ args, env, timeout: 25000 });
  await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.hasSingleInstanceLock()), true);
  assert.notEqual(electron.process().pid, pid);
  console.log('PASS 正常退出后释放锁，可再次启动');
} finally {
  for (const child of children) child.kill('SIGKILL');
  await electron?.close();
  rmSync(directory, { recursive: true, force: true });
}
