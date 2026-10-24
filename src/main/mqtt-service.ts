import { Notification } from 'electron';
import { NotificationStore } from './notification-store';
import { connect, type MqttClient } from 'mqtt';
import * as serverApi from './api';
import type { MqttState, SessionInfo } from '../shared/types';

/** 断线重连退避：1s 起、每次翻倍、封顶 30s（对齐 im-client message-mqtt-client.ts） */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** 错误日志节流，避免 broker 不可达时刷屏 */
const ERROR_LOG_THROTTLE_MS = 60_000;
/** 通知正文最大长度，超长截断 */
const BODY_MAX_LENGTH = 120;

/**
 * {userId}/unreadMessage 的 payload：服务端 MessageUtils.publishUnreadMessage 把
 * S_UserMessage 的 DataRow 直接 json() 发布（字段名 = 实体属性的 CamelCase 形态，
 * 如 corp_no_ → CorpNo_），仅在发送前补 AppUserName_/ToUserName_ 两个展示名。
 * 这里只取通知链路需要的字段，其余原样保留在 raw。
 */
export interface UnreadMessagePayload {
  /** 消息 UID（S_UserMessage.uid_） */
  uid: string;
  /** 消息所属账套（CorpNo_） */
  corpNo: string;
  /** 接收子账号代码（UserCode_） */
  userCode: string;
  /** 消息等级（Level_，MessageLevel 序数：0 通用/1 重要/2 紧急/3 日志） */
  level: number;
  /** 摘要（Subject_），可能为空 */
  subject: string;
  /** 正文（Content_），可能为 HTML */
  content: string;
  /** 发送人展示名（AppUserName_，缺省回退 AppUser_ 代码） */
  senderName: string;
  /** 发送时间（AppDate_ 字符串形态） */
  sendTime: string;
}

function readPayloadString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 解析 unreadMessage payload；缺 UID/Subject/Content 关键字段的坏消息返回 null（不上通知） */
export function parseUnreadPayload(raw: Record<string, unknown>): UnreadMessagePayload | null {
  const uid = readPayloadString(raw, 'UID_');
  const subject = readPayloadString(raw, 'Subject_');
  const content = readPayloadString(raw, 'Content_');
  if (!uid && !subject && !content) return null;
  const level = Number(raw.Level_);
  return {
    uid,
    corpNo: readPayloadString(raw, 'CorpNo_'),
    userCode: readPayloadString(raw, 'UserCode_'),
    level: Number.isFinite(level) ? level : 0,
    subject,
    content,
    senderName: readPayloadString(raw, 'AppUserName_') || readPayloadString(raw, 'AppUser_'),
    sendTime: readPayloadString(raw, 'AppDate_'),
  };
}

/** 去掉正文里的 HTML 标签与多余空白，作通知/弹窗文案；超长截断 */
export function toPlainExcerpt(text: string): string {
  const plain = text
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > BODY_MAX_LENGTH ? `${plain.slice(0, BODY_MAX_LENGTH)}…` : plain;
}

/** MqttService 对外部（托盘角标、置顶弹窗、打开消息中心）的依赖注入 */
export interface MqttServiceHooks {
  /** 会话读取（拉未读用最新 token） */
  readSession: () => SessionInfo | null;
  /** 未读总数变化（连接成功、每条消息后、手动刷新后回调），驱动托盘角标 */
  onUnreadChange: (count: number) => void;
  /** 收到一条消息（已通过关键字段校验），驱动重要消息置顶弹窗 */
  onMessage: (payload: UnreadMessagePayload) => void;
  /** 用户点击通知/弹窗：聚焦主窗并打开消息中心标签 */
  openMessageCenter: (payload: UnreadMessagePayload) => Promise<boolean>;
  readPreferences: () => { systemNotifications: boolean; importantPopups: boolean };
  getStoreDirectory: () => string;
  isAuthorized: (payload: UnreadMessagePayload) => boolean;
  corpName: (corpNo: string) => string;
  onRestorePending: (items: UnreadMessagePayload[]) => void;
  /** 状态变化广播（renderer 经 mqtt:changed 收到同一结构） */
  onStateChanged: (state: MqttState) => void;
}

/**
 * 主进程常驻 MQTT 客户端：登录成功后连接 broker、订阅 {主账号ID}/unreadMessage，
 * 收到消息 → 系统通知 + 重要消息置顶弹窗 + REST 拉未读总数刷托盘角标。
 * 协议结论（源码依据见各方法注释）：topic 的 userId 即登录返回的 LoginResult.userId
 * （主账号 ID，S_UserInfo.id_ / AccountEntity.accountId，新账号为 GUID、老账号为 9 位数字）；
 * 与账套无关，切换账套无需重连重订阅，只需用新 token 重新拉取未读。
 */
export class MqttService {
  private readonly hooks: MqttServiceHooks;
  private client: MqttClient | null = null;
  private broker = '';
  private username = '';
  private password = '';
  private topic = '';
  private isConnected = false;
  private connectionStatus: MqttState['connectionStatus'] = 'idle';
  private unreadUpdatedAt: number | null = null;
  private isUnreadError = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private lastErrorLoggedAt = 0;
  private unread = -1;
  private lastNotification: MqttState['lastNotification'] = null;
  private lastPopupTitle: string | null = null;
  private store: NotificationStore | null = null;
  private scope = '';
  private isRecovering = false;
  private unreadRefresh: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly notifications = new Set<Notification>();

  constructor(hooks: MqttServiceHooks) {
    this.hooks = hooks;
  }

  getState(): MqttState {
    return {
      connectionStatus: this.connectionStatus,
      unreadUpdatedAt: this.unreadUpdatedAt,
      unreadError: this.isUnreadError,
      systemNotificationSupported: Notification.isSupported(),
      connected: this.isConnected,
      topic: this.topic,
      unread: this.unread,
      lastNotification: this.lastNotification,
      lastPopupTitle: this.lastPopupTitle,
    };
  }

  /** 登录成功后启动：拉 mqttConfig → 连接 → 订阅；重复调用幂等（已连且 topic 未变时跳过） */
  async start(session: SessionInfo): Promise<void> {
    const topic = `${session.userId}/unreadMessage`;
    if (this.client && topic === this.topic && this.scope === `${session.serverBase}\n${session.userId}`) return;
    this.stop('restart');
    if (!session.userId) return;
    this.topic = topic;
    this.connectionStatus = 'connecting';
    this.pushState();
    this.scope = `${session.serverBase}
${session.userId}`;
    this.store = new NotificationStore(this.hooks.getStoreDirectory(), this.scope);
    this.hooks.onRestorePending(this.store.getPending().filter(this.hooks.isAuthorized));
    // HTTP 补查独立于 broker 配置/连接，离线登录后仍能在网络恢复时补回消息。
    this.pollTimer = setInterval(() => { void this.refreshUnread(); void this.recoverUnread(); }, 30_000);
    void this.refreshUnread();
    void this.recoverUnread();
    const generation = this.generation;
    const config = await serverApi.getMqttConfig(session.serverBase, session.corpNo, session.token, session.machineCode);
    if (this.generation !== generation || this.hooks.readSession()?.userId !== session.userId) return;
    if (!config.ok) {
      console.warn(`[mqtt] mqttConfig 获取失败，未读通知停用：${config.message}`);
      this.topic = '';
      this.connectionStatus = 'unavailable';
      this.pushState();
      return;
    }
    if (!config.data.broker) {
      this.connectionStatus = 'unavailable';
      this.pushState();
      void this.refreshUnread();
      return;
    }
    this.broker = config.data.broker;
    this.username = config.data.username;
    this.password = config.data.password;
    this.open();
    // 连接建立后拉一次未读基线（open 的 connect 回调里也会触发）
    void this.refreshUnread();
  }

  /** 断开并复位；登出/退出时调用 */
  stop(reason: string): void {
    this.generation += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.isRecovering = false;
    this.unreadRefresh = null;
    for (const notification of this.notifications) notification.close();
    this.notifications.clear();
    this.store = null;
    this.scope = '';
    this.unread = -1;
    this.unreadUpdatedAt = null;
    this.isUnreadError = false;
    this.lastNotification = null;
    this.lastPopupTitle = null;
    this.isConnected = false;
    this.connectionStatus = 'idle';
    this.topic = '';
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) client.end(true);
    if (reason !== 'silent') console.log(`[mqtt] 已断开（${reason}）`);
    this.pushState();
  }

  /**
   * REST 拉取未读总数并广播（登录/收到消息/切换账套后调用）。
   * 切换账套只换 token：topic 按主账号订阅与账套无关，无需重连。
   */
  refreshUnread(): Promise<void> {
    if (this.unreadRefresh) return this.unreadRefresh;
    const pending = this.readUnread();
    this.unreadRefresh = pending;
    void pending.finally(() => { if (this.unreadRefresh === pending) this.unreadRefresh = null; });
    return pending;
  }

  private async readUnread(): Promise<void> {
    const session = this.hooks.readSession();
    if (!session) return;
    const generation = this.generation;
    const result = await serverApi.getUnreadMessage(
      session.serverBase,
      session.corpNo,
      session.token,
      session.machineCode,
      session.userId,
    );
    if (generation !== this.generation) return;
    if (this.hooks.readSession() !== session) return;
    if (!result.ok) {
      console.warn(`[mqtt] 未读数拉取失败：${result.message}`);
      this.isUnreadError = true;
      this.pushState();
      return;
    }
    this.isUnreadError = false;
    this.unreadUpdatedAt = Date.now();
    this.setUnread(result.data);
  }

  dismiss(uid: string): void { this.store?.dismiss(uid); }

  /** 断网与重启补查：普通历史消息静默，紧急消息进入同一持久队列，最多20页一轮。 */
  async recoverUnread(): Promise<void> {
    const session = this.hooks.readSession();
    const store = this.store;
    if (!session || !store || this.isRecovering) return;
    this.isRecovering = true;
    const generation = this.generation;
    try {
      let cursor = '';
      const resume = store.getCursor();
      for (let page = 0; page < 20; page += 1) {
        const result = await serverApi.getDesktopNotifications(session, cursor);
        if (generation !== this.generation || this.hooks.readSession() !== session) return;
        if (!result.ok) {
          console.warn(`[mqtt] 通知补查失败：${result.message}`);
          return;
        }
        for (const payload of result.data.items) this.deliver(payload, true);
        const next = result.data.nextCursor;
        if (!next) { store.checkpoint(''); return; }
        // 恢复时先看第一页的新消息，再继续上次中断的历史扫描。
        cursor = page === 0 && resume ? resume : next;
        store.checkpoint(cursor);
      }
    } catch {
      console.warn('[mqtt] 通知补查或本地保存未完成，将在下次轮询重试');
    } finally { if (generation === this.generation) this.isRecovering = false; }
  }

  /** 记录置顶弹窗已触发（ImportantNotifier 弹窗后回调，进状态供 e2e 断言） */
  reportPopupShown(title: string): void {
    this.lastPopupTitle = title;
    this.pushState();
  }

  private setUnread(count: number): void {
    const isChanged = this.unread !== count;
    this.unread = count;
    if (isChanged) this.hooks.onUnreadChange(count);
    this.pushState();
  }

  /** 连接参数对齐 im-client message-mqtt-client.ts / ERP UIMqttConnect：v5、keepalive 60、clean、clientId 加时间戳后缀 */
  private open(): void {
    const generation = ++this.generation;
    this.unreadRefresh = null;
    this.isRecovering = false;
    this.connectionStatus = 'connecting';
    this.pushState();
    const client = connect(this.broker, {
      protocolVersion: 5,
      keepalive: 60,
      reconnectPeriod: 0,
      connectTimeout: 30_000,
      clean: true,
      clientId: `diteng-agent-${this.hooks.readSession()?.machineCode ?? 'desktop'}-${Date.now()}`,
      username: this.username,
      password: this.password,
    });
    this.client = client;
    const isCurrent = () => this.client === client && this.generation === generation;

    client.on('connect', () => {
      if (!isCurrent()) return;
      this.reconnectAttempt = 0;
      console.log(`[mqtt] 已连接 ${this.broker}，订阅 ${this.topic}`);
      // QoS 0：与 ERP 端 initMessageMqtt 一致，未读状态由 REST 校准兜底。
      // connected 在订阅成功（SUBACK）后才置位：保证外部看到的 connected=true 即已可收消息
      client.subscribe(this.topic, { qos: 0 }, (error) => {
        if (!isCurrent()) return;
        if (error) {
          console.warn(`[mqtt] 订阅失败：${error.message}`);
          this.isConnected = false;
          this.connectionStatus = 'reconnecting';
          this.pushState();
          this.scheduleReconnect();
        } else {
          this.isConnected = true;
          this.connectionStatus = 'connected';
          this.pushState();
          void this.refreshUnread();
          void this.recoverUnread();
        }
      });
    });
    client.on('message', (topic, body) => {
      if (!isCurrent() || topic !== this.topic) return;
      this.handleMessage(body.toString('utf8'));
    });
    client.on('error', (error) => {
      if (!isCurrent()) return;
      const now = Date.now();
      if (now - this.lastErrorLoggedAt >= ERROR_LOG_THROTTLE_MS) {
        this.lastErrorLoggedAt = now;
        console.warn(`[mqtt] 连接异常，将按退避重试：${error.message}`);
      }
    });
    client.on('close', () => {
      if (!isCurrent()) return;
      this.client = null;
      this.isConnected = false;
      this.connectionStatus = 'reconnecting';
      this.pushState();
      this.scheduleReconnect();
    });
  }

  /** 收到 unreadMessage：解析 payload → 系统通知（+置顶弹窗钩子）→ REST 校准未读 */
  private handleMessage(text: string): void {
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      raw = parsed as Record<string, unknown>;
    } catch {
      console.warn('[mqtt] unreadMessage payload 非合法 JSON，已忽略');
      return;
    }
    const payload = parseUnreadPayload(raw);
    if (!payload) {
      console.warn('[mqtt] unreadMessage payload 缺少关键字段，已忽略');
      return;
    }
    this.deliver(payload, false);
    void this.refreshUnread();
  }

  private deliver(payload: UnreadMessagePayload, isRecovery: boolean): void {
    const store = this.store;
    if (!payload.uid || !store || !this.hooks.isAuthorized(payload)) return;
    const preferences = this.hooks.readPreferences();
    try { if (!store.accept(payload, preferences.importantPopups)) return; }
    catch { console.warn('[mqtt] 通知本地保存失败，未占用去重标记，等待补查重试'); return; }
    if (preferences.importantPopups && payload.level === 2) this.hooks.onMessage(payload);
    // 历史积压不逐条轰炸系统通知；紧急消息仍在一个窗口排队，关闭不会标为业务已读。
    if (isRecovery || !preferences.systemNotifications) return;
    const corpName = this.hooks.corpName(payload.corpNo) || payload.corpNo;
    this.lastNotification = {
      title: `${corpName} · ${payload.senderName || '帝擎消息'}`,
      body: toPlainExcerpt(payload.subject || payload.content) || '您有一条新的未读消息',
      at: Date.now(),
    };
    this.pushState();
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: this.lastNotification.title, body: this.lastNotification.body });
    this.notifications.add(notification);
    notification.on('click', () => { void this.hooks.openMessageCenter(payload); });
    notification.on('close', () => this.notifications.delete(notification));
    notification.on('failed', () => this.notifications.delete(notification));
    notification.show(); // 仅表示调用通知API；系统权限/专注模式仍可阻止实际展示。
  }

  /** 断线退避重连：1s 起指数退避 + 少量抖动，封顶 30s */
  private scheduleReconnect(): void {
    if (this.client || this.reconnectTimer !== null || !this.topic) return;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    const delay = base + Math.floor(Math.random() * Math.min(1_000, base / 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private pushState(): void {
    this.hooks.onStateChanged(this.getState());
  }
}
