/** 真实 macOS 应用替换测试：仅操作临时目录，需提供旧应用与新版 ZIP。 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('此测试需要 macOS');
const [sourceApp, archive, version, mode] = process.argv.slice(2);
const isRollback = mode === '--rollback' || mode === '--rollback-launch';
if (!sourceApp || !archive || !version) throw new Error('用法：node scripts/e2e-mac-install.mjs 旧应用.app 新版.zip 新版本号');
const directory = await mkdtemp(join(tmpdir(), 'diteng-install-e2e-'));
const target = join(directory, 'diteng agent.app');
const userData = join(directory, 'user-data');
const executable = join(target, 'Contents/MacOS/diteng agent');
let launchedPid;
let helperPid;
let server;
try {
  execFileSync('/usr/bin/ditto', [resolve(sourceApp), target]);
  const originalVersion = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(target, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  await mkdir(userData);
  await writeFile(join(userData, 'config.json'), JSON.stringify({ configVersion: 3, autoLogin: false, autoCheckUpdates: false, autoDownloadUpdates: false }));
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const digest = hash.digest('base64');
  const { prepareMacUpdate } = createRequire(import.meta.url)(resolve('dist/main/mac-update-install.js'));
  const invalid = { archive: resolve(archive), expectedHash: digest, version, executable, logFile: join(directory, 'install.log') };
  await assert.rejects(prepareMacUpdate({ ...invalid, expectedHash: 'wrong' }), /校验失败/);
  await assert.rejects(prepareMacUpdate({ ...invalid, version: '0.0.0' }), /版本不匹配/);
  assert.ok(!(await readdir(directory)).some(name => name.startsWith('.diteng-update-')));
  console.log('PASS 校验值或版本不匹配时拒绝安装并清理临时文件');
  // 在旧应用的 Electron 进程中执行真实安装代码；新版仍是原始发布包。
  const resources = join(target, 'Contents/Resources');
  await rename(join(resources, 'app.asar'), join(directory, 'original.asar'));
  await mkdir(join(resources, 'app'));
  await writeFile(join(resources, 'app/package.json'), JSON.stringify({ name: 'install-e2e', version: '0.0.1', main: 'index.js' }));
  const filename = `update-${process.arch}.zip`;
  server = createServer((request, response) => {
    if (request.url?.split('?')[0].endsWith('.yml')) {
      response.end(JSON.stringify({ version, minimumVersion: '0.0.1', releaseDate: '2026-01-01T00:00:00Z',
        files: [{ url: filename, sha512: digest }], path: filename, sha512: digest }));
    } else createReadStream(archive).pipe(response);
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const updateConfig = join(directory, 'update.yml');
  await writeFile(updateConfig, JSON.stringify({ provider: 'generic', url: base, updaterCacheDirName: `diteng-e2e-${Date.now()}` }));
  const config = { executable, logFile: join(directory, 'install.log'), relaunchArgs: [`--user-data-dir=${userData}`] };
  await writeFile(join(resources, 'app/index.js'), `
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', ${JSON.stringify(userData)});
app.setPath('cache', ${JSON.stringify(directory)});
app.whenReady().then(async () => {
  try {
    if (${isRollback} && fs.existsSync(${JSON.stringify(join(directory, 'rollback-triggered'))})) {
      fs.writeFileSync(${JSON.stringify(join(directory, 'rollback-restarted'))}, String(process.pid));
      app.quit();
      return;
    }
    const { autoUpdater } = require(${JSON.stringify(resolve('node_modules/electron-updater'))});
    Object.defineProperty(autoUpdater.app, 'baseCachePath', { value: ${JSON.stringify(directory)} });
    autoUpdater.updateConfigPath = ${JSON.stringify(updateConfig)};
    autoUpdater.setFeedURL({ provider: 'generic', url: ${JSON.stringify(base)} });
    autoUpdater.disableDifferentialDownload = true;
    const { UpdateService } = require(${JSON.stringify(resolve('dist/main/update-service.js'))});
    const service = new UpdateService({ currentVersion: '0.0.1', disabledReason: '', updater: autoUpdater,
      readPreferences: () => ({ autoCheckUpdates: false, autoDownloadUpdates: false }),
      readPolicy: () => null, savePolicy: () => {}, onChanged: () => {}, prepareInstall: async () => true,
      installDownloaded: async (archive, version, expectedHash) => {
        await require(${JSON.stringify(resolve('dist/main/mac-update-install.js'))}).prepareMacUpdate({ ...${JSON.stringify(config)}, archive, version, expectedHash });
        if (${isRollback}) {
          const work = fs.readdirSync(${JSON.stringify(directory)}).find(name => name.startsWith('.diteng-update-'));
          const staged = path.join(${JSON.stringify(directory)}, work, 'diteng agent.app');
          const broken = ${JSON.stringify(mode)} === '--rollback-launch' ? path.join(staged, 'Contents/MacOS/diteng agent') : staged;
          fs.renameSync(broken, broken + '.unavailable');
          fs.writeFileSync(${JSON.stringify(join(directory, 'rollback-triggered'))}, '1');
        }
        app.quit();
      },
    });
    if ((await service.check()).status !== 'available') throw new Error('检查失败');
    if ((await service.download()).status !== 'downloaded') throw new Error('下载失败');
    const state = await service.install();
    if (state.status !== 'installing') throw new Error(state.error);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
  const old = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  old.stdout.on('data', data => { output += data; }); old.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolveExit, reject) => { old.once('error', reject); old.once('exit', resolveExit); });
  assert.equal(code, 0, output);
  if (isRollback) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { await readFile(join(directory, 'rollback-restarted')); break; } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
    assert.ok(await readFile(join(directory, 'rollback-restarted'), 'utf8'), '旧版恢复后未重启');
    const log = await readFile(join(directory, 'install.log'), 'utf8');
    assert.match(log, /安装失败，已尝试恢复旧版本/);
    if (mode === '--rollback-launch') assert.match(log, /新版应用启动失败，准备恢复旧版本/);
    helperPid = Number(log.match(/安装进程 (\d+)/)?.[1]);
    assert.ok(helperPid, '未找到测试安装进程');
    const actual = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(target, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    assert.equal(actual, originalVersion, '替换失败后应恢复原版');
    const cleanupDeadline = Date.now() + 5000;
    while ((await readdir(directory)).some(name => name.startsWith('.diteng-update-')) && Date.now() < cleanupDeadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    assert.ok(!(await readdir(directory)).some(name => name.startsWith('.diteng-update-')), '恢复后未清理临时文件');
    console.log(`PASS 替换失败后恢复原版 ${actual}、重新启动并清理临时文件`);
  } else {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const match = processes.split('\n').map(line => line.trim()).find(line => line.includes(executable) && line.includes(`--user-data-dir=${userData}`));
    if (match) { launchedPid = Number(match.split(/\s+/)[0]); break; }
  }
  assert.ok(launchedPid, `新版未启动：${await readFile(join(directory, 'install.log'), 'utf8').catch(() => output)}`);
  const actual = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(target, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(actual, version);
  console.log(`PASS 真实检查、下载、校验：旧应用退出、替换为 ${actual} 并启动新进程（独立数据目录）`);
  }
} finally {
  if (isRollback && !helperPid) {
    const log = await readFile(join(directory, 'install.log'), 'utf8').catch(() => '');
    helperPid = Number(log.match(/安装进程 (\d+)/)?.[1]);
  }
  if (helperPid) {
    try {
      const children = execFileSync('/usr/bin/pgrep', ['-P', String(helperPid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
      for (const pid of children) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    } catch {}
    try { process.kill(helperPid, 'SIGTERM'); } catch {}
  }
  if (launchedPid) {
    try { process.kill(launchedPid, 'SIGTERM'); } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  await rm(directory, { recursive: true, force: true });
}
