/**
 * e2e：内容卡片（地址栏并入悬浮卡片）+ 地址栏跟随网页底色。
 *
 * 断言：
 * 1. 地址栏在内容卡片内部（与卡片顶对齐、同宽）；
 * 2. 卡片四边 5px 留白（上/下/右等宽，左侧与 rail 同色融合）、16px 圆角；
 * 3. 卡片/地址栏底色跟随网页顶部实际底色（页面顶部导航条 + theme-color 两档）；
 * 4. 深色网页自动切深色工具条文字（tone=dark），浅色网页用深色文字；
 * 5. 设置页卡片与网页卡片同规格（四边 5px）；
 * 6. 外围颜色切换后，功能栏 Chat 图标仍使用与同组入口一致的主题色；
 * 7. 收起侧栏后内容区铺满窗口，卡片仍四边 5px；
 * 8. 多标签按标签缓存底色，切换标签即时换色。
 *
 * 安全边界（硬性）：
 * - 全部请求只发往脚本进程内的 127.0.0.1 mock 后端，不访问任何真实服务器；
 * - 临时 userData（mkdtemp）+ 独立 CDP 9228 + 主进程 inspector 9231，绝不使用 9223/9224；
 * - 启动/清理只动占用 9228 的本仓库 electron 测试进程。
 *
 * 用法：node scripts/e2e-page-chrome.mjs
 * 产物：/tmp/diteng-page-chrome-*.png（渲染层截图与整窗截图，整窗截图含 macOS 红绿灯）
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { PROJECT_ROOT, ensureVite, killElectron, sleep, startElectron } from './e2e-app-control.mjs';

const TEST_CDP_PORT = 9228;
const TEST_INSPECT_PORT = 9231;
const TEST_CDP_ENDPOINT = `http://127.0.0.1:${TEST_CDP_PORT}`;
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'diteng-agent-e2e-page-chrome-'));
const ELECTRON_LOG = '/tmp/diteng-electron-page-chrome.log';
const SHOT_PREFIX = '/tmp/diteng-page-chrome';

/** 网页顶部色带：浅色（无 theme-color）/ theme-color / 深色两档，模拟不同站点主题 */
const PAGE_STYLES = {
  light: { themeColor: '', topBar: '#e8f0fe', body: '#ffffff', title: '浅色 ERP 页' },
  themed: { themeColor: '#d3e3ff', topBar: '#d3e3ff', body: '#ffffff', title: '带 theme-color 的 ERP 页' },
  dark: { themeColor: '', topBar: '#111318', body: '#15171c', title: '深色 ERP 页' },
  // 一侧有深色侧栏的页面（对齐 AI 对话页：左侧深色图标栏 + 白色正文），验证多点投票不被侧栏带偏
  ai: { themeColor: '', topBar: '#ffffff', body: '#ffffff', title: '带深色侧栏的 AI 页', leftRail: '#2b2d31' },
};
let pageStyle = 'light';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
};

/** 本地 mock 后端：登录/账套列表成功，页面顶部 56px 是站点导航条（地址栏应跟随它的底色） */
function startMockServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (url.pathname === '/__style') {
      const next = url.searchParams.get('name');
      if (next && PAGE_STYLES[next]) pageStyle = next;
      send(200, JSON.stringify({ pageStyle }), 'application/json');
      return;
    }
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
          token: 'mock-token-page-chrome',
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
        userName: '地址栏自测用户',
        corpNo: '250008',
        options: {},
      }), 'application/json');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/logout') {
      send(200, '', 'application/json');
      return;
    }
    if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      send(200, JSON.stringify({
        state: 1,
        head: {},
        body: [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '地址栏自测账套', 'MOCK']],
      }), 'application/json');
      return;
    }
    if (url.pathname.endsWith('/FrmMessages.mqttConfig')) {
      send(200, JSON.stringify({ result: false, message: 'mock 未配置 MQTT' }), 'application/json');
      return;
    }
    if (url.pathname === '/favicon.ico') {
      send(404, '', 'text/plain');
      return;
    }
    const style = PAGE_STYLES[pageStyle];
    const meta = style.themeColor ? `<meta name="theme-color" content="${style.themeColor}">` : '';
    const layoutCss = style.leftRail
      ? `body { display: flex; }
         .site-rail { width: 56px; align-self: stretch; flex: none; background: ${style.leftRail}; }
         .site-main { flex: 1; min-width: 0; }`
      : '';
    const railHtml = style.leftRail ? '<div class="site-rail"></div>' : '';
    send(200, `<!DOCTYPE html><html><head><meta charset="utf-8">${meta}<title>${style.title}</title>
<style>
  html, body { margin: 0; }
  body { background: ${style.body}; color: ${style.topBar === '#111318' ? '#eee' : '#222'}; font: 13px system-ui; }
  ${layoutCss}
  .site-top { height: 56px; background: ${style.topBar}; display: flex; align-items: center; padding: 0 20px; box-sizing: border-box; }
  .site-body { padding: 28px 32px; }
</style></head>
<body>${railHtml}<div class="site-main"><div class="site-top">站点顶部导航（${pageStyle}）</div>
<div class="site-body"><h2>mock 页面内容</h2><p>用于验证地址栏是否跟随网页顶部底色。</p></div></div></body></html>`, 'text/html; charset=utf-8');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// ===== 主进程 inspector（--inspect=9231）：取原生 window id，截含 macOS 红绿灯的整窗 =====
let inspectorSocket = null;
let inspectorSeq = 0;
const inspectorPending = new Map();

async function connectInspector() {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${TEST_INSPECT_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const list = await response.json();
        const entry = list.find((item) => item.webSocketDebuggerUrl);
        if (entry) {
          const socket = new WebSocket(entry.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', () => reject(new Error('主进程 inspector 连接失败')), { once: true });
          });
          socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id !== undefined) {
              inspectorPending.get(message.id)?.(message);
              inspectorPending.delete(message.id);
            }
          });
          inspectorSocket = socket;
          return;
        }
      }
    } catch { /* 继续等待 */ }
    await sleep(500);
  }
  throw new Error('主进程 inspector 未就绪');
}

function mainEval(expression) {
  const id = ++inspectorSeq;
  return new Promise((resolve, reject) => {
    inspectorPending.set(id, (message) => {
      if (message.error) reject(new Error(message.error.message));
      else if (message.result?.exceptionDetails) reject(new Error(`主进程求值异常：${message.result.exceptionDetails.text}`));
      else resolve(message.result?.result?.value);
    });
    inspectorSocket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
}

/** 测试主窗原生 window id（screencapture -l 会带上 macOS 红绿灯，用于人工核对基线） */
async function nativeWindowId() {
  await sleep(300);
  const info = await mainEval(`(() => {
    const req = process.mainModule.require.bind(process.mainModule);
    const { BrowserWindow } = req('electron');
    const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed() && item.getContentBounds().width > 500);
    if (!win) return null;
    win.focus();
    win.moveTop();
    return { media: win.getMediaSourceId() };
  })()`);
  const match = String(info?.media ?? '').match(/window:(\d+)/);
  return match ? Number(match[1]) : null;
}

/** 主进程/preload 先编译（脚本直接拉起 electron，需要 dist/main） */
function buildMainAndPreload() {
  for (const project of ['tsconfig.main.json', 'tsconfig.preload.json']) {
    execFileSync(join(PROJECT_ROOT, 'node_modules/.bin/tsc'), ['-p', project], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  }
}

const mock = await startMockServer();
buildMainAndPreload();
await killElectron(20, TEST_CDP_PORT);
await ensureVite();
await startElectron(ELECTRON_LOG, [`--user-data-dir=${USER_DATA_DIR}`, `--inspect=${TEST_INSPECT_PORT}`], TEST_CDP_PORT);
await connectInspector();

const browser = await chromium.connectOverCDP(TEST_CDP_ENDPOINT);
const allPages = () => browser.contexts().flatMap((context) => context.pages());
const findShell = () =>
  allPages().find((page) => page.url().includes('127.0.0.1:5173') && page.url().includes('#/main'));
const findLogin = () =>
  allPages().find((page) => page.url().includes('127.0.0.1:5173') && !page.url().includes('#/main'));

let shell = null;
try {
  let login = null;
  for (let i = 0; i < 30 && !login; i++) {
    login = findLogin();
    if (!login) await sleep(1000);
  }
  check('登录窗出现', Boolean(login), login ? 'ok' : '30s 内未见登录窗');
  if (!login) throw new Error('登录窗未出现');

  await login.fill('#server-base', mock.base);
  await login.fill('#login-id', 'mock-user');
  await login.fill('#password', 'mock-pass');
  await login.click('button[type=submit]');

  for (let i = 0; i < 30 && !shell; i++) {
    shell = findShell();
    if (!shell) await sleep(1000);
  }
  check('登录进入主窗', Boolean(shell), shell ? 'ok' : '30s 内未见 #/main');
  if (!shell) throw new Error('主窗未出现');
  await shell.waitForSelector('[data-testid="browser-toolbar"]', { timeout: 30_000 });
  await shell.waitForSelector('[data-testid="content-card"]', { timeout: 30_000 });
  await sleep(1800);

  /** 读取卡片/地址栏几何与配色 */
  async function readLayout() {
    return shell.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right };
      };
      const card = box('[data-testid="content-card"]');
      const toolbar = box('[data-testid="browser-toolbar"]');
      const rail = box('[data-testid="tabstrip"]');
      const cardEl = document.querySelector('[data-testid="content-card"]');
      const toolbarEl = document.querySelector('[data-testid="browser-toolbar"]');
      const urlText = document.querySelector('[data-testid="url-bar"]');
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        card,
        toolbar,
        rail,
        cardRadius: cardEl ? getComputedStyle(cardEl).borderTopLeftRadius : '',
        cardBackground: cardEl ? getComputedStyle(cardEl).backgroundColor : '',
        toolbarBackground: toolbarEl ? getComputedStyle(toolbarEl).backgroundColor : '',
        tone: cardEl?.getAttribute('data-tone') ?? '',
        urlColor: urlText ? getComputedStyle(urlText).color : '',
      };
    });
  }

  async function shot(name) {
    await shell.screenshot({ path: `${SHOT_PREFIX}-${name}.png` }).catch(() => {});
    try {
      const windowId = await nativeWindowId();
      if (!windowId) {
        console.log('WARN 整窗截图跳过：没拿到原生 window id');
        return;
      }
      await sleep(250);
      execFileSync('screencapture', ['-x', '-o', '-l', String(windowId), `${SHOT_PREFIX}-${name}-window.png`]);
    } catch (error) {
      console.log('WARN 整窗截图跳过（可能未授予屏幕录制权限）：', String(error).slice(0, 120));
    }
  }

  async function setStyle(name) {
    await fetch(`${mock.base}/__style?name=${name}`);
    await shell.click('[data-testid="nav-reload"]');
    await sleep(2600);
  }

  // 1. 卡片几何：地址栏在卡片内、四边 5px、16px 圆角
  let layout = await readLayout();
  console.log('LAYOUT', JSON.stringify(layout));
  check(
    '地址栏在卡片内部（顶部对齐）',
    Boolean(layout.card && layout.toolbar) && Math.abs(layout.toolbar.y - layout.card.y) < 1.5,
    `card.y=${layout.card?.y} toolbar.y=${layout.toolbar?.y}`,
  );
  check(
    '地址栏宽度 = 卡片宽度',
    Boolean(layout.card && layout.toolbar) && Math.abs(layout.toolbar.width - layout.card.width) < 1.5,
    `card=${layout.card?.width} toolbar=${layout.toolbar?.width}`,
  );
  const frameTop = layout.card?.y ?? -1;
  const frameRight = layout.innerWidth - (layout.card?.right ?? 0);
  const frameBottom = layout.innerHeight - (layout.card?.bottom ?? 0);
  const frameLeft = (layout.card?.x ?? 0) - (layout.rail?.right ?? 0);
  check(
    '上/右/下边框等宽（5px）',
    [frameTop, frameRight, frameBottom].every((value) => Math.abs(value - 5) < 1.5),
    `top=${frameTop} right=${frameRight} bottom=${frameBottom}`,
  );
  check('左边框 5px（与 rail 同色融合）', Math.abs(frameLeft - 5) < 1.5, `left=${frameLeft}`);
  check('卡片圆角 16px', String(layout.cardRadius).startsWith('16px'), layout.cardRadius);

  // 2. 地址栏跟随网页顶部底色 + 明暗档
  check('浅色页：卡片/地址栏跟随页面顶部底色', /rgb\(232,\s*240,\s*254\)/.test(layout.cardBackground), layout.cardBackground);
  check('浅色页：地址栏自身透明（露出卡片底色，无第二条色带）', layout.toolbarBackground === 'rgba(0, 0, 0, 0)', layout.toolbarBackground);
  check('浅色页：tone=light', layout.tone === 'light', layout.tone);
  await shot('light');

  await setStyle('themed');
  layout = await readLayout();
  console.log('LAYOUT themed', JSON.stringify({ bg: layout.cardBackground, tone: layout.tone }));
  check('theme-color 页：跟随页面顶部底色', /rgb\(211,\s*227,\s*255\)/.test(layout.cardBackground), layout.cardBackground);
  await shot('themed');

  await setStyle('dark');
  layout = await readLayout();
  console.log('LAYOUT dark', JSON.stringify({ bg: layout.cardBackground, tone: layout.tone, urlColor: layout.urlColor }));
  check('深色页：卡片/地址栏跟随深色底', /rgb\(17,\s*19,\s*24\)/.test(layout.cardBackground), layout.cardBackground);
  check('深色页：tone=dark', layout.tone === 'dark', layout.tone);
  check('深色页：地址栏文字转浅色', Number((layout.urlColor.match(/(\d+)/) || [0, 0])[1]) > 150, layout.urlColor);
  await shot('dark');

  await setStyle('ai');
  layout = await readLayout();
  console.log('LAYOUT ai', JSON.stringify({ bg: layout.cardBackground, tone: layout.tone }));
  check(
    '一侧深色侧栏的页面：仍取页面主底色（多点投票不被侧栏带偏）',
    /rgb\(255,\s*255,\s*255\)/.test(layout.cardBackground) && layout.tone === 'light',
    `${layout.cardBackground} tone=${layout.tone}`,
  );
  await shot('ai');

  // 3. 设置页卡片与网页卡片同规格
  await shell.click('[data-testid="open-settings"]');
  await shell.waitForSelector('[data-testid="settings-page"]', { timeout: 15_000 });
  await sleep(600);
  const settingsPage = await shell.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-page"]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { y: rect.y, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
  });
  check(
    '设置页卡片四边 5px',
    Boolean(settingsPage) &&
      Math.abs(settingsPage.y - 5) < 1.5 &&
      Math.abs(settingsPage.width - settingsPage.right - 5) < 1.5 &&
      Math.abs(settingsPage.height - settingsPage.bottom - 5) < 1.5,
    `page=${JSON.stringify(settingsPage)}`,
  );
  await shot('settings');
  // 功能栏沿用主题标签色，外围色切换后仍清晰可读。
  await shell.click('[data-testid="settings-nav-appearance"]');
  await shell.click('[data-testid="settings-chrome-blue"]');
  await sleep(400);
  await shell.click('[data-testid="settings-back"]');
  await sleep(500);
  const chatAccent = await shell.evaluate(() => {
    const icon = document.querySelector('[data-testid="open-ai"] > span');
    const svg = icon?.querySelector('svg');
    return {
      accent: getComputedStyle(document.documentElement).getPropertyValue('--dsw-chrome-accent').trim(),
      labelColor: getComputedStyle(document.querySelector('[data-testid="open-messages"]')).color,
      iconColor: icon ? getComputedStyle(icon).color : '',
      iconFill: svg ? getComputedStyle(svg).fill : '',
      iconStroke: svg ? getComputedStyle(svg).stroke : '',
    };
  });
  check(
    'Dia 式 AI 入口图标跟随外围强调色',
    chatAccent.accent === '#3b6fd4' && chatAccent.iconColor === 'rgb(59, 111, 212)',
    `accent=${chatAccent.accent} icon=${chatAccent.iconColor}`,
  );
  check(
    'Chat 图标为实心填充（fill 用图标色、无描边）',
    chatAccent.iconFill === chatAccent.iconColor && chatAccent.iconStroke === 'none',
    `fill=${chatAccent.iconFill} stroke=${chatAccent.iconStroke}`,
  );

  // 4. 收起侧栏：保留窄栏，卡片仍四边 5px
  await shell.click('[data-testid="sidebar-toggle"]');
  await sleep(500);
  const collapsed = await shell.evaluate(() => {
    const card = document.querySelector('[data-testid="content-card"]')?.getBoundingClientRect();
    return card
      ? { x: card.x, y: card.y, right: card.right, bottom: card.bottom, width: window.innerWidth, height: window.innerHeight }
      : null;
  });
  check(
    '收起侧栏后卡片仍四边 5px',
    Boolean(collapsed) &&
      Math.abs(collapsed.x - 5) < 1.5 &&
      Math.abs(collapsed.y - 5) < 1.5 &&
      Math.abs(collapsed.width - collapsed.right - 5) < 1.5 &&
      Math.abs(collapsed.height - collapsed.bottom - 5) < 1.5,
    JSON.stringify(collapsed),
  );
  await shot('collapsed');
  await shell.click('[data-testid="sidebar-toggle"]');
  await sleep(500);

  // 5. 多标签：底色按标签各自缓存，切换标签即时换色
  // tab1 切回深色页；把 mock 调回浅色后新建 tab2（浅色页），来回切换应分别得到深/浅底色
  await setStyle('dark');
  await fetch(`${mock.base}/__style?name=light`);
  await mainEval(`(() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('#/main'));
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
    owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers });
    owner.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers });
  })()`);
  await sleep(2800);
  const tab2Layout = await readLayout();
  const tabCount = await shell.evaluate(() => window.__ditengTabsList?.().tabs.length ?? 0);
  console.log('TAB2', JSON.stringify({ bg: tab2Layout.cardBackground, tone: tab2Layout.tone, tabCount }));
  check('新标签（浅色页）地址栏浅色', /rgb\(232,\s*240,\s*254\)/.test(tab2Layout.cardBackground), tab2Layout.cardBackground);
  const tabIds = await shell.evaluate(() => window.__ditengTabsList?.().tabs.map((tab) => tab.id) ?? []);
  await shell.click(`[data-testid="tab-${tabIds[0]}"]`);
  await sleep(700);
  check('切回深色标签：底色恢复深色', /rgb\(17,\s*19,\s*24\)/.test((await readLayout()).cardBackground));
  await shell.click(`[data-testid="tab-${tabIds[1]}"]`);
  await sleep(700);
  check('再切回浅色标签：底色恢复浅色', /rgb\(232,\s*240,\s*254\)/.test((await readLayout()).cardBackground));
  await shot('two-tabs');
} catch (error) {
  console.log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  checks.push({ name: 'harness', ok: false });
} finally {
  await browser.close().catch(() => {});
  await killElectron(20, TEST_CDP_PORT);
  mock.server.close();
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.ok);
console.log(`截图: ${SHOT_PREFIX}-*.png`);
console.log(failed.length ? `RESULT: FAIL（${failed.map((item) => item.name).join('、')}）` : 'RESULT: PASS');
process.exit(failed.length ? 1 : 0);
