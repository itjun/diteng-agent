import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  CDP_ENDPOINT,
  PROJECT_ROOT,
  VITE_URL,
  ensureVite,
  isHttpOk,
  killElectron,
  listCdpPids,
  sleep,
  startElectron,
} from './e2e-app-control.mjs';

/**
 * 账套同步 mock e2e 编排脚本（安全性最高优先）：
 *   0 预检：端口/既有进程只读检查；
 *   1 编译主进程 + preload（tsc；renderer 由 vite HMR）；
 *   2 备份真实用户 config.json 到 /tmp（含 savedPassword 密文，sha256 留证）；
 *   3 停 electron → 写入测试 config（serverBase=本地 mock、清空 savedPassword、关自动登录）；
 *   4 起 mock(8788，只监听 127.0.0.1) → 重启 electron(9223)；
 *   5 跑 e2e-webview-switch.mjs（三条切换链路 + 设置页/用户行断言）；
 *   6 finally 无条件还原：停 electron/mock → config.json 原样还原并校验 sha256 →
 *     重启真实环境 electron（允许应用自身自动登录）→ 打开设置页确认显示最新会话并截图。
 *
 * 安全边界：测试期间所有登录/换票/取值请求只到 http://127.0.0.1:8788，
 * 不向 https://m.cdcp.site 发起任何写操作。还原后真实环境为正常自动登录（与用户日常启动一致）。
 *
 * 用法：node scripts/e2e-corp-sync-run.mjs
 * 任一阶段失败都会走 finally 还原；失败/通过详情见 /tmp/diteng-corp-sync-result.json。
 */

const IS_DARWIN = process.platform === 'darwin';
const MOCK_PORT = 8788;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const CONFIG_PATH = join(homedir(), 'Library/Application Support/diteng-agent/config.json');
const MOCK_LOG = '/tmp/diteng-mock-8788.log';
const ELECTRON_MOCK_LOG = '/tmp/diteng-electron-mock.log';
const ELECTRON_REAL_LOG = '/tmp/diteng-electron-restored.log';
const RESULT_FILE = '/tmp/diteng-corp-sync-result.json';

const state = {
  backupPath: '',
  backupHash: '',
  configOverridden: false,
  needsRestoreRestart: false,
  mockChild: null,
  e2eExitCode: null,
  error: null,
};

let isRestored = false;
let isShuttingDown = false;

function log(message) {
  console.log(`[run] ${message}`);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function execFileAsync(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, (error, stdout) => {
      resolve({ error, stdout: stdout ?? '' });
    });
  });
}

async function listPortPids(port) {
  const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function commandOf(pid) {
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
  return stdout.trim();
}

async function waitProcessExit(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return true;
    await sleep(200);
  }
  return child.exitCode !== null;
}

/** 清掉上次运行残留的 mock（仅允许杀我们自己的 e2e-mock-server.mjs；其他占端口进程直接报错） */
async function clearStaleMock() {
  const pids = await listPortPids(MOCK_PORT);
  for (const pid of pids) {
    const command = await commandOf(pid);
    if (command.includes('e2e-mock-server.mjs')) {
      log(`清掉残留 mock pid=${pid}`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 已退出
      }
    } else {
      throw new Error(`端口 ${MOCK_PORT} 被非 mock 进程占用，拒绝继续：${command}`);
    }
  }
  for (let i = 0; i < 10 && (await listPortPids(MOCK_PORT)).length > 0; i++) await sleep(500);
}

function prepareBackup() {
  if (!IS_DARWIN) throw new Error(`当前平台 ${process.platform} 不是 darwin，未知用户数据目录，拒绝继续`);
  if (!existsSync(CONFIG_PATH)) throw new Error(`未找到真实用户配置：${CONFIG_PATH}`);
  const originalText = readFileSync(CONFIG_PATH, 'utf8');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  state.backupPath = `/tmp/diteng-config-backup-${stamp}.json`;
  copyFileSync(CONFIG_PATH, state.backupPath);
  state.backupHash = sha256(originalText);
  writeFileSync(`${state.backupPath}.sha256`, `${state.backupHash}  ${CONFIG_PATH}\n`);
  const config = JSON.parse(originalText);
  log(`已备份 config.json → ${state.backupPath}`);
  log(
    `备份内容校验：serverBase=${config.serverBase} savedLoginId=${config.savedLoginId || '(空)'} ` +
      `savedPassword=${config.savedPassword ? `已存(${config.savedPassword.length} 字符密文)` : '(空)'} ` +
      `autoLogin=${config.autoLogin} sha256=${state.backupHash.slice(0, 16)}…`,
  );
  return config;
}

function compileMainProcess() {
  const tscBin = join(PROJECT_ROOT, 'node_modules/.bin/tsc');
  if (!existsSync(tscBin)) throw new Error(`未找到 tsc：${tscBin}`);
  for (const project of ['tsconfig.main.json', 'tsconfig.preload.json']) {
    log(`编译 ${project}`);
    const result = spawnSync(tscBin, ['-p', project], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`tsc -p ${project} 失败（exit ${result.status}）`);
  }
}

function writeTestConfig(originalConfig) {
  const testConfig = {
    ...originalConfig,
    serverBase: MOCK_BASE,
    aiBase: '',
    savedLoginId: '',
    savedPassword: '',
    autoLogin: false,
    rememberPassword: false,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(testConfig, null, 2), 'utf8');
  state.configOverridden = true;
  log(`已写入测试 config：serverBase=${MOCK_BASE} savedPassword=清空 autoLogin=false rememberPassword=false`);
}

async function startMockServer() {
  writeFileSync(MOCK_LOG, '');
  const outFd = openSync(MOCK_LOG, 'a');
  state.mockChild = spawn(process.execPath, [join(PROJECT_ROOT, 'scripts/e2e-mock-server.mjs'), String(MOCK_PORT)], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', outFd, outFd],
  });
  state.mockChild.on('exit', (code) => log(`mock 进程退出 code=${code}`));
  closeSync(outFd);
  const isReady = await waitUntil(() => isHttpOk(`${MOCK_BASE}/__health`, 1000), 15_000, 300);
  if (!isReady) throw new Error(`mock(${MOCK_PORT}) 15s 内未就绪，日志：${MOCK_LOG}`);
  log(`mock 已就绪：${MOCK_BASE}（日志 ${MOCK_LOG}）`);
}

async function waitUntil(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function runE2e() {
  log('运行 e2e-webview-switch.mjs（三条切换链路）');
  state.e2eExitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(PROJECT_ROOT, 'scripts/e2e-webview-switch.mjs')], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: { ...process.env, E2E_SERVER_BASE: MOCK_BASE },
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      log(`e2e 子进程启动失败：${error.message}`);
      resolve(1);
    });
  });
  log(`e2e 退出码：${state.e2eExitCode}`);
}

/** 还原后确认真实环境：等自动登录 → 设置页账号卡显示最新会话 → 截图 → 返回标签视图 */
async function verifyRestoredEnvironment() {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const allPages = () => browser.contexts().flatMap((context) => context.pages());
  try {
    const shell = await waitUntil(
      () => allPages().find((page) => page.url().includes('#/main')),
      90_000,
      1000,
    );
    if (!shell) {
      log('WARN 还原后 90s 内未见主窗（真实环境自动登录可能失败或网络慢；配置已还原，应用保持运行）');
      return false;
    }
    await shell.waitForSelector('[data-testid="tabstrip"]', { timeout: 30_000 });
    const session = await shell.evaluate(() => window.diteng.getSession());
    log(
      `还原后会话：corpNo=${session?.corpNo} userCode=${session?.userCode} ` +
        `corpName=${JSON.stringify(session?.corpName)} homeForm=${session?.homeForm}`,
    );
    await shell.waitForSelector('[data-testid="user-chip"] [data-testid="open-settings"]', { timeout: 15_000 });
    await shell.click('[data-testid="user-chip"] [data-testid="open-settings"]');
    await shell.waitForSelector('[data-testid="settings-nav-account"]', { timeout: 10_000 });
    await shell.click('[data-testid="settings-nav-account"]');
    await shell.waitForSelector('[data-testid="settings-corp-name"]', { timeout: 10_000 });
    const name = ((await shell.textContent('[data-testid="settings-corp-name"]')) ?? '').trim();
    const codeLocator = shell.locator('[data-testid="settings-corp-no"], [data-testid="settings-corp-code"]').first();
    const code = (await codeLocator.count()) > 0 ? ((await codeLocator.textContent()) ?? '').trim() : '';
    const isOk = code === (session?.corpNo ?? '') && name.length > 0;
    console.log(
      `CHECK 还原后设置页显示最新会话: ${isOk ? 'OK' : 'FAIL'}（账套名称=${name} 账套代码=${code} ` +
        `会话 corpName=${JSON.stringify(session?.corpName)} corpNo=${session?.corpNo}）`,
    );
    await shell.screenshot({ path: '/tmp/diteng-restored-settings.png' });
    log('还原截图: /tmp/diteng-restored-settings.png');
    await shell.click('[data-testid="settings-back"]').catch(() => {});
    return isOk;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 无条件还原：停 electron/mock → 还原 config → 重启真实环境并确认 */
async function restoreEnvironment() {
  if (isRestored) return;
  isRestored = true;
  log('=== 开始还原环境 ===');
  const errors = [];

  try {
    log('停止测试用 electron（9223）');
    const isKilled = await killElectron();
    if (!isKilled) errors.push('electron 未能在 20s 内退出');
  } catch (error) {
    errors.push(`停止 electron 失败：${error.message}`);
  }

  if (state.mockChild) {
    try {
      state.mockChild.kill('SIGTERM');
      await waitProcessExit(state.mockChild, 5000);
      state.mockChild = null;
      log('mock 服务已停止');
    } catch (error) {
      errors.push(`停止 mock 失败：${error.message}`);
    }
  }
  // 兜底：仍占用 8788 的我们自己的 mock
  try {
    for (const pid of await listPortPids(MOCK_PORT)) {
      const command = await commandOf(pid);
      if (command.includes('e2e-mock-server.mjs')) {
        process.kill(pid, 'SIGTERM');
        log(`兜底停止残留 mock pid=${pid}`);
      } else {
        errors.push(`端口 ${MOCK_PORT} 仍被其他进程占用：${command}`);
      }
    }
  } catch (error) {
    errors.push(`清理 mock 端口失败：${error.message}`);
  }

  if (state.configOverridden) {
    try {
      if (!existsSync(state.backupPath)) throw new Error(`备份文件不存在：${state.backupPath}`);
      copyFileSync(state.backupPath, CONFIG_PATH);
      const restoredText = readFileSync(CONFIG_PATH, 'utf8');
      const restoredHash = sha256(restoredText);
      if (restoredHash !== state.backupHash) {
        throw new Error(`config.json 还原后 sha256 不一致（期望 ${state.backupHash}，实际 ${restoredHash}）`);
      }
      state.configOverridden = false;
      log(`config.json 已原样还原并通过 sha256 校验（${restoredHash.slice(0, 16)}…）`);
    } catch (error) {
      errors.push(`还原 config.json 失败：${error.message}`);
    }
  }

  if (state.needsRestoreRestart) {
    try {
      log('重启真实环境 electron（读取已还原 config，允许自身自动登录）');
      await ensureVite();
      await startElectron(ELECTRON_REAL_LOG);
      const isOk = await verifyRestoredEnvironment();
      if (!isOk) errors.push('还原后设置页未确认显示最新会话');
    } catch (error) {
      errors.push(`重启真实环境失败：${error.message}`);
    }
  }

  if (errors.length > 0) {
    log('还原过程存在问题：');
    for (const message of errors) log(`  - ${message}`);
    state.restoreErrors = errors;
  } else {
    log('环境已恢复：mock 已停、config.json 已还原、真实环境 electron 运行中');
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`收到 ${signal}，先还原环境再退出`);
  try {
    await restoreEnvironment();
  } catch (error) {
    log(`还原异常：${error.message}`);
  }
  process.exit(130);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  log('==== 0. 预检 ====');
  for (const pid of await listCdpPids()) log(`当前 electron(9223) pid=${pid}（稍后会被重启）`);
  log(`vite(5173) ${(await isHttpOk(VITE_URL)) ? '运行中' : '未运行（稍后自动拉起）'}`);
  await clearStaleMock();

  log('==== 1. 备份真实用户配置 ====');
  const originalConfig = prepareBackup();

  log('==== 2. 编译主进程 / preload ====');
  compileMainProcess();

  log('==== 3. 停 electron 并写入测试配置 ====');
  state.needsRestoreRestart = true;
  const isKilled = await killElectron();
  if (!isKilled) throw new Error('electron 未能在 20s 内退出，放弃写入测试配置');
  writeTestConfig(originalConfig);

  log('==== 4. 起 mock + 重启 electron（mock 配置） ====');
  await startMockServer();
  await ensureVite();
  writeFileSync(ELECTRON_MOCK_LOG, '');
  await startElectron(ELECTRON_MOCK_LOG);
  log(`electron 已就绪（CDP ${CDP_ENDPOINT}，日志 ${ELECTRON_MOCK_LOG}）`);

  log('==== 5. 运行 e2e ====');
  await runE2e();
} catch (error) {
  state.error = error;
  log(`ERROR ${error?.stack ?? error}`);
} finally {
  await restoreEnvironment();
}

// ============================== 汇总 ==============================
log('==== 6. 汇总 ====');
let e2eResult = null;
try {
  if (existsSync(RESULT_FILE)) e2eResult = JSON.parse(readFileSync(RESULT_FILE, 'utf8'));
} catch {
  // 结果文件损坏时以退出码为准
}
if (e2eResult) {
  log(`e2e CHECK：${e2eResult.pass}/${e2eResult.pass + e2eResult.fail} 通过`);
  for (const item of e2eResult.checks.filter((check) => !check.ok)) log(`  FAIL ${item.name}：${item.detail}`);
  log(`截图：${(e2eResult.screenshots ?? []).join(' ')}`);
}
log(`config 备份：${state.backupPath}`);
log(`mock 日志：${MOCK_LOG}；测试期 electron 日志：${ELECTRON_MOCK_LOG}；还原后 electron 日志：${ELECTRON_REAL_LOG}`);
log(`环境还原：${state.configOverridden === false ? 'config 已还原' : 'config 未还原（见上方错误）'}`);

const isE2eOk = state.e2eExitCode === 0;
const isRestoreOk = !state.restoreErrors || state.restoreErrors.length === 0;
if (state.error) {
  log(`RESULT: FAIL（编排异常：${state.error.message}）`);
  process.exit(1);
}
if (!isE2eOk) {
  log(`RESULT: FAIL（e2e 退出码 ${state.e2eExitCode}）`);
  process.exit(1);
}
if (!isRestoreOk) {
  log('RESULT: FAIL（e2e 通过，但环境还原存在问题）');
  process.exit(1);
}
log('RESULT: PASS（e2e 全部通过，环境已还原）');
process.exit(0);
