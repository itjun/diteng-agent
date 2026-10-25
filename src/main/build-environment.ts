import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 仅从编译产物读取；缺失或非法时直接报错，避免连到错误环境。
const environment: unknown = JSON.parse(readFileSync(join(__dirname, '../build-environment.json'), 'utf8')).environment;
if (environment !== 'main' && environment !== 'dev') {
  throw new Error('构建环境无效，请使用 pnpm build 或 pnpm build:dev 重新构建');
}

export const BUILD_SERVER_BASE = environment === 'main' ? 'https://m.cdcp.site' : 'http://rc.local.lan';
