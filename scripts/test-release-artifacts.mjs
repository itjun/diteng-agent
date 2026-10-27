import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';
import { validatePolicy, verifyArtifacts } from './release-artifacts.mjs';

function fixture(t, platform) {
  const directory = mkdtempSync(join(tmpdir(), 'diteng-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const suffixes = { darwin: ['mac-arm64.dmg', 'mac-x64.dmg', 'mac-arm64.zip', 'mac-x64.zip'], win32: ['win-x64.exe'], linux: ['linux-amd64.deb', 'linux-arm64.deb'] }[platform];
  const files = suffixes.map(suffix => {
    const name = `diteng-agent-0.3.0-${suffix}`, data = Buffer.from(`installer ${suffix}`);
    writeFileSync(join(directory, name), data);
    return { url: name, sha512: createHash('sha512').update(data).digest('base64'), size: data.length };
  });
  const metadata = { darwin: { 'latest-mac.yml': files }, win32: { 'latest.yml': files }, linux: { 'latest-linux.yml': [files[0]], 'latest-linux-arm64.yml': [files[1]] } }[platform];
  for (const [name, subset] of Object.entries(metadata)) writeFileSync(join(directory, name), JSON.stringify({ version: '0.3.0', files: subset }));
  return { directory, files, metadata };
}

test('发布策略拒绝最低版本大于新版、预发布版本和无效版本', () => {
  for (const versions of [['bad', '0.2.4'], ['0.3.0', '0.4.0'], ['0.3.0-beta.1', '0.2.4'], ['0.3.0', 'bad']]) assert.throws(() => validatePolicy(...versions));
  validatePolicy('0.10.0', '0.9.0');
});
for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform} 的真实文件哈希、架构完整性和最低版本清单统一验证`, t => {
    const { directory, files, metadata } = fixture(t, platform);
    assert.throws(() => verifyArtifacts(directory, '0.3.0', '0.2.4', platform));
    verifyArtifacts(directory, '0.3.0', '0.2.4', platform, true);
    for (const name of Object.keys(metadata)) assert.equal(parse(readFileSync(join(directory, name), 'utf8')).minimumVersion, '0.2.4');
    writeFileSync(join(directory, files[0].url), 'corrupt');
    assert.throws(() => verifyArtifacts(directory, '0.3.0', '0.2.4', platform), /校验失败/);
  });
}
test('缺少任一架构的安装包会阻止公开 Release', t => {
  const { directory, files } = fixture(t, 'darwin');
  const metadata = { version: '0.3.0', minimumVersion: '0.2.4', files: files.filter(file => !file.url.endsWith('mac-x64.zip')) };
  writeFileSync(join(directory, 'latest-mac.yml'), JSON.stringify(metadata));
  assert.throws(() => verifyArtifacts(directory, '0.3.0', '0.2.4', 'darwin'), /缺少已校验/);
});
test('版本提升预演不修改 package.json，不创建提交或标签', () => {
  const before = readFileSync('package.json', 'utf8');
  const result = spawnSync(process.execPath, ['scripts/release.mjs', 'patch', '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /macOS arm64\/x64.*Windows x64.*Linux deb/);
  assert.equal(readFileSync('package.json', 'utf8'), before);
});
test('正式发布使用免签名 macOS 配置，无需苹果证书', () => {
  const env = { ...process.env, RELEASE_PUBLISH: 'true' };
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) delete env[key];
  const result = spawnSync(process.execPath, ['-e', "const c = require('./electron-builder.release.cjs').mac; process.stdout.write(JSON.stringify({ identity: c.identity, hardenedRuntime: c.hardenedRuntime, notarize: c.notarize }))"], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { identity: null, hardenedRuntime: false, notarize: false });
});
