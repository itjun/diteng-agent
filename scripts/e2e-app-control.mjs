/**
 * e2e 应用控制公共模块：杀/起 electron、确保 vite、原生 CDP 通道。
 * 从 e2e-autologin.mjs 的 restartApp()/listCdpPids() 抽取（只读复用，不改动原脚本），
 * 供 e2e-corp-sync-run.mjs（生命周期编排）与 e2e-webview-switch.mjs（webview guest 操作）共用。
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本文件位于 {root}/scripts/） */
export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const CDP_PORT = 9223;
export const VITE_URL = 'http://127.0.0.1:5173/';
export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function isHttpOk(url, timeoutMs = 2000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 列出监听指定 CDP 端口（默认 9223）的进程号；无进程时返回空数组。
 * 必须限定 -sTCP:LISTEN：裸 lsof 会把与该端口的已建立连接（包括本进程的连接）一并列出。
 */
export async function listCdpPids(port = CDP_PORT) {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (error, stdout) => {
      const pids = (stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
      resolve(pids);
    });
  });
}

/** 优雅杀掉占用 CDP 端口的 electron，等待端口释放（超时返回 false） */
export async function killElectron(timeoutSeconds = 20, port = CDP_PORT) {
  for (const pid of await listCdpPids(port)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 进程可能已退出
    }
  }
  for (let i = 0; i < timeoutSeconds; i++) {
    if ((await listCdpPids(port)).length === 0) return true;
    await sleep(1000);
  }
  return (await listCdpPids(port)).length === 0;
}

/** vite 5173 存活检查：被 concurrently -k 连带杀掉时自行拉起（detached，脚本退出后仍存活） */
export async function ensureVite(logPath = '/tmp/diteng-vite.log') {
  if (await isHttpOk(VITE_URL)) return;
  const viteBin = join(PROJECT_ROOT, 'node_modules/.bin/vite');
  if (!existsSync(viteBin)) throw new Error(`未找到 vite：${viteBin}`);
  const outFd = openSync(logPath, 'a');
  spawn(viteBin, [], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', outFd, outFd] }).unref();
  closeSync(outFd);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await isHttpOk(VITE_URL)) return;
  }
  throw new Error(`vite 未能在 30s 内就绪（日志 ${logPath}）`);
}

/** 拉起 electron 并等 CDP 端口就绪；stdout/stderr 落 logPath，便于读取主进程日志。
 *  extraArgs 追加到 electron 命令行（如 --user-data-dir=/tmp/... 隔离配置，避免测试改写真实账号数据）；
 *  port 可指定独立 CDP 端口，避免误接管正在占用 9223 的真实 dev 应用。 */
export async function startElectron(logPath = '/tmp/diteng-electron.log', extraArgs = [], port = CDP_PORT) {
  const electronBin = join(PROJECT_ROOT, 'node_modules/.bin/electron');
  if (!existsSync(electronBin)) throw new Error(`未找到 electron：${electronBin}`);
  // 必须在干净环境里拉起 electron：宿主（如 Electron 版 IDE/Agent 运行时）可能注入
  // ELECTRON_RUN_AS_NODE=1，会让 electron 二进制退化为 node，主进程 app.whenReady 直接崩。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const outFd = openSync(logPath, 'a');
  spawn(electronBin, ['.', `--remote-debugging-port=${port}`, ...extraArgs], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env,
  }).unref();
  closeSync(outFd);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await isHttpOk(`http://127.0.0.1:${port}/json/version`)) return;
  }
  throw new Error(`electron 未能在 60s 内开出 CDP ${port}（日志 ${logPath}）`);
}

/** 杀 electron → 确保 vite 存活 → 重新拉起 electron（detached）→ 等 CDP 就绪 */
export async function restartElectron(logPath = '/tmp/diteng-electron.log', extraArgs = [], port = CDP_PORT) {
  await killElectron(20, port);
  await ensureVite();
  await startElectron(logPath, extraArgs, port);
}

/**
 * 原生 CDP 通道（仅 webview guest 用）：playwright-core 只把 type=page 的 target 收进 pages()，
 * <webview> 的 guest（type=webview）不可见，故直连 browser 调试端点查 target、flat session 进 guest 执行。
 * Node ≥21 全局 WebSocket。
 */
export async function createCdpLink() {
  const version = await fetch(`${CDP_ENDPOINT}/json/version`).then((response) => response.json());
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
