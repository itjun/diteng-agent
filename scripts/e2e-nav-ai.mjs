import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证：同域 window.open 自动补 sid/CLIENTID/device → AI 对话页作为客户端新标签打开。
 * 账套切换已统一由网页版（页头账套卡片）完成，客户端不再提供切换入口，本脚本不含切账套步骤。
 * 前置：vite(5173) 和 electron(--remote-debugging-port=9223) 已运行。
 * 用法：node scripts/e2e-nav-ai.mjs
 */
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');

function allPages() {
  return browser.contexts().flatMap((c) => c.pages());
}
function shellPage() {
  return allPages().find((p) => p.url().includes('127.0.0.1:5173'));
}
function maskUrl(url) {
  return url.replace(/sid=[^&]+/, 'sid=***');
}

// 1. 登录（复用步骤 2 流程；先过自动登录闸门，自动登录成功则跳过表单登录）
const login = shellPage();
let shell = await resolveAutoLoginGate(allPages, login);
if (!shell) {
  await login.fill('#server-base', SERVER_BASE);
  await login.fill('#login-id', LOGIN_ID);
  await login.fill('#password', PASSWORD);
  await login.click('button[type=submit]');

  for (let i = 0; i < 40 && !shell; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    shell = allPages().find((p) => p.url().includes('#/main'));
  }
}
if (!shell) {
  console.log('CHECK 主窗: FAIL（30s 内未见 #/main 主窗 target）');
  process.exit(1);
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
console.log('CHECK 主窗壳 tabstrip: OK');

let erp = null;
for (let i = 0; i < 40 && !erp; i++) {
  await shell.waitForTimeout(1000);
  erp = allPages().find((p) => /\/\d+\/Frm/.test(p.url()));
}
if (!erp) {
  console.log('CHECK ERP 标签: FAIL（30s 内未见 ERP 页面 target）');
  process.exit(1);
}
console.log('CHECK ERP 标签 URL:', maskUrl(erp.url()));

const session0 = await shell.evaluate(() => window.diteng.getSession());
console.log('CHECK 登录会话 corpNo:', session0.corpNo);

// 2. 任务 A：同域 window.open 不带 sid → 主进程应自动补 sid/CLIENTID/device
await erp.evaluate((origin) => {
  window.open(`${origin}/${window.location.pathname.split('/')[1]}/FrmDefault`, '_blank');
}, SERVER_BASE);
await shell.waitForTimeout(3000);
const tabsAfterOpen = await shell.evaluate(() => window.__ditengTabsList());
const openedTab = tabsAfterOpen.tabs[tabsAfterOpen.tabs.length - 1];
const hasSid = /[?&]sid=[^&]+/.test(openedTab.url) && /[?&]CLIENTID=[^&]+/.test(openedTab.url);
console.log('CHECK 任务A window.open 补 sid:', hasSid ? 'OK' : 'FAIL', maskUrl(openedTab.url));

// 3. AI 对话页（作为客户端新标签，外链白名单内）
// 先关到 0 个标签露出新建标签页（标签状态在渲染层，逐个点关闭 ×），再点 quicklink-ai
for (let guard = 0; guard < 10; guard++) {
  if ((await shell.locator('[data-testid^="tab-close-"]').count()) === 0) break;
  await shell.locator('[data-testid^="tab-close-"]').first().click();
  await shell.waitForTimeout(300);
}
await shell.waitForSelector('[data-testid="quicklink-ai"]:not([disabled])', { timeout: 10_000 });
await shell.click('[data-testid="quicklink-ai"]');
await shell.waitForTimeout(5000);
const tabsAfterAi = await shell.evaluate(() => window.__ditengTabsList());
const aiTab = tabsAfterAi.tabs.find((t) => /\/chat/.test(t.url));
console.log('CHECK AI 标签:', aiTab ? maskUrl(aiTab.url) : 'FAIL（未见 /chat 标签）');
let aiPage = null;
for (let i = 0; i < 20 && !aiPage; i++) {
  await shell.waitForTimeout(1000);
  aiPage = allPages().find((p) => /\/chat/.test(p.url()));
}
if (aiPage) {
  await aiPage.waitForLoadState('domcontentloaded').catch(() => {});
  console.log('CHECK AI 页面标题:', (await aiPage.title().catch(() => '')) || '(空)');
}

await shell.screenshot({ path: '/tmp/diteng-nav-ai.png' });
console.log('截图: /tmp/diteng-nav-ai.png');
await browser.close();
