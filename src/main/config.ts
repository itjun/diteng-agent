import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AppConfig, AppConfigPatch, ThemeSetting, WindowBounds } from '../shared/types';

/** 线上生产环境地址（登录页默认预填；本地开发可直接手输其它地址） */
const DEFAULT_SERVER_BASE = 'https://m.cdcp.site';

/** 旧版默认服务地址（本地 diteng-im-server）：仅用于升级迁移，不参与新安装默认值 */
const LEGACY_DEFAULT_SERVER_BASE = 'http://127.0.0.1:8101';

/** 配置结构版本：2 = 默认服务地址切到线上；旧配置（缺字段视为 1）按旧默认值判定迁移 */
const CONFIG_VERSION = 2;

/** 历史账号保留上限：超出按最近登录时间淘汰，避免下拉列表无限增长 */
const MAX_SAVED_ACCOUNTS = 10;

/** 历史登录账号持久化记录（密码为 safeStorage 密文，空串表示只记住了账号） */
export interface SavedAccount {
  loginId: string;
  serverBase: string;
  passwordCipher: string;
  /** 最近一次成功登录时间（epoch ms）；0 表示旧版配置迁移而来 */
  lastLoginAt: number;
}

/**
 * config.json 的完整持久化结构（仅主进程使用）。
 * savedAccounts 含密码密文，config:get/config:set 下发渲染层前由主进程剥离。
 */
export type StoredAppConfig = AppConfig & {
  savedAccounts: SavedAccount[];
};

/** aiBase 未手动设置时的推导：生产 m.cdcp.site 对应 https://ai.cdcp.site（ai-agent web-host 同源约定），其余回本地 dev */
export function resolveAiBase(config: AppConfig): string {
  if (config.aiBase.trim()) return config.aiBase.trim().replace(/\/+$/, '');
  return config.serverBase.includes('cdcp.site') ? 'https://ai.cdcp.site' : 'http://127.0.0.1:3060';
}

// 进程内缓存：machineCode 首次生成后终身复用，避免每次读取都碰磁盘
let currentConfig: StoredAppConfig | null = null;

function configFile(): string {
  return join(app.getPath('userData'), 'config.json');
}

function createDefault(): StoredAppConfig {
  // aiBase 空串 = 未手动设置，读取时经 resolveAiBase 按 serverBase 推导
  return { configVersion: CONFIG_VERSION, serverBase: DEFAULT_SERVER_BASE, aiBase: '', machineCode: '', savedLoginId: '', savedPassword: '', theme: 'system', windowBounds: null, railWidth: 0, rememberPassword: true, autoLogin: true, savedAccounts: [] };
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

/** 已存配置的版本号：缺字段/非法值按旧配置 1 处理（旧版本没有该字段） */
function storedConfigVersion(input: Partial<AppConfig> | null): number {
  return typeof input?.configVersion === 'number' && Number.isInteger(input.configVersion) && input.configVersion > 0
    ? input.configVersion
    : 1;
}

/** 单条历史账号解析；账号或服务器缺失视为脏数据丢弃 */
function parseSavedAccount(input: unknown): SavedAccount | null {
  if (typeof input !== 'object' || input === null) return null;
  const source = input as { loginId?: unknown; serverBase?: unknown; passwordCipher?: unknown; lastLoginAt?: unknown };
  const loginId = typeof source.loginId === 'string' ? source.loginId.trim() : '';
  const serverBase =
    typeof source.serverBase === 'string' ? source.serverBase.trim().replace(/\/+$/, '') : '';
  if (!loginId || !serverBase) return null;
  // 密码密文（safeStorage base64）原样保留，不做格式推断
  const passwordCipher = typeof source.passwordCipher === 'string' ? source.passwordCipher.trim() : '';
  const lastLoginAt =
    typeof source.lastLoginAt === 'number' && Number.isFinite(source.lastLoginAt) && source.lastLoginAt > 0
      ? source.lastLoginAt
      : 0;
  return { loginId, serverBase, passwordCipher, lastLoginAt };
}

/**
 * 历史账号列表归一：按「服务器 + 账号」去重（保留最近登录的一条）、最近登录在前、上限 10 条。
 * 字段缺失（旧版 config.json）时用已存的单账号凭据迁移；显式空数组表示用户已清空，不再回填。
 */
function normalizeSavedAccounts(
  input: unknown,
  legacy: { serverBase: string; savedLoginId: string; savedPassword: string },
): SavedAccount[] {
  let candidates: unknown[];
  if (Array.isArray(input)) candidates = input;
  else if (legacy.savedLoginId) {
    candidates = [
      {
        loginId: legacy.savedLoginId,
        serverBase: legacy.serverBase,
        passwordCipher: legacy.savedPassword,
        lastLoginAt: 0,
      },
    ];
  } else {
    candidates = [];
  }
  const byKey = new Map<string, SavedAccount>();
  for (const candidate of candidates) {
    const account = parseSavedAccount(candidate);
    if (!account) continue;
    const key = `${account.serverBase}\n${account.loginId}`;
    const existing = byKey.get(key);
    if (!existing || account.lastLoginAt >= existing.lastLoginAt) byKey.set(key, account);
  }
  return [...byKey.values()]
    .sort((left, right) => right.lastLoginAt - left.lastLoginAt)
    .slice(0, MAX_SAVED_ACCOUNTS);
}

/** 按字段类型逐项归一，坏字段回落默认值，避免脏 JSON 直接进入内存 */
function normalize(input: Partial<StoredAppConfig> | null): StoredAppConfig {
  const base = createDefault();
  const storedServerBase =
    typeof input?.serverBase === 'string' && input.serverBase.trim()
      ? input.serverBase.trim().replace(/\/+$/, '')
      : '';
  // 旧版默认地址迁移：值仍是旧默认（用户从未自定义地址）才切到线上默认，手改过的地址保持不动
  const serverBase =
    storedConfigVersion(input) < CONFIG_VERSION && storedServerBase === LEGACY_DEFAULT_SERVER_BASE
      ? base.serverBase
      : storedServerBase || base.serverBase;
  const theme: ThemeSetting =
    input?.theme === 'light' || input?.theme === 'dark' ? input.theme : 'system';
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
  const savedLoginId = typeof input?.savedLoginId === 'string' ? input.savedLoginId.trim() : '';
  // savedPassword 为自动登录用的兼容凭据（safeStorage base64），与历史账号最近一次登录同步
  const savedPassword = typeof input?.savedPassword === 'string' ? input.savedPassword.trim() : '';
  return {
    configVersion: CONFIG_VERSION,
    serverBase,
    aiBase:
      typeof input?.aiBase === 'string'
        ? input.aiBase.trim().replace(/\/+$/, '')
        : '',
    machineCode: typeof input?.machineCode === 'string' ? input.machineCode : '',
    savedLoginId,
    savedPassword,
    theme,
    windowBounds,
    railWidth,
    rememberPassword,
    autoLogin,
    savedAccounts: normalizeSavedAccounts(input?.savedAccounts, { serverBase, savedLoginId, savedPassword }),
  };
}

/** 主进程写入窗口大小记录（渲染层无此通道） */
export function saveWindowBounds(bounds: WindowBounds): void {
  const config = getConfig();
  config.windowBounds = normalizeWindowBounds(bounds);
  writeToDisk(config);
}

function readFromDisk(): StoredAppConfig {
  const file = configFile();
  if (!existsSync(file)) return createDefault();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredAppConfig>;
    const config = normalize(raw);
    // 旧版配置迁移（默认服务地址切换/补齐版本号）立即回写：避免每次启动重复迁移、登录页仍预填旧地址
    if (storedConfigVersion(raw) < CONFIG_VERSION) writeToDisk(config);
    return config;
  } catch (error) {
    console.warn('[config] config.json 解析失败，改用默认配置：', error);
    return createDefault();
  }
}

function writeToDisk(config: StoredAppConfig): void {
  writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}

/** 读取配置；首次调用时补齐并持久化 machineCode */
export function getConfig(): StoredAppConfig {
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
export function updateConfig(patch: AppConfigPatch): StoredAppConfig {
  const config = getConfig();
  if (typeof patch.serverBase === 'string' && patch.serverBase.trim())
    config.serverBase = patch.serverBase.trim().replace(/\/+$/, '');
  // aiBase 仅接受非空手改值；空串表示按 serverBase 推导，不清除已存的手改地址
  if (typeof patch.aiBase === 'string' && patch.aiBase.trim())
    config.aiBase = patch.aiBase.trim().replace(/\/+$/, '');
  if (patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system')
    config.theme = patch.theme;
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

/** 自动登录兼容凭据的一次性更新字段 */
export interface AutoLoginCredentialPatch {
  serverBase?: string;
  savedLoginId?: string;
  savedPassword?: string;
}

/**
 * 历史账号列表整体替换并落盘（排序、去重、上限在这里统一归一）。
 * 可同时更新自动登录兼容凭据：两者在同一次 writeFileSync 中写入，避免两次写盘的中间态。
 * 只由主进程账号存储模块调用，渲染层没有写入口。
 */
export function persistSavedAccounts(
  accounts: SavedAccount[],
  credential?: AutoLoginCredentialPatch,
): SavedAccount[] {
  const config = getConfig();
  const next: StoredAppConfig = {
    ...config,
    savedAccounts: normalizeSavedAccounts(accounts, {
      serverBase: config.serverBase,
      savedLoginId: '',
      savedPassword: '',
    }),
  };
  if (credential) {
    if (typeof credential.serverBase === 'string' && credential.serverBase.trim())
      next.serverBase = credential.serverBase.trim().replace(/\/+$/, '');
    if (typeof credential.savedLoginId === 'string') next.savedLoginId = credential.savedLoginId.trim();
    if (typeof credential.savedPassword === 'string') next.savedPassword = credential.savedPassword.trim();
  }
  // 先写盘成功再更新内存缓存：写失败时内存与磁盘保持一致，调用方可安全放弃本次变更
  writeToDisk(next);
  config.serverBase = next.serverBase;
  config.savedLoginId = next.savedLoginId;
  config.savedPassword = next.savedPassword;
  config.savedAccounts = next.savedAccounts;
  return config.savedAccounts;
}

/** 主进程内部：清空自动登录凭据（保留 savedLoginId 供登录页预填账号）；历史账号不动，一次落盘 */
export function clearAutoLoginCredential(): void {
  const config = getConfig();
  if (!config.savedPassword) return;
  const next: StoredAppConfig = { ...config, savedPassword: '' };
  writeToDisk(next);
  config.savedPassword = '';
}
