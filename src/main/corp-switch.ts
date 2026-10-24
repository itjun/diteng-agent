import type { SessionInfo } from '../shared/types';

export interface CorpSwitchTarget {
  corpNo: string;
  userCode?: string;
  sourceWebContentsId: number | null;
}
export interface CorpSwitchTicket {
  id: number;
  generation: number;
  session: SessionInfo;
  target: CorpSwitchTarget;
  isSent: boolean;
  verificationToken?: string;
}
export type SwitchResult = { ok: true } | { ok: false; message: string };
export interface CorpSwitchHooks {
  getSession(): SessionInfo | null;
  confirm(target: CorpSwitchTarget): Promise<boolean>;
  isSourceAlive(source: number | null): boolean;
  verify(ticket: CorpSwitchTicket, token?: string): Promise<SessionInfo | null>;
  commit(session: SessionInfo, target: CorpSwitchTarget, generation: number): void;
  report(message: string): void;
  settled?(): void;
}

/** 单一切换事务：先确认放弃未保存内容，再让原请求发出；只以服务端身份核验提交。 */
export class CorpSwitchCoordinator {
  private sequence = 0;
  private generation = 0;
  private active: CorpSwitchTicket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isReconciling = false;
  private uncertain: CorpSwitchTicket | null = null;
  private idleWaiters = new Set<() => void>();

  constructor(private readonly hooks: CorpSwitchHooks, private readonly timeoutMs = 45_000) {}

  getGeneration(): number { return this.generation; }
  getActive(): CorpSwitchTicket | null { return this.active; }
  isBlocked(): boolean { return this.active !== null || this.uncertain !== null; }
  isUncertain(): boolean { return this.uncertain !== null; }

  waitForIdle(timeoutMs = 15_000): Promise<boolean> {
    if (!this.active) return Promise.resolve(!this.uncertain);
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.idleWaiters.delete(finish); resolve(!this.isBlocked()); };
      const timer = setTimeout(finish, timeoutMs);
      this.idleWaiters.add(finish);
    });
  }

  reset(): void {
    this.sequence += 1;
    this.generation += 1;
    this.active = null;
    this.uncertain = null;
    this.isReconciling = false;
    this.clearTimer();
    for (const finish of this.idleWaiters) finish();
  }

  async begin(target: CorpSwitchTarget): Promise<CorpSwitchTicket | null> {
    const session = this.hooks.getSession();
    if (!session || this.active || this.uncertain) return null;
    const ticket: CorpSwitchTicket = { id: ++this.sequence, generation: this.generation, session, target, isSent: false };
    this.active = ticket;
    this.timer = setTimeout(() => {
      if (this.active !== ticket) return;
      if (ticket.isSent) void this.complete(ticket);
      else this.release(ticket);
    }, this.timeoutMs);
    try {
      if (!await this.hooks.confirm(target)) { this.release(ticket); return null; }
      if (!this.isCurrent(ticket) || !this.hooks.isSourceAlive(target.sourceWebContentsId)) { this.release(ticket); return null; }
      return ticket;
    } catch (error) {
      this.hooks.report(error instanceof Error ? error.message : '切换准备失败');
      this.release(ticket);
      return null;
    }
  }

  markSent(ticket: CorpSwitchTicket): boolean {
    if (!this.isCurrent(ticket) || !this.hooks.isSourceAlive(ticket.target.sourceWebContentsId)) {
      this.release(ticket); return false;
    }
    ticket.isSent = true;
    return true;
  }

  /** 请求失败或发起页关闭仍核验：HTTP 失败并不证明 refreshUser 没有成功。 */
  async complete(ticket: CorpSwitchTicket, token?: string): Promise<SwitchResult> {
    if (!this.isCurrent(ticket)) return { ok: false, message: '切换已结束' };
    if (token) ticket.verificationToken = token;
    if (this.isReconciling) return { ok: false, message: '正在核验账套身份' };
    this.isReconciling = true;
    this.clearTimer();
    let verified: SessionInfo | null = null;
    try { verified = await this.hooks.verify(ticket, ticket.verificationToken); } catch { /* 进入身份待核验状态 */ }
    if (!this.isCurrent(ticket)) { this.isReconciling = false; return { ok: false, message: '会话已变化' }; }
    this.isReconciling = false;
    if (!verified || verified.userId !== ticket.session.userId || !verified.corpNo || !verified.userCode) {
      this.uncertain = ticket;
      this.release(ticket);
      const message = '账套切换结果暂时无法核验，已暂停网页请求。请检查网络后重试核验，或退出登录；不会继续使用可能已失效的身份。';
      this.hooks.report(message);
      return { ok: false, message };
    }
    const isChanged = verified.corpNo !== ticket.session.corpNo || verified.userCode !== ticket.session.userCode || verified.token !== ticket.session.token;
    const isTarget = verified.corpNo === ticket.target.corpNo && (!ticket.target.userCode || verified.userCode === ticket.target.userCode);
    this.release(ticket);
    if (!isTarget && !isChanged) return { ok: false, message: '服务端未切换账套，已保留当前页面' };
    if (!isTarget) {
      this.uncertain = ticket;
      this.hooks.report('服务端身份与请求目标不一致，已暂停网页请求，请重新核验或登录。');
      return { ok: false, message: '账套身份不一致' };
    }
    this.uncertain = null;
    this.generation += 1;
    this.hooks.commit(verified, ticket.target, this.generation);
    return { ok: true };
  }

  async retryVerification(): Promise<SwitchResult> {
    const ticket = this.uncertain;
    if (!ticket || this.active) return { ok: false, message: '没有待核验的切换' };
    this.uncertain = null;
    this.active = ticket;
    return this.complete(ticket);
  }

  sourceClosed(id: number): void {
    const ticket = this.active;
    if (!ticket || ticket.target.sourceWebContentsId !== id) return;
    if (ticket.isSent) void this.complete(ticket);
    else this.release(ticket);
  }

  private isCurrent(ticket: CorpSwitchTicket): boolean {
    return this.active === ticket && this.hooks.getSession() === ticket.session && this.generation === ticket.generation;
  }
  private release(ticket: CorpSwitchTicket): void {
    if (this.active !== ticket) return;
    this.active = null;
    this.clearTimer();
    queueMicrotask(() => { for (const finish of this.idleWaiters) finish(); if (!this.isBlocked()) this.hooks.settled?.(); });
  }
  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
