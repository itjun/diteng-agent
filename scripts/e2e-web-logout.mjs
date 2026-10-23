import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证：网页版退出入口 → 外壳退出 → 回外壳登录窗。
 * 在壳内点击 ERP 页面右上角用户菜单「退出登录」（真实环境 href 为 /{corpNo}/TFrmLogout?...；
 * E2E_MOCK=1 时由 mock 页提供同形态链接）后，主进程应在 will-navigate 阶段捕获退出入口：
 * 不加载网页版退出系统页，改走外壳 performLogout（服务端 logout → 清会话/销毁托盘 → 主窗销毁 → 登录窗回归）。
 * 断言：主窗 #/main 销毁、登录窗回归、会话为空；mock 模式追加「网页版退出页请求数 0」「服务端 logout 被调用」。
 * 前置：vite(5173) + electron(--remote-debugging-port=9223，已用最新 dist/main 启动) 运行。
 * 用法：node scripts/e2e-web-logout.mjs
 *   E2E_MOCK=1                      本地 mock 后端自测（不连生产）
 *   E2E_SERVER_BASE / E2E_LOGIN_ID / E2E_PASSWORD  覆盖目标环境
 * 注意：真机验证会注销当前会话，脚本结尾自动重新登录；主进程日志应出现
 *       「[auth] 捕获网页版退出入口，改走外壳退出」。
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { CDP_ENDPOINT, createCdpLink, sleep } from './e2e-app-control.mjs';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const USE_MOCK = process.env.E2E_MOCK === '1';

/** 本地 mock 后端：登录/getTokenInfo/logout 记数；首页带网页版「退出登录」链接；退出系统页单独计数 */
function startMockServer() {
  let logoutCalls = 0;
  let logoutPageCalls = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/services/SvrUserLogin.getToken') {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
      });
      let head = {};
      try {
        head = JSON.parse(new URLSearchParams(body).get('dataIn') ?? '{}').head ?? {};
      } catch { /* 宽松解析 */ }
      if (head.verifyCode === '??????') {
        send(200, JSON.stringify({ state: 1, message: '验证码已发送' }), 'application/json');
        return;
      }
      send(200, JSON.stringify({
        state: 1,
        message: '登录成功',
        head: {
          status: 1,
          token: `mock-token-web-logout-${Date.now()}`,
          user_code: '01',
          startPage: '250008/FrmDefault',
          corpNo: '250008',
          homeForm: 'FrmDefault',
          forceRedirect: false,
          redirectUrl: '',
        },
      }), 'application/json');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/getTokenInfo') {
      send(200, JSON.stringify({
        userId: 'mock-user',
        userCode: '01',
        userName: '网页退出自测用户',
        corpNo: '250008',
        options: {},
      }), 'application/json');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/logout') {
      logoutCalls += 1;
      send(200, '', 'application/json');
      return;
    }
    if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      send(200, JSON.stringify({
        state: 1,
        head: {},
        body: [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '网页退出自测账套', 'MOCK']],
      }), 'application/json');
      return;
    }
    // 网页版退出系统页：壳内不应加载（命中即说明退出入口未被外壳接管）
    if (url.pathname === '/250008/TFrmLogout') {
      logoutPageCalls += 1;
      send(200, '<!DOCTYPE html><html><head><meta charset="utf-8"><title>退出系统</title></head><body>网页版退出系统页</body></html>', 'text/html; charset=utf-8');
      return;
    }
    if (url.pathname === '/__calls') {
      send(200, JSON.stringify({ logout: logoutCalls, logoutPage: logoutPageCalls }), 'application/json');
      return;
    }
    if (url.pathname === '/favicon.ico') {
      send(404, '', 'text/plain');
      return;
    }
    if (url.pathname.endsWith('/FrmMessages.mqttConfig')) {
      send(200, JSON.stringify({ result: false, message: 'mock 未配置 MQTT' }), 'application/json');
      return;
    }
    // 首页/普通页：右上角用户菜单里的网页版「退出登录」链接（与真实 ERP 同形态）
    send(200, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ERP Mock 页</title></head><body>
<div>mock erp content page</div>
<ul class="header-menu-list"><li><a id="web-logout" href="/250008/TFrmLogout?sid=mock-token&CLIENTID=mock&device=pc">退出登录</a></li></ul>
</body></html>`, 'text/html; charset=utf-8');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
      getLogoutCalls: () => logoutCalls,
      getLogoutPageCalls: () => logoutPageCalls,
    }));
  });
}

const mock = USE_MOCK ? await startMockServer() : null;
const serverBase = mock ? mock.base : SERVER_BASE;

const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
const allPages = () => browser.contexts().flatMap((context) => context.pages());
const findShell = () => allPages().find((page) => page.url().includes('127.0.0.1:5173') && page.url().includes('#/main'));
const findLogin = () =>
  allPages().find((page) => {
    if (!page.url().includes('127.0.0.1:5173')) return false;
    return !page.url().includes('#') || !/#\/(main|notify-popup)/.test(page.url());
  });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  return Boolean(ok);
}

async function waitForMain(seconds) {
  let found = null;
  for (let i = 0; i < seconds && !found; i++) {
    await sleep(1000);
    found = findShell();
  }
  return found;
}

async function submitLogin(page, base) {
  await page.fill('#server-base', base);
  await page.fill('#login-id', LOGIN_ID);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
}

/**
 * 在 webview guest 内查找网页版「退出登录」链接（a[href*="TFrmLogout"]）。
 * playwright-core 只收 type=page，guest(type=webview) 需经原生 CDP 查询；
 * 返回命中链接的 CDP 会话，供随后在其上下文中点击（点击后 guest 即随主窗销毁）。
 */
async function findWebLogoutLink() {
  const cdp = await createCdpLink();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const guest of targetInfos.filter((target) => target.type === 'webview')) {
      let sessionId = '';
      try {
        ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: guest.targetId, flatten: true }));
      } catch {
        continue;
      }
      try {
        const result = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const a = document.querySelector('a[href*="TFrmLogout"]');
            return a ? { href: a.href, text: (a.textContent || '').trim() } : null;
          })()`,
          returnByValue: true,
        }, sessionId);
        const link = result.result?.value;
        if (link?.href) return { cdp, sessionId, link, guestUrl: guest.url };
      } catch {
        // guest 正在导航/销毁：下一轮重试
      }
    }
  } catch {
    // 连接/查询失败：下一轮重试
  }
  await cdp.close();
  return null;
}

// 1. 归零：若残留 #/main 会话，先走壳退出（与本脚本被测链路不同的另一入口），确保从登录窗出发。
let shell = findShell();
if (shell) {
  await shell.waitForSelector('[data-testid="user-chip"]:not([disabled])', { timeout: 30_000 });
  await shell.click('[data-testid="user-chip"]');
  await shell.waitForSelector('[data-testid="user-card"] [data-testid="logout"]', { timeout: 10_000 });
  await shell.click('[data-testid="logout"]');
  for (let i = 0; i < 30 && (findShell() || !findLogin()); i++) await sleep(1000);
  shell = null;
}

let login = findLogin();
if (!login) {
  console.log('CHECK 登录窗: FAIL（未见 5173 登录页，请先启动 vite 与 electron --remote-debugging-port=9223）');
  await browser.close();
  mock?.server.close();
  process.exit(1);
}
shell = await resolveAutoLoginGate(allPages, login);
// 自动登录未成功（无凭据/失败）：走登录表单；失败重试一次，仍失败则终止并提示用 mock 自测
for (let attempt = 0; attempt < 2 && !shell; attempt++) {
  if (attempt > 0) await sleep(1500);
  await submitLogin(login, serverBase);
  shell = await waitForMain(30);
}
check('登录进入主窗', Boolean(shell), shell ? '' : '30s 内未见 #/main');
if (!shell) {
  await login.screenshot({ path: '/tmp/diteng-web-logout-login.png' }).catch(() => {});
  await browser.close();
  mock?.server.close();
  process.exit(1);
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

// 2. 等 webview 里出现网页版「退出登录」链接（真实 ERP 首页右上角用户菜单）
let hit = null;
for (let i = 0; i < 30 && !hit; i++) {
  hit = await findWebLogoutLink();
  if (!hit) await sleep(1000);
}
check('找到网页版退出登录链接', Boolean(hit), hit ? `${hit.link.text} → ${hit.link.href}` : '30s 内未见 a[href*="TFrmLogout"]');
if (!hit) {
  await browser.close();
  mock?.server.close();
  process.exit(1);
}

// 3. 在 guest 内点击网页版退出（模拟用户操作；点击后 guest 随主窗销毁，回包可能丢失）
await hit.cdp.send('Runtime.evaluate', {
  expression: `document.querySelector('a[href*="TFrmLogout"]').click()`,
}, hit.sessionId).catch(() => {});
hit.cdp.close();

// 4. 断言回到外壳登录窗：主窗销毁、登录窗回归、会话清空
let loginAgain = null;
for (let i = 0; i < 30 && !loginAgain; i++) {
  await sleep(1000);
  if (!findShell()) loginAgain = findLogin();
}
check('网页版退出后回到外壳登录窗', Boolean(loginAgain), loginAgain ? loginAgain.url() : '30s 内未见登录窗');
check('主窗 #/main 已销毁', !findShell());
if (loginAgain) {
  const session = await loginAgain.evaluate(() => window.diteng.getSession());
  check('壳会话已清空', session === null, JSON.stringify(session));
  await loginAgain.screenshot({ path: '/tmp/diteng-web-logout-login.png' }).catch(() => {});
}

// 5. mock 模式：网页版退出页未被加载（退出入口在外壳侧被接管）、服务端 logout 已发出
if (mock) {
  await sleep(1500);
  check('网页版退出页未加载', mock.getLogoutPageCalls() === 0, `TFrmLogout 请求=${mock.getLogoutPageCalls()}`);
  check('服务端 logout 被调用', mock.getLogoutCalls() >= 1, `calls=${mock.getLogoutCalls()}`);
}

// 6. 重新登录恢复可用（退出已清自动登录凭据，账号历史保留，服务器地址沿用退出前）
if (loginAgain) {
  await submitLogin(loginAgain, serverBase);
  const shellAgain = await waitForMain(30);
  check('重新登录进入主窗', Boolean(shellAgain), shellAgain ? '' : '30s 内未见 #/main');
  if (shellAgain) await shellAgain.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
}

console.log('截图: /tmp/diteng-web-logout-login.png');
mock?.server.close();
await browser.close();
const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.log(`RESULT: FAIL（${failed.map((item) => item.name).join('、')}）`);
  process.exit(1);
}
console.log('全部通过');
