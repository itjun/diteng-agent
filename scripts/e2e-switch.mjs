import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证（步骤 3）：任务 A 同域补 sid → 账套列表（listMyLivingUsers）→
 * 经用户卡片切换账套（getNuewToken，生产仅允许验证一次，脚本结束停在新账套）→ AI 对话页打开。
 * 前置：vite(5173) 和 electron(--remote-debugging-port=9223) 已运行。
 * 用法：node scripts/e2e-switch.mjs [目标corpNo]（缺省取列表中第一个非当前账套）
 */
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const targetCorpArg = process.argv[2] || '';

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

// 3. 账套列表（listMyLivingUsers，仅查询）
const corpsResult = await shell.evaluate(() => window.diteng.sessionListCorps());
if (!corpsResult.ok) {
  console.log('CHECK 账套列表: FAIL', JSON.stringify(corpsResult));
  process.exit(1);
}
console.log(
  'CHECK 账套列表: OK',
  corpsResult.data.map((c) => `${c.corpNo}/${c.shortName || c.name || c.code}`).join(', '),
);

// 4. 切换账套（getNuewToken；生产只验证一次，结束停在新账套）——经用户卡片 UI 路径
const target = targetCorpArg || corpsResult.data.find((c) => c.corpNo !== session0.corpNo)?.corpNo || '';
if (!target) {
  console.log('CHECK 切换: SKIP（仅一个账套，无可切换目标）');
} else {
  console.log(`CHECK 切换目标: ${session0.corpNo} -> ${target}`);
  // 点底部用户行弹卡片 → 卡片内账套列表渲染、当前账套打勾 → 点目标账套行（内部走 sessionSwitchCorp）
  await shell.waitForSelector('[data-testid="user-chip"]:not([disabled])', { timeout: 10_000 });
  await shell.click('[data-testid="user-chip"]');
  await shell.waitForSelector('[data-testid="user-card"]', { timeout: 5_000 });
  const cardOptionCount = await shell.locator('[data-testid="user-card"] [data-testid^="corp-option-"]').count();
  const currentOption = shell.locator(`[data-testid="user-card"] [data-testid="corp-option-${session0.corpNo}"]`);
  console.log(
    'CHECK 卡片账套列表:',
    cardOptionCount === corpsResult.data.length && (await currentOption.getAttribute('aria-selected')) === 'true' ? 'OK' : 'FAIL',
    `渲染 ${cardOptionCount} 项（接口 ${corpsResult.data.length} 项），当前 ${session0.corpNo} 打勾`,
  );
  await shell.click(`[data-testid="corp-option-${target}"]`);
  // 切换成功后卡片收起、corp:switched 已关旧账套标签并开新首页
  for (let i = 0; i < 20 && (await shell.locator('[data-testid="user-card"]').count()) > 0; i++) {
    await shell.waitForTimeout(500);
  }
  console.log('CHECK 卡片收起:', (await shell.locator('[data-testid="user-card"]').count()) === 0 ? 'OK' : 'FAIL');

  // 旧账套标签应全部关闭，仅剩新账套首页
  await shell.waitForTimeout(2000);
  const tabsAfterSwitch = await shell.evaluate(() => window.__ditengTabsList());
  const isAllNewCorp = tabsAfterSwitch.tabs.every((t) => t.corpNo === target);
  console.log('CHECK 切换后标签 corpNo:', isAllNewCorp ? 'OK' : 'FAIL', JSON.stringify(tabsAfterSwitch.tabs.map((t) => ({ id: t.id, corpNo: t.corpNo }))));
  console.log('CHECK 切换后标签 URL:', tabsAfterSwitch.tabs.map((t) => maskUrl(t.url)));
  const session1 = await shell.evaluate(() => window.diteng.getSession());
  console.log('CHECK 切换后会话 corpNo:', session1.corpNo === target ? 'OK' : 'FAIL', session1.corpNo);

  let newErp = null;
  for (let i = 0; i < 40 && !newErp; i++) {
    await shell.waitForTimeout(1000);
    newErp = allPages().find((p) => new RegExp(`/${target}/Frm`).test(p.url()));
  }
  console.log('CHECK 新账套 ERP 页:', newErp ? maskUrl(newErp.url()) : 'FAIL（未见新账套页面 target）');
}

// 5. AI 对话页（作为客户端新标签，外链白名单内）
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

await shell.screenshot({ path: '/tmp/diteng-switch.png' });
console.log('截图: /tmp/diteng-switch.png');
await browser.close();
