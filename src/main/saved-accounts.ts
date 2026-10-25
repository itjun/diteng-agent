import type { SavedAccountKey, SavedAccountSummary } from '../shared/types';
import {
  getConfig,
  persistSavedAccounts,
  type AutoLoginCredentialPatch,
  type SavedAccount,
} from './config';

/** 服务器地址归一：去空白与末尾斜杠（与 config.serverBase 归一规则一致），保证「账号 + 服务器」匹配稳定 */
function normalizeServerBase(serverBase: string): string {
  return serverBase.trim().replace(/\/+$/, '');
}

/** 历史账号摘要（不含密码密文，供 renderer 列表展示与管理） */
export function listSavedAccounts(): SavedAccountSummary[] {
  const config = getConfig();
  return config.savedAccounts.filter((account) => account.serverBase === config.serverBase).map((account) => ({
    loginId: account.loginId,
    serverBase: account.serverBase,
    hasPassword: Boolean(account.passwordCipher),
    lastLoginAt: account.lastLoginAt,
  }));
}

/** 按「账号 + 服务器」定位一条历史记录；未找到返回 null */
export function findSavedAccount(key: SavedAccountKey): SavedAccount | null {
  const loginId = key.loginId.trim();
  const serverBase = normalizeServerBase(key.serverBase);
  if (!loginId || serverBase !== getConfig().serverBase) return null;
  return (
    getConfig().savedAccounts.find(
      (account) => account.loginId === loginId && account.serverBase === serverBase,
    ) ?? null
  );
}

/**
 * 登录成功记录历史账号：同一账号覆盖密码与最近登录时间并置顶。
 * - passwordCipher 为本次要保存的密文
 * - passwordCipher 为 null 表示 safeStorage 不可用：保留该账号已存密文，只刷新账号与最近登录时间
 * - credential 传入时与历史账号一次落盘；不传则保持自动登录凭据不变
 */
export function recordSavedAccountLogin(
  loginId: string,
  serverBase: string,
  passwordCipher: string | null,
  credential?: AutoLoginCredentialPatch,
): void {
  const trimmedLoginId = loginId.trim();
  const normalizedServerBase = normalizeServerBase(serverBase);
  if (!trimmedLoginId || !normalizedServerBase) return;
  const accounts = getConfig().savedAccounts;
  const rest = accounts.filter(
    (account) => !(account.loginId === trimmedLoginId && account.serverBase === normalizedServerBase),
  );
  const existing = accounts.find(
    (account) => account.loginId === trimmedLoginId && account.serverBase === normalizedServerBase,
  );
  persistSavedAccounts(
    [
      {
        loginId: trimmedLoginId,
        serverBase: normalizedServerBase,
        // null 表示无法加密：保留旧密文，避免临时 keyring 不可用静默清掉已保存密码
        passwordCipher: passwordCipher ?? existing?.passwordCipher ?? '',
        lastLoginAt: Date.now(),
      },
      ...rest,
    ],
    credential,
  );
}

/** 自动登录成功时刷新最近登录时间，登录页历史列表据此保持最近使用在前 */
export function touchSavedAccount(loginId: string, serverBase: string): void {
  const trimmedLoginId = loginId.trim();
  const normalizedServerBase = normalizeServerBase(serverBase);
  const accounts = getConfig().savedAccounts;
  if (
    !accounts.some(
      (account) => account.loginId === trimmedLoginId && account.serverBase === normalizedServerBase,
    )
  )
    return;
  const now = Date.now();
  persistSavedAccounts(
    accounts.map((account) =>
      account.loginId === trimmedLoginId && account.serverBase === normalizedServerBase
        ? { ...account, lastLoginAt: now }
        : account,
    ),
  );
}

/**
 * 删除一条历史账号；记录不存在返回 false（handler 据此返回失败，避免静默成功）。
 * 删除的是自动登录兼容凭据对应账号时，同一次落盘里清空凭据：
 * 同一账号名可能登录不同服务器，必须连服务器地址一起比较，避免误清另一台服务器的同名账号。
 */
export function removeSavedAccount(loginId: string, serverBase: string): boolean {
  const trimmedLoginId = loginId.trim();
  const normalizedServerBase = normalizeServerBase(serverBase);
  const config = getConfig();
  if (normalizedServerBase !== config.serverBase) return false;
  const next = config.savedAccounts.filter(
    (account) => !(account.loginId === trimmedLoginId && account.serverBase === normalizedServerBase),
  );
  if (next.length === config.savedAccounts.length) return false;
  const isAutoLoginAccount =
    config.savedLoginId === trimmedLoginId && config.serverBase === normalizedServerBase;
  persistSavedAccounts(next, isAutoLoginAccount ? { savedLoginId: '', savedPassword: '' } : undefined);
  return true;
}

/** 清空当前环境的历史账号与自动登录凭据，保留其他环境的历史。 */
export function clearSavedAccounts(): void {
  const config = getConfig();
  persistSavedAccounts(config.savedAccounts.filter((account) => account.serverBase !== config.serverBase), { savedLoginId: '', savedPassword: '' });
}
