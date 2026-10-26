import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { validatePolicy } from './release-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const requested = args.filter(arg => arg !== '--dry-run');
if (requested.length !== 1) throw new Error('用法：pnpm release <patch|minor|major|版本号> [--dry-run]');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = ['patch', 'minor', 'major'].includes(requested[0]) ? semver.inc(pkg.version, requested[0]) : requested[0];
const { minimumVersion } = JSON.parse(readFileSync(new URL('../release-policy.json', import.meta.url), 'utf8'));
validatePolicy(version, minimumVersion);
if (!semver.gt(version, pkg.version)) throw new Error('新版本必须大于当前版本');
console.log(`发布计划：${pkg.version} → ${version}；最低版本 ${minimumVersion}；macOS arm64/x64、Windows x64、Linux deb x64/arm64`);
if (!isDryRun) {
  function run(command, params, isCapture = false) {
    const result = spawnSync(command, params, { cwd: root, encoding: 'utf8', stdio: isCapture ? 'pipe' : 'inherit', shell: process.platform === 'win32' && command === 'pnpm' });
    if (result.error || result.status !== 0) throw result.error || new Error(`${command} 执行失败`);
    return result.stdout?.trim();
  }
  if (run('git', ['status', '--porcelain'], true)) throw new Error('请先提交工作区改动');
  if (run('git', ['branch', '--show-current'], true) !== 'main') throw new Error('请在 main 分支发布');
  run('git', ['fetch', 'origin', 'main', '--tags']);
  if (run('git', ['rev-parse', 'HEAD'], true) !== run('git', ['rev-parse', 'origin/main'], true)) throw new Error('main 必须先与远程同步');
  const tags = run('git', ['tag', '--list', `v${version}`], true);
  if (tags) throw new Error('版本标签已存在');
  const secrets = JSON.parse(run('gh', ['secret', 'list', '--json', 'name'], true)).map(secret => secret.name);
  const required = ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'MAC_CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const missing = required.filter(name => !secrets.includes(name));
  if (missing.length) throw new Error(`正式发布前请配置仓库 Secrets：${missing.join(', ')}`);
  run('pnpm', ['typecheck']);
  run('pnpm', ['test']);
  pkg.version = version;
  writeFileSync(new URL('../package.json', import.meta.url), JSON.stringify(pkg, null, 2) + '\n');
  run('git', ['add', '--', 'package.json']);
  run('git', ['commit', '-m', `发布 v${version}`]);
  run('git', ['tag', '-a', `v${version}`, '-m', `发布 v${version}`]);
  run('git', ['push', '--atomic', 'origin', 'main', `refs/tags/v${version}`]);
  console.log('已触发 GitHub Actions；三平台构建与验收全部成功后自动公开 Release。失败时不会公开不完整版本。');
}
