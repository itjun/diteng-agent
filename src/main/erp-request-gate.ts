import { session as electronSession, webContents, type WebContents } from 'electron';
import type { CorpAccount, SessionInfo } from '../shared/types';
import type { CorpSwitchCoordinator, CorpSwitchTicket, CorpSwitchTarget } from './corp-switch';
import { classifyUrl, readErpCorpNo, withSessionParams } from './url-policy';

interface GuestBinding { generation: number; corpNo: string; }
export interface ErpRequestGateHooks {
  coordinator: CorpSwitchCoordinator;
  getSession(): SessionInfo | null;
  getCorps(): CorpAccount[];
  aiBase(): string;
  getOwner(): WebContents | null;
  switchTo(target: CorpSwitchTarget): Promise<boolean>;
  verifyNavigation(target: CorpSwitchTarget, token: string): Promise<boolean>;
}

/** 最终安全边界在请求前；兼容补丁仅禁止旧网页广播抢先关闭其它标签。 */
export class ErpRequestGate {
  private readonly guests = new Map<number, GuestBinding>();
  private readonly requests = new Map<number, CorpSwitchTicket>();
  private activeGuest: number | null = null;
  private readonly exchangeRequests = new Set<number>();

  constructor(private readonly hooks: ErpRequestGateHooks) {}

  register(contents: WebContents): void {
    const session = this.hooks.getSession();
    if (!session || contents.hostWebContents !== this.hooks.getOwner()) return;
    this.guests.set(contents.id, { generation: this.hooks.coordinator.getGeneration(), corpNo: session.corpNo });
    contents.on('dom-ready', () => {
      if (!this.isTrusted(contents)) return;
      if (classifyUrl(contents.getURL(), this.hooks.getSession(), this.hooks.aiBase()) !== 'same-server') return;
      // 不暴露 IPC/密钥/Node。defineProperty 防止旧脚本重新写回广播函数。
      void contents.executeJavaScript(`(() => { try { Object.defineProperty(window, 'sendAccountChannel', { value: function () {}, writable: false, configurable: false }); } catch {} })()`).catch(() => {});
    });
    contents.once('destroyed', () => {
      this.guests.delete(contents.id);
      if (this.activeGuest === contents.id) this.activeGuest = null;
      this.hooks.coordinator.sourceClosed(contents.id);
    });
  }

  isTrusted(contents: WebContents): boolean {
    return !contents.isDestroyed() && this.guests.has(contents.id) && contents.hostWebContents === this.hooks.getOwner();
  }

  setActive(id: number | null): void {
    if (id === null) { this.activeGuest = null; return; }
    const contents = webContents.fromId(id);
    if (contents && this.isTrusted(contents)) this.activeGuest = id;
  }

  getActive(): WebContents | null {
    if (this.activeGuest === null || this.hooks.coordinator.isBlocked()) return null;
    const contents = webContents.fromId(this.activeGuest);
    const binding = this.guests.get(this.activeGuest);
    return contents && this.isTrusted(contents) && binding?.generation === this.hooks.coordinator.getGeneration() ? contents : null;
  }

  commit(sourceId: number | null, session: SessionInfo, generation: number): void {
    if (sourceId !== null && this.guests.has(sourceId)) this.guests.set(sourceId, { generation, corpNo: session.corpNo });
    // 其余 guest 保留旧 generation；即使 renderer 延迟处理关闭事件，也不能再发业务请求。
  }

  reset(): void { this.guests.clear(); this.requests.clear(); this.exchangeRequests.clear(); this.activeGuest = null; }

  refreshCredentials(session: SessionInfo): void {
    for (const [id, binding] of this.guests) {
      const contents = webContents.fromId(id);
      if (!contents || !this.isTrusted(contents) || binding.corpNo !== session.corpNo || binding.generation !== this.hooks.coordinator.getGeneration()) continue;
      const url = contents.getURL();
      if (classifyUrl(url, session, this.hooks.aiBase()) !== 'same-server') continue;
      const parsed = new URL(url);
      parsed.searchParams.set('sid', session.token);
      parsed.searchParams.set('CLIENTID', session.machineCode);
      void contents.loadURL(parsed.toString()).catch(() => {});
    }
  }

  install(): void {
    const request = electronSession.defaultSession.webRequest;
    request.onBeforeRequest((details, callback) => {
      const contents = details.webContentsId ? webContents.fromId(details.webContentsId) : null;
      if (!contents || !this.isTrusted(contents)) { callback({ cancel: false }); return; }
      let isAnswered = false;
      const timer = setTimeout(() => answer({ cancel: true }), 46_000);
      const answer = (response: Electron.CallbackResponse) => {
        if (isAnswered) return;
        isAnswered = true;
        clearTimeout(timer);
        callback(response);
      };
      void this.beforeRequest(contents, details).then(answer, () => answer({ cancel: true }));
    });
    request.onBeforeSendHeaders((details, callback) => {
      const binding = this.guests.get(details.webContentsId ?? -1);
      if (binding && classifyUrl(details.url, this.hooks.getSession(), this.hooks.aiBase()) === 'same-server') {
        details.requestHeaders['X-Diteng-Expected-Corp-No'] = binding.corpNo;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    const completed = (id: number, redirectUrl?: string, isError = false) => {
      const ticket = this.requests.get(id);
      if (!ticket) return;
      this.requests.delete(id);
      const isExchange = this.exchangeRequests.delete(id);
      // 换票响应的 token 由原网页消费；成功后等待其目标导航再核验，不重发该请求。
      if (isExchange && !isError && !redirectUrl) return;
      let token: string | undefined;
      if (redirectUrl) {
        try { token = new URL(redirectUrl).searchParams.get('sid') || undefined; } catch { /* 核验原 token */ }
      }
      void this.hooks.coordinator.complete(ticket, token);
    };
    request.onCompleted((details) => completed(details.id));
    request.onErrorOccurred((details) => completed(details.id, undefined, true));
    request.onBeforeRedirect((details) => completed(details.id, details.redirectURL));
  }

  private async beforeRequest(contents: WebContents, details: Electron.OnBeforeRequestListenerDetails): Promise<Electron.CallbackResponse> {
    const session = this.hooks.getSession();
    if (!session) return { cancel: true };
    if (details.method === 'OPTIONS') return { cancel: false };
    if (classifyUrl(details.url, session, this.hooks.aiBase()) !== 'same-server') return { cancel: false };
    const coordinator = this.hooks.coordinator;
    const binding = this.guests.get(contents.id);
    if (!binding || binding.generation !== coordinator.getGeneration()) return { cancel: true };
    const parsed = new URL(details.url);
    const isExchange = /\/services\/SvrTerminal\.getNuewToken$/.test(parsed.pathname);
    const isSwitch = /\/TFrmChooseAccount\.(switchUser|enterSystem)$/.test(parsed.pathname) || isExchange;
    if (isSwitch) {
      const params = new URLSearchParams(parsed.search);
      for (const part of details.uploadData || []) {
        if (part.bytes) new URLSearchParams(part.bytes.toString('utf8')).forEach((value, key) => params.set(key, value));
      }
      let targetCorp = '';
      if (isExchange) {
        try { targetCorp = String(JSON.parse(params.get('dataIn') || '{}').head?.target_book || ''); } catch { return { cancel: true }; }
      }
      const target = this.hooks.getCorps().find((corp) => isExchange ? corp.corpNo === targetCorp : corp.code === params.get('code'));
      if (!target) return { cancel: true };
      const ticket = await coordinator.begin({ corpNo: target.corpNo, userCode: target.code, sourceWebContentsId: contents.id });
      if (!ticket || !coordinator.markSent(ticket)) return { cancel: true };
      this.requests.set(details.id, ticket);
      if (isExchange) this.exchangeRequests.add(details.id);
      return { cancel: false };
    }
    const active = coordinator.getActive();
    if (active && active.target.sourceWebContentsId === contents.id && details.resourceType === 'mainFrame'
      && readErpCorpNo(details.url) === active.target.corpNo && parsed.searchParams.get('sid')) {
      await coordinator.complete(active, parsed.searchParams.get('sid')!);
    }
    if (coordinator.getActive()) {
      if (coordinator.getActive()?.target.sourceWebContentsId !== contents.id) return { cancel: true };
      if (!await coordinator.waitForIdle()) return { cancel: true };
    }
    if (coordinator.isUncertain() || !this.isTrusted(contents)) return { cancel: true };
    if (this.guests.get(contents.id)?.generation !== coordinator.getGeneration()) return { cancel: true };
    const urlCorpNo = readErpCorpNo(details.url);
    const current = this.hooks.getSession();
    if (!current) return { cancel: true };
    const sid = parsed.searchParams.get('sid');
    if (details.resourceType === 'mainFrame' && sid && sid !== current.token && urlCorpNo && urlCorpNo !== '000000') {
      const target = this.hooks.getCorps().find((corp) => corp.corpNo === urlCorpNo);
      if (!target || !await this.hooks.verifyNavigation({ corpNo: target.corpNo, userCode: target.code, sourceWebContentsId: contents.id }, sid)) return { cancel: true };
      return { cancel: false };
    }
    // 静态资源/000000选择页不是换账套；只有顶层导航跨账套才进入换票事务。
    if (details.resourceType === 'mainFrame' && urlCorpNo && urlCorpNo !== '000000' && urlCorpNo !== current.corpNo && !/\/(TFrmChooseAccount|.*Login|.*Logout)/.test(parsed.pathname)) {
      const target = this.hooks.getCorps().find((corp) => corp.corpNo === urlCorpNo);
      if (!target || !await this.hooks.switchTo({ corpNo: target.corpNo, userCode: target.code, sourceWebContentsId: contents.id })) return { cancel: true };
      const updated = this.hooks.getSession();
      if (!updated || !this.isTrusted(contents)) return { cancel: true };
      parsed.searchParams.delete('sid');
      parsed.searchParams.delete('CLIENTID');
      return { redirectURL: withSessionParams(parsed.toString(), updated, this.hooks.aiBase()) };
    }
    return { cancel: false };
  }
}
