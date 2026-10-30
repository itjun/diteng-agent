import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 该进程必须在旧应用退出后才替换；参数均通过 argv 传入，不拼接 shell 命令。
const INSTALL_SCRIPT = `
old=$1
staged=$2
work=$3
parent=$4
log=$5
shift 5
launch() {
  if [ "$#" -gt 0 ]; then /usr/bin/open -n "$old" --args "$@"; else /usr/bin/open -n "$old"; fi
}
exec >>"$log" 2>&1
echo "安装进程 $$"
for i in $(/usr/bin/jot 120); do
  if ! kill -0 "$parent" 2>/dev/null; then break; fi
  sleep 0.5
done
if kill -0 "$parent" 2>/dev/null; then
  echo '应用未退出，已取消安装'
  /bin/rm -rf "$work"
  exit 1
fi
backup="$work/previous.app"
if /bin/mv "$old" "$backup"; then
  if /bin/mv "$staged" "$old"; then
    echo '新版应用已替换，准备启动'
    if launch "$@"; then
      /bin/rm -rf "$work"
      exit 0
    fi
    echo '新版应用启动失败，准备恢复旧版本'
    /bin/mv "$old" "$staged" || echo '无法移走新版应用，旧版本保存在备份目录'
  fi
  if [ ! -e "$old" ]; then /bin/mv "$backup" "$old"; fi
fi
echo '安装失败，已尝试恢复旧版本'
launch "$@"
if [ -d "$old" ] && [ ! -e "$backup" ]; then /bin/rm -rf "$work"; fi
/usr/bin/osascript -e 'display dialog "更新安装失败，已尝试恢复旧版本。请使用新版安装包手动安装。" buttons {"好"} default button 1 with title "软件更新"' >/dev/null 2>&1
`;

async function sha512(file: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

/** 在同一磁盘预备更新；失败时保留正在运行的应用。 */
export async function prepareMacUpdate(options: {
  archive: string; expectedHash: string; version: string; executable: string; logFile: string; relaunchArgs?: string[];
}): Promise<() => void> {
  const appPath = await realpath(resolve(options.executable, '../../..'));
  if (!appPath.endsWith('.app') || basename(options.executable) === '' || !(await realpath(options.executable)).startsWith(`${appPath}/Contents/MacOS/`)) {
    throw new Error('当前应用路径无效');
  }
  const parent = dirname(appPath);
  await access(parent, constants.W_OK);
  if (await sha512(options.archive) !== options.expectedHash) throw new Error('更新文件校验失败');
  const work = await mkdtemp(join(parent, '.diteng-update-'));
  try {
    const listing = await execFileAsync('/usr/bin/unzip', ['-Z', '-1', options.archive], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
    if (listing.stdout.split('\n').some(name => name.startsWith('/') || name.split('/').includes('..'))) throw new Error('更新包路径无效');
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', options.archive, work], { timeout: 120000 });
    const entries = await readdir(work);
    if (entries.length !== 1 || !entries[0].endsWith('.app')) throw new Error('更新包内容无效');
    const staged = join(work, entries[0]);
    if (await realpath(staged) !== staged) throw new Error('更新应用路径无效');
    const plist = join(staged, 'Contents', 'Info.plist');
    const readPlist = async (key: string) => (await execFileAsync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
    if (await readPlist('CFBundleIdentifier') !== 'site.diteng.agent' || await readPlist('CFBundleShortVersionString') !== options.version) {
      throw new Error('更新包应用标识或版本不匹配');
    }
    const executable = await readPlist('CFBundleExecutable');
    if (basename(executable) !== executable) throw new Error('更新包启动文件无效');
    const binary = join(staged, 'Contents', 'MacOS', executable);
    await access(binary, constants.X_OK);
    const architectures = (await execFileAsync('/usr/bin/lipo', ['-archs', binary])).stdout.trim().split(/\s+/);
    if (!architectures.includes(process.arch === 'x64' ? 'x86_64' : process.arch)) throw new Error('更新包架构不匹配');
    const child = spawn('/bin/sh', ['-c', INSTALL_SCRIPT, 'diteng-update', appPath, staged, work, String(process.pid), options.logFile, ...(options.relaunchArgs || [])], {
      detached: true, stdio: 'ignore',
    });
    await new Promise<void>((resolveSpawn, reject) => { child.once('error', reject); child.once('spawn', resolveSpawn); });
    child.unref();
    return () => {
      child.once('exit', () => { void rm(work, { recursive: true, force: true }); });
      child.kill();
    };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}
