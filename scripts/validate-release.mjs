import { readFileSync } from 'node:fs';
import { validatePolicy } from './release-artifacts.mjs';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { minimumVersion } = JSON.parse(readFileSync(new URL('../release-policy.json', import.meta.url), 'utf8'));
validatePolicy(version, minimumVersion);
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('标签必须与 package.json 的版本一致');

// 安装器底图烘焙了版本号，防止改版本后忘记重新生成（Windows 发布链路）
if (process.platform === 'win32') {
  const artVersion = readFileSync(new URL('../build/installer/art-version.txt', import.meta.url), 'utf8').trim();
  if (artVersion !== version) {
    throw new Error(`安装器底图版本(${artVersion})与 package.json(${version})不一致，请先运行 pnpm make:installer-art`);
  }
}
console.log(`发布策略有效：${version}，最低支持 ${minimumVersion}`);
