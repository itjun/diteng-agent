import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证（步骤 4）：生产登录 → MQTT 连接 → 自发自收一条模拟未读消息 → 断言通知链路。
 *
 * 断言口径（全部为主进程内部状态，不依赖 macOS 系统通知授权弹窗）：
 *   1) window.diteng.getMqttState().connected === true 且 topic = {userId}/unreadMessage
 *   2) 模拟消息发布后 state.lastNotification 非空（系统通知已触发的内部事件）
 *   3) Level_=2（Grave 紧急）→ state.lastPopupTitle 非空（置顶弹窗已创建）
 *   4) state.unread >= 0（消息后 REST 校准已执行）
 * 系统通知样式、置顶弹窗样式需用户肉眼确认（截图一并输出）。
 *
 * 说明：模拟消息直接发布到本人 MQTT topic（不落库、不产生真实未读数），
 * 与服务端 MessageUtils.publishUnreadMessage 的 payload 形态一致。
 *
 * 前置：vite(5173) 与 electron(--remote-debugging-port=9223) 已运行。
 * 短信验证码登录场景：设置 E2E_SMS_CODE 环境变量后脚本自动填入。
 * 用法：node scripts/e2e-notify.mjs
 */
import { chromium } from 'playwright-core';
import { connectAsync as mqttConnectAsync } from 'mqtt';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';


const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const allPages = () => browser.contexts().flatMap((c) => c.pages());

// 1. 登录（密码登录；设备未验证时转短信码，需 E2E_SMS_CODE）
const login = allPages().find((p) => p.url().includes('127.0.0.1:5173'));
if (!login) {
  console.log('RESULT: FAIL 未找到登录页面（是否已登录过？重启 electron 后重试）');
  process.exit(1);
}
// 自动登录闸门：自动登录成功则跳过登录步骤；否则转普通表单继续原流程
let shell = await resolveAutoLoginGate(allPages, login);
if (shell) {
  console.log('CHECK 已处于登录态（自动登录），跳过登录步骤');
}
if (!shell) {
  await login.fill('#server-base', SERVER_BASE);
  await login.fill('#login-id', LOGIN_ID);
  await login.fill('#password', PASSWORD);
  await login.click('button[type=submit]');

  const loginOutcome = await login
    .waitForFunction(
      () => {
        const text = document.body.innerText || '';
        if (text.includes('登录成功')) return 'DONE';
        if (document.querySelector('#sms-code')) return 'SMS_MODE';
        return '';
      },
      { timeout: 30_000, polling: 500 },
    )
    .then((h) => h.jsonValue())
    .catch(() => 'TIMEOUT');

  if (loginOutcome === 'SMS_MODE') {
    const smsCode = process.env.E2E_SMS_CODE;
    if (!smsCode) {
      console.log('RESULT: FAIL 进入短信验证码登录，请设置 E2E_SMS_CODE=<收到的验证码> 后重跑');
      process.exit(1);
    }
    await login.fill('#sms-code', smsCode);
    await login.click('button[type=submit]');
  }

  // 2. 等主窗壳就绪
  for (let i = 0; i < 40 && !shell; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    shell = allPages().find((p) => p.url().includes('#/main'));
  }
}
if (!shell) {
  console.log('RESULT: FAIL 30s 内未见 #/main 主窗 target');
  process.exit(1);
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
console.log('CHECK 主窗壳: OK');

// 3. 断言 MQTT 已连（connected + topic）
let mqttState = null;
for (let i = 0; i < 30; i++) {
  mqttState = await shell.evaluate(() => window.diteng.getMqttState());
  if (mqttState.connected && mqttState.topic) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('CHECK MQTT state:', JSON.stringify(mqttState));
if (!mqttState.connected || !mqttState.topic.endsWith('/unreadMessage')) {
  console.log('RESULT: FAIL MQTT 未连接或 topic 异常');
  process.exit(1);
}
console.log('CHECK MQTT 连接: OK');

// 4. 从壳会话/标签拿 sid + CLIENTID，node 侧直连 FrmMessages.mqttConfig 拿 broker 凭据
const session = await shell.evaluate(() => window.diteng.getSession());
const config = await shell.evaluate(() => window.diteng.getConfig());
const tabsState = await shell.evaluate(() => window.__ditengTabsList());
const sid = new URL(tabsState.tabs.find((t) => t.url.includes('sid='))?.url ?? '').searchParams.get('sid');
if (!session || !sid) {
  console.log('RESULT: FAIL 无法取得会话/标签 sid', JSON.stringify({ session, tabCount: tabsState.tabs.length }));
  process.exit(1);
}
console.log(`CHECK 会话: userId=${session.userId} corpNo=${session.corpNo}`);

const configUrl = new URL(`${SERVER_BASE}/${session.corpNo}/FrmMessages.mqttConfig`);
configUrl.searchParams.set('sid', sid);
configUrl.searchParams.set('CLIENTID', config.machineCode);
configUrl.searchParams.set('device', 'pc');
const configResponse = await fetch(configUrl, { method: 'POST' });
const configRaw = (await configResponse.json()) ?? {};
const mqttConfig = configRaw.data && typeof configRaw.data === 'object' ? configRaw.data : configRaw;
console.log('CHECK mqttConfig: broker=' + (mqttConfig.broker || '(空)'));
if (!mqttConfig.broker) {
  console.log('RESULT: FAIL mqttConfig 未返回 broker');
  process.exit(1);
}

// 5. 以独立 clientId 连 broker，向本人 topic 发一条模拟消息（形态对齐 MessageUtils：
//    S_UserMessage DataRow json()，Level_=2 触发置顶弹窗）
const topic = `${session.userId}/unreadMessage`;
const payload = {
  UID_: Math.floor(Date.now() / 1000),
  CorpNo_: session.corpNo,
  UserCode_: '',
  Level_: 2,
  Process_: 0,
  Subject_: 'e2e 紧急消息验证',
  Content_: '这是一条 MQTT 自发自收的模拟紧急消息（Level_=2），用于验证置顶弹窗与系统通知。',
  Status_: 0,
  Channel_: '系统消息',
  AppUser_: 'e2e-runner',
  AppUserName_: 'e2e 测试',
  ToUserName_: '本人',
  AppDate_: new Date().toISOString().slice(0, 19).replace('T', ' '),
  Final_: 0,
};

const publisher = await mqttConnectAsync(mqttConfig.broker, {
  protocolVersion: 5,
  keepalive: 60,
  clean: true,
  clientId: `e2e_${Date.now()}`,
  username: mqttConfig.username,
  password: mqttConfig.password,
  connectTimeout: 15_000,
});
// QoS 1（PUBACK 确认 broker 已收到）：QoS 0 + 立即 end 会因帧未 flush 丢消息（真机踩过）
await publisher.publishAsync(topic, JSON.stringify(payload), { qos: 1 });
console.log('CHECK 已发布模拟消息 →', topic);
// 等 PUBACK 落定再断开，避免半开写丢帧
await new Promise((r) => setTimeout(r, 1000));
await publisher.endAsync();

// 6. 轮询断言：通知触发 + 弹窗创建 + 未读校准
let finalState = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  finalState = await shell.evaluate(() => window.diteng.getMqttState());
  if (finalState.lastNotification && finalState.lastPopupTitle && finalState.unread >= 0) break;
}
console.log('CHECK 通知后 state:', JSON.stringify(finalState));

const checks = [
  ['系统通知已触发', finalState.lastNotification !== null],
  ['通知标题为发送人', finalState.lastNotification?.title === payload.AppUserName_],
  ['置顶弹窗已创建(Level_=2)', finalState.lastPopupTitle === payload.Subject_],
  ['未读 REST 校准已执行', Number.isFinite(finalState.unread) && finalState.unread >= 0],
];
let allPassed = true;
for (const [name, passed] of checks) {
  console.log(`CHECK ${name}: ${passed ? 'OK' : 'FAIL'}`);
  if (!passed) allPassed = false;
}

// 弹窗 8 秒自动关闭期间截图（置顶弹窗为独立无边框小窗，样式需肉眼确认）
const popupPage = allPages().find((p) => p.url().includes('#/notify-popup'));
if (popupPage) {
  await popupPage.screenshot({ path: '/tmp/diteng-notify-popup.png' }).catch(() => {});
  console.log('截图: /tmp/diteng-notify-popup.png（置顶弹窗样式请肉眼确认）');
}
await shell.screenshot({ path: '/tmp/diteng-notify-shell.png' }).catch(() => {});

console.log('RESULT:', allPassed ? 'PASS' : 'FAIL');
console.log('需肉眼确认：系统通知样式（macOS 首次运行会弹通知授权）、托盘图标与未读角标、置顶弹窗样式与 8s 自动关闭。');
await browser.close();
process.exit(allPassed ? 0 : 1);
