/**
 * 真机验证：Dia 式标签侧栏 + 网页内容双栏布局。
 * 断言：取消功能区、侧栏拖拽/复位/重启恢复、顶部工具入口、设置切换保留网页、
 * 消息角标与异常状态、长账套名、未登录禁用入口、三种窗口尺寸 × 深浅主题 × 三种视图、
 * 反馈截图标注、原生应用快捷键，以及导航组与页面信息布局。
 * 注意：ERP 标签是渲染层 <webview>（guest target type=webview），playwright-core 1.64 只把
 * type=page 收进 pages()，ERP 页对 playwright 不可见——第二标签的 window.open 改走原生 CDP。
 * 非 mock 模式前置：vite(5173) 和 electron(--remote-debugging-port=9223) 已运行。
 * 用法：node scripts/e2e-layout.mjs
 *   E2E_MOCK=1                      自动启动隔离 Electron + 本地 mock（不连生产，不改真实配置）
 *   E2E_SERVER_BASE / E2E_LOGIN_ID / E2E_PASSWORD  覆盖目标环境
 * 生产登录遇瞬时失败自动重试一次，仍失败退回 mock 自测（输出注明 MOCK_FALLBACK）。
 * 范围约束：仅登录与打开自有 ERP 页面（window.open 自身地址），不做生产业务操作。
 */
import { createServer } from 'node:http';
import { chromium, _electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureVite, isHttpOk, PROJECT_ROOT } from './e2e-app-control.mjs';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const USE_MOCK = process.env.E2E_MOCK === '1';
const { SERVER_BASE, LOGIN_ID, PASSWORD } = USE_MOCK
  ? { SERVER_BASE: '', LOGIN_ID: 'layout-test', PASSWORD: 'mock-password' }
  : await import('./e2e-secrets.mjs');
const CDP_ENDPOINT = `http://127.0.0.1:${USE_MOCK ? 9236 : 9223}`;
let testApp = null;
let testLaunchOptions = null;
let browser = null;

/** 本地 mock 后端：登录/账套列表成功、MQTT 配置失败（仅告警）、其余路径给极简 ERP 页 */
function startMockServer() {
  const modulePageRequests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (/\/(FrmMyMessage|chat)(?:$|\.)/.test(url.pathname)) modulePageRequests.push(url.pathname);
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    // 网页版同款登录：POST /services/SvrUserLogin.getToken，form 编码单字段 dataIn（宽松解析，不校验凭据）
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
          token: 'mock-token-layout-e2e',
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
        userName: '布局自测用户',
        corpNo: '250008',
        options: {},
      }), 'application/json');
      return;
    }
    if (url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      send(200, JSON.stringify({
        state: 1,
        head: {},
        body: [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '布局自测账套', 'MOCK']],
      }), 'application/json');
      return;
    }
    if (url.pathname === '/favicon.ico') {
      // 404 让 Chromium 不发 favicon 事件，rail 标签走首字符圆点（真实 ERP 站有 favicon）
      send(404, '', 'text/plain');
      return;
    }
    if (url.pathname.endsWith('/FrmMessages.mqttConfig')) {
      send(200, JSON.stringify({ result: false, message: 'mock 未配置 MQTT' }), 'application/json');
      return;
    }
    send(200, '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ERP Mock 页</title></head><body>mock erp content page</body></html>', 'text/html; charset=utf-8');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, modulePageRequests }));
  });
}

let mock = USE_MOCK ? await startMockServer() : null;
let serverBase = mock ? mock.base : SERVER_BASE;
let erpHost = new URL(serverBase).host;

try {
if (USE_MOCK) {
  if (await isHttpOk(`${CDP_ENDPOINT}/json/version`)) throw new Error('测试端口 9236 已被占用，不接管已有实例');
  await ensureVite();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  testLaunchOptions = {
    args: ['.', '--remote-debugging-port=9236', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'diteng-layout-'))}`],
    cwd: PROJECT_ROOT,
    env,
    timeout: 30_000,
  };
  testApp = await _electron.launch(testLaunchOptions);
}
browser = await chromium.connectOverCDP(CDP_ENDPOINT);

async function pressAppShortcut(keyCode) {
  await testApp.evaluate(({ BrowserWindow }, keyCode) => {
    const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('#/main'));
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  }, keyCode);
}

function allPages() {
  return browser.contexts().flatMap((c) => c.pages());
}
function shellPage() {
  return allPages().find((p) => p.url().includes('127.0.0.1:5173'));
}

/**
 * 原生 CDP 通道（仅 webview guest 用）：playwright-core 1.64 只把 type=page 的 target 收进
 * pages()，<webview> 的 guest（type=webview）不可见，故直连 browser 调试端点查 target、
 * flat session 进 guest 执行 evaluate（Node ≥21 全局 WebSocket）。
 */
async function createCdpLink() {
  const version = await fetch(`${CDP_ENDPOINT}/json/version`).then((r) => r.json());
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, (msg) =>
          msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result),
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

function check(name, ok, detail = '') {
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  if (!ok) {
    console.log('当前 targets:', allPages().map((p) => p.url()));
    throw new Error('布局验证失败');
  }
}

let shell = allPages().find((p) => p.url().includes('#/main'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let usedMockFallback = false;

// 1. 登录（若上轮运行残留 #/main 主窗则直接复用）；生产失败重试一次，仍失败退回 mock 自测
if (!shell) {
  const login = shellPage();
  if (!login) {
    console.log('CHECK 登录窗: FAIL（未见 5173 登录页，请先启动 vite 和 electron --remote-debugging-port=9223）');
    throw new Error('布局验证失败');
  }
  // 自动登录闸门：短等 #/main（自动登录成功→按已登录继续）；仍处自动登录态则点「手动登录」转表单
  shell = await resolveAutoLoginGate(allPages, login);
  async function submitLogin(base) {
    await login.fill('#server-base', base);
    await login.fill('#login-id', LOGIN_ID);
    await login.fill('#password', PASSWORD);
    await login.click('button[type=submit]');
  }
  // 登录成功后登录窗即关闭，轮询不能用 page.waitForTimeout（页面销毁会抛 Target closed）
  async function waitForMain(seconds) {
    let found = null;
    for (let i = 0; i < seconds && !found; i++) {
      await sleep(1000);
      found = allPages().find((p) => p.url().includes('#/main'));
    }
    return found;
  }
  let lastErrorText = '';
  for (let attempt = 0; attempt < 2 && !shell; attempt++) {
    if (attempt === 0) await submitLogin(serverBase);
    else {
      await sleep(1500);
      await login.click('button[type=submit]');
    }
    shell = await waitForMain(30);
    if (!shell) {
      lastErrorText = await login.evaluate(() => {
        const text = document.body.innerText || '';
        return text.split('\n').find((line) => /失败|错误|超时|500/.test(line)) ?? '';
      });
      console.log(`WARN 登录第 ${attempt + 1} 次未成功：${lastErrorText || '(无错误提示)'}`);
    }
  }
  if (!shell && !mock) {
    console.log(`WARN 生产登录重试仍失败（${lastErrorText}），退回 mock 自测（MOCK_FALLBACK）`);
    usedMockFallback = true;
    mock = await startMockServer();
    serverBase = mock.base;
    erpHost = new URL(serverBase).host;
    await submitLogin(serverBase);
    shell = await waitForMain(30);
  }
  check('主窗出现', Boolean(shell), shell ? '' : '30s 内未见 #/main');
  if (!shell) {
    console.log('当前 targets:', allPages().map((p) => p.url()));
    throw new Error('布局验证失败');
  }
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

// 2. rail 形态断言：根容器存在，tabstrip 宽度=记忆值或默认 224（Cursor/VS Code 同款默认）
async function tabstripBox() {
  return shell.locator('[data-testid="tabstrip"]').boundingBox();
}

check('根容器 shell-rail', (await shell.locator('[data-testid="shell-rail"]').count()) === 1);
check('侧栏已移除新建标签和公司下拉入口', await shell.locator('[data-testid="new-tab"], [data-testid="switch-account"]').count() === 0);
const toolbarBox = await shell.locator('[data-testid="browser-toolbar"]').boundingBox();
check(
  'Chrome 式工具栏宽高',
  // 顶部通栏已压缩到 38px（rail 头部与右侧工具栏同高）
  Boolean(toolbarBox) && toolbarBox.width >= 500 && toolbarBox.height >= 32 && toolbarBox.height <= 40,
  `w=${toolbarBox?.width} h=${toolbarBox?.height}`,
);
for (const testid of ['sidebar-toggle', 'nav-back', 'nav-forward', 'nav-reload', 'nav-home']) {
  check(`工具栏按钮 ${testid}`, (await shell.locator(`[data-testid="${testid}"]`).count()) === 1);
}
check(
  '侧栏开关位于顶部通栏',
  (await shell.locator('[data-testid="browser-toolbar"] [data-testid="sidebar-toggle"]').count()) === 1,
);
const navBackBox = await shell.locator('[data-testid="nav-back"]').boundingBox();
const navHomeBox = await shell.locator('[data-testid="nav-home"]').boundingBox();
const urlBarBox = await shell.locator('[data-testid="url-bar"]').boundingBox();
const navAddressGap =
  navHomeBox && urlBarBox ? urlBarBox.x - (navHomeBox.x + navHomeBox.width) : Number.NaN;
check(
  '导航组紧邻地址栏',
  Boolean(navBackBox) &&
    Boolean(urlBarBox) &&
    navBackBox.x > toolbarBox.x &&
    navAddressGap >= 0 &&
    navAddressGap <= 12,
  `nav-back.x=${navBackBox?.x} nav-address.gap=${navAddressGap}`,
);
// 页面信息显示名称和域名，不把会话参数带入壳内文本与 tooltip。
const addressText = (await shell.locator('[data-testid="url-bar"]').innerText()).trim();
check('页面信息有标题且不含会话参数', Boolean(addressText) && !/sid=|CLIENTID=/i.test(addressText));
const railConfig = await shell.evaluate(() => window.diteng.getConfig());
const expectedRailWidth = (railConfig.railWidth >= 200 && railConfig.railWidth <= 480) ? railConfig.railWidth : 224;
const box = await tabstripBox();
check(
  'rail tabstrip 竖向侧栏',
  Boolean(box) && Math.abs(box.width - expectedRailWidth) <= 1 && box.height >= 300 && box.x === 0,
  `期望宽=${expectedRailWidth} 实际 x=${box?.x} y=${box?.y} w=${box?.width} h=${box?.height}`,
);

// 3.5 侧栏宽度：先双击复位到默认 224（消除历史记忆宽度，避开 480 上限钳制），再拖 +80 验证跟随与持久化，最后双击复位
{
  const handle = shell.locator('[data-testid="rail-resize-handle"]');
  check('拖拽手柄存在', (await handle.count()) === 1);
  await shell.dblclick('[data-testid="rail-resize-handle"]', { position: { x: 3, y: 300 } });
  await shell.waitForTimeout(400);
  let box0 = await tabstripBox();
  check('双击复位默认 224', Math.abs(box0.width - 224) <= 5, `w=${box0.width}`);
  const cfgReset = await shell.evaluate(() => window.diteng.getConfig());
  check('复位后 config.railWidth=0', cfgReset.railWidth === 0, `config.railWidth=${cfgReset.railWidth}`);
  const hb = await handle.boundingBox();
  const startX = hb.x + hb.width / 2;
  const startY = hb.y + hb.height / 2;
  await shell.mouse.move(startX, startY);
  await shell.mouse.down();
  await shell.mouse.move(startX + 80, startY, { steps: 8 });
  await shell.mouse.up();
  await shell.waitForTimeout(400);
  const afterDrag = await tabstripBox();
  check('拖拽后宽度 +80', Math.abs(afterDrag.width - 304) <= 6, `w=${afterDrag.width} 期望=304`);
  const cfgAfterDrag = await shell.evaluate(() => window.diteng.getConfig());
  check('拖拽宽度已持久化', cfgAfterDrag.railWidth === Math.round(afterDrag.width), `config.railWidth=${cfgAfterDrag.railWidth}`);
  await shell.dblclick('[data-testid="rail-resize-handle"]', { position: { x: 3, y: 300 } });
  await shell.waitForTimeout(400);
  const afterReset = await tabstripBox();
  check('再双击复位默认 224', Math.abs(afterReset.width - 224) <= 5, `w=${afterReset.width}`);
}

let state = await shell.evaluate(() => window.__ditengTabsList());
check('登录后标签数 1', state.tabs.length === 1, `tabs=${state.tabs.length}`);

// 4. 开第二个标签：ERP 页对自身地址 window.open（同域，转客户端新标签）。
//    ERP 在渲染层 <webview>（type=webview，playwright 不可见），改走原生 CDP：
//    轮询 Target.getTargets 找 ERP guest → attach → guest 内 window.open（userGesture 放行弹窗）
const cdp = await createCdpLink();
let erpTarget = null;
for (let i = 0; i < 40 && !erpTarget; i++) {
  await shell.waitForTimeout(1000);
  const { targetInfos } = await cdp.send('Target.getTargets');
  erpTarget =
    targetInfos.find((t) => {
      if (t.type !== 'webview') return false;
      try {
        return new URL(t.url).host === erpHost && /\/\d+\/Frm/.test(t.url);
      } catch {
        return false;
      }
    }) ?? null;
}
check('ERP 标签 target', Boolean(erpTarget), erpTarget ? '' : '30s 内未见 ERP 页面');
if (!erpTarget) {
  console.log('当前 targets:', allPages().map((p) => p.url()));
  throw new Error('布局验证失败');
}
const { sessionId } = await cdp.send('Target.attachToTarget', {
  targetId: erpTarget.targetId,
  flatten: true,
});
await cdp.send(
  'Runtime.evaluate',
  { expression: `window.open(${JSON.stringify(erpTarget.url)}, '_blank')`, userGesture: true },
  sessionId,
);
await cdp.send('Target.detachFromTarget', { sessionId });
await cdp.close();
await shell.waitForTimeout(3000);
state = await shell.evaluate(() => window.__ditengTabsList());
check('第二标签打开', state.tabs.length === 2, `tabs=${state.tabs.length}`);
const secondTabId = state.tabs[state.tabs.length - 1].id;
check('新标签为激活态', state.activeTabId === secondTabId, `active=${state.activeTabId}`);

// 5. 底部只保留设置入口；外壳不提供退出入口。
await shell.click('[data-testid="open-settings"]');
await shell.waitForSelector('[data-testid="settings-page"]');
check('底部入口打开设置', (await shell.locator('[data-testid="settings-page"]').count()) === 1);
check('外壳不提供退出或账户弹层', (await shell.locator('[data-testid="logout"], [data-testid="user-card"]').count()) === 0);
await shell.keyboard.press('Escape');
await shell.waitForSelector('[data-testid="browser-toolbar"]');

// 6. 设置页：rail 底部齿轮进入，rail 原地换成设置导航，内容区被设置页替换，返回后标签不丢
await shell.click('[data-testid="open-settings"]');
await shell.waitForSelector('[data-testid="settings-page"]', { timeout: 5_000 });
check('settings-page 打开（齿轮入口）', (await shell.locator('[data-testid="settings-page"]').count()) === 1);
check('设置页不显示地址输入条', (await shell.locator('[data-testid="url-bar"]').count()) === 0);
check('设置页不显示地址复制按钮', (await shell.locator('[data-testid="url-bar-copy"]').count()) === 0);
check('设置页不显示浏览器工具栏', (await shell.locator('[data-testid="browser-toolbar"]').count()) === 0);
check('设置页只展示设置内容', (await shell.locator('[data-testid="open-ai"]').count()) === 0);
const settingsPageBox = await shell.locator('[data-testid="settings-page"]').boundingBox();
const settingsRailBox = await shell.locator('[data-testid="settings-rail"]').boundingBox();
check(
  '设置页从 rail 右侧 5px 处铺开（悬浮卡片四边留白一致）',
  Boolean(settingsPageBox) &&
    Boolean(settingsRailBox) &&
    settingsPageBox.x >= settingsRailBox.x + settingsRailBox.width + 4 &&
    settingsPageBox.y >= 4 &&
    settingsPageBox.y <= 6,
  `page.x=${settingsPageBox?.x} y=${settingsPageBox?.y} rail.right=${settingsRailBox ? settingsRailBox.x + settingsRailBox.width : undefined}`,
);
const settingsContentBox = await shell.locator('[data-testid="settings-content"]').boundingBox();
const settingsExpectedContentX =
  settingsPageBox && settingsContentBox
    ? settingsPageBox.x + (settingsPageBox.width - settingsContentBox.width) / 2
    : Number.NaN;
check(
  '设置正文水平居中',
  Boolean(settingsContentBox) &&
    Math.abs(settingsContentBox.x - settingsExpectedContentX) <= 2,
  `content.x=${settingsContentBox?.x} expected=${settingsExpectedContentX}`,
);
const settingsBackground = await shell
  .locator('[data-testid="settings-page"]')
  .evaluate((element) => getComputedStyle(element).backgroundColor);
check('设置页使用统一实底', settingsBackground !== 'rgba(0, 0, 0, 0)', `background=${settingsBackground}`);
state = await shell.evaluate(() => window.__ditengTabsList());
check('设置页打开时标签保留', state.tabs.length === 2 && state.activeTabId === secondTabId, `tabs=${state.tabs.length} active=${state.activeTabId}`);

// 6a. 设置分类位于中间栏，功能栏始终可用；切到外观检查主题控件
check(
  '设置导航位于中间栏',
  (await shell.locator('[data-testid="tabstrip"] [data-testid="settings-rail"]').count()) === 1,
);
check('设置态隐藏标签列表', (await shell.locator('[data-testid="rail-tabs"]').count()) === 0);
check('设置页顶部只保留返回', (await shell.locator('[data-testid="settings-rail"] h1').count()) === 0);
// 返回入口整行可点：命中区铺满 rail 宽度，文字之外（行两端）也能触发返回
const settingsBackBox = await shell.locator('[data-testid="settings-back"]').boundingBox();
check(
  '返回入口整行可点',
  Boolean(settingsBackBox) &&
    Boolean(settingsRailBox) &&
    settingsBackBox.x <= settingsRailBox.x + 1 &&
    settingsBackBox.width >= settingsRailBox.width - 1,
  `back.x=${settingsBackBox?.x} back.w=${settingsBackBox?.width} rail.w=${settingsRailBox?.width}`,
);
check('设置页无搜索框', (await shell.locator('[data-testid="settings-search"]').count()) === 0);
check('设置态底部仅保留设置入口', await shell.locator('[data-testid="sidebar-footer"] button').count() === 1 && await shell.locator('[data-testid="user-chip"]').count() === 0);
check('设置页保留设置入口并高亮', (await shell.locator('[data-testid="open-settings"][aria-pressed="true"]').count()) === 1);
const navCount = await shell.locator('[data-testid^="settings-nav-"]').count();
check('设置导航 5 分类', navCount === 5, `nav=${navCount}`);
await shell.click('[data-testid="settings-nav-appearance"]');
check(
  '外观页导航高亮',
  (await shell.locator('[data-testid="settings-nav-appearance"][aria-current="page"]').count()) === 1,
);
for (const testid of [
  'settings-theme-system',
  'settings-theme-light',
  'settings-theme-dark',
]) {
  check(`外观页控件 ${testid}`, (await shell.locator(`[data-testid="${testid}"]`).count()) === 1);
}

// 6b. 分类切换：点「账号」→ 右栏换页（大卡片仅展示身份、主题控件移除），高亮跟随
await shell.click('[data-testid="settings-nav-account"]');
await shell.waitForTimeout(300);
check('账号页无退出入口', (await shell.locator('[data-testid="settings-page"] [data-testid="logout"]').count()) === 0);
check('账号页导航高亮', (await shell.locator('[data-testid="settings-nav-account"][aria-current="page"]').count()) === 1);
check('切页后主题控件移除', (await shell.locator('[data-testid="settings-theme-system"]').count()) === 0);

await shell.click('[data-testid="settings-back"]');
await shell.waitForTimeout(300);
check('设置页返回', (await shell.locator('[data-testid="settings-page"]').count()) === 0);
check('返回浏览页后恢复浏览器工具栏', (await shell.locator('[data-testid="browser-toolbar"]').count()) === 1);
check('返回后底部无账号信息', await shell.locator('[data-testid="user-chip"]').count() === 0 && (await shell.locator('[data-testid="sidebar-footer"]').innerText()).trim() === '');
state = await shell.evaluate(() => window.__ditengTabsList());
check('返回后标签不丢', state.tabs.length === 2 && state.activeTabId === secondTabId, `tabs=${state.tabs.length} active=${state.activeTabId}`);

// 6c. 完全隐藏中间栏；设置临时展开，返回恢复收起态，webview 实例不变。
const guestIds = await shell.evaluate(() => [...document.querySelectorAll('webview')].map((view) => view.getWebContentsId()));
await shell.click('[data-testid="sidebar-toggle"]');
check('收起后中间栏完全隐藏', (await tabstripBox()) === null);
check('收起后开关仍位于通栏首位', await shell.locator('[data-testid="browser-toolbar"] > button').first().getAttribute('data-testid') === 'sidebar-toggle');
check('已移除独立功能区', await shell.locator('[data-testid="function-rail"]').count() === 0);
check('收起后内容区左移到 5px', (await shell.locator('[data-testid="content-card"]').boundingBox()).x === 5);
if (testApp) {
  await pressAppShortcut(',');
  await shell.waitForSelector('[data-testid="settings-rail"]');
  check('收起态通过快捷键进入设置仍展示分类', await shell.locator('[data-testid="settings-rail"]').isVisible());
  await shell.click('[data-testid="settings-back"]');
  check('返回后恢复收起态', (await tabstripBox()) === null);
}
await shell.click('[data-testid="sidebar-toggle"]');
check('展开后恢复标签侧栏 224px', (await tabstripBox()).width === 224);
check('底部设置入口保持紧凑', (await shell.locator('[data-testid="sidebar-footer"]').boundingBox()).height <= 48);
const restoredGuestIds = await shell.evaluate(() => [...document.querySelectorAll('webview')].map((view) => view.getWebContentsId()));
check('收起和设置切换不重建 webview', JSON.stringify(guestIds) === JSON.stringify(restoredGuestIds));
check('消息、AI 与反馈位于顶部工具栏', await shell.locator('[data-testid="browser-toolbar"] [data-testid="open-ai"]').count() === 1 &&
  await shell.locator('[data-testid="browser-toolbar"] [data-testid="feedback-button"]').count() === 1 &&
  await shell.locator('[data-testid="browser-toolbar"] [data-testid="open-messages"]').count() === 1);

// 消息与 AI 为本地独立模块；切换不创建或销毁 Web 标签，也不请求线上模块页面。
for (const [entry, module] of [['open-messages', 'messages'], ['open-ai', 'ai']]) {
  await shell.click(`[data-testid="${entry}"]`);
  await shell.waitForSelector(`[data-testid="module-${module}"]`);
  const moduleText = await shell.locator(`[data-testid="module-${module}"]`).innerText();
  check(`${module} 使用本地占位`, moduleText.includes(module === 'messages' ? '消息' : 'AI 助手') && moduleText.includes('功能暂未开放'));
  check(`${module} 保留浏览器框架并暂停网页操作`, await shell.locator('[data-testid="browser-toolbar"]').count() === 1 && await shell.locator('[data-testid="nav-reload"]').isDisabled() && (await tabstripBox()).width === 224);
  check(`${module} 不新增标签`, (await shell.evaluate(() => window.__ditengTabsList())).tabs.length === 2);
  await shell.click('[data-testid="open-settings"]');
  await shell.click('[data-testid="settings-back"]');
  check(`退出设置返回 ${module}`, await shell.locator(`[data-testid="module-${module}"]`).isVisible());
  if (module === 'messages') {
    await shell.click('[data-testid="open-settings"]');
    await shell.click('[data-testid="settings-nav-notifications"]');
    await shell.getByRole('button', { name: '查看消息', exact: true }).click();
    check('设置中的消息入口保持打开本地消息', await shell.locator('[data-testid="module-messages"]').isVisible());
  }
  await shell.click('[data-testid="nav-back"]');
  check('工作区恢复之前的 Web 标签', (await shell.evaluate(() => window.__ditengTabsList())).activeTabId === secondTabId);
  const currentGuests = await shell.evaluate(() => [...document.querySelectorAll('webview')].map((view) => view.getWebContentsId()));
  check('模块切换保留 Web 实例', JSON.stringify(currentGuests) === JSON.stringify(restoredGuestIds));
}
if (mock) check('消息与 AI 入口不请求 Web 模块页面', mock.modulePageRequests.length === 0);

// 7. 关闭一个标签（rail 项 hover 显关闭 ×，click 会先 hover 再点）
const firstTabId = state.tabs[0].id;
await shell.click(`[data-testid="tab-close-${firstTabId}"]`);
await shell.waitForTimeout(1000);
state = await shell.evaluate(() => window.__ditengTabsList());
check(
  '关闭后剩 1 标签且激活正确',
  state.tabs.length === 1 && state.activeTabId === secondTabId,
  `tabs=${state.tabs.length} active=${state.activeTabId}`,
);

if (testApp) {
  for (const [testId, pathPart] of [['settings-switch-account', '/TFrmChooseAccount']]) {
    const count = (await shell.evaluate(() => window.__ditengTabsList())).tabs.length;
    await shell.click('[data-testid="open-settings"]');
    await shell.click('[data-testid="settings-nav-account"]');
    await shell.click(`[data-testid="${testId}"]`);
    await shell.waitForFunction((count) => window.__ditengTabsList().tabs.length === count + 1, count);
    let opened = await shell.evaluate(() => window.__ditengTabsList());
    const openedId = opened.activeTabId;
    check(`${testId} 打开正确页面`, opened.tabs.find((tab) => tab.id === openedId).url.includes(pathPart));
    await shell.click('[data-testid="open-settings"]');
    await shell.click('[data-testid="settings-nav-account"]');
    await shell.click(`[data-testid="${testId}"]`);
    await shell.waitForTimeout(150);
    check(`${testId} 复用标签`, (await shell.evaluate(() => window.__ditengTabsList())).tabs.length === count + 1);
    check(`${testId} 保持当前 Web 标签`, (await shell.evaluate(() => window.__ditengTabsList())).activeTabId === openedId);
    await shell.click(`[data-testid="tab-close-${openedId}"]`);
  }
  const sessionSnapshot = await shell.evaluate(() => window.diteng.getSession());
  const mqttSnapshot = await shell.evaluate(() => window.diteng.getMqttState());
  async function emitToShell(channel, payload) {
    await testApp.evaluate(({ BrowserWindow }, { channel, payload }) => {
      BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('#/main')).webContents.send(channel, payload);
    }, { channel, payload });
  }
  for (const unread of [0, 7, 150]) {
    await emitToShell('mqtt:changed', { ...mqttSnapshot, connected: true, connectionStatus: 'connected', unread, unreadError: false });
    await shell.waitForTimeout(100);
    const badge = shell.locator('[data-testid="unread-badge"]');
    check(`消息角标 ${unread}`, unread === 0 ? await badge.count() === 0 : await badge.innerText() === (unread > 99 ? '99+' : String(unread)));
    check('正常连接不显示提示点', await shell.locator('[data-testid="message-warning"]').count() === 0);
  }
  await emitToShell('mqtt:changed', { ...mqttSnapshot, connected: false, connectionStatus: 'reconnecting' });
  await shell.waitForSelector('[data-testid="message-warning"]');
  check('连接异常有可见提示点和说明', (await shell.locator('[data-testid="open-messages"]').getAttribute('title')).includes('重连') &&
    await shell.locator('[data-testid="message-warning"]').evaluate((element) => getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)'));
  await emitToShell('mqtt:changed', mqttSnapshot);

  const longName = '布局验收用超长账套名称用于检查省略与悬停详情';
  await emitToShell('session:changed', { ...sessionSnapshot, corpName: longName });
  await shell.waitForTimeout(100);
  await shell.click('[data-testid="open-settings"]');
  await shell.click('[data-testid="settings-nav-account"]');
  check('公司信息仍可在设置中查看', (await shell.locator('[data-testid="settings-page"]').innerText()).includes(longName));
  await shell.click('[data-testid="settings-back"]');
  await emitToShell('session:changed', null);
  await shell.waitForTimeout(100);
  check('未登录时 AI 和消息入口禁用', await shell.locator('[data-testid="open-ai"]').isDisabled() &&
    await shell.locator('[data-testid="open-messages"]').isDisabled());
  await emitToShell('session:changed', sessionSnapshot);

  for (const [width, height] of [[940, 640], [1280, 800], [1440, 900]]) {
    await testApp.evaluate(({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('#/main'));
      window.setContentSize(width, height);
    }, { width, height });
    await shell.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, { width, height });
    for (const theme of ['light', 'dark']) {
      await shell.evaluate((theme) => window.diteng.setConfig({ theme }), theme);
      await shell.waitForFunction((theme) => document.body.hasAttribute('data-ds-dark-theme') === (theme === 'dark'), theme);
      for (const mode of ['expanded', 'collapsed', 'settings']) {
        if (mode === 'collapsed') await shell.click('[data-testid="sidebar-toggle"]');
        if (mode === 'settings') await pressAppShortcut(',');
        const geometry = await shell.evaluate(() => {
          const box = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
          const rail = box('tabstrip');
          const content = box(document.querySelector('[data-testid="settings-page"]') ? 'settings-page' : 'content-card');
          const footer = box('sidebar-footer');
          const toolbar = document.querySelector('[data-testid="browser-toolbar"]');
          const actions = toolbar ? ['url-bar', 'open-messages', 'feedback-button', 'open-ai'].map(box) : [];
          return { railWidth: rail.width, contentX: content.x, contentRight: content.right, contentBottom: content.bottom,
            footerBottom: footer.bottom, footerHeight: footer.height, scrollWidth: document.documentElement.scrollWidth,
            actionsFit: actions.every((rect, index) => rect.right <= innerWidth && (index === 0 || rect.x >= actions[index - 1].right)) };
        });
        check(`${width}×${height} ${theme} ${mode} 无溢出或入口重叠`, geometry.railWidth === (mode === 'collapsed' ? 0 : 224) && geometry.contentRight <= width &&
          geometry.contentBottom <= height && geometry.footerBottom <= height && geometry.footerHeight <= 56 && geometry.actionsFit &&
          geometry.scrollWidth <= width && geometry.contentX === (mode === 'collapsed' ? 5 : 229));
        await shell.mouse.move(width - 30, height - 30);
        await shell.screenshot({ path: `/tmp/diteng-layout-${width}-${theme}-${mode}.png` });
      }
      await shell.click('[data-testid="settings-back"]');
      await shell.click('[data-testid="sidebar-toggle"]');
    }
  }

  // 长列表独立滚动到底部，标签菜单在窄栏旁仍可操作。
  const beforeNewTabs = (await shell.evaluate(() => window.__ditengTabsList())).tabs.map((tab) => tab.id);
  for (let i = 0; i < 24; i++) await pressAppShortcut('T');
  await shell.waitForFunction((count) => window.__ditengTabsList().tabs.length === count + 24, beforeNewTabs.length);
  const manyTabs = (await shell.evaluate(() => window.__ditengTabsList())).tabs;
  const lastTab = shell.locator(`[data-testid="tab-${manyTabs.at(-1).id}"]`);
  await lastTab.scrollIntoViewIfNeeded();
  check('多标签列表可滚动到底部', await shell.locator('[data-testid="rail-tabs"]').evaluate((element) => element.scrollHeight > element.clientHeight && element.scrollTop > 0));
  await lastTab.click({ button: 'right' });
  await shell.getByRole('menuitem', { name: '关闭其他标签' }).waitFor();
  check('标签右键菜单保持可用', true);
  await shell.keyboard.press('Escape');
  for (const tab of manyTabs.filter((tab) => !beforeNewTabs.includes(tab.id))) await shell.locator(`[data-testid="tab-close-${tab.id}"]`).click();

  // 功能栏反馈入口仍能捕获整窗并打开可绘制的标注画布。
  await shell.click('[data-testid="feedback-button"]');
  const canvas = shell.locator('[data-testid="feedback-editor-canvas"]');
  await canvas.waitFor({ state: 'visible' });
  const canvasBox = await canvas.boundingBox();
  const before = await canvas.evaluate((element) => element.toDataURL());
  await shell.mouse.move(canvasBox.x + canvasBox.width * 0.3, canvasBox.y + canvasBox.height * 0.3);
  await shell.mouse.down();
  await shell.mouse.move(canvasBox.x + canvasBox.width * 0.6, canvasBox.y + canvasBox.height * 0.6, { steps: 8 });
  await shell.mouse.up();
  check('反馈画布可实际标注', await canvas.evaluate((element) => element.toDataURL()) !== before);
  await shell.screenshot({ path: '/tmp/diteng-layout-feedback.png' });
  await shell.click('[data-testid="feedback-cancel"]');
  check('取消反馈返回原页面', await shell.locator('[data-testid="feedback-editor"]').count() === 0);

  // 使用 Electron 原生输入通道，覆盖 before-input-event 到渲染层订阅的完整链路。
  async function pressToggleShortcut() {
    await testApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('#/main'));
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    });
  }
  await pressToggleShortcut();
  await shell.waitForFunction(() => document.querySelector('[data-testid="tabstrip"]').getBoundingClientRect().width === 0);
  await pressToggleShortcut();
  await shell.waitForFunction(() => document.querySelector('[data-testid="tabstrip"]').getBoundingClientRect().width === 224);
  check('展开收起快捷键有效', true);

  // 重启仍从相同隔离配置读取旧版总宽度，不创建新配置字段。
  await shell.evaluate(() => window.diteng.setConfig({ railWidth: 304, theme: 'light' }));
  await browser.close();
  browser = null;
  await testApp.close();
  testApp = await _electron.launch(testLaunchOptions);
  browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  for (let i = 0; i < 50; i++) {
    shell = allPages().find((page) => page.url().includes('#/main'));
    if (shell) break;
    await sleep(200);
  }
  check('重启后自动恢复本地 mock 会话', Boolean(shell));
  await shell.waitForFunction(() => document.querySelector('[data-testid="tabstrip"]')?.getBoundingClientRect().width === 304);
  check('重启后左侧总宽恢复 304px', (await tabstripBox()).width === 304);
  await shell.dblclick('[data-testid="rail-resize-handle"]', { position: { x: 3, y: 300 } });
}

await shell.screenshot({ path: '/tmp/diteng-layout-rail.png' });
console.log('截图: /tmp/diteng-layout-rail.png');
if (usedMockFallback) console.log('RESULT: MOCK_FALLBACK（生产登录失败，已退回 mock 自测）');
console.log('全部通过');
} finally {
  await browser?.close();
  await testApp?.close();
  mock?.server.close();
}
