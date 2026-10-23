/**
 * 历史登录账号 e2e（隔离 userData + 本地 mock，绝不读写真实用户 config）：
 *   1. 用 --user-data-dir 起全新应用数据目录，并使用独立 CDP 端口 9224（不接管 9223 上可能运行的真实 dev 应用）；
 *   2. 首次登录 A（默认勾选记住密码）→ 断言 config.json 记录历史账号且密码为 safeStorage 密文，
 *      config:get 不下发 savedAccounts（密文列表只在主进程）；
 *   3. 删除 savedAccounts 字段模拟旧版 config（保留 savedLoginId/savedPassword）重启
 *      → 断言迁移出历史账号、账号与密码预填、下拉可选中；
 *   4. 登录 → 退出登录 → 断言历史账号与密码仍保留、初始密码不回填、下拉选中后回填密码；
 *   5. 多账号 + 同账号不同服务器：历史按最近登录排序、选中 B 回填 B 的密码、
 *      删除某服务器的同名账号不误清另一服务器的自动登录凭据；
 *   6. 删除自动登录账号并重启 → 不自动登录；登录 C 后测试「清空」二次确认（含防双击）→ 清空后不自动登录；
 *   7. 取消「记住密码」登录 D → 账号仍进入历史但不保存密码与自动登录凭据。
 *
 * 用法：node scripts/e2e-account-history.mjs
 * 前置：无需手动起 vite/electron（脚本会确保 vite 5173 存活，并使用 9224 端口的测试实例）。
 * 安全边界：所有登录请求只到脚本进程内的 127.0.0.1 mock，不访问任何生产地址。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ensureVite, isHttpOk, killElectron, sleep, startElectron } from './e2e-app-control.mjs';

const ACCOUNT_A = 'e2e-history-a';
const ACCOUNT_B = 'e2e-history-b';
const ACCOUNT_C = 'e2e-history-c';
const ACCOUNT_D = 'e2e-history-d';
const PASSWORD_A = 'e2e-password-a';
const PASSWORD_B = 'e2e-password-b';
const PASSWORD_C = 'e2e-password-c';
const PASSWORD_D = 'e2e-password-d';
// 历史账号里不得出现明文密码：只认 base64 密文形态，且解码后不得还原出明文（排除 base64(明文) 的低级错误）
const CIPHER_PATTERN = /^[A-Za-z0-9+/=]{16,}$/;
// 独立 CDP 端口：不碰 9223 上可能运行的真实 dev 应用
const TEST_CDP_PORT = 9224;
const TEST_CDP_ENDPOINT = `http://127.0.0.1:${TEST_CDP_PORT}`;

const USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'diteng-agent-e2e-history-'));
const CONFIG_PATH = join(USER_DATA_DIR, 'config.json');
const ELECTRON_LOG = '/tmp/diteng-electron-account-history.log';

let browser = null;
let mockServerA = null;
let mockServerB = null;
let mockBaseA = '';
let mockBaseB = '';

function check(name, ok, detail = '') {
  console.log(`CHECK ${name}: ${ok ? 'OK' : 'FAIL'}${detail ? `（${detail}）` : ''}`);
  if (!ok) process.exitCode = 1;
}

/** 关键界面留证（浅色/深色各一张），便于人工核对下拉样式与层级 */
async function shot(page, name) {
  const path = `/tmp/diteng-account-history-${name}.png`;
  await page.screenshot({ path });
  console.log(`截图：${path}`);
}

/** 密文校验：base64 形态且解码文本不含明文（safeStorage 密文为二进制，base64(明文) 会被此检查拦住） */
function isEncryptedCipher(cipher, plain) {
  if (typeof cipher !== 'string' || !CIPHER_PATTERN.test(cipher)) return false;
  try {
    return !Buffer.from(cipher, 'base64').toString('utf8').includes(plain);
  } catch {
    return false;
  }
}

/** 轮询等待：predicate 可返回 Promise */
async function waitUntil(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

/** 本地 mock 后端：只实现登录页/主窗会话所需端点，任何凭据都登录成功（与现有 e2e mock 一致） */
function startMockServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks).toString();
    };
    const readDataIn = async () => {
      const form = new URLSearchParams(await readBody());
      return JSON.parse(form.get('dataIn') ?? '{}');
    };
    const dataSet = (head, body = [[]]) => ({ state: 1, message: '', head, body });

    if (req.method === 'POST' && url.pathname === '/services/SvrUserLogin.getToken') {
      const dataIn = await readDataIn();
      const headIn = dataIn.head ?? {};
      if (headIn.verifyCode === '??????') return send(200, dataSet({ status: 1 }));
      return send(
        200,
        dataSet({
          status: 1,
          token: 'T_E2E_HISTORY_ROOT',
          user_code: '01',
          startPage: '250008/FrmDefault',
          corpNo: '250008',
          homeForm: 'FrmDefault',
          forceRedirect: false,
          redirectUrl: '',
        }),
      );
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/getTokenInfo') {
      return send(200, {
        userId: 'U_E2E_HISTORY',
        userCode: '01',
        userName: '历史账号自测用户',
        corpNo: '250008',
        options: {},
      });
    }
    if (req.method === 'POST' && url.pathname === '/center/UserServer/logout') return send(200, {});
    if (req.method === 'POST' && url.pathname === '/services/SvrAccountManage.listMyLivingUsers') {
      return send(
        200,
        dataSet({}, [['CorpNo_', 'Code_', 'Name_', 'ShortName_'], ['250008', '01', '历史账号自测账套', 'E2E']]),
      );
    }
    if (req.method === 'POST' && /FrmMessages\.mqttConfig$/.test(url.pathname)) {
      return send(200, { result: false, message: 'mock 未启用 MQTT' });
    }
    if (req.method === 'POST' && /ImServer\.getUnreadMessage$/.test(url.pathname)) {
      return send(200, { result: true, data: 0 });
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(404, '', 'text/plain');
    if (req.method === 'GET' && /^\/\d{5,8}\//.test(url.pathname)) {
      return send(
        200,
        `<!doctype html><html><head><meta charset="utf-8"><title>mock erp</title></head><body>mock erp page</body></html>`,
        'text/html; charset=utf-8',
      );
    }
    return send(404, { message: 'mock 未实现该端点' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function allPages() {
  return browser.contexts().flatMap((context) => context.pages());
}
function findMainPage() {
  return allPages().find((page) => page.url().includes('#/main')) ?? null;
}
function findLoginPage() {
  return (
    allPages().find((page) => {
      if (!page.url().includes('127.0.0.1:5173')) return false;
      return !/#\/(main|notify-popup)/.test(page.url());
    }) ?? null
  );
}

async function waitForMainPage(seconds = 60) {
  return waitUntil(findMainPage, seconds * 1000, 500);
}

async function waitForLoginPage(seconds = 30) {
  const page = await waitUntil(findLoginPage, seconds * 1000, 500);
  if (page) await page.waitForSelector('#server-base', { timeout: 15_000 }).catch(() => {});
  return page;
}

async function submitLogin(login, loginId, password, base = mockBaseA) {
  await login.waitForSelector('#server-base', { timeout: 20_000 });
  await login.fill('#server-base', base);
  await login.fill('#login-id', loginId);
  await login.fill('#password', password);
  await login.click('button[type=submit]');
}

/** 用户卡片「退出登录」→ 回登录窗（主窗随后销毁） */
async function logout(shell) {
  await shell.waitForSelector('[data-testid="user-chip"]:not([disabled])', { timeout: 30_000 });
  await shell.click('[data-testid="user-chip"]');
  await shell.waitForSelector('[data-testid="user-card"] [data-testid="logout"]', { timeout: 10_000 });
  await shell.click('[data-testid="logout"]');
  const login = await waitForLoginPage(30);
  if (!login) throw new Error('退出登录后 30s 内未见登录窗');
  return login;
}

function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

async function openHistory(login) {
  await login.waitForSelector('[data-testid="account-history-toggle"]', { timeout: 10_000 });
  const list = login.locator('[data-testid="account-history-list"]');
  if ((await list.count()) === 0) await login.click('[data-testid="account-history-toggle"]');
  await login.waitForSelector('[data-testid="account-history-list"]', { timeout: 10_000 });
  return list;
}

/** 历史账号行内的删除按钮（可指定服务器，用于同账号多服务器场景） */
function historyRemoveButton(login, account, serverBase) {
  const serverFilter = serverBase ? `[data-server="${serverBase}"]` : '';
  return login
    .locator(`[data-testid="account-history-item"][data-account="${account}"]${serverFilter}`)
    .locator('..')
    .locator('[data-testid="account-history-remove"]');
}

/** 在登录页内取历史账号摘要（preload 暴露的同一主进程数据） */
async function readAccounts(login) {
  return login.evaluate(() => window.diteng.listSavedAccounts());
}

/** 重启应用（保持同一隔离 userData、独立 CDP 端口），并重连 CDP */
async function restartApp() {
  await killElectron(20, TEST_CDP_PORT);
  await ensureVite();
  await startElectron(ELECTRON_LOG, [`--user-data-dir=${USER_DATA_DIR}`], TEST_CDP_PORT);
  browser = await chromium.connectOverCDP(TEST_CDP_ENDPOINT);
}

try {
  console.log(`隔离 userData：${USER_DATA_DIR}`);
  console.log(`主进程日志：${ELECTRON_LOG}`);

  // ============================== 0. 起 mock / vite / electron ==============================
  mockServerA = await startMockServer();
  mockBaseA = mockServerA.base;
  mockServerB = await startMockServer();
  mockBaseB = mockServerB.base;
  console.log(`mock 后端：${mockBaseA} / ${mockBaseB}`);
  if (await isHttpOk(`${TEST_CDP_ENDPOINT}/json/version`)) {
    console.log(`WARN ${TEST_CDP_PORT} 上已有上一次测试实例，先收掉`);
  }
  await killElectron(20, TEST_CDP_PORT);
  await ensureVite();
  await startElectron(ELECTRON_LOG, [`--user-data-dir=${USER_DATA_DIR}`], TEST_CDP_PORT);
  browser = await chromium.connectOverCDP(TEST_CDP_ENDPOINT);

  // ============================== 1. 首次登录写入历史账号 ==============================
  let login = await waitForLoginPage(40);
  check('全新 userData 登录窗就绪', Boolean(login));
  if (!login) throw new Error('登录窗未就绪');
  check('全新配置无历史账号入口', (await login.locator('[data-testid="account-history-toggle"]').count()) === 0);
  check('默认勾选记住密码', await login.locator('[data-testid="remember-password"]').isChecked());

  await submitLogin(login, ACCOUNT_A, PASSWORD_A);
  let shell = await waitForMainPage(60);
  check('首次登录 A 进入主窗', Boolean(shell));
  if (!shell) throw new Error('首次登录未进入主窗');
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

  const accountsAfterFirst = await shell.evaluate(() => window.diteng.listSavedAccounts());
  check(
    '登录成功后记录历史账号 A（含已记住密码）',
    accountsAfterFirst.length === 1 &&
      accountsAfterFirst[0].loginId === ACCOUNT_A &&
      accountsAfterFirst[0].serverBase === mockBaseA &&
      accountsAfterFirst[0].hasPassword === true,
    JSON.stringify(accountsAfterFirst),
  );
  const publicConfig = await shell.evaluate(() => window.diteng.getConfig());
  check('config:get 不下发 savedAccounts 密文列表', !('savedAccounts' in publicConfig));
  const configAfterFirst = readConfigFile();
  const firstSaved = configAfterFirst?.savedAccounts?.[0];
  check(
    'config.json 落盘 savedAccounts 且密码为密文（非明文/非 base64 明文）',
    Boolean(firstSaved) &&
      firstSaved.loginId === ACCOUNT_A &&
      isEncryptedCipher(firstSaved.passwordCipher, PASSWORD_A) &&
      firstSaved.passwordCipher !== PASSWORD_A,
    `len=${firstSaved?.passwordCipher?.length ?? 0}`,
  );
  check(
    '兼容字段 savedLoginId/savedPassword 同步（自动登录链路）',
    configAfterFirst?.savedLoginId === ACCOUNT_A &&
      isEncryptedCipher(configAfterFirst?.savedPassword, PASSWORD_A),
  );

  // ============================== 2. 旧版 config 迁移 ==============================
  console.log('STEP 构造旧版 config（删除 savedAccounts）并重启，验证迁移');
  // 先停应用再改文件：主窗关闭时会写回窗口大小（整份 config），提前写会被退出流程覆盖
  await killElectron(20, TEST_CDP_PORT);
  const legacyConfig = { ...configAfterFirst };
  delete legacyConfig.savedAccounts;
  legacyConfig.autoLogin = false;
  legacyConfig.rememberPassword = true;
  writeFileSync(CONFIG_PATH, JSON.stringify(legacyConfig, null, 2), 'utf8');
  await ensureVite();
  await startElectron(ELECTRON_LOG, [`--user-data-dir=${USER_DATA_DIR}`], TEST_CDP_PORT);
  browser = await chromium.connectOverCDP(TEST_CDP_ENDPOINT);

  login = await waitForLoginPage(40);
  check('旧版 config 重启后停在登录表单', Boolean(login));
  if (!login) throw new Error('迁移重启后未见登录窗');
  await login.waitForSelector('#server-base', { timeout: 15_000 });
  check('迁移后出现历史账号入口', (await login.locator('[data-testid="account-history-toggle"]').count()) === 1);
  const migratedAccounts = await readAccounts(login);
  check(
    '旧 savedLoginId/savedPassword 迁移为历史账号并保留密码',
    migratedAccounts.length === 1 &&
      migratedAccounts[0].loginId === ACCOUNT_A &&
      migratedAccounts[0].hasPassword === true,
    JSON.stringify(migratedAccounts),
  );
  // 账号与密码预填是 effect 内的异步解密，等值到位再断言，避免首帧竞态
  await login.waitForFunction((expected) => document.querySelector('#login-id')?.value === expected, ACCOUNT_A, {
    timeout: 15_000,
  });
  check('迁移后账号已预填', true);
  await login.waitForFunction((expected) => document.querySelector('#password')?.value === expected, PASSWORD_A, {
    timeout: 15_000,
  });
  check('迁移后密码已预填（记住密码凭据可用）', true);
  let historyList = await openHistory(login);
  check('下拉显示迁移出的 1 条历史账号', (await historyList.locator('[data-testid="account-history-item"]').count()) === 1);
  await login.click('[data-testid="account-history-item"]');
  await login.waitForFunction((expected) => document.querySelector('#password')?.value === expected, PASSWORD_A, {
    timeout: 10_000,
  });
  check('选择历史账号后回填密码', true);

  // 迁移后直接用预填表单登录（同时验证密码回填可用）
  await login.click('button[type=submit]');
  shell = await waitForMainPage(60);
  check('迁移后使用预填凭据登录进入主窗', Boolean(shell));
  if (!shell) throw new Error('迁移后登录未进入主窗');
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });

  // ============================== 3. 退出登录：历史账号保留、初始密码不回填 ==============================
  console.log('STEP 退出登录 A → 历史账号保留，初始密码不回填，下拉选中回填');
  login = await logout(shell);
  const configAfterLogout = readConfigFile();
  check('退出后自动登录凭据 savedPassword 已清', configAfterLogout?.savedPassword === '');
  check('退出后 savedLoginId 保留（账号预填）', configAfterLogout?.savedLoginId === ACCOUNT_A);
  check(
    '退出后历史账号 A 及其密码仍保留',
    configAfterLogout?.savedAccounts?.[0]?.loginId === ACCOUNT_A &&
      isEncryptedCipher(configAfterLogout?.savedAccounts?.[0]?.passwordCipher, PASSWORD_A),
  );
  await login.waitForFunction((expected) => document.querySelector('#login-id')?.value === expected, ACCOUNT_A, {
    timeout: 10_000,
  });
  check('退出后初始账号预填 A', true);
  await login.waitForTimeout(500);
  check('退出后初始密码不回填（凭据已清）', (await login.inputValue('#password')) === '');
  historyList = await openHistory(login);
  await login.click(`[data-testid="account-history-item"][data-account="${ACCOUNT_A}"]`);
  await login.waitForFunction((expected) => document.querySelector('#password')?.value === expected, PASSWORD_A, {
    timeout: 10_000,
  });
  check('退出登录后从下拉选择 A 可回填密码', true);

  // ============================== 4. 多账号 + 同账号多服务器 ==============================
  console.log('STEP 登录 A 后退出并登录 B；再以同一账号登录第二台服务器，验证排序/回填/删除');
  await login.click('button[type=submit]');
  shell = await waitForMainPage(60);
  if (!shell) throw new Error('二次登录 A 未进入主窗');
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
  login = await logout(shell);

  await submitLogin(login, ACCOUNT_B, PASSWORD_B);
  shell = await waitForMainPage(60);
  check('登录第二个账号 B 进入主窗', Boolean(shell));
  if (!shell) throw new Error('登录 B 未进入主窗');
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
  const accountsAfterB = await shell.evaluate(() => window.diteng.listSavedAccounts());
  check(
    '历史账号两个且最近登录 B 在前、都记住密码',
    accountsAfterB.length === 2 &&
      accountsAfterB[0].loginId === ACCOUNT_B &&
      accountsAfterB[1].loginId === ACCOUNT_A &&
      accountsAfterB[0].hasPassword &&
      accountsAfterB[1].hasPassword,
    JSON.stringify(accountsAfterB.map((account) => `${account.loginId}:${account.hasPassword}`)),
  );

  login = await logout(shell);
  check('退出 B 后初始账号预填 B', (await login.inputValue('#login-id')) === ACCOUNT_B);
  check('退出 B 后初始密码不回填', (await login.inputValue('#password')) === '');
  historyList = await openHistory(login);
  check('下拉显示 2 条历史账号', (await historyList.locator('[data-testid="account-history-item"]').count()) === 2);
  await shot(login, 'list-light');
  await login.evaluate(() => window.diteng.setConfig({ theme: 'dark' }));
  await sleep(500);
  await shot(login, 'list-dark');
  await login.evaluate(() => window.diteng.setConfig({ theme: 'system' }));
  await sleep(300);
  // 选中 B 应回填 B 自己的密码（不是上一个账号 A 的）
  await login.click(`[data-testid="account-history-item"][data-account="${ACCOUNT_B}"]`);
  await login.waitForFunction((expected) => document.querySelector('#password')?.value === expected, PASSWORD_B, {
    timeout: 10_000,
  });
  check('选择 B 回填 B 的密码', true);

  // 同账号 A 登录第二台服务器：历史应保留两条 A（不同 serverBase）
  await submitLogin(login, ACCOUNT_A, PASSWORD_A, mockBaseB);
  shell = await waitForMainPage(60);
  check('同一账号登录第二台服务器进入主窗', Boolean(shell));
  if (!shell) throw new Error('登录 A@S2 未进入主窗');
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
  const accountsAfterSecondServer = await shell.evaluate(() => window.diteng.listSavedAccounts());
  check(
    '同一账号不同服务器保留为两条历史记录',
    accountsAfterSecondServer.filter((account) => account.loginId === ACCOUNT_A).length === 2 &&
      new Set(
        accountsAfterSecondServer
          .filter((account) => account.loginId === ACCOUNT_A)
          .map((account) => account.serverBase),
      ).size === 2,
    JSON.stringify(accountsAfterSecondServer.map((account) => `${account.loginId}@${account.serverBase}`)),
  );

  login = await logout(shell);
  check('第二服务器登录后初始服务器地址预填 S2', (await login.inputValue('#server-base')) === mockBaseB);
  historyList = await openHistory(login);
  check('下拉显示 3 条历史账号', (await historyList.locator('[data-testid="account-history-item"]').count()) === 3);
  // 删除 S1 上的同名 A：自动登录凭据对应 A@S2，不能被误清
  await historyRemoveButton(login, ACCOUNT_A, mockBaseA).click();
  await login.waitForFunction(
    () => document.querySelectorAll('[data-testid="account-history-item"]').length === 2,
    undefined,
    { timeout: 10_000 },
  );
  check(
    '删除同账号不同服务器记录后，自动登录凭据仍属另一服务器的 A',
    readConfigFile()?.savedLoginId === ACCOUNT_A,
    `savedLoginId=${readConfigFile()?.savedLoginId}`,
  );
  await historyRemoveButton(login, ACCOUNT_B, mockBaseA).click();
  await login.waitForFunction(
    () => document.querySelectorAll('[data-testid="account-history-item"]').length === 1,
    undefined,
    { timeout: 10_000 },
  );
  await historyRemoveButton(login, ACCOUNT_A, mockBaseB).click();
  await login.waitForSelector('[data-testid="account-history-list"]', { state: 'detached', timeout: 10_000 });
  const configAfterRemove = readConfigFile();
  check('删除最后一条后历史账号清空', (await readAccounts(login)).length === 0);
  check(
    '删除自动登录账号后兼容凭据一并清空',
    configAfterRemove?.savedLoginId === '' && configAfterRemove?.savedPassword === '',
  );
  check('历史账号清空后入口消失', (await login.locator('[data-testid="account-history-toggle"]').count()) === 0);

  // 删除自动登录账号后重启：即使自动登录开关打开也不应自动登录
  console.log('STEP 删除自动登录账号后重启，确认不自动登录');
  await login.evaluate(() => window.diteng.setConfig({ autoLogin: true }));
  await restartApp();
  await sleep(5000);
  check('删除自动登录账号后重启无主窗', !findMainPage());
  login = await waitForLoginPage(40);
  check('删除自动登录账号后重启停在登录表单', Boolean(login));
  if (!login) throw new Error('删除账号后重启未见登录窗');

  // ============================== 5. 清空历史（二次确认防双击） ==============================
  console.log('STEP 登录 C 后退出，测试「清空」二次确认');
  await submitLogin(login, ACCOUNT_C, PASSWORD_C);
  shell = await waitForMainPage(60);
  if (!shell) throw new Error('登录 C 未进入主窗');
  await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
  login = await logout(shell);
  historyList = await openHistory(login);
  check('下拉显示 1 条历史账号 C', (await historyList.locator('[data-testid="account-history-item"]').count()) === 1);
  const clearButton = login.locator('[data-testid="account-history-clear"]');
  await clearButton.click();
  // 模拟一次物理双击：确认态刚出现就再点，不应立即清空（必须在 800ms 防误确认窗口内）
  await clearButton.click();
  check('第一次点清空进入确认态', (await clearButton.textContent())?.includes('确认清空'));
  check('确认态下历史账号仍在（未误删）', (await readAccounts(login)).length === 1);
  check('双击第二次点击不直接清空（防误确认）', (await readAccounts(login)).length === 1);
  await shot(login, 'clear-confirm');
  await sleep(900);
  await clearButton.click();
  await login.waitForSelector('[data-testid="account-history-list"]', { state: 'detached', timeout: 10_000 });
  check('二次确认后历史账号清空', (await readAccounts(login)).length === 0);
  check('清空后兼容凭据清空', readConfigFile()?.savedLoginId === '' && readConfigFile()?.savedPassword === '');
  check('清空后历史入口消失', (await login.locator('[data-testid="account-history-toggle"]').count()) === 0);

  // ============================== 6. 无凭据 + 开自动登录 → 重启停在表单 ==============================
  console.log('STEP 打开自动登录后重启，历史/凭据已清空应停在登录表单');
  await login.evaluate(() => window.diteng.setConfig({ autoLogin: true, rememberPassword: true }));
  await restartApp();
  await sleep(6000);
  check('无凭据重启后无主窗（不自动登录）', !findMainPage());
  login = await waitForLoginPage(40);
  check('无凭据重启后停在登录表单', Boolean(login));
  if (login) {
    await login.waitForSelector('#server-base', { timeout: 15_000 });
    await sleep(2000);
    check('登录表单出现后仍未自动登录', !findMainPage());
    check('无凭据重启后历史入口不存在', (await login.locator('[data-testid="account-history-toggle"]').count()) === 0);
    check('无凭据重启后账号为空', (await login.inputValue('#login-id')) === '');
  }

  // ============================== 7. 未勾选记住密码时仍记住账号 ==============================
  console.log('STEP 取消「记住密码」登录 D：账号仍进入历史，但不保存密码/自动登录凭据');
  if (login) {
    await login.locator('[data-testid="remember-password"]').uncheck();
    await submitLogin(login, ACCOUNT_D, PASSWORD_D);
    shell = await waitForMainPage(60);
    check('未勾选记住密码仍可登录', Boolean(shell));
    if (shell) {
      await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
      const accountsNoSave = await shell.evaluate(() => window.diteng.listSavedAccounts());
      check(
        '未勾选记住密码仍记录历史账号（无密码）',
        accountsNoSave.length === 1 &&
          accountsNoSave[0].loginId === ACCOUNT_D &&
          accountsNoSave[0].hasPassword === false,
        JSON.stringify(accountsNoSave),
      );
      const configNoSave = readConfigFile();
      check(
        '未勾选记住密码不写自动登录凭据',
        configNoSave?.savedLoginId === '' && configNoSave?.savedPassword === '',
      );
    }
  }

  // ============================== 8. 配置归一：上限/去重/脏数据 ==============================
  console.log('STEP 构造 10 条以上/重复/脏数据历史账号，验证 config 归一');
  await killElectron(20, TEST_CDP_PORT);
  const normalizedConfig = { ...readConfigFile() };
  const now = Date.now();
  const validAccounts = Array.from({ length: 9 }, (_unused, index) => ({
    loginId: `u${index}`,
    serverBase: mockBaseA,
    passwordCipher: '',
    lastLoginAt: now - index * 1000,
  }));
  normalizedConfig.savedAccounts = [
    ...validAccounts,
    // 同账号同服务器旧记录：应被较新的一条覆盖
    { loginId: 'u0', serverBase: mockBaseA, passwordCipher: '', lastLoginAt: now - 999_999 },
    // 非法 lastLoginAt 归 0；按排序落在最后，正好补足第 10 条
    { loginId: 'invalid-time', serverBase: mockBaseA, passwordCipher: '', lastLoginAt: 'not-a-time' },
    // 脏数据：缺少账号/服务器、非对象项，应被丢弃
    { loginId: '', serverBase: mockBaseA, passwordCipher: '', lastLoginAt: now },
    { loginId: 'bad-server', serverBase: '', passwordCipher: '', lastLoginAt: now },
    'garbage',
  ];
  normalizedConfig.autoLogin = false;
  normalizedConfig.rememberPassword = false;
  writeFileSync(CONFIG_PATH, JSON.stringify(normalizedConfig, null, 2), 'utf8');
  await ensureVite();
  await startElectron(ELECTRON_LOG, [`--user-data-dir=${USER_DATA_DIR}`], TEST_CDP_PORT);
  browser = await chromium.connectOverCDP(TEST_CDP_ENDPOINT);
  login = await waitForLoginPage(40);
  check('归一测试登录窗就绪', Boolean(login));
  if (login) {
    const normalizedAccounts = await readAccounts(login);
    check(
      '历史账号最多保留 10 条',
      normalizedAccounts.length === 10,
      `len=${normalizedAccounts.length}`,
    );
    check(
      '最近登录在前且同账号去重',
      normalizedAccounts[0]?.loginId === 'u0' &&
        normalizedAccounts[1]?.loginId === 'u1' &&
        normalizedAccounts.filter((account) => account.loginId === 'u0').length === 1,
      JSON.stringify(normalizedAccounts.map((account) => account.loginId)),
    );
    check(
      '脏数据被丢弃、非法时间归 0',
      !normalizedAccounts.some((account) => account.loginId === 'bad-server') &&
        normalizedAccounts.some((account) => account.loginId === 'invalid-time' && account.lastLoginAt === 0),
    );
  }

  console.log(`隔离 userData 保留供排查：${USER_DATA_DIR}`);
  console.log(`主进程日志：${ELECTRON_LOG}`);
} catch (error) {
  console.error('E2E 异常：', error);
  process.exitCode = 1;
} finally {
  try {
    await killElectron(20, TEST_CDP_PORT);
  } catch {
    // 清理失败不掩盖主结果
  }
  if (browser) {
    // CDP 连接随 electron 退出失效，close 仅释放本地资源；不等待避免挂住
    Promise.resolve(browser.close()).catch(() => {});
  }
  if (mockServerA) mockServerA.server.close();
  if (mockServerB) mockServerB.server.close();
  // vite 由 ensureVite 拉起且可能被其他 e2e 复用，保持运行（与仓库现有脚本约定一致）
  console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS');
}
