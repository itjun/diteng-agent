import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { UnreadMessagePayload } from './mqtt-service';

export function isImportantMessage(payload: UnreadMessagePayload): boolean { return payload.level === 2; }

export interface ImportantNotifierHooks {
  loadEntry: (window: BrowserWindow) => void;
  getOwnerWindow: () => BrowserWindow | null;
  openMessageCenter: (payload: UnreadMessagePayload) => Promise<boolean>;
  onShown: (title: string) => void;
  onDismiss: (uid: string) => void;
}

/** 紧急提醒持久排队；新消息不会覆盖旧消息，用户关闭或成功打开后才移出本地队列。 */
export class ImportantNotifier {
  private popup: BrowserWindow | null = null;
  private queue: UnreadMessagePayload[] = [];
  private isActivating = false;
  private isEnabled = true;

  constructor(private readonly hooks: ImportantNotifierHooks) {}

  isSender(contents: Electron.WebContents): boolean { return this.popup?.webContents === contents; }
  getPayload(): UnreadMessagePayload | null { return this.queue[0] || null; }
  getPendingCount(): number { return this.queue.length; }

  replacePending(payloads: UnreadMessagePayload[]): void {
    this.queue = payloads.filter(isImportantMessage);
    this.updateWindow();
  }

  setEnabled(isEnabled: boolean): void {
    this.isEnabled = isEnabled;
    this.updateWindow();
  }

  show(payload: UnreadMessagePayload): void {
    if (!isImportantMessage(payload) || this.queue.some((item) => item.uid === payload.uid)) return;
    this.queue.push(payload);
    this.updateWindow();
  }

  async activate(): Promise<void> {
    const payload = this.getPayload();
    if (!payload || this.isActivating) return;
    this.isActivating = true;
    try {
      if (await this.hooks.openMessageCenter(payload) && this.getPayload()?.uid === payload.uid) this.dismiss();
    } finally { this.isActivating = false; }
  }

  dismiss(): void {
    const payload = this.getPayload();
    if (payload) {
      try { this.hooks.onDismiss(payload.uid); }
      catch { console.warn('[notify] 关闭提醒未能保存，保留待提醒消息'); return; }
      this.queue.shift();
    }
    this.updateWindow();
  }

  close(reason: string): void {
    if (reason === 'user') { this.dismiss(); return; }
    // 登出/退出只销毁窗口，待提醒持久队列由所属账号保留。
    this.queue = [];
    this.destroyWindow();
  }

  private updateWindow(): void {
    if (!this.queue.length || !this.isEnabled) { this.destroyWindow(); return; }
    if (this.popup && !this.popup.isDestroyed()) {
      this.popup.webContents.send('notify-popup:changed');
      return;
    }
    const width = 380;
    const height = 154;
    const popup = new BrowserWindow({
      width, height, show: false, frame: false, resizable: false, minimizable: false,
      maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      focusable: true, transparent: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(__dirname, '../preload/index.js') },
    });
    popup.setAlwaysOnTop(true, 'floating');
    this.popup = popup;
    const owner = this.hooks.getOwnerWindow();
    const display = owner && !owner.isDestroyed() ? screen.getDisplayMatching(owner.getNormalBounds()) : screen.getPrimaryDisplay();
    popup.setPosition(Math.round(display.workArea.x + display.workArea.width - width - 16), Math.round(display.workArea.y + display.workArea.height - height - 16));
    popup.once('ready-to-show', () => {
      if (popup.isDestroyed()) return;
      popup.showInactive();
      this.hooks.onShown(this.getPayload()?.subject || '紧急消息');
    });
    popup.on('closed', () => { if (this.popup === popup) this.popup = null; });
    this.hooks.loadEntry(popup);
  }

  private destroyWindow(): void {
    const popup = this.popup;
    this.popup = null;
    if (popup && !popup.isDestroyed()) popup.destroy();
  }
}
