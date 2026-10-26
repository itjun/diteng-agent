import { Menu, Tray, app, nativeImage } from 'electron';
import { join } from 'node:path';

/** TrayService 依赖注入 */
export interface TrayServiceHooks {
  /** 托盘"显示主窗"/点击托盘图标：还原并聚焦主窗 */
  showMainWindow: () => void;
  /** 托盘"退出"：真正退出应用 */
  quitApp: () => void;
}

/**
 * 托盘常驻：登录成功后创建，退出时销毁。
 * 角标策略：macOS 用 app.dock.setBadge（Dock 数字角标）+ tray.setTitle（菜单栏图标旁计数）；
 * Windows setBadgeCount/setTitle 均无原生角标能力，仅把计数并入 tooltip
 * （任务栏覆盖图标需主窗句柄且体验有限，后续有需要再接 setOverlayIcon）。
 */
export class TrayService {
  private readonly hooks: TrayServiceHooks;
  private tray: Tray | null = null;
  private unread = 0;

  constructor(hooks: TrayServiceHooks) {
    this.hooks = hooks;
  }

  isActive(): boolean {
    return this.tray !== null;
  }

  /** 创建托盘（登录成功后调用）；已存在时幂等 */
  create(): void {
    if (this.tray) return;
    // macOS 用透明模板图（16px + 自动加载的 @2x），由系统适配深浅色/透明菜单栏；其余平台用彩色图
    const iconPath =
      process.platform === 'darwin'
        ? join(__dirname, '../../assets/trayTemplate.png')
        : join(__dirname, '../../assets/tray.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    const tray = new Tray(icon);
    tray.setToolTip('diteng agent');
    this.tray = tray;

    // macOS 点托盘图标直接唤起主窗（Windows 由菜单承担入口）
    tray.on('click', () => this.hooks.showMainWindow());
    this.rebuildMenu();
    console.log('[tray] 托盘已创建');
  }

  /** 未读总数变化：刷新 Dock 角标 / 菜单栏计数 / tooltip */
  setUnread(count: number): void {
    this.unread = count;
    if (this.tray) {
      if (process.platform === 'darwin') this.tray.setTitle(count > 0 ? String(count) : '');
      this.tray.setToolTip(count > 0 ? `diteng agent（${count} 条未读）` : 'diteng agent');
    }
    // Dock 角标：macOS 原生支持；Windows app.dock 不存在，跳过
    if (!app.dock) return;
    if (count > 0) app.dock.setBadge(String(count));
    else app.dock.setBadge('');
  }

  getUnread(): number {
    return this.unread;
  }

  destroy(): void {
    const tray = this.tray;
    this.tray = null;
    if (tray && !tray.isDestroyed()) tray.destroy();
    if (app.dock) app.dock.setBadge('');
  }

  private rebuildMenu(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗', click: () => this.hooks.showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => this.hooks.quitApp() },
    ]);
    this.tray.setContextMenu(menu);
  }
}
