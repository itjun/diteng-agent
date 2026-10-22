import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AppConfig, AppConfigPatch, TabLayout, ThemeSetting, WindowBounds } from '../shared/types';

/** 本地 diteng-im-server 默认地址（本地 8101 未启动属预期，登录时按网络错误提示） */
const DEFAULT_SERVER_BASE = 'http://127.0.0.1:8101';

/** aiBase 未手动设置时的推导：生产 m.cdcp.site 对应 https://ai.cdcp.site（ai-agent web-host 同源约定），其余回本地 dev */
export function resolveAiBase(config: AppConfig): string {
  if (config.aiBase.trim()) return config.aiBase.trim().replace(/\/+$/, '');
  return config.serverBase.includes('cdcp.site') ? 'https://ai.cdcp.site' : 'http://127.0.0.1:3060';
}

// 进程内缓存：machineCode 首次生成后终身复用，避免每次读取都碰磁盘
let currentConfig: AppConfig | null = null;

function configFile(): string {
  return join(app.getPath('userData'), 'config.json');
}

function createDefault(): AppConfig {
  // aiBase 空串 = 未手动设置，读取时经 resolveAiBase 按 serverBase 推导
  return { serverBase: DEFAULT_SERVER_BASE, aiBase: '', machineCode: '', savedLoginId: '', savedPassword: '', theme: 'system', tabLayout: 'left', windowBounds: null, railWidth: 0, rememberPassword: true, autoLogin: true };
}

/** 窗口大小记录归一：正整数且在合理区间（宽/高各 200~20000），否则视为未记录 */
function normalizeWindowBounds(input: unknown): WindowBounds | null {
  if (typeof input !== 'object' || input === null) return null;
  const width = (input as { width?: unknown }).width;
  const height = (input as { height?: unknown }).height;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 200 || width > 20000 || height < 200 || height > 20000) return null;
  return { width, height };
}

/** 按字段类型逐项归一，坏字段回落默认值，避免脏 JSON 直接进入内存 */
function normalize(input: Partial<AppConfig> | null): AppConfig {
  const base = createDefault();
  const serverBase =
    typeof input?.serverBase === 'string' && input.serverBase.trim()
      ? input.serverBase.trim().replace(/\/+$/, '')
      : base.serverBase;
  const theme: ThemeSetting =
    input?.theme === 'light' || input?.theme === 'dark' ? input.theme : 'system';
  // 布局仅认 'left'/'top'，其余（含旧 config 缺字段）回落默认 left
  const tabLayout: TabLayout = input?.tabLayout === 'top' ? 'top' : 'left';
  const windowBounds = normalizeWindowBounds(input?.windowBounds);
  // 侧栏宽度：0=未自定义（渲染层用默认 300）；自定义值限 200~480 整数，越界视为未记录
  const railWidthRaw = (input as { railWidth?: unknown } | undefined)?.railWidth;
  const railWidth =
    typeof railWidthRaw === 'number' && Number.isInteger(railWidthRaw) && railWidthRaw >= 200 && railWidthRaw <= 480
      ? railWidthRaw
      : 0;
  // 布尔勾选（登录页两勾选）：非 boolean 一律回落默认 true（旧 config 缺字段兼容）
  const rememberPassword =
    typeof (input as { rememberPassword?: unknown } | undefined)?.rememberPassword === 'boolean'
      ? (input as { rememberPassword: boolean }).rememberPassword
      : true;
  const autoLogin =
    typeof (input as { autoLogin?: unknown } | undefined)?.autoLogin === 'boolean'
      ? (input as { autoLogin: boolean }).autoLogin
      : true;
  return {
    serverBase,
    aiBase:
      typeof input?.aiBase === 'string'
        ? input.aiBase.trim().replace(/\/+$/, '')
        : '',
    machineCode: typeof input?.machineCode === 'string' ? input.machineCode : '',
    savedLoginId: typeof input?.savedLoginId === 'string' ? input.savedLoginId.trim() : '',
    // 密码密文（safeStorage base64），仅原样保留，不做格式推断
    savedPassword: typeof input?.savedPassword === 'string' ? input.savedPassword.trim() : '',
    theme,
    tabLayout,
    windowBounds,
    railWidth,
    rememberPassword,
    autoLogin,
  };
}

/** 主进程写入窗口大小记录（渲染层无此通道） */
export function saveWindowBounds(bounds: WindowBounds): void {
  const config = getConfig();
  config.windowBounds = normalizeWindowBounds(bounds);
  writeToDisk(config);
}

function readFromDisk(): AppConfig {
  const file = configFile();
  if (!existsSync(file)) return createDefault();
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>);
  } catch (error) {
    console.warn('[config] config.json 解析失败，改用默认配置：', error);
    return createDefault();
  }
}

function writeToDisk(config: AppConfig): void {
  writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}

/** 读取配置；首次调用时补齐并持久化 machineCode */
export function getConfig(): AppConfig {
  if (currentConfig) return currentConfig;
  const config = readFromDisk();
  if (!config.machineCode) {
    config.machineCode = randomUUID();
    writeToDisk(config);
  }
  currentConfig = config;
  return config;
}

/** 部分字段更新并立即落盘；machineCode 不在可更新范围内，由设备身份唯一决定 */
export function updateConfig(patch: AppConfigPatch): AppConfig {
  const config = getConfig();
  if (typeof patch.serverBase === 'string' && patch.serverBase.trim())
    config.serverBase = patch.serverBase.trim().replace(/\/+$/, '');
  // aiBase 仅接受非空手改值；空串表示按 serverBase 推导，不清除已存的手改地址
  if (typeof patch.aiBase === 'string' && patch.aiBase.trim())
    config.aiBase = patch.aiBase.trim().replace(/\/+$/, '');
  if (typeof patch.savedLoginId === 'string') config.savedLoginId = patch.savedLoginId.trim();
  // savedPassword 只接受主进程写入的 safeStorage 密文（空串=清除），渲染层不传明文
  if (typeof patch.savedPassword === 'string') config.savedPassword = patch.savedPassword.trim();
  if (patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system')
    config.theme = patch.theme;
  if (patch.tabLayout === 'left' || patch.tabLayout === 'top') config.tabLayout = patch.tabLayout;
  // railWidth：0（恢复默认）或 200~480 整数
  if (patch.railWidth === 0) config.railWidth = 0;
  else if (
    typeof patch.railWidth === 'number' &&
    Number.isInteger(patch.railWidth) &&
    patch.railWidth >= 200 &&
    patch.railWidth <= 480
  )
    config.railWidth = patch.railWidth;
  if (typeof patch.rememberPassword === 'boolean') config.rememberPassword = patch.rememberPassword;
  if (typeof patch.autoLogin === 'boolean') config.autoLogin = patch.autoLogin;
  writeToDisk(config);
  return config;
}
