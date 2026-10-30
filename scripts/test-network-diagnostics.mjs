import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, stubs = {}) {
  const filename = resolve(file);
  const source = readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => name in stubs ? stubs[name] : name.startsWith('.') ? load(resolve(dirname(filename), `${name}.ts`), stubs) : require(name);
  new Function('require', 'module', 'exports', '__dirname', output)(localRequire, module, module.exports, dirname(filename));
  return module.exports;
}

const { buildTargets, gradeFor, isRemoteBase, measurePhases, overallVerdict, summarizeSamples, createNetworkDiagnosticsService } =
  load('src/main/network-diagnostics.ts', { electron: { net: { fetch: async () => { throw new Error('默认 fetch 不应被使用'); } } } });

const ok = (ttfbMs) => ({ ok: true, ttfbMs });
const fail = () => ({ ok: false, ttfbMs: 0 });

test('评级阈值：全失败不可用，有失败/中位>500 较差，中位/抖动分级', () => {
  assert.equal(gradeFor(8, 0, null, null), 'down');
  assert.equal(gradeFor(8, 7, 30, 5), 'poor');
  assert.equal(gradeFor(8, 8, 501, 0), 'poor');
  assert.equal(gradeFor(8, 8, 500, 80), 'fair');
  assert.equal(gradeFor(8, 8, 201, 0), 'fair');
  assert.equal(gradeFor(8, 8, 200, 81), 'fair');
  assert.equal(gradeFor(8, 8, 101, 40), 'good');
  assert.equal(gradeFor(8, 8, 100, 41), 'good');
  assert.equal(gradeFor(8, 8, 100, 40), 'excellent');
  assert.equal(gradeFor(8, 8, 30, 5), 'excellent');
});

test('summarizeSamples：中位数/均值/抖动只统计成功样本，进度字段随样本增长', () => {
  const [frontend] = buildTargets('https://erp.example.test', 'https://ai.example.test').filter(t => t.key === 'frontend');
  const stat = summarizeSamples(frontend, [ok(10), ok(20), ok(30), ok(40)], 8);
  assert.equal(stat.total, 8);
  assert.equal(stat.completed, 4);
  assert.equal(stat.success, 4);
  assert.equal(stat.medianMs, 25);
  assert.equal(stat.avgMs, 25);
  assert.equal(stat.jitterMs, 11); // [10,20,30,40] 总体标准差 sqrt(125) ≈ 11.18
  assert.equal(stat.maxMs, 40);
  assert.equal(stat.grade, 'excellent');
  assert.equal(stat.documentMs, null);
  const withDocument = summarizeSamples(frontend, [{ ok: true, ttfbMs: 12, totalMs: 80, bytes: 4096 }, ok(10)], 8);
  assert.equal(withDocument.documentMs, 80);
  assert.equal(withDocument.documentBytes, 4096);
  const failed = summarizeSamples(frontend, [fail(), fail()], 8);
  assert.equal(failed.medianMs, null);
  assert.equal(failed.jitterMs, null);
  assert.equal(failed.grade, 'down');
  const mixed = summarizeSamples(frontend, [ok(30), fail()], 8);
  assert.equal(mixed.success, 1);
  assert.equal(mixed.jitterMs, null); // 单样本无法评估抖动
  assert.equal(mixed.grade, 'poor');
});

test('buildTargets：后端免鉴权接口 + 本地 AI 地址跳过', () => {
  const targets = buildTargets('https://m.example.test/', 'https://ai.example.test');
  assert.deepEqual(targets.map(t => t.key), ['internet', 'frontend', 'backend', 'ai']);
  assert.equal(targets[1].url, 'https://m.example.test/');
  assert.equal(targets[2].url, 'https://m.example.test/services/SvrUserLogin.getToken');
  assert.equal(targets[2].method, 'POST');
  assert.match(targets[2].body, /^dataIn=/);
  assert.equal(targets[3].skipped, false);
  const dev = buildTargets('http://rc.local.lan', 'http://127.0.0.1:3060');
  assert.equal(dev[3].skipped, true);
  assert.equal(dev[3].url, 'http://127.0.0.1:3060/');
  assert.equal(isRemoteBase('https://ai.example.test'), true);
  assert.equal(isRemoteBase('http://localhost:3060'), false);
  assert.equal(isRemoteBase('not-a-url'), false);
});

function statOf(key, samples) {
  const target = buildTargets('https://erp.example.test', 'https://ai.example.test').find(t => t.key === key);
  return summarizeSamples(target, samples, samples.length);
}

test('overallVerdict：总体取前端/后端较差者，建议按场景区分', () => {
  const down = overallVerdict([
    statOf('internet', [ok(20), ok(25)]),
    statOf('frontend', [fail(), fail()]),
    statOf('backend', [fail(), fail()]),
    statOf('ai', [ok(30)]),
  ]);
  assert.equal(down.grade, 'down');
  assert.match(down.advice, /无法连接服务器/);
  const localNetworkDown = overallVerdict([
    statOf('internet', [fail(), fail()]),
    statOf('frontend', [fail(), fail()]),
    statOf('backend', [fail(), fail()]),
    statOf('ai', [fail()]),
  ]);
  assert.equal(localNetworkDown.grade, 'down');
  assert.match(localNetworkDown.advice, /无法访问外网/);
  const unstable = overallVerdict([
    statOf('internet', [ok(20)]),
    statOf('frontend', [ok(30), ok(1200)]),
    statOf('backend', [ok(40)]),
    statOf('ai', [ok(50)]),
  ]);
  assert.equal(unstable.grade, 'poor');
  assert.match(unstable.advice, /不稳定/);
  const healthy = overallVerdict([
    statOf('internet', [ok(20), ok(22)]),
    statOf('frontend', [ok(30), ok(35)]),
    statOf('backend', [ok(40), ok(42)]),
    statOf('ai', [ok(50)]),
  ]);
  assert.equal(healthy.grade, 'excellent');
  assert.match(healthy.summary, /优秀/);
  assert.match(healthy.advice, /稳定可靠/);
});

test('measurePhases：分段计时并按 https 决定 TLS 段', async () => {
  const deps = {
    dnsLookup: async () => 5.6,
    tcpConnect: async () => 20.2,
    tlsConnect: async () => 30.9,
    timeoutMs: 1000,
  };
  const https = await measurePhases('https://erp.example.test:8443/base', deps);
  assert.deepEqual(https, { dnsMs: 5, tcpMs: 20, tlsMs: 30, error: '' });
  const http = await measurePhases('http://erp.example.test', deps);
  assert.equal(http.tlsMs, null);
  assert.equal(http.error, '');
  const failing = await measurePhases('https://erp.example.test', {
    dnsLookup: async () => { throw new Error('dns'); },
    tcpConnect: async () => { throw new Error('tcp'); },
    tlsConnect: async () => { throw new Error('tls'); },
    timeoutMs: 100,
  });
  assert.equal(failing.dnsMs, null);
  assert.equal(failing.tcpMs, null);
  assert.equal(failing.tlsMs, null);
  assert.match(failing.error, /DNS 解析失败/);
  assert.match(failing.error, /TCP 连接失败/);
  assert.match(failing.error, /TLS 握手失败/);
});

/** 构造 ResponseLike：chunks 为依次读出的字节，读取完毕后 done */
function fakeResponse(chunks = [], status = 200) {
  const queue = [...chunks];
  return {
    ok: status < 400,
    status,
    body: {
      getReader: () => ({
        read: async () => queue.length ? { done: false, value: queue.shift() } : { done: true },
        cancel: async () => {},
      }),
      cancel: async () => {},
    },
  };
}

const text = (value) => new TextEncoder().encode(value);

/** 按探针 URL 分发的假 fetch：serverBase 域可配置为拒绝（模拟服务器不可达） */
function fakeFetch({ serverDown = false, frontendChunks = [text('<html>')], latencyMs = 1 } = {}) {
  return async (url) => {
    await new Promise(resolve => setTimeout(resolve, latencyMs));
    if (serverDown && /erp\.example\.test/.test(url)) throw new TypeError('fetch failed');
    if (/api64\.ipify\.org/.test(url)) return fakeResponse([text('203.0.113.7')]);
    if (/\/services\/SvrUserLogin\.getToken$/.test(url)) return fakeResponse([], 200);
    if (/^https:\/\/ai\.example\.test\//.test(url)) return fakeResponse([text('ok')]);
    return fakeResponse(frontendChunks);
  };
}

test('service：逐探针推流进度，结束输出汇总与结论（AI 站点计入目标）', async () => {
  const service = createNetworkDiagnosticsService({
    fetchImpl: fakeFetch(),
    probeCount: 3,
    pacingMs: 0,
    phases: { dnsLookup: async () => 5, tcpConnect: async () => 20, tlsConnect: async () => 30, timeoutMs: 1000 },
  });
  const states = [];
  const result = await service.start({ serverBase: 'https://erp.example.test', aiBase: 'https://ai.example.test' }, state => states.push(state));
  assert.equal(result.ok, true);
  assert.equal(service.getState().status, 'done');
  const first = states[0];
  assert.equal(first.status, 'running');
  assert.equal(first.totalProbes, 12); // 4 目标 × 3 探针
  assert.deepEqual(first.targets.map(t => t.key), ['internet', 'frontend', 'backend', 'ai']);
  const last = states[states.length - 1];
  assert.equal(last.status, 'done');
  assert.equal(last.completedProbes, 12);
  assert.deepEqual(last.targets.map(t => t.completed), [3, 3, 3, 3]);
  assert.equal(last.overall.grade, 'excellent');
  assert.deepEqual(last.phases, { dnsMs: 5, tcpMs: 20, tlsMs: 30, error: '' });
  // 进度单调递增且目标顺序稳定
  for (let index = 1; index < states.length; index++) {
    assert.ok(states[index].completedProbes >= states[index - 1].completedProbes);
    assert.deepEqual(states[index].targets.map(t => t.key), ['internet', 'frontend', 'backend', 'ai']);
  }
  // 前端目标记录文档下载
  const frontend = last.targets.find(t => t.key === 'frontend');
  assert.equal(frontend.documentBytes, 6);
  assert.ok(frontend.documentMs >= 0);
});

test('service：本地 AI 地址跳过不计入进度；服务器不可达时结论为不可用并给出建议', async () => {
  const service = createNetworkDiagnosticsService({
    fetchImpl: fakeFetch({ serverDown: true }),
    probeCount: 2,
    pacingMs: 0,
    phases: { dnsLookup: async () => 5, tcpConnect: async () => { throw new Error('tcp'); }, tlsConnect: async () => { throw new Error('tls'); } },
  });
  const states = [];
  await service.start({ serverBase: 'https://erp.example.test', aiBase: 'http://127.0.0.1:3060' }, state => states.push(state));
  const last = states[states.length - 1];
  assert.equal(last.totalProbes, 6); // 外网 + 前端 + 后端，AI 跳过
  assert.equal(last.completedProbes, 6);
  assert.equal(last.targets.find(t => t.key === 'ai').skipped, true);
  assert.equal(last.targets.find(t => t.key === 'frontend').grade, 'down');
  assert.equal(last.targets.find(t => t.key === 'backend').grade, 'down');
  assert.equal(last.targets.find(t => t.key === 'internet').grade, 'excellent');
  assert.equal(last.overall.grade, 'down');
  assert.match(last.overall.advice, /无法连接服务器/);
});

test('service：检测进行中重复发起返回失败', async () => {
  const service = createNetworkDiagnosticsService({
    fetchImpl: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return fakeResponse([text('203.0.113.7')]);
    },
    probeCount: 2,
    pacingMs: 0,
    phases: { dnsLookup: async () => 5, tcpConnect: async () => 20, tlsConnect: async () => 30 },
  });
  const firstStart = service.start({ serverBase: 'https://erp.example.test', aiBase: 'https://ai.example.test' }, () => {});
  const second = await service.start({ serverBase: 'https://erp.example.test', aiBase: 'https://ai.example.test' }, () => {});
  assert.equal(second.ok, false);
  assert.match(second.message, /正在进行中/);
  assert.equal((await firstStart).ok, true);
  assert.equal(service.getState().status, 'done');
});
