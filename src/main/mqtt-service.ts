import { Notification } from 'electron';
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
  openMessageCenter: () => void;
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
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private lastErrorLoggedAt = 0;
  private unread = -1;
  private lastNotification: MqttState['lastNotification'] = null;
  private lastPopupTitle: string | null = null;

  constructor(hooks: MqttServiceHooks) {
    this.hooks = hooks;
  }

  getState(): MqttState {
    return {
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
    if (this.client && topic === this.topic) return;
    this.stop('restart');
    this.topic = topic;
    const config = await serverApi.getMqttConfig(session.serverBase, session.corpNo, session.token, session.machineCode);
    if (!config.ok) {
      console.warn(`[mqtt] mqttConfig 获取失败，未读通知停用：${config.message}`);
      this.topic = '';
      this.pushState();
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
    this.isConnected = false;
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
  async refreshUnread(): Promise<void> {
    const session = this.hooks.readSession();
    if (!session) return;
    const result = await serverApi.getUnreadMessage(
      session.serverBase,
      session.corpNo,
      session.token,
      session.machineCode,
      session.userId,
    );
    if (!result.ok) {
      console.warn(`[mqtt] 未读数拉取失败：${result.message}`);
      return;
    }
    this.setUnread(result.data);
  }

  /** 记录置顶弹窗已触发（ImportantNotifier 弹窗后回调，进状态供 e2e 断言） */
  reportPopupShown(title: string): void {
    this.lastPopupTitle = title;
    this.pushState();
  }

  private setUnread(count: number): void {
    if (this.unread === count) return;
    this.unread = count;
    this.hooks.onUnreadChange(count);
    this.pushState();
  }

  /** 连接参数对齐 im-client message-mqtt-client.ts / ERP UIMqttConnect：v5、keepalive 60、clean、clientId 加时间戳后缀 */
  private open(): void {
    const generation = ++this.generation;
    const client = connect(this.broker, {
      protocolVersion: 5,
      keepalive: 60,
      reconnectPeriod: 0,
      connectTimeout: 30_000,
      clean: true,
      clientId: `${this.hooks.readSession()?.machineCode ?? 'agent'}_${Date.now()}`,
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
          this.scheduleReconnect();
        } else {
          this.isConnected = true;
          this.pushState();
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
    // 先记录再展示：e2e 断言"已调用通知"这一内部事件，不依赖系统授权弹窗
    this.lastNotification = {
      title: payload.senderName || '帝擎消息',
      body: toPlainExcerpt(payload.subject || payload.content) || '您有一条新的未读消息',
      at: Date.now(),
    };
    this.pushState();
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: this.lastNotification.title,
        body: this.lastNotification.body,
      });
      notification.on('click', () => this.hooks.openMessageCenter());
      notification.show();
    } else {
      // 系统通知不可用（授权被拒/平台不支持）时降级：普通消息仅剩角标变化，重要消息仍有置顶弹窗
      console.log('[mqtt] 系统通知不可用，仅更新未读角标');
    }
    console.log(`[mqtt] 未读通知已触发：${this.lastNotification.title} - ${this.lastNotification.body.slice(0, 40)}`);
    this.hooks.onMessage(payload);
    // 消息本体不含全量未读数，REST 校准（与 ERP 端 refreshMessageBadge 口径一致）
    void this.refreshUnread();
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
