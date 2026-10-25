import { mkdirSync, writeFileSync } from 'node:fs';

const environment = process.argv[2];
if (process.argv.length !== 3 || !['main', 'dev'].includes(environment)) {
  throw new Error('构建环境必须为 main 或 dev');
}

const output = new URL('../dist/', import.meta.url);
mkdirSync(output, { recursive: true });
writeFileSync(new URL('build-environment.json', output), JSON.stringify({ environment }) + '\n');
console.log(`构建环境：${environment}`);
