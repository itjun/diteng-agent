import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Windows 的命令行不会展开通配符，显式传入同一组测试文件。
const files = readdirSync(new URL('.', import.meta.url)).filter(name => /^test-.*\.mjs$/.test(name))
  .map(name => fileURLToPath(new URL(name, import.meta.url)));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
