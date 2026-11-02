import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { EventEmitter } from 'node:events';
import * as nodeOs from 'node:os';

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

const flush = () => new Promise(resolve => setImmediate(resolve));

const TERMINAL_ID = '70416dd8b1d649c29fafc87d06e5678f';
const registration = {
  terminalId: TERMINAL_ID,
  mqttHost: '10.2.1.5',
  mqttPort: 1883,
  mqttUsername: 'mqtt_user',
  mqttPassword: 'secret',
};

/** 每个测试独立加载模块：注册桩、saveTerminalId 桩与 MQTT 假客户端互不串扰 */
function setup(t, respond = async () => ({ ok: true, data: { ...registration } })) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clients = [];
  const registered = [];
  const savedTerminalIds = [];
  const connect = (url, options) => {
    const client = Object.assign(new EventEmitter(), {
      url,
      options,
      connected: false,
      ended: false,
      publishes: [],
      publish(topic, payload, opts, callback) {
        client.publishes.push({ topic, payload: JSON.parse(payload), opts });
        if (typeof callback === 'function') callback();
      },
      end() {
        client.connected = false;
        client.ended = true;
      },
    });
    clients.push(client);
    return client;
  };
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const { TerminalService } = load('src/main/terminal-service.ts', {
    './api': { registerTerminal: async (...args) => { registered.push(args); return respond(...args); } },
    './config': { saveTerminalId: id => savedTerminalIds.push(id) },
    mqtt: { connect },
    electron: { app: { getVersion: () => '0.3.0' } },
    'node:os': nodeOs,
  });
  const service = new TerminalService();
  const session = (token = 'sid-1') => ({ serverBase: 'https://erp.example.test', machineCode: 'DEVICE1234ABCD56', token });
  const connectBroker = (client = clients.at(-1)) => {
    client.connected = true;
    client.emit('connect');
    return client;
  };
  t.after(() => { void service.stop('teardown'); });
  return { service, session, clients, registered, savedTerminalIds, connectBroker };
}

test('登录后注册终端，连接后发布 retained Online，此后每 60 秒发布 Refresh', async (t) => {
  const { service, session, clients, registered, savedTerminalIds, connectBroker } = setup(t);
  service.start(session());
  await flush();
  await flush();
  // 注册入参对齐 SvrTerminalGuest.register（computer/machine_code 经 API 层组装）
  assert.equal(registered.length, 1);
  const [serverBase, token, machineCode, info] = registered[0];
  assert.equal(serverBase, 'https://erp.example.test');
  assert.equal(token, 'sid-1');
  assert.equal(machineCode, 'DEVICE1234ABCD56');
  assert.equal(typeof info.computer, 'string');
  assert.ok(info.operatingSystem.length > 0);
  assert.equal(info.version, '0.3.0');
  assert.deepEqual(savedTerminalIds, [TERMINAL_ID]);
  // MQTT 连接参数对齐 diteng-terminal：clientId={appId}_{machineCode}、keepalive 60、10 秒重连
  const client = clients.at(-1);
  assert.equal(client.url, 'mqtt://10.2.1.5:1883');
  assert.equal(client.options.clientId, 'agent_DEVICE1234ABCD56');
  assert.equal(client.options.keepalive, 60);
  assert.equal(client.options.reconnectPeriod, 10_000);
  assert.equal(client.options.username, 'mqtt_user');
  assert.equal(client.options.password, 'secret');
  // 连接成功 → Online（QoS1 + retained）
  connectBroker(client);
  let publish = client.publishes.at(-1);
  assert.equal(publish.topic, `device/${TERMINAL_ID}/status`);
  assert.deepEqual(publish.opts, { qos: 1, retain: true });
  assert.deepEqual(
    { ...publish.payload, timestamp: 'number' },
    { status: 1, app_id: 'agent', version: '0.3.0', terminal_id: TERMINAL_ID, timestamp: 'number', message: 'Online' },
  );
  // 60 秒后 Refresh；断线状态下跳过发布
  t.mock.timers.tick(60_000);
  assert.equal(client.publishes.at(-1).payload.message, 'Refresh');
  client.connected = false;
  const offlineCount = client.publishes.length;
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(60_000);
  assert.equal(client.publishes.length, offlineCount);
  // 重连成功补发 Online（对齐 doOnOnline）
  connectBroker(client);
  assert.equal(client.publishes.at(-1).payload.message, 'Online');
});

test('系统唤醒立即补发 Refresh', async (t) => {
  const { service, session, connectBroker } = setup(t);
  service.start(session());
  await flush();
  await flush();
  const client = connectBroker();
  const before = client.publishes.length;
  service.refresh();
  assert.equal(client.publishes.length, before + 1);
  assert.equal(client.publishes.at(-1).payload.message, 'Refresh');
  assert.equal(client.publishes.at(-1).payload.status, 1);
});

test('相同会话去重；token 变化重注册，broker 未变时复用现有连接', async (t) => {
  const { service, session, clients, registered } = setup(t);
  service.start(session('sid-1'));
  await flush();
  await flush();
  service.start(session('sid-1'));
  await flush();
  assert.equal(registered.length, 1);
  assert.equal(clients.length, 1);
  // 切账套：token 变化触发重注册，broker 相同 → 不重建连接（心跳不中断）
  service.start(session('sid-2'));
  await flush();
  await flush();
  assert.equal(registered.length, 2);
  assert.equal(registered[1][1], 'sid-2');
  assert.equal(clients.length, 1);
  assert.ok(!clients[0].ended);
});

test('注册失败 60 秒后自动重试，成功后连接并恢复心跳', async (t) => {
  let failing = true;
  const context = setup(t, async () => (failing ? { ok: false, code: -1, message: '无法连接服务器' } : { ok: true, data: { ...registration } }));
  const { service, session, clients, registered } = context;
  service.start(session());
  await flush();
  assert.equal(registered.length, 1);
  assert.equal(clients.length, 0);
  failing = false;
  t.mock.timers.tick(60_000);
  await flush();
  await flush();
  assert.equal(registered.length, 2);
  assert.equal(clients.length, 1);
  // 注册成功后排定心跳
  const client = context.connectBroker();
  t.mock.timers.tick(60_000);
  assert.ok(client.publishes.some(publish => publish.payload.message === 'Refresh'));
});

test('停止时发布 status=0 stop 后断开，重复停止幂等且不再注册', async (t) => {
  const { service, session, clients, registered, connectBroker } = setup(t);
  service.start(session());
  await flush();
  await flush();
  const client = connectBroker();
  await service.stop('quit');
  const publish = client.publishes.at(-1);
  assert.equal(publish.topic, `device/${TERMINAL_ID}/status`);
  assert.deepEqual(publish.opts, { qos: 1, retain: true });
  assert.equal(publish.payload.status, 0);
  assert.equal(publish.payload.message, 'stop');
  assert.ok(client.ended);
  // 幂等：再次停止不产生新报文
  const count = client.publishes.length;
  await service.stop('quit');
  assert.equal(client.publishes.length, count);
  // 停止后不再心跳、不再重试注册
  t.mock.timers.tick(120_000);
  assert.equal(client.publishes.length, count);
  assert.equal(registered.length, 1);
});

test('迟到的注册回包不触碰新会话状态', async (t) => {
  const resolvers = [];
  const context = setup(t, () => new Promise(resolve => { resolvers.push(resolve); }));
  const { service, session, clients, savedTerminalIds } = context;
  service.start(session('sid-1'));
  await flush();
  // 第一笔注册在途时切换会话：旧回包必须被丢弃
  service.start(session('sid-2'));
  await flush();
  assert.equal(resolvers.length, 2);
  resolvers[0]({ ok: true, data: { ...registration, terminalId: 'STALE0000000000000000000000X' } });
  await flush();
  await flush();
  assert.deepEqual(savedTerminalIds, []);
  // 新会话的回包正常生效
  resolvers[1]({ ok: true, data: { ...registration } });
  await flush();
  await flush();
  assert.deepEqual(savedTerminalIds, [TERMINAL_ID]);
  assert.equal(clients.length, 1);
  assert.ok(clients.every(client => client.publishes.length === 0));
  await service.stop('quit');
});
