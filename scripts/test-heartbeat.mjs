import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function load(file, stubs = {}) {
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    assert.ok(name in stubs, `未预期的依赖：${name}`);
    return stubs[name];
  }, module, module.exports);
  return module.exports;
}

const { heartbeat } = load('src/main/api.ts');
const success = { ok: true, data: null };
const session = () => ({ serverBase: 'https://erp.example.test', machineCode: 'test-device', token: 'current-test-sid', rootToken: 'current-test-sid' });
const flush = () => new Promise(resolve => setImmediate(resolve));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('心跳使用登录服务器、sid 与 CLIENTID，DataSet POST 不透出返回的用户信息', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return json({ state: requests.length === 1 ? 1 : true, head: {}, body: [{ private: '用户信息' }] });
  });
  for (const base of ['https://erp.example.test/', 'http://dev.example.test']) {
    assert.deepEqual(await heartbeat(base, 'sid+&=?', 'device /&', new AbortController().signal), success);
    const { url, options } = requests.at(-1);
    assert.equal(url.origin, new URL(base).origin);
    assert.equal(url.pathname, '/services/TAppHeartbeat.Hello');
    assert.equal(url.searchParams.get('sid'), 'sid+&=?');
    assert.equal(url.searchParams.get('CLIENTID'), 'device /&');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(JSON.parse(new URLSearchParams(options.body).get('dataIn')), { head: { _RecordFilter_: '' }, body: [[]] });
  }
});

test('会话失效、设备不匹配、HTTP 错误及畸形响应都不能当作续期成功', async (t) => {
  for (const state of [0, false, -4, -6]) {
    t.mock.method(globalThis, 'fetch', async () => json({ state, message: '测试拒绝' }));
    const result = await heartbeat(session().serverBase, 'sid', 'device', new AbortController().signal);
    assert.equal(result.ok, false);
    assert.equal(result.code, typeof state === 'number' ? state : 0);
  }
  for (const response of [json({ message: '不可用' }, 503), json(null), new Response('not-json')]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    assert.equal((await heartbeat(session().serverBase, 'sid', 'device', new AbortController().signal)).ok, false);
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal((await heartbeat(session().serverBase, 'sid', 'device', new AbortController().signal)).ok, false);
});

test('心跳请求同时遵守 10 秒超时和外部取消，包括响应体仍在读取的情况', async (t) => {
  for (const isTimeout of [false, true]) {
    const caller = new AbortController();
    const deadline = new AbortController();
    t.mock.method(AbortSignal, 'timeout', (milliseconds) => { assert.equal(milliseconds, 10_000); return deadline.signal; });
    let requestSignal;
    t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
      requestSignal = signal;
      return { ok: true, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
    });
    const request = heartbeat(session().serverBase, 'sid', 'device', caller.signal);
    await flush();
    (isTimeout ? deadline : caller).abort();
    assert.equal(requestSignal.aborted, true);
    assert.equal((await request).ok, false);
  }
});

function setup(t, send = async () => success) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], warnings = [], logs = [];
  t.mock.method(console, 'warn', value => warnings.push(value));
  t.mock.method(console, 'log', value => logs.push(value));
  const { HeartbeatService } = load('src/main/heartbeat-service.ts', {
    './api': { heartbeat: (...args) => { calls.push(args); return send(...args); } },
  });
  const service = new HeartbeatService();
  t.after(() => service.stop());
  return { service, calls, warnings, logs };
}

test('未登录不发送，登录立即续期，相同 sid 去重，重复启动只有一个 15 秒循环', async (t) => {
  const { service, calls } = setup(t);
  await service.refresh();
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 0);
  service.start(session());
  service.start(session());
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(14_999);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2);
  service.stop();
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 2);
});

test('切账套保活原始 sid 和当前 sid，切回原始 sid 后恢复单次续期', async (t) => {
  const { service, calls } = setup(t);
  const original = session();
  service.start(original);
  await flush();
  service.start({ ...original, token: 'switched-test-sid' });
  await flush();
  assert.deepEqual(calls.map(call => call[1]), [original.token, original.token, 'switched-test-sid']);
  service.start(original);
  await flush();
  t.mock.timers.tick(15_000);
  await flush();
  assert.deepEqual(calls.slice(3).map(call => call[1]), [original.token, original.token]);
  assert.ok(calls.every(call => call[0] === original.serverBase && call[2] === original.machineCode));
});

test('原始 sid 失败不阻断当前 sid，断网后定期重试并在恢复后继续续期', async (t) => {
  let isOffline = true;
  const { service, calls, warnings, logs } = setup(t, async (_base, token) =>
    isOffline && token === 'root-test-sid' ? { ok: false, code: -1, message: '敏感 sid 内容' } : success);
  service.start({ ...session(), rootToken: 'root-test-sid' });
  await flush();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(calls.length, 4);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('sid'));
  isOffline = false;
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(calls.length, 6);
  assert.equal(logs.length, 1);
});

test('唤醒立即补发并重排周期，慢请求与连续唤醒不会产生并发心跳', async (t) => {
  let finish;
  const { service, calls } = setup(t, () => new Promise(resolve => { finish = resolve; }));
  service.start(session());
  await service.refresh();
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 1);
  finish(success);
  await flush();
  t.mock.timers.tick(5_000);
  const resumed = service.refresh();
  await service.refresh();
  assert.equal(calls.length, 2);
  finish(success);
  await resumed;
  t.mock.timers.tick(10_000);
  assert.equal(calls.length, 2);
  t.mock.timers.tick(5_000);
  assert.equal(calls.length, 3);
});

test('退出中止在途请求，迟到回包不发送第二个 sid，也不重启定时器', async (t) => {
  let finish;
  const { service, calls, warnings } = setup(t, () => new Promise(resolve => { finish = resolve; }));
  service.start({ ...session(), rootToken: 'root-test-sid' });
  service.stop();
  assert.equal(calls[0][3].aborted, true);
  finish({ ok: false, code: -4, message: '迟到的错误' });
  await flush();
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 0);
});

test('重新登录中止旧请求，旧回包不影响新会话的周期与状态', async (t) => {
  let finishOld;
  const { service, calls, warnings } = setup(t, (_base, token) => token === 'current-test-sid'
    ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(success));
  service.start(session());
  const next = { serverBase: 'https://other.example.test', machineCode: 'next-device', token: 'next-test-sid', rootToken: 'next-test-sid' };
  service.start(next);
  await flush();
  assert.equal(calls[0][3].aborted, true);
  finishOld({ ok: false, code: -4 });
  await flush();
  next.token = 'mutated';
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].slice(0, 3), ['https://other.example.test', 'next-test-sid', 'next-device']);
  assert.equal(warnings.length, 0);
});
