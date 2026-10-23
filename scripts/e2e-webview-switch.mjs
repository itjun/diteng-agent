import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { CDP_ENDPOINT, createCdpLink, sleep } from './e2e-app-control.mjs';

/**
 * 真机 mock e2e：网页版切换账套后「主进程会话 → 设置页账号卡/用户行 → 壳标签」同步。
 * 账套切换只在网页版内发生（壳内不再提供账套菜单），切换成功后壳关闭当前标签以外的全部标签。
 * 链路：
 *   A 网页内 SPA 切账套：guest 内 history.pushState 到 /250050/FrmMyMessage（不带 sid）→ 主进程
 *     getNuewToken 换票 + getTokenInfo 取信 → 会话 corpNo=250050/userCode=25005001/corpName=中储粮(天津)/homeForm=FrmDefault，
 *     设置页账号卡 settings-corp-name/settings-corp-no 与用户行同步，标签 corpNo 重记账，
 *     其他标签全部关闭且仅保留发起切换的当前标签。
 *   B 网页内 SSR 切账套：pushState 到 /250059/FrmDefault?sid=<合成sid> → 主进程直接采信 URL 凭证调 getTokenInfo、
 *     不再换票（getNuewToken 次数不增）；设置页在打开状态下随 session:changed 实时刷回 250059/盛世浩淼。
 *   C 经典页同 token（同 sid）切账套：guest 内 POST TFrmChooseAccount.switchUser（body code=目标子账号代码），
 *     服务端只刷新同一 token 会话选项、返回 data.url，页面 location.href 整页跳转（同一 sid + 新账套号）。
 *     断言主进程在 sid 未变、URL 账套号变化时仍调 getTokenInfo 同步（+1）且不换票（getNuewToken 不增），
 *     会话/设置页/用户行/标签 corpNo 同步；并连续切回一次（C1 250059→250050、C2 250050→250059）。
 *
 * 安全：本脚本只允许本地 mock 后端（E2E_SERVER_BASE=http://127.0.0.1:<port>），
 * 否则直接退出（防止对生产环境发起登录/换票等写操作）。前置：mock(8788) 已起、
 * electron(--remote-debugging-port=9223) 已按 mock 配置重启、vite(5173) 存活（由 e2e-corp-sync-run.mjs 编排）。
 *
 * 用法：E2E_SERVER_BASE=http://127.0.0.1:8788 node scripts/e2e-webview-switch.mjs
 * 输出：逐条 `CHECK 名称: OK/FAIL（实际值）`、截图 /tmp/diteng-corp-sync-*.png、
 *       结果 JSON /tmp/diteng-corp-sync-result.json；有 FAIL 时退出码 1。
 */

const SERVER_BASE = (process.env.E2E_SERVER_BASE ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
let mockHost = '';
try {
  mockHost = new URL(SERVER_BASE).host;
} catch {
  mockHost = '';
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(SERVER_BASE) || !mockHost) {
  console.error(
    `拒绝运行：E2E_SERVER_BASE=${SERVER_BASE || '(空)'}。本脚本只允许本地 mock（http://127.0.0.1:<端口>），` +
      '以防止对真实环境发起登录、换票等写操作。',
  );
  process.exit(2);
}

/** 起始账套（登录 token 对应）：用 SSR 链路切回的账套 B */
const CORP_B = { corpNo: '250059', userCode: '25005902', corpName: '盛世浩淼' };
/** SPA 切换的目标账套 A */
const CORP_A = { corpNo: '250050', userCode: '25005001', corpName: '中储粮(天津)' };
/** 合成 SSR sid：mock 按结尾 6 位账套号反查账套 */
const SSR_SID = `T_MOCK_SSR_${CORP_B.corpNo}`;
const RESULT_FILE = '/tmp/diteng-corp-sync-result.json';

const checks = [];
const screenshots = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  return Boolean(ok);
}

async function waitUntil(fn, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
    } catch {
      last = null;
    }
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

const allPages = () => browser.contexts().flatMap((context) => context.pages());
const findShell = () => allPages().find((page) => page.url().includes('127.0.0.1:5173') && page.url().includes('#/main'));
const findLogin = () =>
  allPages().find((page) => page.url().includes('127.0.0.1:5173') && !page.url().includes('#/main'));

const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
let shell = null;
let cdp = null;
/** 初始 ERP guest target：场景 A 前置会再开一个标签，注入必须固定回到原标签 */
let erpTargetId = '';

const getSession = () => shell.evaluate(() => window.diteng.getSession());
const tabsState = () => shell.evaluate(() => window.__ditengTabsList());
const fetchCalls = async () => (await fetch(`${SERVER_BASE}/__calls`)).json();
const countCalls = async () => {
  const calls = await fetchCalls();
  const count = (kind) => calls.filter((call) => call.kind === kind).length;
  return {
    getNuewToken: count('getNuewToken'),
    getTokenInfo: count('getTokenInfo'),
    switchUser: count('switchUser'),
    login: count('login'),
    listMyLivingUsers: count('listMyLivingUsers'),
  };
};

/** 取某类 mock 调用的最后一条（token 只记前缀，用于断言「同一 token」） */
async function lastCallOf(kind) {
  const calls = await fetchCalls();
  return calls.filter((call) => call.kind === kind).at(-1) ?? null;
}

/** 从 /__calls detail 里取字段值（如 sid=T_MOCK_250050 / token=T_MOCK_250050） */
function detailField(detail, field) {
  const matched = String(detail ?? '').match(new RegExp(`${field}=([^\\s]+)`));
  return matched?.[1] ?? '';
}

async function waitForSession(predicate, timeoutMs = 20_000) {
  return waitUntil(async () => {
    const session = await getSession();
    return predicate(session) ? session : null;
  }, timeoutMs);
}

async function shot(name) {
  const path = `/tmp/${name}.png`;
  try {
    await shell.screenshot({ path });
    screenshots.push(path);
  } catch (error) {
    console.log(`WARN 截图失败 ${path}: ${error?.message ?? error}`);
  }
  return path;
}

async function readUserChip() {
  await shell.waitForSelector('[data-testid="user-chip"]', { timeout: 10_000 });
  const text = ((await shell.textContent('[data-testid="user-chip"]')) ?? '').replace(/\s+/g, ' ').trim();
  const title = (await shell.getAttribute('[data-testid="user-chip"]', 'title')) ?? '';
  return { text, title };
}

/** 进设置页 → 账号分类；账号卡名/代码 testid 见 task-2（settings-corp-name / settings-corp-no） */
async function openSettingsAccount() {
  await shell.waitForSelector('[data-testid="user-chip"] [data-testid="open-settings"]', { timeout: 10_000 });
  await shell.click('[data-testid="user-chip"] [data-testid="open-settings"]');
  await shell.waitForSelector('[data-testid="settings-nav-account"]', { timeout: 10_000 });
  await shell.click('[data-testid="settings-nav-account"]');
  await shell.waitForSelector('[data-testid="settings-corp-name"]', { timeout: 10_000 });
}

async function readSettingsCard() {
  const name = ((await shell.textContent('[data-testid="settings-corp-name"]')) ?? '').trim();
  // 契约：副标题 testid 实际为 settings-corp-no；兼容 settings-corp-code，二者取其一
  const codeLocator = shell.locator('[data-testid="settings-corp-no"], [data-testid="settings-corp-code"]').first();
  const code = (await codeLocator.count()) > 0 ? ((await codeLocator.textContent()) ?? '').trim() : '';
  return { name, code };
}

async function waitSettingsCard(predicate, timeoutMs = 15_000) {
  return waitUntil(async () => {
    const card = await readSettingsCard();
    return predicate(card) ? card : null;
  }, timeoutMs);
}

async function closeSettings() {
  await shell.click('[data-testid="settings-back"]');
  await shell.waitForSelector('[data-testid="settings-page"]', { state: 'detached', timeout: 10_000 });
}

/** 断言设置页账号卡：大标题=账套名称、副标题=账套代码 */
async function checkSettingsCard(label, expected) {
  const card = await readSettingsCard();
  check(
    `${label} 设置页账套名称（settings-corp-name）`,
    card.name === expected.corpName,
    `期望=${expected.corpName} 实际=${JSON.stringify(card.name)}`,
  );
  check(
    `${label} 设置页账套代码（settings-corp-no）`,
    card.code === expected.corpNo,
    `期望=${expected.corpNo} 实际=${JSON.stringify(card.code)}`,
  );
  const pageText = ((await shell.textContent('[data-testid="settings-page"]')) ?? '').replace(/\s+/g, ' ');
  check(`${label} 设置页已移除「当前账套」行`, !pageText.includes('当前账套'), '账号页仍出现「当前账套」文案');
}

/** 断言会话四要素中的展示三要素（corpNo/userCode/corpName） */
function checkSession(label, session, expected) {
  check(`${label} 会话 corpNo`, session?.corpNo === expected.corpNo, `期望=${expected.corpNo} 实际=${session?.corpNo}`);
  check(`${label} 会话 userCode`, session?.userCode === expected.userCode, `期望=${expected.userCode} 实际=${session?.userCode}`);
  check(
    `${label} 会话 corpName`,
    session?.corpName === expected.corpName,
    `期望=${expected.corpName} 实际=${JSON.stringify(session?.corpName)}`,
  );
}

async function checkUserChip(label, expected) {
  const matched = await waitUntil(async () => {
    const chip = await readUserChip();
    return chip.text.includes(expected.corpName) ? chip : null;
  }, 15_000);
  const actual = matched ?? (await readUserChip().catch(() => ({ text: '(读取失败)', title: '' })));
  check(
    `${label} 用户行显示账套名称`,
    Boolean(matched),
    `期望含=${expected.corpName} 实际="${actual.text}" title="${actual.title}"`,
  );
  return actual;
}

/** 找 ERP webview guest target（playwright pages() 不可见，走原生 CDP Target.getTargets） */
async function findErpTarget() {
  if (!cdp) return null;
  const { targetInfos } = await cdp.send('Target.getTargets');
  return (
    targetInfos.find((target) => {
      if (target.type !== 'webview' && target.type !== 'page') return false;
      try {
        const url = new URL(target.url);
        return url.host === mockHost && /^\/\d{5,8}\/Frm/.test(url.pathname);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** 在 ERP guest 内执行表达式（attach → Runtime.evaluate → detach）；固定注入初始标签的 target */
async function evalInGuest(expression) {
  const targetId = erpTargetId;
  if (!targetId) throw new Error('未找到 ERP webview target');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '';
      throw new Error(`guest 内执行失败：${description}`);
    }
    return result.result?.value;
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

/** 模拟网页版切账套的页内路由变化（不整页跳转，不触发加载） */
async function pushGuestUrl(path) {
  await evalInGuest(`history.pushState({}, '', ${JSON.stringify(path)})`);
}

/**
 * 场景 C：在 guest 内模拟经典页（myapp.js）切账套：
 * 页头账套卡片 → POST 当前账套的 TFrmChooseAccount.switchUser（body code=目标子账号代码），
 * 服务端（mock）把当前 sid 原地改绑到目标账套、不换 token；页面拿返回的 data.url 做整页跳转
 * （同一 sid + 新账套号）。setTimeout 让本次 evaluate 先返回再触发导航，避免 CDP 会话随文档销毁报错。
 */
async function switchUserInGuest(targetCorp) {
  const expression = `(async () => {
    const current = new URL(location.href);
    const currentCorpNo = current.pathname.split('/').filter(Boolean)[0] || '';
    const sid = current.searchParams.get('sid') || '';
    const clientId = current.searchParams.get('CLIENTID') || 'e2e';
    const endpoint = '/' + currentCorpNo + '/TFrmChooseAccount.switchUser'
      + '?sid=' + encodeURIComponent(sid)
      + '&CLIENTID=' + encodeURIComponent(clientId)
      + '&device=pc';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=' + encodeURIComponent(${JSON.stringify(targetCorp.userCode)}),
    });
    const data = await response.json();
    if (!data || data.result !== true || typeof data.url !== 'string') {
      throw new Error('switchUser 返回异常：' + JSON.stringify(data));
    }
    setTimeout(() => { location.href = data.url; }, 50);
    return { url: data.url, fromCorpNo: currentCorpNo };
  })()`;
  return evalInGuest(expression);
}

async function loginWithMock() {
  const login = findLogin();
  if (!login) throw new Error('未找到登录页（electron 9223 / vite 5173 是否已按 mock 配置重启？）');
  // 兜底：若误入自动登录态，取消后走手动登录（测试配置已清空 savedPassword，正常不会出现）
  if ((await login.locator('[data-testid="auto-login-state"]').count()) > 0) {
    await login.click('[data-testid="auto-login-cancel"]');
  }
  await login.waitForSelector('#server-base', { timeout: 15_000 });
  await login.fill('#server-base', SERVER_BASE);
  await login.fill('#login-id', 'e2e-mock-account');
  await login.fill('#password', 'e2e-mock-password');
  await login.click('button[type=submit]');
  const found = await waitUntil(() => findShell(), 60_000, 500);
  if (!found) {
    const errorText = await login
      .evaluate(() => {
        const text = document.body.innerText || '';
        return text.split('\n').find((line) => /失败|错误|超时|500/.test(line)) ?? '(无错误提示)';
      })
      .catch(() => '(登录页已关闭)');
    throw new Error(`mock 登录后 60s 未见 #/main：${errorText}`);
  }
  shell = found;
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
}

try {
  // ============================== 0. 登录 / 初始状态 ==============================
  shell = findShell();
  if (shell) {
    console.log('WARN 复用已存在的主窗（应由编排脚本重启出干净登录窗）');
  } else {
    console.log('STEP 登录（本地 mock，账号无关）');
    await loginWithMock();
  }
  check('主窗就绪（#/main + tabstrip）', Boolean(shell));

  const initial = await waitForSession((session) => Boolean(session), 10_000);
  check('初始会话 corpNo=' + CORP_B.corpNo, initial?.corpNo === CORP_B.corpNo, `实际=${initial?.corpNo}`);
  check('初始会话 userCode=' + CORP_B.userCode, initial?.userCode === CORP_B.userCode, `实际=${initial?.userCode}`);
  check(
    '初始会话 corpName=' + CORP_B.corpName,
    initial?.corpName === CORP_B.corpName,
    `实际=${JSON.stringify(initial?.corpName)}（登录链路应经 getTokenInfo + 账套列表 ShortName_ 解析）`,
  );
  await checkUserChip('初始', CORP_B);

  await openSettingsAccount();
  await checkSettingsCard('初始', CORP_B);
  await shot('diteng-corp-sync-initial-settings');
  await closeSettings();

  // ERP webview guest（原生 CDP 才可见）
  cdp = await createCdpLink();
  const erpTarget = await waitUntil(() => findErpTarget(), 45_000, 500);
  check('ERP webview target 就绪', Boolean(erpTarget), erpTarget ? erpTarget.url : '45s 内未见 /{corpNo}/Frm 的 webview guest');
  if (!erpTarget) throw new Error('ERP webview target 未出现，无法执行网页内切账套场景');
  erpTargetId = erpTarget.targetId;

  // 壳内切账套入口已移除，网页内切换后应关闭其他标签：先多开一个标签，再切回当前标签发起切换。
  const initialTabs = await tabsState();
  const currentTabId = initialTabs.activeTabId;
  await shell.click('[data-testid="new-tab"]');
  const twoTabs = await waitUntil(async () => {
    const state = await tabsState();
    return state.tabs.length === initialTabs.tabs.length + 1 ? state : null;
  }, 15_000);
  check(
    '场景A 前置：第二个标签已打开',
    Boolean(twoTabs),
    `tabs=${(twoTabs ?? (await tabsState())).tabs.length}`,
  );
  await shell.click(`[data-testid="tab-${currentTabId}"]`);
  const isReactivated = await waitUntil(async () => (await tabsState()).activeTabId === currentTabId, 5_000);
  check('场景A 前置：切回发起切换的标签', Boolean(isReactivated), `active=${(await tabsState()).activeTabId}`);
  // 同账套导航账套号未变，不应触发关闭
  await pushGuestUrl(`/${CORP_B.corpNo}/FrmMyMessage`);
  await sleep(2000);
  check(
    '场景A 前置：同账套导航不关闭标签',
    (await tabsState()).tabs.length === initialTabs.tabs.length + 1,
    JSON.stringify((await tabsState()).tabs.map((tab) => ({ url: tab.url, corpNo: tab.corpNo }))),
  );

  // ============================== A. 网页内 SPA 切账套（无 sid） ==============================
  console.log(`STEP 场景A：guest pushState /${CORP_A.corpNo}/FrmMyMessage（SPA 形态，不带 sid）`);
  const beforeA = await countCalls();
  await pushGuestUrl(`/${CORP_A.corpNo}/FrmMyMessage`);
  const sessionA = await waitForSession((session) => session?.corpNo === CORP_A.corpNo, 25_000);
  checkSession('场景A', sessionA, CORP_A);
  check('场景A 会话 homeForm=FrmDefault', sessionA?.homeForm === 'FrmDefault', `实际=${sessionA?.homeForm}`);
  const afterA = await countCalls();
  check(
    '场景A 经 getNuewToken 换票一次',
    afterA.getNuewToken === beforeA.getNuewToken + 1,
    `${beforeA.getNuewToken} -> ${afterA.getNuewToken}`,
  );
  check(
    '场景A 以新 token 调 getTokenInfo',
    afterA.getTokenInfo > beforeA.getTokenInfo,
    `${beforeA.getTokenInfo} -> ${afterA.getTokenInfo}`,
  );
  // 切账套成功后壳只保留当前标签：第二个标签关闭，当前标签重记账为新账套
  const closedState = await waitUntil(async () => {
    const state = await tabsState();
    return state.tabs.length === 1 ? state : null;
  }, 20_000);
  check(
    '场景A 切账套后仅保留当前标签',
    Boolean(closedState) && closedState.activeTabId === currentTabId,
    JSON.stringify((await tabsState()).tabs.map((tab) => ({ id: tab.id, url: tab.url, corpNo: tab.corpNo }))),
  );
  const tabA = await waitUntil(async () => {
    const state = await tabsState();
    return (
      state.tabs.find(
        (tab) => tab.id === currentTabId && tab.url.includes(`/${CORP_A.corpNo}/`) && tab.corpNo === CORP_A.corpNo,
      ) ?? null
    );
  }, 15_000);
  check(
    '场景A 当前标签 URL/corpNo 重记账为 ' + CORP_A.corpNo,
    Boolean(tabA),
    JSON.stringify((await tabsState()).tabs.map((tab) => ({ url: tab.url, corpNo: tab.corpNo }))),
  );
  await checkUserChip('场景A', CORP_A);
  await openSettingsAccount();
  await checkSettingsCard('场景A', CORP_A);
  await shot('diteng-corp-sync-a-settings');
  await closeSettings();

  // ============================== B. 网页内 SSR 切账套（带合成 sid） ==============================
  console.log(`STEP 场景B：guest pushState /${CORP_B.corpNo}/FrmDefault?sid=${SSR_SID}（SSR 形态，直接采信 URL 凭证）`);
  // 设置页保持打开，验证 session:changed 后账号卡实时刷新
  await openSettingsAccount();
  const cardA = await waitSettingsCard(
    (card) => card.name === CORP_A.corpName && card.code === CORP_A.corpNo,
    5_000,
  );
  check(
    '场景B 前置：设置页仍显示场景A账套',
    Boolean(cardA),
    JSON.stringify(cardA ?? (await readSettingsCard())),
  );
  const beforeB = await countCalls();
  await pushGuestUrl(`/${CORP_B.corpNo}/FrmDefault?sid=${SSR_SID}&CLIENTID=e2e&device=pc`);
  const sessionB = await waitForSession((session) => session?.corpNo === CORP_B.corpNo, 25_000);
  const cardB = await waitSettingsCard((card) => card.name === CORP_B.corpName && card.code === CORP_B.corpNo, 15_000);
  check(
    '场景B 设置页实时刷新为账套名称 ' + CORP_B.corpName,
    cardB?.name === CORP_B.corpName,
    `实际=${JSON.stringify((await readSettingsCard()).name)}`,
  );
  check(
    '场景B 设置页实时刷新为账套代码 ' + CORP_B.corpNo,
    cardB?.code === CORP_B.corpNo,
    `实际=${JSON.stringify((await readSettingsCard()).code)}`,
  );
  checkSession('场景B', sessionB, CORP_B);
  check('场景B 会话 homeForm=FrmDefault', sessionB?.homeForm === 'FrmDefault', `实际=${sessionB?.homeForm}`);
  const afterB = await countCalls();
  check(
    '场景B 未再换票（getNuewToken 次数不增）',
    afterB.getNuewToken === beforeB.getNuewToken,
    `${beforeB.getNuewToken} -> ${afterB.getNuewToken}`,
  );
  check(
    '场景B 直接以 URL sid 调 getTokenInfo',
    afterB.getTokenInfo > beforeB.getTokenInfo,
    `${beforeB.getTokenInfo} -> ${afterB.getTokenInfo}`,
  );
  await shot('diteng-corp-sync-b-settings');
  await closeSettings();
  await checkUserChip('场景B', CORP_B);

  // ============================== C. 经典页同 token（同 sid）整页导航切账套 ==============================
  // 真实网页版页头账套卡片：switchUser(code) → 服务端只刷新同一 token 会话选项 → location.href = data.url
  // （同一 sid + 新账套号）。主进程须在 sid 未变、URL 账套号变化时继续 getTokenInfo 同步。
  await waitUntil(() => findErpTarget(), 15_000);
  console.log(
    `STEP 场景C1：guest 内 TFrmChooseAccount.switchUser(code=${CORP_A.userCode}) → location.href /${CORP_A.corpNo}/FrmDefault（同一 sid）`,
  );
  const beforeC1 = await countCalls();
  const switchC1 = await switchUserInGuest(CORP_A);
  check(
    '场景C1 switchUser 返回同 sid 新账套 URL',
    typeof switchC1?.url === 'string' &&
      switchC1.fromCorpNo === CORP_B.corpNo &&
      switchC1.url.includes(`/${CORP_A.corpNo}/FrmDefault`) &&
      switchC1.url.includes('sid='),
    JSON.stringify(switchC1),
  );
  const sessionC1 = await waitForSession((session) => session?.corpNo === CORP_A.corpNo, 25_000);
  checkSession('场景C1', sessionC1, CORP_A);
  check('场景C1 会话 homeForm=FrmDefault', sessionC1?.homeForm === 'FrmDefault', `实际=${sessionC1?.homeForm}`);
  const afterC1 = await countCalls();
  check(
    '场景C1 getTokenInfo 次数 +1（同 sid 也同步）',
    afterC1.getTokenInfo === beforeC1.getTokenInfo + 1,
    `${beforeC1.getTokenInfo} -> ${afterC1.getTokenInfo}`,
  );
  check(
    '场景C1 未换票（getNuewToken 次数不增）',
    afterC1.getNuewToken === beforeC1.getNuewToken,
    `${beforeC1.getNuewToken} -> ${afterC1.getNuewToken}`,
  );
  check(
    '场景C1 调用了 switchUser 端点',
    afterC1.switchUser === beforeC1.switchUser + 1,
    `${beforeC1.switchUser} -> ${afterC1.switchUser}`,
  );
  const sidC1 = detailField((await lastCallOf('switchUser'))?.detail, 'sid');
  const tokenC1 = detailField((await lastCallOf('getTokenInfo'))?.detail, 'token');
  check(
    '场景C1 getTokenInfo 使用 switchUser 的同一 token',
    Boolean(sidC1) && sidC1 === tokenC1,
    `switchUser sid=${sidC1 || '(空)'} getTokenInfo token=${tokenC1 || '(空)'}`,
  );
  const tabC1 = await waitUntil(async () => {
    const state = await tabsState();
    return state.tabs.find((tab) => tab.url.includes(`/${CORP_A.corpNo}/`) && tab.corpNo === CORP_A.corpNo) ?? null;
  }, 15_000);
  check(
    '场景C1 标签 corpNo 重记账为 ' + CORP_A.corpNo,
    Boolean(tabC1),
    JSON.stringify((await tabsState()).tabs.map((tab) => ({ url: tab.url, corpNo: tab.corpNo }))),
  );
  await checkUserChip('场景C1', CORP_A);
  await openSettingsAccount();
  await checkSettingsCard('场景C1', CORP_A);
  await shot('diteng-corp-sync-c1-settings');
  await closeSettings();

  console.log(
    `STEP 场景C2：再次同 token 切回 ${CORP_B.corpNo}（switchUser code=${CORP_B.userCode} → location.href /${CORP_B.corpNo}/FrmDefault）`,
  );
  const beforeC2 = await countCalls();
  const switchC2 = await switchUserInGuest(CORP_B);
  check(
    '场景C2 switchUser 返回同 sid 新账套 URL',
    typeof switchC2?.url === 'string' &&
      switchC2.fromCorpNo === CORP_A.corpNo &&
      switchC2.url.includes(`/${CORP_B.corpNo}/FrmDefault`) &&
      switchC2.url.includes('sid='),
    JSON.stringify(switchC2),
  );
  const sessionC2 = await waitForSession((session) => session?.corpNo === CORP_B.corpNo, 25_000);
  checkSession('场景C2', sessionC2, CORP_B);
  check('场景C2 会话 homeForm=FrmDefault', sessionC2?.homeForm === 'FrmDefault', `实际=${sessionC2?.homeForm}`);
  const afterC2 = await countCalls();
  check(
    '场景C2 getTokenInfo 次数 +1（连续同 token 切换）',
    afterC2.getTokenInfo === beforeC2.getTokenInfo + 1,
    `${beforeC2.getTokenInfo} -> ${afterC2.getTokenInfo}`,
  );
  check(
    '场景C2 未换票（getNuewToken 次数不增）',
    afterC2.getNuewToken === beforeC2.getNuewToken,
    `${beforeC2.getNuewToken} -> ${afterC2.getNuewToken}`,
  );
  const sidC2 = detailField((await lastCallOf('switchUser'))?.detail, 'sid');
  check(
    '场景C1/C2 两次 switchUser 复用同一 token（全程未换票）',
    Boolean(sidC1) && sidC1 === sidC2,
    `C1 sid=${sidC1 || '(空)'} C2 sid=${sidC2 || '(空)'}`,
  );
  const tabC2 = await waitUntil(async () => {
    const state = await tabsState();
    return state.tabs.find((tab) => tab.url.includes(`/${CORP_B.corpNo}/`) && tab.corpNo === CORP_B.corpNo) ?? null;
  }, 15_000);
  check(
    '场景C2 标签 corpNo 重记账为 ' + CORP_B.corpNo,
    Boolean(tabC2),
    JSON.stringify((await tabsState()).tabs.map((tab) => ({ url: tab.url, corpNo: tab.corpNo }))),
  );
  await checkUserChip('场景C2', CORP_B);
  await openSettingsAccount();
  await checkSettingsCard('场景C2', CORP_B);
  await shot('diteng-corp-sync-c2-settings');
  await closeSettings();
  await shot('diteng-corp-sync-shell');
} catch (error) {
  check('脚本执行完成', false, `${error?.message ?? error}`);
  if (shell) {
    await shot('diteng-corp-sync-failure');
    console.log('失败时 target 列表:', allPages().map((page) => page.url()));
  }
} finally {
  const passCount = checks.filter((item) => item.ok).length;
  const failChecks = checks.filter((item) => !item.ok);
  let callsSnapshot = [];
  try {
    const allCalls = await fetchCalls();
    callsSnapshot = allCalls.filter((call) => call.kind !== 'page');
  } catch {
    // mock 可能已退出，结果文件仍要落盘
  }
  const result = {
    timestamp: new Date().toISOString(),
    serverBase: SERVER_BASE,
    pass: passCount,
    fail: failChecks.length,
    checks,
    screenshots,
    calls: callsSnapshot,
  };
  try {
    writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(`WARN 结果文件写入失败：${error?.message ?? error}`);
  }
  console.log('—— 截图 ——');
  for (const path of screenshots) console.log(path);
  console.log(`RESULT: ${failChecks.length === 0 ? 'PASS' : 'FAIL'}（${passCount}/${checks.length} 项通过）`);
  if (failChecks.length > 0) {
    console.log('失败明细：');
    for (const item of failChecks) console.log(`- ${item.name}：${item.detail}`);
  }
  console.log(`结果文件: ${RESULT_FILE}`);
  await cdp?.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exit(failChecks.length === 0 ? 0 : 1);
}
