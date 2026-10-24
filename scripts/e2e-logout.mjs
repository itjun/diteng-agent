/**
 * 保留原退出验收命令；退出入口统一到网页版后，复用网页退出全链路验收。
 * E2E_MOCK=1 使用本地 mock；真实环境执行会注销当前会话，细节见 e2e-web-logout.mjs。
 */
import './e2e-web-logout.mjs';
