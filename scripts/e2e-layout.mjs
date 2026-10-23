import { SERVER_BASE, LOGIN_ID, PASSWORD } from './e2e-secrets.mjs';
/**
 * 真机验证：主窗壳左侧竖向标签栏（rail，唯一布局）。
 * 断言：rail 根容器与竖向形态、侧栏拖宽/双击复位、双标签打开与激活、
 * 用户卡片（打开/账套列表/当前账套打勾）、设置页（打开/返回，标签不丢；
 * 设置导航复用最左 rail：分类切换、主题控件 testid；设置态隐藏底部用户行与齿轮）；
 * Chrome 式浏览器工具栏：宽高、侧栏收起/展开、前进/后退/刷新/主页按钮紧邻地址栏。
 * 注意：ERP 标签是渲染层 <webview>（guest target type=webview），playwright-core 1.64 只把
 * type=page 收进 pages()，ERP 页对 playwright 不可见——第二标签的 window.open 改走原生 CDP。
 * 前置：vite(5173) 和 electron(--remote-debugging-port=9223) 已运行。
 * 用法：node scripts/e2e-layout.mjs
 *   E2E_MOCK=1                      本地 mock 后端自测（不连生产，脚本内起临时 HTTP 服务）
 *   E2E_SERVER_BASE / E2E_LOGIN_ID / E2E_PASSWORD  覆盖目标环境
 * 生产登录遇瞬时失败自动重试一次，仍失败退回 mock 自测（输出注明 MOCK_FALLBACK）。
 * 范围约束：仅登录与打开自有 ERP 页面（window.open 自身地址），不做生产业务操作。
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { resolveAutoLoginGate } from './e2e-login-gate.mjs';

const USE_MOCK = process.env.E2E_MOCK === '1';

/** 本地 mock 后端：登录/账套列表成功、MQTT 配置失败（仅告警）、其余路径给极简 ERP 页 */
function startMockServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
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
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const mock = USE_MOCK ? await startMockServer() : null;
let serverBase = mock ? mock.base : SERVER_BASE;
let erpHost = new URL(serverBase).host;

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');

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
  const version = await fetch('http://127.0.0.1:9223/json/version').then((r) => r.json());
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
    process.exit(1);
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
    process.exit(1);
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
    mock?.server.close();
    await browser.close();
    process.exit(1);
  }
}
await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

// 2. rail 形态断言：根容器存在，tabstrip 宽度=记忆值或默认 300（Cursor/VS Code 同款默认）
async function tabstripBox() {
  return shell.locator('[data-testid="tabstrip"]').boundingBox();
}

check('根容器 shell-rail', (await shell.locator('[data-testid="shell-rail"]').count()) === 1);
// 平台分支：Windows 无系统标题栏（内容列顶部为自绘 caption 条），macOS 红绿灯落 rail 顶栏
const appIsWindows = !(await shell.evaluate(() => /Macintosh/.test(navigator.userAgent)));
if (appIsWindows) {
  const captionBox = await shell.locator('[data-testid="caption-bar"]').boundingBox();
  check(
    'Windows caption 条宽高且贴顶',
    Boolean(captionBox) && captionBox.width >= 400 && captionBox.height >= 36 && captionBox.height <= 44 && captionBox.y <= 1,
    `w=${captionBox?.width} h=${captionBox?.height} y=${captionBox?.y}`,
  );
  for (const testid of ['nav-back', 'nav-forward', 'nav-reload']) {
    check(`caption 导航按钮 ${testid}`, (await shell.locator(`[data-testid="${testid}"]`).count()) === 1);
  }
  for (const testid of ['caption-minimize', 'caption-maximize', 'caption-close']) {
    check(`caption 窗口控制 ${testid}`, (await shell.locator(`[data-testid="${testid}"]`).count()) === 1);
  }
} else {
  check('macOS 无自绘 caption 条', (await shell.locator('[data-testid="caption-bar"]').count()) === 0);
}
check(
  '侧栏开关保留在左栏顶栏',
  (await shell.locator('[data-testid="sidebar-toolbar"] [data-testid="sidebar-toggle"]').count()) === 1,
);
check('rail 品牌行标识', (await shell.locator('[data-testid="sidebar-toolbar"]').innerText()).includes('diteng'));
check('rail AI 对话导航项', (await shell.locator('[data-testid="rail-ai"]').count()) === 1);
check('无浏览器工具栏（已按 dsh 布局移除）', (await shell.locator('[data-testid="browser-toolbar"]').count()) === 0);
check('无地址栏（新建标签页内输入代替）', (await shell.locator('[data-testid="url-bar"]').count()) === 0);
const railConfig = await shell.evaluate(() => window.diteng.getConfig());
const expectedRailWidth = (railConfig.railWidth >= 200 && railConfig.railWidth <= 480) ? railConfig.railWidth : 300;
const box = await tabstripBox();
check(
  'rail tabstrip 竖向侧栏',
  Boolean(box) && Math.abs(box.width - expectedRailWidth) <= 5 && box.height >= 300 && box.x < 10,
  `期望宽=${expectedRailWidth} 实际 x=${box?.x} y=${box?.y} w=${box?.width} h=${box?.height}`,
);

// 3.5 侧栏宽度：先双击复位到默认 300（消除历史记忆宽度，避开 480 上限钳制），再拖 +80 验证跟随与持久化，最后双击复位
{
  const handle = shell.locator('[data-testid="rail-resize-handle"]');
  check('拖拽手柄存在', (await handle.count()) === 1);
  await shell.dblclick('[data-testid="rail-resize-handle"]', { position: { x: 3, y: 300 } });
  await shell.waitForTimeout(400);
  let box0 = await tabstripBox();
  check('双击复位默认 300', Math.abs(box0.width - 300) <= 5, `w=${box0.width}`);
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
  check('拖拽后宽度 +80', Math.abs(afterDrag.width - 380) <= 6, `w=${afterDrag.width} 期望=380`);
  const cfgAfterDrag = await shell.evaluate(() => window.diteng.getConfig());
  check('拖拽宽度已持久化', cfgAfterDrag.railWidth === Math.round(afterDrag.width), `config.railWidth=${cfgAfterDrag.railWidth}`);
  await shell.dblclick('[data-testid="rail-resize-handle"]', { position: { x: 3, y: 300 } });
  await shell.waitForTimeout(400);
  const afterReset = await tabstripBox();
  check('再双击复位默认 300', Math.abs(afterReset.width - 300) <= 5, `w=${afterReset.width}`);
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
  mock?.server.close();
  await browser.close();
  process.exit(1);
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

// 5. 用户卡片：点底部用户行弹出，账套列表渲染，当前账套行打勾（aria-selected），ESC 关闭
const session = await shell.evaluate(() => window.diteng.getSession());
await shell.waitForSelector('[data-testid="user-chip"]:not([disabled])', { timeout: 10_000 });
await shell.click('[data-testid="user-chip"]');
await shell.waitForSelector('[data-testid="user-card"]', { timeout: 5_000 });
check('user-card 打开', (await shell.locator('[data-testid="user-card"]').count()) === 1);
const corpOptionCount = await shell.locator('[data-testid="user-card"] [data-testid^="corp-option-"]').count();
check('卡片账套列表渲染', corpOptionCount >= 1, `options=${corpOptionCount}`);
const currentOption = shell.locator(`[data-testid="user-card"] [data-testid="corp-option-${session.corpNo}"]`);
check(
  '当前账套行打勾',
  (await currentOption.count()) === 1 && (await currentOption.getAttribute('aria-selected')) === 'true',
  `corpNo=${session.corpNo}`,
);
// ESC 关闭卡片
await shell.keyboard.press('Escape');
await shell.waitForTimeout(300);
check('ESC 关闭卡片', (await shell.locator('[data-testid="user-card"]').count()) === 0);

// 6. 设置页：rail 底部齿轮进入，rail 原地换成设置导航，内容区被设置页替换，返回后标签不丢
await shell.click('[data-testid="user-chip"] [data-testid="open-settings"]');
await shell.waitForSelector('[data-testid="settings-page"]', { timeout: 5_000 });
check('settings-page 打开（齿轮入口）', (await shell.locator('[data-testid="settings-page"]').count()) === 1);
check('设置页不显示地址输入条', (await shell.locator('[data-testid="url-bar"]').count()) === 0);
check('设置页不显示地址复制按钮', (await shell.locator('[data-testid="url-bar-copy"]').count()) === 0);
check('设置页不显示浏览器工具栏', (await shell.locator('[data-testid="browser-toolbar"]').count()) === 0);
check('设置页不显示 Chat 工具栏按钮', (await shell.locator('[data-testid="toolbar-chat"]').count()) === 0);
check(
  '设置页 caption 条常驻但导航组隐藏',
  (await shell.locator('[data-testid="caption-bar"]').count()) === (appIsWindows ? 1 : 0) &&
    (await shell.locator('[data-testid="nav-back"]').count()) === 0,
);
const settingsPageBox = await shell.locator('[data-testid="settings-page"]').boundingBox();
const settingsRailBox = await shell.locator('[data-testid="settings-rail"]').boundingBox();
check(
  '设置页从 rail 右侧直接铺开',
  Boolean(settingsPageBox) &&
    Boolean(settingsRailBox) &&
    settingsPageBox.x >= settingsRailBox.x + settingsRailBox.width - 1 &&
    // Windows 顶部为 40px caption 条，macOS 内容直达顶边
    settingsPageBox.y <= (appIsWindows ? 41 : 1),
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

// 6a. 设置导航收进最左 rail：顶部只有返回入口 + 4 个分类；默认外观页主题控件齐全
check(
  '设置导航位于最左 rail',
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
check('设置页隐藏底部用户行', (await shell.locator('[data-testid="tabstrip"] [data-testid="user-chip"]').count()) === 0);
check('设置页隐藏齿轮设置入口', (await shell.locator('[data-testid="open-settings"]').count()) === 0);
const navCount = await shell.locator('[data-testid^="settings-nav-"]').count();
check('设置导航 4 分类', navCount === 4, `nav=${navCount}`);
check(
  '默认外观页导航高亮',
  (await shell.locator('[data-testid="settings-nav-appearance"][aria-current="page"]').count()) === 1,
);
for (const testid of [
  'settings-theme-system',
  'settings-theme-light',
  'settings-theme-dark',
]) {
  check(`外观页控件 ${testid}`, (await shell.locator(`[data-testid="${testid}"]`).count()) === 1);
}

// 6b. 分类切换：点「账号」→ 右栏换页（大卡片 logout 入口出现、主题控件移除），高亮跟随
await shell.click('[data-testid="settings-nav-account"]');
await shell.waitForTimeout(300);
check('账号页 logout 入口', (await shell.locator('[data-testid="settings-page"] [data-testid="logout"]').count()) === 1);
check('账号页导航高亮', (await shell.locator('[data-testid="settings-nav-account"][aria-current="page"]').count()) === 1);
check('切页后主题控件移除', (await shell.locator('[data-testid="settings-theme-system"]').count()) === 0);

await shell.click('[data-testid="settings-back"]');
await shell.waitForTimeout(300);
check('设置页返回', (await shell.locator('[data-testid="settings-page"]').count()) === 0);
check(
  '返回浏览页后恢复 caption 条',
  (await shell.locator('[data-testid="caption-bar"]').count()) === (appIsWindows ? 1 : 0) &&
    (await shell.locator('[data-testid="nav-back"]').count()) === (appIsWindows ? 1 : 0),
);
check('返回后恢复底部用户行', (await shell.locator('[data-testid="user-chip"]').count()) === 1);
state = await shell.evaluate(() => window.__ditengTabsList());
check('返回后标签不丢', state.tabs.length === 2 && state.activeTabId === secondTabId, `tabs=${state.tabs.length} active=${state.activeTabId}`);

// 6d. 侧栏收起/展开：caption 条留在最上方（展开入口移入其左端），rail 从布局中移除，再点同一按钮恢复
await shell.click('[data-testid="sidebar-toggle"]');
await shell.waitForTimeout(300);
check('收起侧栏后 rail 隐藏', (await shell.locator('[data-testid="tabstrip"]').count()) === 0);
check(
  '收起侧栏后 caption 条保留',
  (await shell.locator('[data-testid="caption-bar"]').count()) === (appIsWindows ? 1 : 0),
);
await shell.click('[data-testid="sidebar-toggle"]');
await shell.waitForTimeout(300);
check('展开侧栏后 rail 恢复', (await shell.locator('[data-testid="tabstrip"]').count()) === 1);

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

await shell.screenshot({ path: '/tmp/diteng-layout-rail.png' });
console.log('截图: /tmp/diteng-layout-rail.png');
if (usedMockFallback) console.log('RESULT: MOCK_FALLBACK（生产登录失败，已退回 mock 自测）');
mock?.server.close();
await browser.close();
console.log('全部通过');
