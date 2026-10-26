/** 启动本平台真实打包产物；Linux CI 使用 apt 已安装的 deb 可执行文件。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
const directory = mkdtempSync(join(tmpdir(), 'diteng-package-e2e-'));
const executablePath = process.env.PACKAGED_APP_EXECUTABLE || resolve({
  darwin: `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/diteng agent.app/Contents/MacOS/diteng agent`,
  win32: 'release/win-unpacked/diteng agent.exe', linux: 'release/linux-unpacked/diteng-agent',
}[process.platform]);
writeFileSync(join(directory, 'config.json'), JSON.stringify({ configVersion: 3, serverBase: 'https://m.cdcp.site', autoLogin: false, autoCheckUpdates: false }));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let electron;
try {
  electron = await _electron.launch({ executablePath, args: [`--user-data-dir=${directory}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], env, timeout: 45000 });
  const page = await electron.firstWindow();
  await page.locator('#login-id').waitFor();
  const state = await page.evaluate(() => window.diteng.getUpdateState());
  assert.equal(state.currentVersion, JSON.parse(readFileSync('package.json', 'utf8')).version);
  assert.equal(state.status, 'idle');
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  console.log(`PASS ${process.platform}/${process.arch} 真实安装包启动、版本信息与更新 IPC`);
} finally {
  if (electron) await electron.close();
  rmSync(directory, { recursive: true, force: true });
}
