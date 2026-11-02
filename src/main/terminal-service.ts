import { hostname, platform, release } from 'node:os';
import { connect, type MqttClient } from 'mqtt';
import { app } from 'electron';
import * as serverApi from './api';
import { saveTerminalId } from './config';
import type { SessionInfo } from '../shared/types';

/** 对齐 diteng-terminal（MqttUtils.pas）：心跳间隔 60s、MQTT keepalive 60s、断线 10s 自动重连 */
const HEARTBEAT_INTERVAL_MS = 60_000;
const REGISTER_RETRY_MS = 60_000;
const MQTT_RECONNECT_MS = 10_000;
/** 退出下线报文的等待上限：超过即直接断开，不长时间阻塞退出（漏发时服务端按心跳超时判离线） */
const STOP_PUBLISH_TIMEOUT_MS = 2_000;
/** 错误日志节流，避免 broker 不可达时刷屏 */
const ERROR_LOG_THROTTLE_MS = 60_000;
/** Electron 客户端在终端心跳里的应用标识（MQTT clientId 前缀与心跳 payload 的 app_id） */
const APP_ID = 'agent';

type TerminalSession = Pick<SessionInfo, 'serverBase' | 'machineCode' | 'token'>;

function operatingSystemName(): string {
  const name = platform() === 'darwin' ? 'macOS' : platform() === 'win32' ? 'Windows' : 'Linux';
  // getSystemVersion 为 Electron 主进程 API；脱离 Electron 的测试环境回落 os.release
  const version = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : release();
  return `${name} ${version}`;
}

/** 心跳 payload：对齐 diteng-terminal MqttUtils.sendHeartbeat 的六字段结构 */
function heartbeatPayload(status: number, terminalId: string, message: string): string {
  return JSON.stringify({
    status,
    app_id: APP_ID,
    version: app.getVersion(),
    terminal_id: terminalId,
    timestamp: Date.now(),
    message,
  });
}

function heartbeatTopic(terminalId: string): string {
  return `device/${terminalId}/status`;
}

/**
 * 设备级终端服务（与登录会话级的 HeartbeatService、通知用的 MqttService 相互独立）：
 * 登录成功后调 SvrTerminalGuest.register 注册终端，用下发的凭证连 MQTT
 * （mqtt://{mqtt_site}:{mqtt_port}，与未读通知的 WebSocket broker 入口不同），
 * 每 60s 向 device/{terminal_id}/status 发布 retained QoS1 心跳；重连成功补发 Online；
 * 登出/退出时发布 status=0 stop 后断开。注册依赖有效会话，未登录阶段不启动。
 */
export class TerminalService {
  private session: TerminalSession | null = null;
  private client: MqttClient | null = null;
  private broker = '';
  private terminalId = '';
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastErrorLoggedAt = 0;

  /** 登录/切账套后启动；serverBase+machineCode+token 相同则幂等跳过（含在途注册） */
  start(session: SessionInfo): void {
    const next: TerminalSession = {
      serverBase: session.serverBase, machineCode: session.machineCode, token: session.token,
    };
    const current = this.session;
    if (current && current.serverBase === next.serverBase && current.machineCode === next.machineCode
      && current.token === next.token) return;
    // 直接替换目标会话：在途注册回包检测到会话对象已变更即放弃，无需显式中止
    this.session = next;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    void this.register(next);
  }

  /** 系统唤醒后立即补发一次心跳（MQTT 重连成功本身也会补发 Online） */
  refresh(): void {
    this.publish(1, 'Refresh');
  }

  /** 登出/退出时调用：发布 status=0 stop（retained）后断开；幂等 */
  async stop(reason: string): Promise<void> {
    if (!this.session && !this.client && this.retryTimer === null && this.heartbeatTimer === null) return;
    this.session = null;
    this.broker = '';
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const client = this.client;
    this.client = null;
    const terminalId = this.terminalId;
    this.terminalId = '';
    if (!client) return;
    // 对齐 diteng-terminal 的下线流程：先发 stop 遗嘱报文再断开（未连接时跳过）
    if (client.connected && terminalId) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, STOP_PUBLISH_TIMEOUT_MS);
        try {
          client.publish(heartbeatTopic(terminalId), heartbeatPayload(0, terminalId, 'stop'), { qos: 1, retain: true },
            () => {
              clearTimeout(timeout);
              resolve();
            });
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      });
    }
    client.end(true);
    console.log(`[terminal] 终端心跳已停止（${reason}）`);
  }

  private async register(session: TerminalSession): Promise<void> {
    const result = await serverApi.registerTerminal(session.serverBase, session.token, session.machineCode, {
      computer: hostname(),
      operatingSystem: operatingSystemName(),
      version: app.getVersion(),
    });
    // 会话已切换或已停止：迟到的回包不得触碰新状态
    if (this.session !== session) return;
    if (!result.ok) {
      console.warn(`[terminal] 终端注册失败（code=${result.code}），稍后自动重试`);
      this.scheduleRegisterRetry();
      return;
    }
    const { terminalId, mqttHost, mqttPort, mqttUsername, mqttPassword } = result.data;
    this.terminalId = terminalId;
    saveTerminalId(terminalId);
    this.scheduleHeartbeat();
    // broker 未变（如切账套重注册）时复用现有连接，避免心跳中断
    const broker = `${mqttHost}:${mqttPort}`;
    if (this.client && this.broker === broker) {
      console.log(`[terminal] 终端注册成功，复用心跳连接（terminalId=${terminalId.slice(0, 8)}…）`);
      return;
    }
    console.log(`[terminal] 终端注册成功，连接 MQTT ${broker}（terminalId=${terminalId.slice(0, 8)}…）`);
    this.openMqtt(broker, session.machineCode, mqttUsername, mqttPassword);
  }

  private scheduleRegisterRetry(): void {
    if (this.retryTimer !== null) return;
    // start/stop 都会清理重试定时器，触发时 this.session 仍属于当初排队的会话
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const active = this.session;
      if (active) void this.register(active);
    }, REGISTER_RETRY_MS);
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    const tick = () => {
      this.heartbeatTimer = null;
      if (!this.session) return;
      // 未连接时跳过本拍（对齐 diteng-terminal 的 MOSQ_ERR_NO_CONN 处理），重连成功由 connect 补发
      this.publish(1, 'Refresh');
      this.heartbeatTimer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
    };
    this.heartbeatTimer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
  }

  private openMqtt(broker: string, machineCode: string, username: string, password: string): void {
    this.closeMqttClient();
    const client = connect(`mqtt://${broker}`, {
      protocolVersion: 4,
      keepalive: 60,
      reconnectPeriod: MQTT_RECONNECT_MS,
      connectTimeout: 30_000,
      clean: true,
      clientId: `${APP_ID}_${machineCode}`,
      username,
      password,
    });
    this.client = client;
    this.broker = broker;
    client.on('connect', () => {
      if (this.client !== client) return;
      console.log(`[terminal] 终端心跳已连接 ${broker}`);
      // 首连与断线自动重连成功都补发 Online（对齐 diteng-terminal doOnOnline）
      this.publish(1, 'Online');
    });
    client.on('error', (error) => {
      if (this.client !== client) return;
      const now = Date.now();
      if (now - this.lastErrorLoggedAt >= ERROR_LOG_THROTTLE_MS) {
        this.lastErrorLoggedAt = now;
        console.warn(`[terminal] 心跳连接异常，将按 10 秒间隔自动重试：${error.message}`);
      }
    });
  }

  private publish(status: number, message: string): void {
    const client = this.client;
    const terminalId = this.terminalId;
    if (!client || !terminalId || !client.connected) return;
    client.publish(heartbeatTopic(terminalId), heartbeatPayload(status, terminalId, message), { qos: 1, retain: true });
  }

  private closeMqttClient(): void {
    const client = this.client;
    this.client = null;
    this.broker = '';
    if (client) client.end(true);
  }
}
