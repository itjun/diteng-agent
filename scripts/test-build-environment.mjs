import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const servers = { main: 'https://m.cdcp.site', dev: 'http://rc.local.lan' };

function fixture(t, environment, stored) {
  const directory = mkdtempSync(join(tmpdir(), 'diteng-build-environment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'main'));
  if (environment !== undefined) writeFileSync(join(directory, 'build-environment.json'), JSON.stringify({ environment }));
  if (stored) writeFileSync(join(directory, 'config.json'), JSON.stringify(stored));
  const modules = new Map();
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const output = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    modules.set(path, module);
    const localRequire = (id) => {
      if (id === 'electron') return { app: { getPath: () => directory } };
      if (id.startsWith('.')) return load(resolve(dirname(path), id + '.ts'));
      return require(id);
    };
    new Function('require', 'module', 'exports', '__dirname', output)(localRequire, module, module.exports, join(directory, 'main'));
    return module.exports;
  }
  return {
    config: () => load(resolve('src/main/config.ts')),
    accounts: () => load(resolve('src/main/saved-accounts.ts')),
    disk: () => JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')),
  };
}

for (const [environment, serverBase] of Object.entries(servers)) {
  test(`${environment} 固定地址，忽略运行时配置更新`, (t) => {
    const { config, disk } = fixture(t, environment);
    assert.equal(config().getConfig().serverBase, serverBase);
    config().updateConfig({ serverBase: 'http://untrusted.invalid', theme: 'dark' });
    config().persistSavedAccounts([], { serverBase: 'http://untrusted.invalid' });
    assert.equal(config().getConfig().serverBase, serverBase);
    assert.equal(disk().serverBase, serverBase);
    assert.equal(disk().theme, 'dark');
  });

  test(`${environment} 同环境升级保留自动登录与设备信息`, (t) => {
    const stored = { configVersion: 2, serverBase: serverBase + '/', savedLoginId: 'same-account', savedPassword: 'test-cipher', machineCode: 'existing-device', autoLogin: true };
    const { config, accounts, disk } = fixture(t, environment, stored);
    const result = config().getConfig();
    assert.equal(result.savedLoginId, stored.savedLoginId);
    assert.equal(result.savedPassword, stored.savedPassword);
    assert.equal(result.machineCode, stored.machineCode);
    assert.equal(accounts().listSavedAccounts()[0].serverBase, serverBase);
    assert.equal(disk().configVersion, 3);
  });

  for (const previousServer of [Object.values(servers).find(value => value !== serverBase), 'http://127.0.0.1:8101', 'http://custom.invalid', '']) {
    test(`${environment} 不沿用其他或未知环境的凭据：${previousServer || '缺地址'}`, (t) => {
      const { config, accounts, disk } = fixture(t, environment, { configVersion: 3, serverBase: previousServer, savedLoginId: 'old-account', savedPassword: 'old-cipher', machineCode: 'existing-device' });
      assert.equal(config().getConfig().serverBase, serverBase);
      assert.equal(config().getConfig().savedPassword, '');
      assert.equal(config().getConfig().savedLoginId, '');
      assert.equal(disk().savedPassword, '');
      assert.deepEqual(accounts().listSavedAccounts(), []);
      assert.equal(accounts().findSavedAccount({ loginId: 'old-account', serverBase: previousServer }), null);
      assert.equal(config().getConfig().savedAccounts[0]?.serverBase, previousServer || undefined);
    });
  }

  test(`${environment} 账号展示、取密码、删除和清空仅作用于当前环境`, (t) => {
    const otherServer = Object.values(servers).find(value => value !== serverBase);
    const savedAccounts = [serverBase, otherServer].map((serverBase, i) => ({ loginId: 'same-name', serverBase, passwordCipher: `cipher-${i}`, lastLoginAt: i + 1 }));
    const { config, accounts } = fixture(t, environment, { serverBase, savedAccounts });
    assert.equal(accounts().listSavedAccounts().length, 1);
    assert.equal(accounts().findSavedAccount({ loginId: 'same-name', serverBase }).passwordCipher, 'cipher-0');
    assert.equal(accounts().findSavedAccount({ loginId: 'same-name', serverBase: otherServer }), null);
    assert.equal(accounts().removeSavedAccount('same-name', otherServer), false);
    assert.equal(accounts().removeSavedAccount('same-name', serverBase), true);
    config().persistSavedAccounts(savedAccounts);
    accounts().clearSavedAccounts();
    assert.deepEqual(accounts().listSavedAccounts(), []);
    assert.deepEqual(config().getConfig().savedAccounts, [savedAccounts[1]]);
  });
}

test('构建环境缺失或非法时启动失败，不静默连接默认服务器', (t) => {
  for (const environment of [undefined, 'other']) {
    assert.throws(() => fixture(t, environment).config());
  }
});
