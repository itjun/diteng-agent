import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const module = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(readFileSync(new URL('../src/main/update-service.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(createRequire(import.meta.url), module, module.exports);
const { UpdateService, parseUpdatePolicy } = module.exports;
const policy = (version = '0.3.0', minimumVersion = '0.2.4') => ({ version, minimumVersion });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0, downloads = 0, installs = 0, confirmations = 0;
  let cached = options.cached;
  const preferences = { autoCheckUpdates: true, autoDownloadUpdates: false, ...options.preferences };
  updater.checkForUpdates = async () => { checks++; return { updateInfo: options.info || policy() }; };
  updater.downloadUpdate = async () => { downloads++; return ['installer']; };
  updater.quitAndInstall = () => { installs++; };
  const states = [];
  const service = new UpdateService({ currentVersion: '0.2.4', disabledReason: '', updater,
    readPreferences: () => preferences, readPolicy: () => cached, savePolicy: value => { cached = value; },
    onChanged: state => states.push(state), prepareInstall: async () => { confirmations++; return true; }, ...options.hooks });
  return { service, updater, states, preferences, counts: () => ({ checks, downloads, installs, confirmations }) };
}

test('严格比较稳定版、预发布版本，拒绝非法与矛盾策略', () => {
  for (const input of [null, {}, policy('0.3.0'), policy('bad', '0.2.4'), policy('0.3.0', '0.4.0')]) {
    if (input?.version === '0.3.0' && input.minimumVersion === '0.2.4') continue;
    assert.throws(() => parseUpdatePolicy(input));
  }
  assert.deepEqual(parseUpdatePolicy(policy('0.3.0-beta.1', '0.2.4')), policy('0.3.0-beta.1', '0.2.4'));
  assert.equal(fixture({ cached: policy('0.10.0', '0.9.0') }).service.getState().isRequired, true);
});

test('重复检查共用同一请求，最低版本与最近检查时间来自更新源', async () => {
  const f = fixture();
  const a = f.service.check(), b = f.service.check(true);
  assert.equal(a, b);
  assert.equal(f.service.getState().status, 'checking');
  await a;
  assert.equal(f.counts().checks, 1);
  assert.equal(f.service.getState().status, 'available');
  assert.equal(f.service.getState().minimumVersion, '0.2.4');
  assert.ok(f.service.getState().checkedAt);
  assert.equal(f.service.getState().isManual, true);
});

test('相同或旧版本均不下载，不允许版本降级与预发布通道', async () => {
  for (const version of ['0.2.4', '0.2.3']) {
    const f = fixture({ info: policy(version, '0.2.0'), preferences: { autoDownloadUpdates: true } });
    await f.service.check(); await tick();
    assert.equal(f.service.getState().status, 'latest');
    assert.equal(f.counts().downloads, 0);
    assert.equal(f.updater.allowDowngrade, false);
    assert.equal(f.updater.allowPrerelease, false);
  }
});

test('自动下载不阻塞启动兼容检查；手动入口与后台共用下载闸门', async () => {
  const f = fixture({ preferences: { autoDownloadUpdates: true } });
  let finish;
  f.updater.downloadUpdate = () => new Promise(resolve => { finish = resolve; });
  f.service.start();
  assert.equal(await f.service.isCompatible(), true);
  await tick();
  assert.equal(f.service.getState().status, 'downloading');
  const a = f.service.download(), b = f.service.download();
  assert.equal(a, b);
  f.updater.emit('download-progress', { percent: 48.5 });
  assert.equal(f.service.getState().progress, 48.5);
  finish(['installer']); await a;
  assert.equal(f.service.getState().status, 'downloaded');
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  f.service.stop();
});

test('最低版本要求重启离线仍生效，旧发布源不能解除或下载低于要求的版本', async () => {
  const f = fixture({ cached: policy('0.4.0', '0.3.0'), info: policy('0.2.5', '0.2.4') });
  await f.service.check();
  assert.equal(f.service.getState().isRequired, true);
  assert.equal(f.service.getState().status, 'error');
  assert.equal(await f.service.isCompatible(), false);
  assert.equal(f.counts().downloads, 0);
  f.updater.checkForUpdates = async () => { throw new Error('offline'); };
  await f.service.check();
  assert.equal(await f.service.isCompatible(), false);
});

test('检查失败、无效策略与超时均可恢复重试，不清除已知策略', async () => {
  const f = fixture({ hooks: { checkTimeoutMs: 10 } });
  f.updater.checkForUpdates = () => new Promise(() => {});
  await f.service.check();
  assert.equal(f.service.getState().status, 'error');
  f.updater.checkForUpdates = async () => ({ updateInfo: policy('0.3.0', 'invalid') });
  await f.service.check(); assert.equal(f.service.getState().status, 'error');
  f.updater.checkForUpdates = async () => ({ updateInfo: policy() });
  await f.service.check(); assert.equal(f.service.getState().status, 'available');
});

test('下载失败不会标记就绪，重新检查后可再次下载', async () => {
  const f = fixture(); await f.service.check();
  f.updater.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  await f.service.download();
  assert.equal(f.service.getState().status, 'error');
  await f.service.install(); assert.equal(f.counts().installs, 0);
  await f.service.check(); f.updater.downloadUpdate = async () => ['installer'];
  await f.service.download(); assert.equal(f.service.getState().status, 'downloaded');
});

test('安装入口同步防重；取消确认保持就绪，安装错误会显示失败', async () => {
  let approve;
  const f = fixture({ hooks: { prepareInstall: () => new Promise(resolve => { approve = resolve; }) } });
  await f.service.check(); await f.service.download();
  const first = f.service.install();
  await f.service.install(); assert.equal(f.counts().installs, 0);
  approve(false); await first;
  assert.equal(f.service.getState().status, 'downloaded');
  const next = f.service.install(); approve(true); await next;
  assert.equal(f.counts().installs, 1);
  f.updater.emit('error', new Error('permission denied'));
  assert.equal(f.service.getState().status, 'error');
});

test('自动检查开关控制启动和周期，stop 释放定时器；开发构建不联网', async () => {
  const f = fixture({ preferences: { autoCheckUpdates: false }, hooks: { checkIntervalMs: 10 } });
  f.service.start(); f.service.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.counts().checks, 0);
  f.preferences.autoCheckUpdates = true;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(f.counts().checks >= 1);
  f.service.stop(); const count = f.counts().checks;
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(f.counts().checks, count);
  const dev = fixture({ cached: policy('1.0.0', '1.0.0'), hooks: { disabledReason: 'dev' } });
  dev.service.start(); await dev.service.check();
  assert.equal(dev.counts().checks, 0);
  assert.equal(dev.service.getState().isRequired, false);
});
