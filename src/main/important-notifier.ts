import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { UnreadMessagePayload } from './mqtt-service';

/** 弹窗尺寸与停留时长（产品约定：360x120 右下角、8 秒无操作自动关） */
const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 120;
const AUTO_CLOSE_MS = 8_000;

/**
 * 消息等级阈值：S_UserMessage.Level_ 对应 summer-core
 * cn.cerc.mis.message.MessageLevel 的 ordinal —— 0 General 通用 / 1 Forever 重要（首页滚动展示）/
 * 2 Grave 紧急（服务端注释即"需要弹窗提示"，按 3 年保存）/ 3 Logger 日志。
 * 当前判定 Level_ >= 2（Grave 紧急）才弹置顶窗；1（Forever）在 ERP 首页滚动展示，客户端不弹。
 * 若后续业务调整分级，只需改这一个函数。
 */
export function isImportantMessage(payload: UnreadMessagePayload): boolean {
  return payload.level >= 2;
}

/** ImportantNotifier 依赖注入 */
export interface ImportantNotifierHooks {
  /** dev/prod 入口判定与加载（与主窗一致的 isDevMode + loadURL/loadFile 逻辑） */
  loadEntry: (window: BrowserWindow) => void;
  /** 弹窗定位参考窗口（主窗）；可能已关闭，返回 null 时用主显示器 */
  getOwnerWindow: () => BrowserWindow | null;
  /** 点击弹窗主体：聚焦主窗并打开消息中心 */
  openMessageCenter: () => void;
  /** 弹窗实际创建后回调（记录进 MqttState 供 e2e 断言） */
  onShown: (title: string) => void;
}

/**
 * 重要（紧急）消息置顶弹窗：同一时刻最多一个，新消息顶掉旧窗。
 * 窗口：无边框、alwaysOnTop、skipTaskbar，右下角定位；页面加载壳入口 #/notify-popup，
 * hover 暂停自动关闭、移开后重新计时；点击主体打开消息中心，右上角关闭按钮仅关弹窗。
 */
export class ImportantNotifier {
  private readonly hooks: ImportantNotifierHooks;
  private popup: BrowserWindow | null = null;
  private autoCloseTimer: NodeJS.Timeout | null = null;
  private payload: UnreadMessagePayload | null = null;

  constructor(hooks: ImportantNotifierHooks) {
    this.hooks = hooks;
  }

  /** 命中 isImportantMessage 时弹窗；不满足级别静默返回 */
  show(payload: UnreadMessagePayload): void {
    if (!isImportantMessage(payload)) return;
    this.close('replace');
    this.payload = payload;

    const popup = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      // 透明底 + 页面卡片 radius 12：无边框小窗四角真正圆角（macOS/Windows 均可）
      transparent: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: join(__dirname, '../preload/index.js'),
      },
    });
    // floating 层级：悬浮在普通窗口之上，不抢占全屏应用
    popup.setAlwaysOnTop(true, 'floating');
    this.popup = popup;

    // 右下角定位：优先主窗所在显示器（隐藏到托盘时保留原位置），其次主显示器；
    // 工作区（排除任务栏/Dock）右下角留 16px 边距
    const owner = this.hooks.getOwnerWindow();
    const display = owner && !owner.isDestroyed()
      ? screen.getDisplayMatching(owner.getNormalBounds())
      : screen.getPrimaryDisplay();
    const area = display.workArea;
    popup.setPosition(
      Math.round(area.x + area.width - POPUP_WIDTH - 16),
      Math.round(area.y + area.height - POPUP_HEIGHT - 16),
    );

    popup.once('ready-to-show', () => {
      if (popup.isDestroyed()) return;
      // 不抢焦点，仅浮层展示
      popup.showInactive();
      this.hooks.onShown(payload.subject || '紧急消息');
      this.armAutoClose();
    });
    // 关闭（含 8 秒自动关）统一走 closed 清理
    popup.on('closed', () => {
      this.clearAutoClose();
      if (this.popup === popup) this.popup = null;
    });
    this.hooks.loadEntry(popup);
  }

  /** 供弹窗页面查询当前展示的消息（notify-popup:get IPC 背后） */
  getPayload(): UnreadMessagePayload | null {
    return this.payload;
  }

  /** 弹窗页面"点击主体"回调：关弹窗 + 聚焦主窗开消息中心 */
  activate(): void {
    this.close('activate');
    this.hooks.openMessageCenter();
  }

  /** 关闭当前弹窗（自动超时/替换/激活/退出） */
  close(reason: string): void {
    this.clearAutoClose();
    const popup = this.popup;
    this.popup = null;
    if (popup && !popup.isDestroyed()) popup.close();
    if (reason !== 'replace') this.payload = null;
  }

  /** 8 秒无操作自动关闭；hover 暂停、离开重新计时（由弹窗页面 IPC 暂停/恢复） */
  armAutoClose(): void {
    this.clearAutoClose();
    this.autoCloseTimer = setTimeout(() => this.close('timeout'), AUTO_CLOSE_MS);
  }

  pauseAutoClose(): void {
    this.clearAutoClose();
  }

  private clearAutoClose(): void {
    if (this.autoCloseTimer !== null) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
  }
}
