import type { CorpAccount, SessionInfo, SessionSummary } from '../shared/types';

/**
 * 登录会话仅存主进程内存（token 不落盘、不下发 renderer）。
 * corpList 为 listMyLivingUsers 的主进程缓存（登录时清空、首次切换器打开时拉取）。
 */
let currentSession: SessionInfo | null = null;
let corpList: CorpAccount[] = [];

/** 登录/切换成功时写入会话 */
export function saveSession(session: SessionInfo): void {
  currentSession = session;
}

export function getSession(): SessionInfo | null {
  return currentSession;
}

/** renderer 展示用摘要（不含 token / rootToken / machineCode） */
export function getSessionSummary(): SessionSummary | null {
  if (!currentSession) return null;
  return {
    serverBase: currentSession.serverBase,
    userId: currentSession.userId,
    corpNo: currentSession.corpNo,
    homeForm: currentSession.homeForm,
    userName: currentSession.userName,
    userCode: currentSession.userCode,
  };
}

/** 缓存当前主账号可用账套列表 */
export function saveCorpList(list: CorpAccount[]): void {
  corpList = list;
}

export function getCorpList(): CorpAccount[] {
  return corpList;
}

/** 退出登录时清空（预留） */
export function clearSession(): void {
  currentSession = null;
  corpList = [];
}
