import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证：同域 window.open 自动补 sid/CLIENTID/device；AI 快捷入口打开并复用 Web Chat。
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

// 3. AI 快捷入口直接打开当前账套的 Web Chat，再次点击复用同一标签。
await shell.click('[data-testid="open-ai"]');
await shell.waitForFunction(() => {
  const state = window.__ditengTabsList();
  return /\/chat(?:\?|\/|$)/.test(state.tabs.find(tab => tab.id === state.activeTabId)?.url ?? '');
});
const afterAi = await shell.evaluate(() => window.__ditengTabsList());
await shell.click('[data-testid="open-ai"]');
await shell.waitForTimeout(200);
const afterAgain = await shell.evaluate(() => window.__ditengTabsList());
if (afterAi.tabs.length !== afterAgain.tabs.length || afterAi.activeTabId !== afterAgain.activeTabId) throw new Error('AI 快捷入口未复用已有标签');
console.log('CHECK AI 快捷入口打开并复用 Web Chat: OK');

await shell.screenshot({ path: '/tmp/diteng-nav-ai.png' });
console.log('截图: /tmp/diteng-nav-ai.png');
await browser.close();
