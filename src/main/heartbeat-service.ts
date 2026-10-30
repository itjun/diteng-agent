import * as serverApi from './api';
import type { SessionInfo } from '../shared/types';

const HEARTBEAT_INTERVAL_MS = 15_000;
type HeartbeatSession = Pick<SessionInfo, 'serverBase' | 'machineCode' | 'token' | 'rootToken'>;

/** 主进程负责续期，网页关闭、最小化或隐藏到托盘都不影响心跳。 */
export class HeartbeatService {
  private session: HeartbeatSession | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private lastFailure = '';

  start(session: SessionInfo): void {
    const next: HeartbeatSession = {
      serverBase: session.serverBase, machineCode: session.machineCode,
      token: session.token, rootToken: session.rootToken || session.token,
    };
    const current = this.session;
    if (current && current.serverBase === next.serverBase && current.machineCode === next.machineCode
      && current.token === next.token && current.rootToken === next.rootToken) return;
    this.stop();
    this.session = next;
    void this.refresh();
  }

  stop(): void {
    this.session = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.lastFailure = '';
  }

  /** 唤醒后立即补发；定时触发与唤醒重合时复用在途请求，不叠加请求。 */
  async refresh(): Promise<void> {
    const session = this.session;
    if (!session || this.controller) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const controller = new AbortController();
    this.controller = controller;
    const failures: string[] = [];
    try {
      // 原始 sid 供切账套换票使用；和当前 sid 相同时只发一次。
      const tokens = [...new Set([session.rootToken, session.token])];
      for (const token of tokens) {
        const result = await serverApi.heartbeat(session.serverBase, token, session.machineCode, controller.signal);
        if (this.controller !== controller) return;
        // 只记状态码，服务端文案和异常信息可能带有会话凭据。
        if (!result.ok) failures.push(`${token === session.token ? '当前会话' : '原始会话'}=${result.code}`);
      }
    } catch {
      failures.push('请求异常');
    } finally {
      // 旧会话的回包不得修改新会话状态，也不能在退出后重新启动定时器。
      if (this.controller === controller) {
        this.controller = null;
        const failure = failures.join(', ');
        if (failure && failure !== this.lastFailure) console.warn(`[heartbeat] 心跳失败，将自动重试（${failure}）`);
        else if (!failure && this.lastFailure) console.log('[heartbeat] 心跳已恢复');
        this.lastFailure = failure;
        this.timer = setTimeout(() => { void this.refresh(); }, HEARTBEAT_INTERVAL_MS);
      }
    }
  }
}
