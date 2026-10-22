import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 独立复核（步骤 3）+ 切回原账套：登录 → 读会话 → 切回 250008 → 断言旧账套标签全关。
 * 前置：vite(5173) 与 electron(9223) 已运行。
 */
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');

function pages() {
  return browser.contexts().flatMap((c) => c.pages());
}

const login = pages().find((p) => p.url().includes('127.0.0.1:5173') && !p.url().includes('#/main'));
if (!login) {
  console.log('FAIL: 未找到登录窗');
  process.exit(1);
}
// 自动登录闸门：自动登录成功则跳过表单登录
let shell = await resolveAutoLoginGate(pages, login);
if (!shell) {
  await login.fill('#server-base', SERVER_BASE);
  await login.fill('#login-id', LOGIN_ID);
  await login.fill('#password', PASSWORD);
  await login.click('button[type=submit]');

  for (let i = 0; i < 30 && !shell; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    shell = pages().find((p) => p.url().includes('#/main'));
  }
}
if (!shell) {
  console.log('FAIL: 主窗未出现；targets:', pages().map((p) => p.url()));
  process.exit(1);
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 20_000 });

const sessionBefore = await shell.evaluate(() => window.diteng.getSession());
console.log('CHECK 登录后账套:', sessionBefore.corpNo);

const corpResult = await shell.evaluate(() => window.diteng.sessionListCorps());
const corps = corpResult.ok ? corpResult.data : [];
console.log('CHECK 账套列表条数:', corps.length, '样例:', corps.slice(0, 3).map((c) => `${c.corpNo}:${c.name}`).join(', '));

// 已在 250008：切到 000000 验证关旧标签，再切回 250008 收尾
const away = sessionBefore.corpNo === '250008' ? '000000' : '250008';
console.log(`CHECK 第一段切换 ${sessionBefore.corpNo} -> ${away}`);
await shell.evaluate((corpNo) => window.diteng.sessionSwitchCorp({ corpNo }), away);
await new Promise((r) => setTimeout(r, 8000));
let sessionNow = await shell.evaluate(() => window.diteng.getSession());
console.log('CHECK 切换后账套:', sessionNow.corpNo, '(期望', away + ')');
let tabsNow = await shell.evaluate(() => window.__ditengTabsList());
console.log('CHECK 标签:', tabsNow.tabs.map((t) => t.url.replace(/sid=[^&]+/, 'sid=***')));
const hasOld = tabsNow.tabs.some((t) => t.url.includes(`/${sessionBefore.corpNo}/`));
console.log('CHECK 旧账套标签已全关:', !hasOld ? 'OK' : 'FAIL');

if (away !== '250008') {
  console.log('CHECK 第二段切换 切回 250008');
  await shell.evaluate(() => window.diteng.sessionSwitchCorp({ corpNo: '250008' }));
  await new Promise((r) => setTimeout(r, 8000));
  sessionNow = await shell.evaluate(() => window.diteng.getSession());
  console.log('CHECK 最终账套:', sessionNow.corpNo, '(期望 250008)');
  tabsNow = await shell.evaluate(() => window.__ditengTabsList());
  console.log('CHECK 最终标签:', tabsNow.tabs.map((t) => t.url.replace(/sid=[^&]+/, 'sid=***')));
}

await shell.screenshot({ path: '/tmp/diteng-switchback.png' });
await browser.close();
console.log('完成');
