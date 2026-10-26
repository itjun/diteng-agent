import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import semver from 'semver';

const root = fileURLToPath(new URL('../', import.meta.url));
export function validatePolicy(version, minimumVersion) {
  if (!semver.valid(version) || semver.prerelease(version) || !semver.valid(minimumVersion)
    || semver.prerelease(minimumVersion) || semver.gt(minimumVersion, version)) throw new Error('发布版本与最低版本必须是有效稳定版本，且最低版本不能大于发布版本');
}

/** 在上传前为每个平台的真实更新清单附加策略，并逐文件校验 SHA-512。 */
export function verifyArtifacts(directory, version, minimumVersion, platform, isStamp = false) {
  validatePolicy(version, minimumVersion);
  const expected = { darwin: ['latest-mac.yml'], win32: ['latest.yml'], linux: ['latest-linux.yml', 'latest-linux-arm64.yml'] }[platform];
  if (!expected) throw new Error(`不支持的平台 ${platform}`);
  const files = new Set();
  for (const name of expected) {
    const path = join(directory, name);
    const metadata = parse(readFileSync(path, 'utf8'));
    if (isStamp) { metadata.minimumVersion = minimumVersion; writeFileSync(path, stringify(metadata)); }
    if (metadata.version !== version || metadata.minimumVersion !== minimumVersion || !metadata.files?.length) throw new Error(`${name} 的版本策略不一致或缺少文件`);
    for (const file of metadata.files) {
      const filename = decodeURIComponent(file.url);
      if (filename !== basename(filename) || filename.includes('\\')) throw new Error('更新文件必须位于发布目录');
      const data = readFileSync(join(directory, filename));
      if (createHash('sha512').update(data).digest('base64') !== file.sha512 || (file.size !== undefined && file.size !== data.length)) throw new Error(`${filename} 校验失败`);
      files.add(filename);
    }
  }
  const suffixes = { darwin: ['mac-arm64.dmg', 'mac-x64.dmg', 'mac-arm64.zip', 'mac-x64.zip'], win32: ['win-x64.exe'], linux: ['linux-x64.deb', 'linux-arm64.deb'] }[platform];
  for (const suffix of suffixes) {
    const filename = readdirSync(directory).find(name => name.endsWith(suffix));
    if (!filename || !files.has(filename)) throw new Error(`缺少已校验的 ${suffix}`);
  }
  return [...expected, ...files];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { minimumVersion } = JSON.parse(readFileSync(join(root, 'release-policy.json'), 'utf8'));
  const platform = process.argv[2] || process.platform;
  const files = verifyArtifacts(join(root, 'release'), version, minimumVersion, platform, true);
  console.log(`已校验 ${platform} ${version}（最低 ${minimumVersion}）：${files.join(', ')}`);
}
