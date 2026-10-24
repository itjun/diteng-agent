import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, stubs = {}) {
  const filename = resolve(file);
  const source = readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => name in stubs ? stubs[name] : name.startsWith('.') ? load(resolve(dirname(filename), `${name}.ts`), stubs) : require(name);
  new Function('require', 'module', 'exports', '__dirname', output)(localRequire, module, module.exports, dirname(filename));
  return module.exports;
}
const { CorpSwitchCoordinator } = load('src/main/corp-switch.ts');
const { isShellEntryUrl } = load('src/main/shell-origin.ts');
const base = () => ({ serverBase: 'https://erp.example.test', token: 'test-sid', rootToken: 'test-sid', userId: 'account-a', userCode: 'a1', corpNo: '100001', corpName: '甲账套', homeForm: 'FrmDefault', machineCode: 'test-device', userName: '测试用户' });
const target = { corpNo: '100002', userCode: 'a2', sourceWebContentsId: 42 };

test('打包壳允许准确入口hash路由，拒绝其他本地文件或远程伪造', () => {
  assert.equal(isShellEntryUrl('file:///tmp/app/index.html#/main', '/tmp/app/index.html'), true);
  assert.equal(isShellEntryUrl('file:///tmp/app/index.html#/notify-popup', '/tmp/app/index.html'), true);
  assert.equal(isShellEntryUrl('file:///tmp/other/index.html#/main', '/tmp/app/index.html'), false);
  assert.equal(isShellEntryUrl('https://evil.test/index.html#/main', '/tmp/app/index.html'), false);
});

const deferred = () => { let resolve; const promise = new Promise((value) => { resolve = value; }); return { promise, resolve }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(overrides = {}, timeout = 1000) {
  let session = base();
  const commits = [], reports = [];
  let settled = 0;
  const coordinator = new CorpSwitchCoordinator({
    getSession: () => session, confirm: async () => true, isSourceAlive: () => true,
    verify: async () => ({ ...session, corpNo: target.corpNo, userCode: target.userCode }),
    commit: (next, source, generation) => { session = next; commits.push({ next, source, generation }); },
    report: (message) => reports.push(message), settled: () => { settled += 1; }, ...overrides,
  }, timeout);
  return { coordinator, commits, reports, setSession: (value) => { session = value; }, get settled() { return settled; } };
}

test('取消确认不发请求、不改身份或关页', async () => {
  const state = setup({ confirm: async () => false });
  assert.equal(await state.coordinator.begin(target), null);
  assert.equal(state.commits.length, 0); assert.equal(state.coordinator.isBlocked(), false);
});

test('同时切换同步占锁，只放行第一份原请求', async () => {
  const confirm = deferred();
  const state = setup({ confirm: () => confirm.promise });
  const first = state.coordinator.begin(target);
  assert.equal(await state.coordinator.begin({ ...target, corpNo: '100003' }), null);
  confirm.resolve(true);
  const ticket = await first;
  assert.equal(state.coordinator.markSent(ticket), true);
  await state.coordinator.complete(ticket);
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].source.sourceWebContentsId, 42);
});

test('HTTP失败但服务器身份已切换仍按权威身份提交，保留发起guest', async () => {
  const state = setup();
  const ticket = await state.coordinator.begin(target);
  state.coordinator.markSent(ticket);
  const result = await state.coordinator.complete(ticket);
  assert.equal(result.ok, true); assert.equal(state.commits[0].source.sourceWebContentsId, 42);
  assert.equal(state.commits[0].next.corpNo, '100002'); assert.equal(state.coordinator.isBlocked(), false);
});

test('HTTP失败且服务器身份未变化，保留原所有页并解除切换锁', async () => {
  const state = setup({ verify: async (ticket) => ({ ...ticket.session }) });
  const ticket = await state.coordinator.begin(target); state.coordinator.markSent(ticket);
  assert.equal((await state.coordinator.complete(ticket)).ok, false);
  await flush(); assert.equal(state.commits.length, 0); assert.equal(state.settled, 1);
});

test('身份核验失败暂停请求，恢复核验后只提交一次', async () => {
  let isOnline = false;
  const state = setup({ verify: async (ticket) => isOnline ? ({ ...ticket.session, ...target }) : null });
  const ticket = await state.coordinator.begin(target); state.coordinator.markSent(ticket);
  await state.coordinator.complete(ticket); await flush();
  assert.equal(state.coordinator.isUncertain(), true); assert.equal(state.settled, 0);
  isOnline = true;
  assert.equal((await state.coordinator.retryVerification()).ok, true);
  assert.equal(state.commits.length, 1); assert.equal(state.coordinator.isBlocked(), false);
});

test('换票后核验暂失败，重试仍核验新token而非退回旧token', async () => {
  let isOnline = false;
  const tokens = [];
  const state = setup({ verify: async (ticket, token) => { tokens.push(token); return isOnline ? { ...ticket.session, ...target, token } : null; } });
  const ticket = await state.coordinator.begin(target); state.coordinator.markSent(ticket);
  await state.coordinator.complete(ticket, 'new-test-token');
  isOnline = true; await state.coordinator.retryVerification();
  assert.deepEqual(tokens, ['new-test-token', 'new-test-token']);
  assert.equal(state.commits[0].next.token, 'new-test-token');
});

test('发起页确认前关闭取消；发出后关闭仍核验已变身份', async () => {
  const confirm = deferred();
  const before = setup({ confirm: () => confirm.promise });
  const pending = before.coordinator.begin(target); before.coordinator.sourceClosed(42); confirm.resolve(true);
  assert.equal(await pending, null); assert.equal(before.commits.length, 0);
  const after = setup();
  const ticket = await after.coordinator.begin(target); after.coordinator.markSent(ticket); after.coordinator.sourceClosed(42);
  await flush(); assert.equal(after.commits.length, 1);
});

test('旧回包不覆盖退出后新会话，未放行超时不永久占锁', async () => {
  const verification = deferred();
  const state = setup({ verify: () => verification.promise });
  const ticket = await state.coordinator.begin(target); state.coordinator.markSent(ticket);
  const response = state.coordinator.complete(ticket);
  state.coordinator.reset(); state.setSession({ ...base(), userId: 'account-b' });
  verification.resolve({ ...base(), ...target }); await response;
  assert.equal(state.commits.length, 0);
  const confirm = deferred(); const timed = setup({ confirm: () => confirm.promise }, 15);
  const beginning = timed.coordinator.begin(target); await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(timed.coordinator.isBlocked(), false); confirm.resolve(true); assert.equal(await beginning, null);
});

test('原换票请求只放行一次，目标导航带新票核验，旧guest与预检独立处理', async () => {
  const callbacks = {};
  const owner = {};
  const guests = new Map();
  const makeGuest = (id) => { const guest = new EventEmitter(); Object.assign(guest, { id, hostWebContents: owner, isDestroyed: () => false, getURL: () => `${base().serverBase}/100001/FrmDefault`, executeJavaScript: async () => {} }); guests.set(id, guest); return guest; };
  const { ErpRequestGate } = load('src/main/erp-request-gate.ts', { electron: { session: { defaultSession: { webRequest: Object.fromEntries(['onBeforeRequest', 'onBeforeSendHeaders', 'onCompleted', 'onErrorOccurred', 'onBeforeRedirect'].map(name => [name, callback => { callbacks[name] = callback; }])) } }, webContents: { fromId: id => guests.get(id) } } });
  let current = base(); let confirms = 0; const verifiedTokens = [];
  let gate;
  const coordinator = new CorpSwitchCoordinator({ getSession: () => current, confirm: async () => { confirms++; return true; }, isSourceAlive: () => true,
    verify: async (_ticket, token) => { verifiedTokens.push(token); return {...current, ...target, token}; },
    commit: (next, target, generation) => { current = next; gate.commit(target.sourceWebContentsId, next, generation); }, report: () => {} });
  gate = new ErpRequestGate({coordinator, getSession: () => current, getCorps: () => [{corpNo:'100002', code:'a2'}], aiBase: () => 'https://ai.example.test', getOwner: () => owner, switchTo: async () => false, verifyNavigation: async () => false});
  gate.register(makeGuest(42)); gate.register(makeGuest(43)); gate.install();
  let answers = 0;
  const request = (details) => new Promise(resolve => callbacks.onBeforeRequest({id:1,webContentsId:42,method:'GET',resourceType:'xhr',...details}, result => { answers++; resolve(result); }));
  assert.equal((await request({method:'OPTIONS',url:`${current.serverBase}/services/SvrTerminal.getNuewToken`})).cancel,false);
  assert.equal(confirms,0);
  const exchangeUrl=`${current.serverBase}/services/SvrTerminal.getNuewToken`;
  assert.equal((await request({method:'POST',url:exchangeUrl,uploadData:[{bytes:Buffer.from(new URLSearchParams({dataIn:JSON.stringify({head:{target_book:'100002'}})}).toString())}]})).cancel,false);
  callbacks.onCompleted({id:1});
  assert.equal(coordinator.isBlocked(),true); assert.equal(verifiedTokens.length,0);
  assert.equal((await request({id:2,resourceType:'mainFrame',url:`${current.serverBase}/100002/FrmDefault?sid=exchanged-test-token`})).cancel,false);
  assert.deepEqual(verifiedTokens,['exchanged-test-token']); assert.equal(confirms,1); assert.equal(answers,3);
  const headers = await new Promise(resolve => callbacks.onBeforeSendHeaders({webContentsId:42,url:`${current.serverBase}/100002/FrmDefault`,requestHeaders:{}},resolve));
  assert.equal(headers.requestHeaders['X-Diteng-Expected-Corp-No'],'100002');
  assert.equal((await request({id:3,webContentsId:43,url:`${current.serverBase}/100001/FrmDefault`})).cancel,true);
  coordinator.reset(); gate.reset();
});
