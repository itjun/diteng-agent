import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机登录自动化（阶段 1）：CDP 连接真实运行的 diteng-agent，
 * 填写服务器/账号/密码并点击登录，判读结果状态。
 * 用法：node scripts/e2e-login.mjs
 */
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';


const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const allPages = () => browser.contexts().flatMap((c) => c.pages());
const page = allPages().find((p) => p.url().includes('127.0.0.1:5173'));
if (!page) {
  console.log('RESULT: FAIL 未找到登录页面');
  process.exit(1);
}

// 自动登录闸门：自动登录成功则已登录（本脚本验证手动登录流程，无法继续），否则转普通表单
if (await resolveAutoLoginGate(allPages, page)) {
  console.log('RESULT: SKIP 已处于登录态（自动登录），重启应用清凭据后再验证手动登录');
  await browser.close();
  process.exit(0);
}

// React 受控输入用 fill 触发
await page.fill('#server-base', SERVER_BASE);
await page.fill('#login-id', LOGIN_ID);
await page.fill('#password', PASSWORD);
await page.click('button[type=submit]');

// 轮询判读：登录成功面板 / 短信子表单 / 错误提示
const outcome = await page.waitForFunction(
  () => {
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('登录成功')) return 'DONE';
    if (document.querySelector('#sms-code')) return 'SMS_MODE';
    return '';
  },
  { timeout: 30_000, polling: 500 },
).then((handle) => handle.jsonValue()).catch(() => 'TIMEOUT');

console.log('OUTCOME:', outcome);

if (outcome === 'SMS_MODE') {
  const errorText = await page.locator('.error, p').allTextContents();
  console.log('页面提示:', errorText.filter((t) => t && t.length < 60).join(' | '));
  // 点击发送验证码（真实短信发到用户手机）
  await page.click('button:has-text("发送验证码")');
  await page.waitForTimeout(4000);
  const hint = await page.locator('p').allTextContents();
  console.log('发送后提示:', hint.filter((t) => t.includes('验证码') || t.includes('发送')).join(' | '));
}

await page.screenshot({ path: '/tmp/diteng-login-state.png' });
console.log('截图: /tmp/diteng-login-state.png');
await browser.close();
