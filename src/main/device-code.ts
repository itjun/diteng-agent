import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

/**
 * 设备编码：对齐 diteng-terminal（lanarus/BaseCtrl/ApConst.pas NBGetVolumnNo）的生成逻辑，
 * 同一台机器上的地藤终端服务与本客户端由此得到相同 machine_code，服务端按其去重复用同一 terminal_id。
 *
 * Windows：8 位大写十六进制硬盘卷序列号与 HWASOFT\system.ini 中的永久 GUID 盐逐字节 XOR 后
 * 十六进制编码，得 16 位大写 hex；盐首次生成时写回，之后与地藤终端服务共用同一份。
 * macOS/Linux：无卷序列号机制，取硬件 UUID 的 SHA-256 前 16 位大写 hex，保持格式一致。
 */

/** 盐文件与卷序列号的盘符选择仅接受 NTFS/FAT32（exFAT/ReFS 等不入选，ApConst.pas 同款） */
const ACCEPTED_FILESYSTEMS = new Set(['NTFS', 'FAT32']);
/** HWASOFT 盐文件的节/键名（对齐 ApConst.pas MACHNO_GUID 常量） */
const SALT_SECTION = '{DAB8ECD7-69D8-4161-A364-CA71A387C154}';
const SALT_KEY = 'MachNo';
const SALT_HEX = /^[0-9A-F]{32}$/;
/** 最终设备编码格式：16 位大写十六进制 */
const DEVICE_CODE = /^[0-9A-F]{16}$/;
const COMMAND_TIMEOUT_MS = 5_000;

export interface FixedDisk {
  /** 盘符（单字母大写） */
  letter: string;
  /** 文件系统类型（NTFS/FAT32/exFAT…，可能为空） */
  fileSystem: string;
  /** 卷序列号（大写 hex，可能不足 8 位或为空） */
  serial: string;
}

/**
 * 卷序列号与盐的循环 XOR + 十六进制编码：
 * ApConst.pas Encrypt(Value, PSW, True) 的逐字节移植（盐按 i mod len 循环，每字节 2 位大写 hex）。
 */
export function encryptVolumeCode(serial: string, salt: string): string {
  if (!serial.length || !salt.length) return '';
  let result = '';
  for (let i = 0; i < serial.length; i++) {
    const mixed = serial.charCodeAt(i) ^ salt.charCodeAt(i % salt.length);
    result += mixed.toString(16).toUpperCase().padStart(2, '0');
  }
  return result;
}

/**
 * 盘符选择（NBGetVolumnNo / SystemRootPath 同款）：默认系统盘；按字母序扫描固定盘，
 * 系统盘之后第一个 NTFS/FAT32 固定盘优先（重装系统盘不改变设备编码）；
 * 系统盘之前的固定盘既不入选也不推进标记。
 */
export function selectPreferredDisk(disks: FixedDisk[], systemLetter: string): FixedDisk | null {
  const system = systemLetter.toUpperCase();
  let sawSystem = false;
  for (const disk of [...disks].sort((left, right) => left.letter.localeCompare(right.letter))) {
    if (!sawSystem) {
      if (disk.letter.toUpperCase() === system) sawSystem = true;
      continue;
    }
    if (ACCEPTED_FILESYSTEMS.has(disk.fileSystem.toUpperCase())) return disk;
  }
  return disks.find((disk) => disk.letter.toUpperCase() === system) ?? null;
}

/** 解析 INI 单节单键值（节名/键名大小写不敏感；`;`/`#` 开头为注释行） */
export function readIniValue(text: string, section: string, key: string): string | null {
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      inSection = sectionMatch[1].trim().toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim().toLowerCase() !== key.toLowerCase()) continue;
    return trimmed.slice(eq + 1).trim();
  }
  return null;
}

/** 写入/替换 INI 单节单键值并保留其余内容（CRLF 行尾，纯 ASCII 追加，与 Windows INI API 兼容） */
export function upsertIniValue(text: string, section: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const sectionHeader = `[${section}]`;
  let sectionIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().replace(/\s+/g, '').toLowerCase() === sectionHeader.toLowerCase()) {
      sectionIndex = i;
      break;
    }
  }
  if (sectionIndex < 0) {
    lines.push(sectionHeader, `${key}=${value}`);
    return `${lines.join('\r\n')}\r\n`;
  }
  let sectionEnd = lines.length;
  for (let i = sectionIndex + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  for (let i = sectionIndex + 1; i < sectionEnd; i++) {
    const eq = lines[i].indexOf('=');
    if (eq <= 0) continue;
    if (lines[i].slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
      lines[i] = `${key}=${value}`;
      return `${lines.join('\r\n')}\r\n`;
    }
  }
  lines.splice(sectionEnd, 0, `${key}=${value}`);
  return `${lines.join('\r\n')}\r\n`;
}

/** 硬件 UUID 的 SHA-256 前 16 位大写 hex（非 Windows 平台的设备编码，格式与 Windows 一致） */
export function hardwareUuidToCode(uuid: string): string {
  return createHash('sha256').update(uuid).digest('hex').slice(0, 16).toUpperCase();
}

interface Win32LogicalDisk {
  DeviceID?: unknown;
  FileSystem?: unknown;
  VolumeSerialNumber?: unknown;
}

/** 枚举 Windows 固定盘（DriveType=3）的盘符/文件系统/卷序列号，失败抛出由调用方兜底 */
function listWindowsFixedDisks(): FixedDisk[] {
  const powershell = join(
    process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const stdout = execFileSync(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FileSystem,VolumeSerialNumber | ConvertTo-Json -Compress",
  ], { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) as string;
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const disks: FixedDisk[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const disk = item as Win32LogicalDisk;
    const letter = typeof disk.DeviceID === 'string' ? disk.DeviceID.trim().toUpperCase().charAt(0) : '';
    if (!/^[A-Z]$/.test(letter)) continue;
    disks.push({
      letter,
      fileSystem: typeof disk.FileSystem === 'string' ? disk.FileSystem.trim() : '',
      serial: typeof disk.VolumeSerialNumber === 'string'
        ? disk.VolumeSerialNumber.replace(/[^0-9A-Fa-f]/g, '').toUpperCase()
        : '',
    });
  }
  return disks;
}

/**
 * 读取（或首次生成并写回）HWASOFT 盐：优先地藤终端服务选定的数据盘，其次系统盘。
 * 用 latin1 逐字节读写，避免改写 system.ini 中其他程序的本地化内容。
 */
function readOrCreateSalt(systemLetter: string, disks: FixedDisk[]): string | null {
  const candidates: string[] = [];
  const preferred = selectPreferredDisk(disks, systemLetter);
  if (preferred && preferred.letter.toUpperCase() !== systemLetter.toUpperCase()) candidates.push(preferred.letter);
  candidates.push(systemLetter.toUpperCase());
  for (const letter of candidates) {
    try {
      const directory = `${letter}:\\HWASOFT`;
      const file = join(directory, 'system.ini');
      const text = existsSync(file) ? readFileSync(file, 'latin1') : '';
      const existing = text ? readIniValue(text, SALT_SECTION, SALT_KEY) : null;
      if (existing && SALT_HEX.test(existing.toUpperCase())) return existing;
      // 值缺失才写回：首次生成的盐与地藤终端服务共用（GUID 去连字符，小写 hex）
      const salt = randomUUID().replaceAll('-', '');
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
      writeFileSync(`${file}.tmp`, upsertIniValue(text, SALT_SECTION, SALT_KEY, salt), 'latin1');
      renameSync(`${file}.tmp`, file);
      return salt;
    } catch {
      // 该盘不可读/不可写（如数据盘写保护），尝试下一候选
    }
  }
  return null;
}

/** 由固定盘列表与盐计算 Windows 设备编码（选中盘无序列号或盐缺失返回空串） */
export function windowsCodeFrom(disks: FixedDisk[], systemLetter: string, salt: string | null): string {
  const preferred = selectPreferredDisk(disks, systemLetter);
  if (!preferred || !preferred.serial || preferred.serial.length > 8 || !salt) return '';
  const serial = preferred.serial.padStart(8, '0');
  if (!/^[0-9A-F]{8}$/.test(serial)) return '';
  return encryptVolumeCode(serial, salt);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MACHINE_ID_PATTERN = /^[0-9a-f]{16,64}$/i;

/** 读取本机硬件 UUID（macOS IOPlatformUUID / Linux product_uuid，回落 /etc/machine-id），无效返回空串 */
function readHardwareUuid(): string {
  const isValid = (value: string) =>
    (UUID_PATTERN.test(value) && !/^(0|-)+$/.test(value) && !/^(f|-)+$/i.test(value))
    || (MACHINE_ID_PATTERN.test(value) && !/^0+$/.test(value));
  try {
    if (platform() === 'darwin') {
      const stdout = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        timeout: COMMAND_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }) as string;
      const uuid = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i)?.[1]?.trim() ?? '';
      return isValid(uuid) ? uuid : '';
    }
    if (platform() === 'linux') {
      for (const source of ['/sys/class/dmi/id/product_uuid', '/etc/machine-id']) {
        try {
          const value = readFileSync(source, 'utf8').trim();
          if (isValid(value)) return value;
        } catch {
          // 尝试下一个来源
        }
      }
    }
  } catch {
    // 采集失败由调用方兜底
  }
  return '';
}

/** 按平台采集并计算设备编码；采集失败返回空串 */
function computeDeviceCode(): string {
  if (platform() === 'win32') {
    try {
      const systemLetter = (process.env.SystemDrive || 'C:').trim().toUpperCase().charAt(0);
      const disks = listWindowsFixedDisks();
      return windowsCodeFrom(disks, systemLetter, readOrCreateSalt(systemLetter, disks));
    } catch {
      return '';
    }
  }
  const uuid = readHardwareUuid();
  return uuid ? hardwareUuidToCode(uuid) : '';
}

/**
 * 计算设备编码（同步，getConfig 首次调用时执行一次）：
 * 采集成功返回 16 位大写 hex；失败沿用已存值（跨启动稳定，保住服务端设备验证绑定），
 * 两者皆无才随机生成（持久化于 config.json，此后同样稳定）。
 * compute 参数供测试注入采集结果。
 */
export function getDeviceCode(previous: string, compute: () => string = computeDeviceCode): string {
  try {
    const computed = compute();
    if (DEVICE_CODE.test(computed)) return computed;
  } catch {
    // 采集异常走兜底
  }
  return previous || randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
}
