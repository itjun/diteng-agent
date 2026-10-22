/**
 * 真机登录自动化（阶段 2）：填写短信验证码并提交，校验登录成功面板。
 * 用法：SMS_CODE=xxxxxx node scripts/e2e-login-sms.mjs
 */
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const smsCode = process.env.SMS_CODE;
if (!smsCode) {
  console.log('RESULT: FAIL 缺少 SMS_CODE');
  process.exit(1);
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const allPages = () => browser.contexts().flatMap((c) => c.pages());
const page = allPages().find((p) => p.url().includes('127.0.0.1:5173'));
if (!page) {
  console.log('RESULT: FAIL 未找到登录页面');
  process.exit(1);
}

// 自动登录闸门：本脚本前置为「已处于短信子表单」（e2e-login 触发 -8 后），此处仅取消自动登录态兜底
await resolveAutoLoginGate(allPages, page, 0);

await page.fill('#sms-code', smsCode);
await page.click('button[type=submit]');

const outcome = await page.waitForFunction(
  () => {
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('登录成功')) return 'DONE';
    return '';
  },
  { timeout: 30_000, polling: 500 },
).then((handle) => handle.jsonValue()).catch(() => 'TIMEOUT');

console.log('OUTCOME:', outcome);

if (outcome === 'DONE') {
  const doneList = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('dl dt, dl dd')).map((el) => el.textContent?.trim());
    return items;
  });
  console.log('登录面板:', doneList.join(' | '));
}

await page.screenshot({ path: '/tmp/diteng-login-done.png' });
console.log('截图: /tmp/diteng-login-done.png');
await browser.close();
