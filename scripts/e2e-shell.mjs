import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证（步骤 2）：生产登录 → 主窗壳 → ERP 标签加载 → 同域 window.open 转新标签。
 * 前置：vite(5173) 与 electron(--remote-debugging-port=9223) 已运行。
 * 用法：node scripts/e2e-shell.mjs
 */
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';


const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');

function shellPage() {
  return browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('127.0.0.1:5173'));
}
function allPages() {
  return browser.contexts().flatMap((c) => c.pages());
}
function erpPages() {
  return browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().includes('cdcp.site'));
}

// 1. 登录（先过自动登录闸门：自动登录成功则按已登录继续，否则转普通表单）
const login = shellPage();
let shell = await resolveAutoLoginGate(allPages, login);
if (!shell) {
  await login.fill('#server-base', SERVER_BASE);
  await login.fill('#login-id', LOGIN_ID);
  await login.fill('#password', PASSWORD);
  await login.click('button[type=submit]');

  // 2. 登录窗会关闭、主窗是新开的 BrowserWindow：轮询发现 #/main 的 target
  for (let i = 0; i < 40 && !shell; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    shell = allPages().find((p) => p.url().includes('#/main'));
  }
}
if (!shell) {
  console.log('CHECK 主窗: FAIL（30s 内未见 #/main 主窗 target）');
  console.log('当前 targets:', browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()));
  process.exit(1);
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
console.log('CHECK 主窗壳 tabstrip: OK');

let erp = null;
for (let i = 0; i < 40 && !erp; i++) {
  await shell.waitForTimeout(1000);
  erp = erpPages().find((p) => /\/\d+\/Frm/.test(p.url()));
}
if (!erp) {
  console.log('CHECK ERP 标签: FAIL（30s 内未见 ERP 页面 target）');
  console.log('当前 targets:', browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()));
  process.exit(1);
}
console.log('CHECK ERP 标签 URL:', erp.url().replace(/sid=[^&]+/, 'sid=***'));
await erp.waitForLoadState('domcontentloaded').catch(() => {});
const erpTitle = await erp.title().catch(() => '');
console.log('CHECK ERP 标题:', erpTitle || '(空)');

const tabs1 = await shell.evaluate(() => window.__ditengTabsList());
console.log('CHECK 标签数(登录后):', tabs1.tabs.length, '激活:', tabs1.activeTabId);

// 3. 同域 window.open → 应转成客户端新标签
await erp.evaluate((origin) => {
  window.open(`${origin}/250008/FrmDefault`, '_blank');
}, SERVER_BASE);
await shell.waitForTimeout(3000);
const tabs2 = await shell.evaluate(() => window.__ditengTabsList());
console.log('CHECK 标签数(window.open 后):', tabs2.tabs.length, '(期望 +1)');
console.log('CHECK 新标签 URL:', tabs2.tabs.map((t) => t.url.replace(/sid=[^&]+/, 'sid=***')));

// 4. 截图存档：壳 + ERP 页
await shell.screenshot({ path: '/tmp/diteng-shell.png' });
await erp.screenshot({ path: '/tmp/diteng-erp-tab.png' });
console.log('截图: /tmp/diteng-shell.png /tmp/diteng-erp-tab.png');

const session = await shell.evaluate(() => window.diteng.getSession());
console.log('CHECK 会话:', JSON.stringify(session));
await browser.close();
