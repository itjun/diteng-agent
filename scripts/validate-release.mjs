import { readFileSync } from 'node:fs';
import { validatePolicy } from './release-artifacts.mjs';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { minimumVersion } = JSON.parse(readFileSync(new URL('../release-policy.json', import.meta.url), 'utf8'));
validatePolicy(version, minimumVersion);
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('标签必须与 package.json 的版本一致');
console.log(`发布策略有效：${version}，最低支持 ${minimumVersion}`);
