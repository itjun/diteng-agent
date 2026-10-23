import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ensureVite, isHttpOk, killElectron, sleep, startElectron } from './e2e-app-control.mjs';

/**
 * 真机验证：经典 ERP 菜单页（一级轻壳 FrmDefault.moduleMenu）的菜单卡片在壳内
 * 保持网页版 `_blank` 语义——点击卡片在壳里新开标签，而不是把当前菜单页替换掉。
 *
 * 背景：模板页卡片点击调用 myapp.js 的 appendTodayMenuSummary(menuCode, isOpenNewWindow, navUrl)，
 * isOpenNewWindow 来自用户参数“模组子菜单默认新窗口打开”（默认关）。关闭时桌面端走
 * safeNavigate（location.href 同标签），这与网页版 `_blank` 新标签不一致；主进程需向 guest
 * 主世界注入兼容补丁，把卡片点击固定为 window.open，再由 setWindowOpenHandler 转壳新标签。
 *
 * 隔离：全新临时 userData + 独立 CDP 端口 9226（绝不使用 9223 上用户/dev 应用），
 * mock 后端只监听 127.0.0.1（不做任何真实环境请求）；脚本结束收掉实例。
 *
 * 用法：node scripts/e2e-menu-newtab.mjs
 * 输出：逐条 `CHECK 名称: OK/FAIL`、截图 /tmp/diteng-menu-newtab.png；有 FAIL 时退出码 1。
 */

const TEST_CDP_PORT = 9226;
const TEST_CDP_ENDPOINT = `http://127.0.0.1:${TEST_CDP_PORT}`;
const LOG_PATH = '/tmp/diteng-menu-newtab-electron.log';
const SCREENSHOT_PATH = '/tmp/diteng-menu-newtab.png';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  return Boolean(ok);
}

/**
 * 本地 mock 后端：登录/账套/退出协议沿用现有 mock；页面部分复刻经典一级轻壳链路：
 *   首页 FrmDefault →（同标签）菜单模组页 FrmDefault.moduleMenu →（卡片点击）Frm1401。
 * 模组页内联脚本按 myapp.js 现行实现提供 appendTodayMenuSummary（menu card 覆盖层 onclick 调用），
 * `isOpenNewWindow=false` 时与真实页面一致走 safeNavigate（这正是壳内当前同标签打开的原因）。
 */
function startMockServer() {
  let statsCalls = 0;
  const modulePageCounts = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, type = 'application/json', headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks).toString();
    };

    if (req.method === 'POST' && url.pathname === '/services/SvrUserLogin.getToken') {
      const body = await readBody();
      let head = {};
      try {
        head = JSON.parse(new URLSearchParams(body).get('dataIn') ?? '{}').head ?? {};
      } catch {
        /* 宽松解析：mock 不校验凭据 */
      }
      if (head.verifyCode === '??????') {
        send(200, { state: 1, message: '验证码已发送' });
        return;
      }
      send(200, {
        state: 1,
        message: '登录成功',
        head: {
          status: 1,
          token: 'mock-token-menu-newtab',
          user_code: '01',
          startPage: '250008/FrmDefault',
          corpNo: '250008',
          homeForm: 'FrmDefault',
          forceRedirect: false,
          redirectUrl: '',
        },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/getTokenInfo') {
      send(200, { userId: 'mock-user', userCode: '01', userName: '菜单新标签自测用户', corpNo: '250008', options: {} });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/logout') {
      send(200, '');
      return;
    }
    if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      send(200, { state: 1, head: {}, body: [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '菜单新标签自测账套', 'MOCK']] });
      return;
    }
    // 菜单点击统计（appendTodayMenuSummary 内 getServiceByCenter 发出）：补丁不得跳过统计
    if (req.method === 'POST' && url.pathname === '/services/TAppUserMenu.appendTodayMenuSummary') {
      statsCalls += 1;
      send(200, { state: 1 });
      return;
    }
    if (url.pathname === '/__calls') {
      send(200, { stats: statsCalls, modules: Object.fromEntries(modulePageCounts) });
      return;
    }
    if (url.pathname === '/favicon.ico') {
      send(404, '', 'text/plain');
      return;
    }
    if (url.pathname.endsWith('/FrmMessages.mqttConfig')) {
      send(200, { result: false, message: 'mock 未配置 MQTT' });
      return;
    }
    if (url.pathname === '/250008/FrmDefault') {
      send(
        200,
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ERP Mock 首页</title></head><body>
<div>mock erp home</div>
<a id="module-link" href="/250008/FrmDefault.moduleMenu?module=7695&sid=mock-token-menu-newtab&CLIENTID=mock-clientid&device=pc">产品管理</a>
</body></html>`,
        'text/html; charset=utf-8',
      );
      return;
    }
    if (url.pathname === '/250008/FrmDefault.moduleMenu') {
      modulePageCounts.set('FrmDefault.moduleMenu', (modulePageCounts.get('FrmDefault.moduleMenu') ?? 0) + 1);
      // 真实页面多为外链脚本 + 内联 onclick，带 CSP 仍应能被主进程注入补丁（executeJavaScript 不受 CSP 限制）
      send(200, moduleMenuPage(origin), 'text/html; charset=utf-8', {
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
      });
      return;
    }
    if (/^\/250008\/Frm\d+/.test(url.pathname)) {
      modulePageCounts.set(url.pathname.split('?')[0], (modulePageCounts.get(url.pathname.split('?')[0]) ?? 0) + 1);
      send(
        200,
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ERP Mock 业务页 ${url.pathname}</title></head><body>mock erp form ${url.pathname}</body></html>`,
        'text/html; charset=utf-8',
      );
      return;
    }
    send(404, 'not found', 'text/plain');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, getStats: () => statsCalls }));
  });
}

/**
 * 经典模组页（一级轻壳）最小复刻：与 myapp.js 现行的 appendTodayMenuSummary 分支逻辑一致。
 * 卡片覆盖层 span 的 onclick 传 isOpenNewWindow=false（默认用户参数关闭），
 * 未经主进程补丁时这里会执行 safeNavigate（location.href）→ 壳内同标签替换。
 */
function moduleMenuPage(origin) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>产品管理(7695)</title>
<style>
  body { font-family: sans-serif; }
  #card-1401 { position: relative; width: 420px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
  #card-1401-hit { position: absolute; inset: 0; cursor: pointer; }
</style></head><body>
<div id="product-menu"><h3>产品管理</h3><div class="groupTitle">基本设置</div>
  <div class="commonMenu" id="card-1401">
    <div>
      <ul>
        <li><div><div><span class="menuCodeNum">1401</span><span>品牌资料管理</span></div></div></li>
        <li>品牌的登记，查询，分享模式设置等</li>
      </ul>
    </div>
    <span id="card-1401-hit" onclick='appendTodayMenuSummary("1401", false, "${origin}/250008/Frm1401")'></span>
  </div>
</div>
<script>
  // ===== 复刻 myapp.js 关键实现（只保留菜单卡片点击链路）=====
  window.Application = { device: 'pc', userCode: '25005902' };
  window.aui = { common: { DataRow: function () { this.setValue = function () {}; } } };
  window.getServiceByCenter = function (code, row) {
    fetch('/services/' + code, { method: 'POST' }).catch(function () {});
  };
  window.isPhone = function () {
    var device = Application.device;
    return device == 'phone' || device == 'weixin' || device == 'android'
      || device == 'iphone' || device == 'android-gps' || device == 'iphone-gps';
  };
  window.isValidNavigateUrl = function (url) {
    if (url === undefined || url === null || url === false) return false;
    if (typeof url !== 'string' && typeof url !== 'number') return false;
    var s = String(url).trim();
    if (!s) return false;
    if (s === 'undefined' || s === 'null' || s === 'NaN') return false;
    if (/^javascript:\\s*(undefined|null)\\b/i.test(s)) return false;
    if (/\\/(undefined|null)(\\/|\\?|#|$)/i.test(s)) return false;
    if (/^(undefined|null)(\\/|\\?|#|$)/i.test(s)) return false;
    return true;
  };
  window.safeNavigate = function (url) {
    if (!isValidNavigateUrl(url)) return false;
    location.href = url;
    return true;
  };
  window.safeWindowOpen = function (url, target, features) {
    if (!isValidNavigateUrl(url)) return null;
    if (features !== undefined) return window.open(url, target, features);
    if (target !== undefined) return window.open(url, target);
    return window.open(url);
  };
  window.appendTodayMenuSummary = function (menuCode, isOpenNewWindow, navUrl) {
    if (event) event.preventDefault();
    var targetUrl = navUrl || menuCode;
    if (!isValidNavigateUrl(targetUrl)) return;
    var row = new aui.common.DataRow();
    row.setValue('menu_code_', menuCode);
    getServiceByCenter('TAppUserMenu.appendTodayMenuSummary', row);
    if (isPhone() || (!isOpenNewWindow && (window.event && !window.event.ctrlKey))) {
      safeNavigate(targetUrl);
    } else {
      safeWindowOpen(targetUrl, menuCode || '_blank');
    }
  };
</script>
</body></html>`;
}

/** 独立 CDP 通道（guest 为 type=webview，playwright pages() 不收） */
async function createCdpLink(port = TEST_CDP_PORT) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, (message) =>
          message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result),
        );
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() {
      return new Promise((resolve) => {
        socket.addEventListener('close', resolve, { once: true });
        socket.close();
      });
    },
  };
}

let mock = null;
let browser = null;
let cdpLink = null;
const userDataDir = mkdtempSync(join(tmpdir(), 'diteng-menu-newtab-'));
let cleanupDone = false;

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  try {
    mock?.server.close();
  } catch {
    /* 已关闭 */
  }
  try {
    await cdpLink?.close();
  } catch {
    /* 已断开 */
  }
  try {
    await browser?.close();
  } catch {
    /* 已断开 */
  }
  try {
    await killElectron(20, TEST_CDP_PORT);
  } catch {
    /* 进程已退出 */
  }
  rmSync(userDataDir, { recursive: true, force: true });
}

try {
  mock = await startMockServer();
  console.log(`mock 后端: ${mock.base}`);

  await ensureVite();
  if (await isHttpOk(`${TEST_CDP_ENDPOINT}/json/version`)) {
    console.log(`WARN ${TEST_CDP_PORT} 上已有上一次测试实例，先收掉`);
    await killElectron(20, TEST_CDP_PORT);
  }
  await startElectron(LOG_PATH, [`--user-data-dir=${userDataDir}`], TEST_CDP_PORT);
  browser = await chromium.connectOverCDP(TEST_CDP_ENDPOINT);
  const allPages = () => browser.contexts().flatMap((context) => context.pages());
  const findShell = () => allPages().find((page) => page.url().includes('127.0.0.1:5173') && page.url().includes('#/main'));
  const findLogin = () =>
    allPages().find((page) => page.url().includes('127.0.0.1:5173') && !page.url().includes('#/main'));

  // 1. 全新 userData：直接走登录表单进入主窗
  const login = findLogin();
  if (!login) throw new Error('未见登录窗（vite 5173 未就绪？）');
  await login.fill('#server-base', mock.base);
  await login.fill('#login-id', '01');
  await login.fill('#password', '123456');
  await login.click('button[type=submit]');
  let shell = null;
  for (let i = 0; i < 30 && !shell; i++) {
    await sleep(1000);
    shell = findShell();
  }
  check('登录进入主窗', Boolean(shell));
  if (!shell) throw new Error('30s 内未见 #/main');
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

  // 2. 等首页 guest 就绪，同标签进入菜单模组页（正常页内导航不应被补丁改变）
  cdpLink = await createCdpLink();
  const cdp = cdpLink;
  let guestTarget = null;
  for (let i = 0; i < 30 && !guestTarget; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    guestTarget = targetInfos.find((target) => target.type === 'webview' && target.url.includes(mock.base));
    if (!guestTarget) await sleep(1000);
  }
  check('ERP 标签 guest 就绪', Boolean(guestTarget), guestTarget?.url ?? '');
  if (!guestTarget) throw new Error('未见 webview guest');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: guestTarget.targetId, flatten: true });

  await cdp.send('Runtime.evaluate', {
    expression: `document.getElementById('module-link').click()`,
    userGesture: true,
  }, sessionId);
  let moduleUrl = '';
  for (let i = 0; i < 20 && !moduleUrl.includes('FrmDefault.moduleMenu'); i++) {
    await sleep(500);
    moduleUrl = (await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)).result?.value ?? '';
  }
  check('首页同标签进入菜单模组页', moduleUrl.includes('/250008/FrmDefault.moduleMenu'), moduleUrl);
  let state = await shell.evaluate(() => window.__ditengTabsList());
  check('模组页仍为单标签', state.tabs.length === 1, `tabs=${state.tabs.length}`);

  // 3. 等主进程兼容补丁注入完成（补丁标记由主进程 executeJavaScript 写入 guest 主世界）
  let patched = false;
  for (let i = 0; i < 20 && !patched; i++) {
    patched = (await cdp.send('Runtime.evaluate', {
      expression: 'window.__ditengErpMenuNewTabPatch === true',
      returnByValue: true,
    }, sessionId)).result?.value === true;
    if (!patched) await sleep(500);
  }
  check('菜单卡片新标签补丁已注入', patched);

  // 4. 点击菜单卡片：应新开壳标签，原模组页标签保持不变
  await cdp.send('Runtime.evaluate', {
    expression: `document.getElementById('card-1401-hit').click()`,
    userGesture: true,
  }, sessionId);
  let opened = null;
  for (let i = 0; i < 20 && !opened; i++) {
    await sleep(500);
    const next = await shell.evaluate(() => window.__ditengTabsList());
    if (next.tabs.length === 2) opened = next;
  }
  check('菜单卡片打开新标签', Boolean(opened), opened ? opened.tabs.map((tab) => tab.url).join(' | ') : '未新增标签（同标签导航）');
  if (opened) {
    const [, newTab] = opened.tabs;
    check('新标签为当前标签', opened.activeTabId === newTab.id, `active=${opened.activeTabId} new=${newTab.id}`);
    check('新标签为菜单目标页', newTab.url.includes('/250008/Frm1401'), newTab.url);
    check(
      '新标签自动补会话参数',
      /[?&]sid=[^&]+/.test(newTab.url) && /[?&]CLIENTID=[^&]+/.test(newTab.url) && /[?&]device=pc/.test(newTab.url),
      newTab.url,
    );
    check('原菜单标签保持页面不变', opened.tabs[0].url.includes('/250008/FrmDefault.moduleMenu'), opened.tabs[0].url);
  }

  // 5. 统计未被补丁绕过（appendTodayMenuSummary 内仍调用收藏/使用统计服务）
  await sleep(1000);
  check('菜单使用统计仍上报', mock.getStats() >= 1, `calls=${mock.getStats()}`);

  await shell.screenshot({ path: SCREENSHOT_PATH }).catch(() => {});
  console.log(`截图: ${SCREENSHOT_PATH}`);
  cdp.close();
} finally {
  await cleanup();
}

const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.log(`RESULT: FAIL（${failed.map((item) => item.name).join('、')}）`);
  process.exit(1);
}
console.log(`RESULT: PASS（${checks.length} 项全部通过）`);
