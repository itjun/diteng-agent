/**
 * e2e 凭据模板：复制为 e2e-secrets.mjs（已 gitignore）并填入真实测试账号。
 * 环境变量 E2E_SERVER_BASE / E2E_LOGIN_ID / E2E_PASSWORD 可覆盖文件值。
 */
export const SERVER_BASE = process.env.E2E_SERVER_BASE ?? 'https://目标环境地址';
export const LOGIN_ID = process.env.E2E_LOGIN_ID ?? '测试账号';
export const PASSWORD = process.env.E2E_PASSWORD ?? '测试密码';
