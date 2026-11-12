/**
 * Linux 免安装运行的桌面入口。
 *
 * 菜单按 desktop file id 查找，`$XDG_DATA_HOME/applications` 优先于系统目录。
 * 先跑免安装版会留下用户级 diteng-agent.desktop；之后安装 deb 时，若只跳过写入，
 * 菜单仍指向旧的免安装路径。这里在系统条目可见时删掉「本程序写出的」用户级条目。
 *
 * 只认两种内容：当前模板，以及 b102310 那个逐行固定、仅 Exec 不同的旧模板。
 * 改过名称、注释、键、参数，或是符号链接 / 其他文件，一律不动。
 * 开发运行（未打包）不注册、也不清理，避免 pnpm dev 改到用户应用菜单。
 */
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** electron-builder 26 按 executableName 安装到 /usr/share/applications。带空格的文件名是旧检查里保留的产品名形式。 */
const SYSTEM_DESKTOP_NAMES = ['diteng-agent.desktop', 'diteng agent.desktop'] as const;
const USER_DESKTOP_NAME = 'diteng-agent.desktop';
const ICON_NAME = 'diteng-agent.png';
/** 自定义键，用来识别本程序后续写出的免安装条目。桌面规范允许 X- 扩展键。 */
const MANAGED_KEY = 'X-Diteng-Agent-Managed=portable';
const LEGACY_SUFFIX = [
  'Icon=diteng-agent',
  'Terminal=false',
  'Categories=Office;',
  'StartupWMClass=diteng-agent',
  'Comment=帝擎 ERP 桌面客户端',
  '',
] as const;
const CURRENT_SUFFIX = [
  'Icon=diteng-agent',
  'Terminal=false',
  'Categories=Office;',
  'StartupWMClass=diteng-agent',
  MANAGED_KEY,
  'Comment=帝擎 ERP 桌面客户端',
  '',
] as const;
const FIELD_CODE = /^%[fFuUdDnNickvm]$/;

export type LinuxDesktopSyncAction =
  | 'skipped-platform'
  | 'skipped-unpackaged'
  | 'skipped-unsafe-exec'
  | 'skipped-protected-location'
  | 'removed-user-entry'
  | 'installed'
  | 'updated'
  | 'unchanged'
  | 'kept-user-entry';

export interface LinuxDesktopSyncInput {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  /** 菜单图标源文件。缺失时仍写 desktop，不覆盖已有图标。 */
  iconSource: string;
  /** 已解析的 XDG_DATA_HOME。 */
  dataHome: string;
  /** 已解析的系统 applications 目录（XDG_DATA_DIRS）。 */
  systemApplicationDirs: string[];
}

export interface LinuxDesktopSyncResult {
  action: LinuxDesktopSyncAction;
  userDesktopPath: string;
  removedDesktop: boolean;
  removedIcon: boolean;
  wroteDesktop: boolean;
}

/** 未设置、空白或相对路径时用 $HOME/.local/share。规范要求 XDG_DATA_HOME 为绝对路径。 */
export function resolveXdgDataHome(envValue: string | undefined, homeDir: string): string {
  const configured = envValue?.trim();
  if (configured && isAbsolute(configured)) return configured;
  return join(homeDir, '.local', 'share');
}

/**
 * 未设置、空白，或过滤掉相对路径后为空时，用规范默认值 /usr/local/share:/usr/share。
 * 只把桌面环境真正会搜索的目录当成系统条目，避免删掉用户级入口后菜单里什么都不剩。
 */
export function resolveXdgSystemApplicationDirs(envValue: string | undefined): string[] {
  const configured = envValue?.trim();
  const roots = configured
    ? configured.split(':').map((part) => part.trim()).filter((part) => part.length > 0 && isAbsolute(part))
    : [];
  const selected = roots.length > 0 ? roots : ['/usr/local/share', '/usr/share'];
  return selected.map((root) => join(root, 'applications'));
}

/**
 * 编码 Exec，使 GLib 2.80（GNOME）既能加载条目，又能启动到原路径。
 * GKeyFile 会把 \\ 还原成 \，但把 \"、\$、\` 当成非法转义，整段 Exec 会读不出来；
 * 因此用 shell 单引号，而不是 desktop spec 的双引号转义。单引号里的 \ 仍要写成 \\，否则 GKeyFile 直接拒绝。
 * 启动时 GLib 先把 %% 还原成 %，再做 shell 解析；加载菜单时却不还原，并用 argv[0] 检查文件是否存在。
 * 路径含 % 时若 %% 留在 argv[0]，条目会被丢掉，所以改由 /usr/bin/env -- 执行。
 * 路径含控制字符或不是绝对路径时抛出，调用方应改走跳过。
 */
export function formatDesktopExec(execPath: string): string {
  if (!isSafeExecPath(execPath)) throw new Error('可执行文件路径无法写入 desktop Exec');
  let doubled = '';
  for (const char of execPath) doubled += char === '%' ? '%%' : char;
  const quoted = shellQuote(doubled).replace(/\\/g, '\\\\');
  if (!execPath.includes('%')) return quoted;
  return `/usr/bin/env -- ${quoted}`;
}

/** g_shell_quote：整段单引号，单引号本身写成 '\'' 。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function syncLinuxDesktopEntry(input: LinuxDesktopSyncInput): LinuxDesktopSyncResult {
  const userDesktopPath = join(input.dataHome, 'applications', USER_DESKTOP_NAME);
  const untouched = {
    userDesktopPath,
    removedDesktop: false,
    removedIcon: false,
    wroteDesktop: false,
  };
  if (input.platform !== 'linux') return { action: 'skipped-platform', ...untouched };
  if (!input.isPackaged) return { action: 'skipped-unpackaged', ...untouched };
  if (isProtectedDesktop(userDesktopPath, input.systemApplicationDirs)) {
    return { action: 'skipped-protected-location', ...untouched };
  }

  const iconPath = join(input.dataHome, 'icons', 'hicolor', '512x512', 'apps', ICON_NAME);
  const systemRoots = input.systemApplicationDirs.map((dir) => canonicalize(dirname(dir)));
  if (hasSystemDesktop(input.systemApplicationDirs)) {
    return retireUserEntry(userDesktopPath, iconPath, input.iconSource, input.dataHome, systemRoots);
  }
  if (!isSafeExecPath(input.execPath)) return { action: 'skipped-unsafe-exec', ...untouched };

  const content = renderDesktop(formatDesktopExec(input.execPath));
  const action = writeOwnedDesktop(userDesktopPath, content);
  if (action === 'installed' || action === 'updated' || action === 'unchanged') {
    ensureUserIcon(input.iconSource, iconPath, input.dataHome, systemRoots);
  }
  return {
    action,
    userDesktopPath,
    removedDesktop: false,
    removedIcon: false,
    wroteDesktop: action === 'installed' || action === 'updated',
  };
}

function retireUserEntry(
  userDesktopPath: string,
  iconPath: string,
  iconSource: string,
  dataHome: string,
  systemRoots: string[],
): LinuxDesktopSyncResult {
  const base = { userDesktopPath, removedDesktop: false, removedIcon: false, wroteDesktop: false };
  const kind = pathKind(userDesktopPath);
  if (kind === 'file') {
    const text = readFileSync(userDesktopPath, 'utf8');
    if (!isOwnedDesktop(text)) return { action: 'kept-user-entry', ...base };
    unlinkSync(userDesktopPath);
    return {
      action: 'removed-user-entry',
      ...base,
      removedDesktop: true,
      removedIcon: removeIdenticalIcon(iconSource, iconPath, dataHome, systemRoots),
    };
  }
  if (kind === 'missing') {
    const removedIcon = removeIdenticalIcon(iconSource, iconPath, dataHome, systemRoots);
    return { action: removedIcon ? 'removed-user-entry' : 'unchanged', ...base, removedIcon };
  }
  // 符号链接、目录等视为用户自行放置，不删除，也不动旁边的图标。
  return { action: 'kept-user-entry', ...base };
}

function renderDesktop(execValue: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=diteng agent',
    `Exec=${execValue}`,
    ...CURRENT_SUFFIX,
  ].join('\n');
}

function writeOwnedDesktop(desktopPath: string, content: string): 'installed' | 'updated' | 'unchanged' | 'kept-user-entry' {
  const existing = readRegularFile(desktopPath);
  if (existing === content) return 'unchanged';
  if (existing != null && !isOwnedDesktop(existing)) return 'kept-user-entry';
  if (existing == null && pathKind(desktopPath) === 'other') return 'kept-user-entry';

  mkdirSync(dirname(desktopPath), { recursive: true });
  const tempPath = join(dirname(desktopPath), `.${USER_DESKTOP_NAME}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o644 });
    const again = readRegularFile(desktopPath);
    if (again === content) return 'unchanged';
    if (again != null && !isOwnedDesktop(again)) return 'kept-user-entry';
    if (again == null && pathKind(desktopPath) === 'other') return 'kept-user-entry';
    if (!replaceFile(tempPath, desktopPath)) return 'kept-user-entry';
    return existing == null && again == null ? 'installed' : 'updated';
  } finally {
    try {
      if (pathKind(tempPath) !== 'missing') unlinkSync(tempPath);
    } catch {
      // rename 成功后临时文件已不在；删除失败留到下次启动无影响（文件名不以 .desktop 结尾）。
    }
  }
}

/** Linux 的 rename 会原子覆盖目标。Windows 上目标已存在时 rename 失败，确认仍是本程序的文件后再替换。 */
function replaceFile(tempPath: string, desktopPath: string): boolean {
  try {
    renameSync(tempPath, desktopPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EBUSY') throw error;
    const current = readRegularFile(desktopPath);
    if (current == null || !isOwnedDesktop(current)) return false;
    unlinkSync(desktopPath);
    renameSync(tempPath, desktopPath);
    return true;
  }
}

function ensureUserIcon(iconSource: string, iconPath: string, dataHome: string, systemRoots: string[]): void {
  if (!isReadableFile(iconSource)) return;
  if (!iconMutationAllowed(iconPath, dataHome, systemRoots)) return;
  if (pathKind(iconPath) !== 'missing') return;
  mkdirSync(dirname(iconPath), { recursive: true });
  if (!iconMutationAllowed(iconPath, dataHome, systemRoots)) return;
  if (pathKind(iconPath) !== 'missing') return;
  copyFileSync(iconSource, iconPath);
}

function removeIdenticalIcon(iconSource: string, iconPath: string, dataHome: string, systemRoots: string[]): boolean {
  if (!isReadableFile(iconSource) || !iconMutationAllowed(iconPath, dataHome, systemRoots)) return false;
  if (pathKind(iconPath) !== 'file') return false;
  if (!readFileSync(iconPath).equals(readFileSync(iconSource))) return false;
  unlinkSync(iconPath);
  return true;
}

function isOwnedDesktop(content: string): boolean {
  return isCurrentOwned(content) || isLegacyOwned(content);
}

function isCurrentOwned(content: string): boolean {
  const exec = matchedExec(content, CURRENT_SUFFIX);
  if (exec == null) return false;
  const parsed = parseOwnedExecPath(exec);
  if (parsed == null || !isSafeExecPath(parsed)) return false;
  return formatDesktopExec(parsed) === exec;
}

/**
 * 旧模板没有管理标记，Exec 是 process.execPath 原文。
 * 空白分开的 -参数 或 %U 这类 field code 说明用户改过命令行，保留。
 * 路径本身含空格仍算旧条目：当年没有加引号，这正是要迁移的文件。
 */
function isLegacyOwned(content: string): boolean {
  const exec = matchedExec(content, LEGACY_SUFFIX);
  if (exec == null) return false;
  if (!exec.startsWith('/') || !isAbsolute(exec) || hasControlChar(exec)) return false;
  const tokens = exec.split(/[ \t]+/).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => !token.startsWith('-') && !FIELD_CODE.test(token));
}

function matchedExec(content: string, suffix: readonly string[]): string | null {
  const lines = content.split('\n');
  const execIndex = 3;
  if (lines.length !== execIndex + 1 + suffix.length) return null;
  if (lines[0] !== '[Desktop Entry]' || lines[1] !== 'Type=Application' || lines[2] !== 'Name=diteng agent') return null;
  for (let index = 0; index < suffix.length; index += 1) {
    if (lines[execIndex + 1 + index] !== suffix[index]) return null;
  }
  const execLine = lines[execIndex];
  if (!execLine.startsWith('Exec=')) return null;
  return execLine.slice('Exec='.length);
}

/**
 * 按 GLib 的实际顺序还原路径：GKeyFile 反转义，再展开 %，再 shell 分词。
 * 只接受本程序会写出的命令：一个绝对路径，或 /usr/bin/env -- 加上该路径。
 */
function parseOwnedExecPath(exec: string): string | null {
  const unescaped = keyfileUnescape(exec);
  if (unescaped == null) return null;
  const expanded = expandPercent(unescaped);
  if (expanded == null) return null;
  const args = shellParse(expanded);
  if (args == null) return null;
  const path = args.length === 1
    ? args[0]
    : args.length === 3 && args[0] === '/usr/bin/env' && args[1] === '--'
      ? args[2]
      : null;
  if (path == null || !isSafeExecPath(path)) return null;
  return path;
}

/** GKeyFile 只接受 \s \n \t \r \\。其他反斜杠转义会让 Exec 读出来是空的。 */
function keyfileUnescape(value: string): string | null {
  let text = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      text += value[index];
      continue;
    }
    const next = value[index + 1];
    if (next === '\\') text += '\\';
    else if (next === 's') text += ' ';
    else if (next === 'n') text += '\n';
    else if (next === 't') text += '\t';
    else if (next === 'r') text += '\r';
    else return null;
    index += 1;
  }
  return text;
}

/** 与 gdesktopappinfo.c 的展开一致：%% 变成 %，其他 %X 会吃掉两个字符。后者不是我们的路径。 */
function expandPercent(value: string): string | null {
  let text = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '%' && index + 1 < value.length) {
      if (value[index + 1] !== '%') return null;
      text += '%';
      index += 1;
      continue;
    }
    text += value[index];
  }
  return text;
}

function shellParse(value: string): string[] | null {
  const args: string[] = [];
  let current = '';
  let mode: 'none' | 'single' | 'double' = 'none';
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (mode === 'single') {
      if (char === '\'') mode = 'none';
      else current += char;
      started = true;
      continue;
    }
    if (mode === 'double') {
      if (char === '\\') {
        const next = value[index + 1];
        if (next == null) return null;
        current += (next === '"' || next === '\\' || next === '`' || next === '$' || next === '\n') ? next : char + next;
        started = true;
        index += 1;
        continue;
      }
      if (char === '"') mode = 'none';
      else current += char;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    if (char === '\'') {
      mode = 'single';
      started = true;
      continue;
    }
    if (char === '"') {
      mode = 'double';
      started = true;
      continue;
    }
    if (char === '\\') {
      const next = value[index + 1];
      if (next == null) return null;
      current += next;
      started = true;
      index += 1;
      continue;
    }
    current += char;
    started = true;
  }
  if (mode !== 'none') return null;
  if (started) args.push(current);
  return args;
}

function hasSystemDesktop(systemApplicationDirs: string[]): boolean {
  return systemApplicationDirs.some((dir) => SYSTEM_DESKTOP_NAMES.some((name) => isReadableFile(join(dir, name))));
}

function isProtectedDesktop(userDesktop: string, systemApplicationDirs: string[]): boolean {
  const userCanon = canonicalize(userDesktop);
  const userDir = canonicalize(dirname(userDesktop));
  return systemApplicationDirs.some((dir) => {
    const systemDir = canonicalize(dir);
    if (userDir === systemDir || isInside(systemDir, userCanon)) return true;
    return SYSTEM_DESKTOP_NAMES.some((name) => canonicalize(join(dir, name)) === userCanon);
  });
}

function iconMutationAllowed(iconPath: string, dataHome: string, systemRoots: string[]): boolean {
  const canon = canonicalize(iconPath);
  if (!isInside(canonicalize(dataHome), canon)) return false;
  return systemRoots.every((root) => !isInside(root, canon));
}

function isSafeExecPath(execPath: string): boolean {
  return isAbsolute(execPath) && !hasControlChar(execPath);
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function readRegularFile(path: string): string | null {
  if (pathKind(path) !== 'file') return null;
  return readFileSync(path, 'utf8');
}

function pathKind(path: string): 'missing' | 'file' | 'other' {
  try {
    return lstatSync(path).isFile() ? 'file' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** 文件尚不存在时，解析到最近的已存在父目录，避免把符号链接当成普通目录。 */
function canonicalize(target: string): string {
  const missing: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      return missing.reduce((path, part) => join(path, part), realpathSync(current));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}
