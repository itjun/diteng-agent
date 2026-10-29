import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  webContents,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  safeStorage,
  screen,
  shell,
  systemPreferences,
} from 'electron';
import { join } from 'node:path';
import { release } from 'node:os';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { UpdateService } from './update-service';
import { BUILD_SERVER_BASE } from './build-environment';
import {
  clearAutoLoginCredential,
  getConfig,
  resolveAiBase,
  saveWindowBounds,
  updateConfig,
} from './config';
import {
  clearSavedAccounts,
  findSavedAccount,
  listSavedAccounts,
  recordSavedAccountLogin,
  removeSavedAccount,
  touchSavedAccount,
} from './saved-accounts';
import * as serverApi from './api';
import { clearSession, getCorpList, getSession, getSessionSummary, saveCorpList, saveSession } from './session-store';
import { buildAiUrl, buildErpUrl, classifyUrl, isErpLogoutUrl, withSessionParams } from './url-policy';
import { installErpMenuNewTabPatch } from './erp-menu-newtab';
import { MqttService, toPlainExcerpt, type UnreadMessagePayload } from './mqtt-service';
import { ImportantNotifier } from './important-notifier';
import { TrayService } from './tray-service';
import { openFeedbackChatApp } from './external-apps';
import { CorpSwitchCoordinator, type CorpSwitchTarget } from './corp-switch';
import { ErpRequestGate } from './erp-request-gate';
import { isShellEntryUrl } from './shell-origin';
import { getDeviceInfo, getPublicIp } from './device-info';
import { installContextMenu, isContextMenuOpen, registerContextMenuIpc } from './context-menu';
import type {
  AppConfig,
  AppConfigPatch,
  ApiFailure,
  CorpAccount,
  FeedbackCopyResult,
  FeedbackScreenshotResult,
  LoginResult,
  MqttState,
  SavedAccountKey,
  SessionInfo,
  ShortcutAction,
  TabsResolveRequest,
  ThemeState,
  WindowStyleState,
} from '../shared/types';

// 在初始化服务、读取配置和创建窗口前占锁；重复启动仅唤醒已有实例。
if (!app.requestSingleInstanceLock()) app.exit(0);

const DEV_SERVER_URL = process.env.DITENG_AGENT_DEV_URL || 'http://127.0.0.1:5173';
// 对应 --dsw-static-neutral-bluish-950 / 00，避免深色主题下窗口底色闪白
const THEME_DARK_BACKGROUND = '#151517';
const THEME_LIGHT_BACKGROUND = '#ffffff';
// 主窗整窗原生材质（macOS vibrancy / Windows 云母同款）：底色全透明（#RRGGBBAA），让系统材质透出
const TRANSPARENT_BACKGROUND = '#00000000';
// 主窗壳路由 hash：与登录窗共用同一入口页，仅 hash 区分（App.tsx 判定 #/main，需带斜杠）
const MAIN_WINDOW_HASH = '/main';
// Windows 11 22H2（build 22621）起 DWMWA_SYSTEMBACKDROP_TYPE 才支持云母（Electron backgroundMaterial 同一门槛）；
// 更早系统保持实底窗口，渲染层经 material:get-sync 不走透明分支。云母色深跟随系统主题（非应用主题），
// 应用固定深/浅色时由壳 CSS 的外围 tint（Shell.module.css mica 分支）向应用主题靠拢。
const WINDOWS_MICA =
  process.platform === 'win32' && Number.parseInt(release().split('.')[2] ?? '0', 10) >= 22621;

let loginWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
// 主窗创建时的首个标签（forceRedirect 落点或 ERP 首页），壳挂载后经 tabs:pop-entry 取走（仅一次）
let pendingEntry: { url: string; corpNo: string } | null = null;
// 托盘退出（托盘菜单/Dock 退出）时置位，主窗 close 拦截据此放行真正关闭
let isQuitting = false;
let isUpdateQuitRequested = false;
let isRestartRequested = false;
// 反馈标注编辑器打开状态：由主窗壳经 feedback:editor-active 同步，打开期间主窗接管 Esc/⌘Z/⇧⌘Z/⌘W
let isFeedbackEditorActive = false;
let isLoggingOut = false;
let isConfirmingRelogin = false;
let testNotification: Notification | null = null;

/** 壳页面入口加载：dev 走 vite dev server，打包后加载本地 index.html；hash 区分页面角色 */
function loadShellEntry(window: BrowserWindow, hash: string): void {
  if (isDevMode()) void window.loadURL(`${DEV_SERVER_URL}#${hash}`);
  else void window.loadFile(join(__dirname, '../renderer/index.html'), { hash });
}

/** 聚焦主窗：最小化先还原，隐藏（托盘）先显示 */
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 重复启动或点击 Dock 时复用当前窗口，兼容尚未登录的状态。 */
function focusExistingWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && getSession()) {
    focusMainWindow();
    return;
  }
  if (!loginWindow || loginWindow.isDestroyed()) return;
  if (loginWindow.isMinimized()) loginWindow.restore();
  loginWindow.show();
  loginWindow.focus();
}

/** 当前 AI 站基址（config 推导），URL 分类白名单用 */
function currentAiBase(): string {
  return resolveAiBase(getConfig());
}

/** 主进程 → 主窗壳单向推送；壳未开/已销毁时静默丢弃（壳挂载后自会经 resolve 重新拿到状态） */
function sendToShell(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/**
 * 应用快捷键：⌘/Ctrl+B 展开收起侧栏、⌘/Ctrl+, 打开设置页。
 * 焦点可能在主窗壳（工具栏/rail/设置页）或 webview guest（ERP 页面）里，
 * 两处 webContents 都挂 before-input-event，统一拦下默认行为后推给壳执行。
 * 反馈标注编辑器打开期间（仅主窗与其 webview guest）另接管 Esc/⌘Z/⇧⌘Z/⌘W 转发 editor-* 动作。
 * macOS 另外补回编辑类快捷键（剪贴板/撤销/重做）与常用窗口快捷键：
 * 应用菜单已被清空（见 app.whenReady），这些系统快捷键原本挂在菜单上，不补会失效。
 */
function handleAppShortcut(event: Electron.Event, input: Electron.Input, contents: Electron.WebContents): void {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing) return;
  // 自定义菜单先处理 Esc，避免关闭右键菜单时连带退出截图编辑器。
  if (input.key === 'Escape' && isContextMenuOpen(contents)) return;
  const isMac = process.platform === 'darwin';
  const isModifierPressed = isMac ? input.meta : input.control;
  const key = input.key.toLowerCase();
  // 反馈标注编辑器打开期间：Esc 取消、⌘/Ctrl+Z 撤销、⇧⌘/Ctrl+Z 重做、⌘/Ctrl+W 取消（不关窗），
  // 均转给壳由编辑器自身处理；其余按键维持下方原有逻辑
  const isMainWindowContents = mainWindow !== null && BrowserWindow.fromWebContents(contents) === mainWindow;
  if (isFeedbackEditorActive && isMainWindowContents) {
    if (input.key === 'Escape') {
      event.preventDefault();
      sendToShell('shortcut:action', 'editor-cancel');
      return;
    }
    if (isModifierPressed && !input.alt) {
      if (key === 'z') {
        event.preventDefault();
        sendToShell('shortcut:action', input.shift ? 'editor-redo' : 'editor-undo');
        return;
      }
      if (key === 'w') {
        event.preventDefault();
        sendToShell('shortcut:action', 'editor-cancel');
        return;
      }
    }
  }
  if (isMainWindowContents && input.control && !input.alt && key === 'tab') {
    event.preventDefault();
    sendToShell('shortcut:action', input.shift ? 'previous-tab' : 'next-tab');
    return;
  }
  if (!isModifierPressed || input.alt) return;
  if (!input.shift) {
    let action: ShortcutAction | null = null;
    if (key === 'b') action = 'toggle-rail';
    else if (key === ',') action = 'open-settings';
    else if (isMainWindowContents && key === 't') action = 'new-tab';
    else if (isMainWindowContents && key === 'w') action = 'close-tab';
    if (action) {
      event.preventDefault();
      sendToShell('shortcut:action', action);
      return;
    }
  }
  // Windows/Linux 的编辑快捷键由 Chromium 在 WebContents 内自行处理，无需接管
  if (!isMac) return;
  if (input.shift) {
    // ⌘⇧Z 重做（同样来自默认 Edit 菜单）
    if (key === 'z') {
      event.preventDefault();
      contents.redo();
    }
    return;
  }
  switch (key) {
    case 'c':
      event.preventDefault();
      contents.copy();
      return;
    case 'v':
      event.preventDefault();
      contents.paste();
      return;
    case 'x':
      event.preventDefault();
      contents.cut();
      return;
    case 'a':
      event.preventDefault();
      contents.selectAll();
      return;
    case 'z':
      event.preventDefault();
      contents.undo();
      return;
    case 'q':
      event.preventDefault();
      app.quit();
      return;
    case 'w':
      event.preventDefault();
      BrowserWindow.fromWebContents(contents)?.close();
      return;
    case 'm':
      event.preventDefault();
      BrowserWindow.fromWebContents(contents)?.minimize();
      return;
    default:
      return;
  }
}

// 所有窗口（登录/主窗/置顶弹窗）都挂快捷键处理；webview guest 在 web-contents-created 另行挂载
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('before-input-event', (event, input) =>
    handleAppShortcut(event, input, window.webContents),
  );
});

/**
 * 打开消息中心标签：FrmMyMessage（消息管理，execute 重定向到 IM 前端并自动带会话凭证）。
 * 注意不是 FrmMessages：其 execute 已停止使用（仅剩 unreadTotal/mqttConfig 等子接口）。
 * 标签状态在渲染层：URL 交给壳走 tabs:resolve 流程开 <webview>。
 */
async function openMessageCenter(payload?: UnreadMessagePayload): Promise<boolean> {
  let session = getSession();
  if (!session) return false;
  focusMainWindow();
  if (payload) {
    const target = getCorpList().find((corp) => corp.corpNo === payload.corpNo && (!payload.userCode || corp.code === payload.userCode));
    if (!target) { reportSwitchError('该消息所属账套的访问权限已变更，请刷新登录后重试'); return false; }
    if (session.corpNo !== target.corpNo || session.userCode !== target.code) {
      if (!await switchCorp({ corpNo: target.corpNo, userCode: target.code, sourceWebContentsId: null })) return false;
      session = getSession();
      if (!session) return false;
    }
  }
  const url = new URL(buildErpUrl(session, payload ? 'FrmMyMessage.desktopNotification' : 'FrmMyMessage'));
  if (payload) {
    url.searchParams.set('uid', payload.uid);
    url.searchParams.set('messageUser', payload.userCode);
  }
  sendToShell('tabs:open-request', { url: url.toString() });
  return true;
}

function reportSwitchError(message: string): void {
  const isUncertain = corpSwitch.isUncertain();
  const options: Electron.MessageBoxOptions = { type: 'warning', title: '账套切换', message, buttons: isUncertain ? ['稍后重试', '重新核验'] : ['知道了'], defaultId: 0, cancelId: 0, noLink: true };
  if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, options).then((result) => {
    if (isUncertain && result.response === 1) void corpSwitch.retryVerification();
  });
}

const corpSwitch = new CorpSwitchCoordinator({
  getSession,
  confirm: async (target) => {
    const name = resolveCorpName(target.corpNo, getCorpList()) || target.corpNo;
    const options: Electron.MessageBoxOptions = {
      type: 'warning', title: '切换账套', message: `切换到「${name}」？`,
      detail: '请先返回页面保存需要保留的表单。继续将放弃其它标签未保存的内容。客户端不能自动保存网页表单。',
      buttons: ['取消，返回保存', '放弃未保存内容并切换'], defaultId: 0, cancelId: 0, noLink: true,
    };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  },
  isSourceAlive: (id) => id === null || Boolean(webContents.fromId(id) && !webContents.fromId(id)?.isDestroyed()),
  verify: async (ticket, token) => {
    const base = ticket.session;
    const nextToken = token || base.token;
    const info = await serverApi.getTokenInfo(base.serverBase, base.machineCode, nextToken);
    if (!info.ok || !info.data.corpNo || !info.data.userCode || info.data.userId !== base.userId) return null;
    if (!getCorpList().some((corp) => corp.corpNo === info.data.corpNo && corp.code === info.data.userCode)) return null;
    return { ...base, token: nextToken, corpNo: info.data.corpNo, userCode: info.data.userCode, userId: info.data.userId,
      corpName: resolveCorpName(info.data.corpNo, getCorpList()), userName: info.data.userName || info.data.userCode, homeForm: 'FrmDefault' };
  },
  commit: (session, target, generation) => {
    saveSession(session);
    requestGate.commit(target.sourceWebContentsId, session, generation);
    pushSessionChanged();
    sendToShell('corp-switch:committed', {
      sourceWebContentsId: target.sourceWebContentsId, generation, session: getSessionSummary(),
      url: buildErpUrl(session, session.homeForm),
    });
    void mqttService.refreshUnread();
  },
  report: reportSwitchError,
});

const requestGate = new ErpRequestGate({ coordinator: corpSwitch, getSession, getCorps: getCorpList,
  isUpdateRequired: () => updateService.getState().isRequired,
  aiBase: currentAiBase, getOwner: () => mainWindow?.webContents || null, switchTo: switchCorp,
  verifyNavigation: async (target, token) => {
    const ticket = await corpSwitch.begin(target);
    if (!ticket || !corpSwitch.markSent(ticket)) return false;
    return (await corpSwitch.complete(ticket, token)).ok;
  },
});

async function switchCorp(target: CorpSwitchTarget): Promise<boolean> {
  const ticket = await corpSwitch.begin(target);
  if (!ticket || !corpSwitch.markSent(ticket)) return false;
  const session = ticket.session;
  const exchanged = await serverApi.getNuewToken(session.serverBase, session.token, session.rootToken || session.token, session.machineCode, target.corpNo);
  const result = await corpSwitch.complete(ticket, exchanged.ok ? exchanged.data : undefined);
  if (!result.ok && !corpSwitch.isUncertain()) reportSwitchError(result.message);
  return result.ok;
}

/** MQTT 状态推送到壳 renderer（e2e/后续 UI 消费） */
function broadcastMqttState(state: MqttState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mqtt:changed', state);
  }
}

const mqttService = new MqttService({
  readSession: getSession,
  onUnreadChange: (count) => trayService.setUnread(count),
  onMessage: (payload: UnreadMessagePayload) => importantNotifier.show(payload),
  readPreferences: getConfig,
  getStoreDirectory: () => join(app.getPath('userData'), 'notifications'),
  isAuthorized: (payload) => getCorpList().some((corp) => corp.corpNo === payload.corpNo && corp.code === payload.userCode),
  corpName: (corpNo) => resolveCorpName(corpNo, getCorpList()),
  onRestorePending: (items) => importantNotifier.replacePending(items),
  openMessageCenter,
  onStateChanged: broadcastMqttState,
});

const importantNotifier = new ImportantNotifier({
  loadEntry: (window) => loadShellEntry(window, '/notify-popup'),
  getOwnerWindow: () => mainWindow,
  openMessageCenter,
  onShown: (title) => mqttService.reportPopupShown(title),
  onDismiss: (uid) => mqttService.dismiss(uid),
});

const updateService = new UpdateService({
  currentVersion: app.getVersion(),
  disabledReason: !app.isPackaged ? '开发运行不检查在线更新' : BUILD_SERVER_BASE !== 'https://m.cdcp.site' ? '开发环境安装包不接收正式版更新' : '',
  updater: autoUpdater,
  readPreferences: getConfig,
  readPolicy: () => {
    const file = join(app.getPath('userData'), 'update-policy-cache.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  },
  savePolicy: policy => {
    const file = join(app.getPath('userData'), 'update-policy-cache.json');
    writeFileSync(file + '.tmp', JSON.stringify(policy), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  },
  onChanged: state => {
    if (isUpdateQuitRequested && state.status === 'error') {
      isUpdateQuitRequested = false;
      isQuitting = false;
    }
    for (const window of [loginWindow, mainWindow]) {
      if (window && !window.isDestroyed()) window.webContents.send('update:changed', state);
    }
  },
  prepareInstall: async () => {
    if (corpSwitch.getActive()) return false;
    const result = await dialog.showMessageBox({ type: 'question', title: '安装更新',
      message: '保存工作后重启并安装更新？', detail: '应用将关闭所有页面，安装完成后重新启动。',
      buttons: ['重启并安装', '取消'], defaultId: 1, cancelId: 1, noLink: true });
    if (result.response !== 0 || corpSwitch.getActive()) return false;
    // quitAndInstall 先关窗口后触发 before-quit，提前放行托盘关闭拦截。
    isQuitting = true;
    isUpdateQuitRequested = true;
    return true;
  },
});

const trayService = new TrayService({
  showMainWindow: focusMainWindow,
  restartApp: () => {
    isRestartRequested = true;
    app.quit();
  },
  checkForUpdates: () => {
    focusExistingWindow();
    void updateService.check(true);
  },
  quitApp: () => app.quit(),
});

function isDevMode(): boolean {
  // 未打包时页面由 vite dev server 提供；打包后加载本地构建产物
  return !app.isPackaged;
}

function resolveIsDarkTheme(config: AppConfig): boolean {
  if (config.theme === 'dark') return true;
  if (config.theme === 'light') return false;
  // Electron 在未打包/部分 macOS 运行形态下可能不继承系统 Dark；以系统默认值兜底，
  // system 模式仍由 nativeTheme.updated 驱动实时刷新。
  if (process.platform === 'darwin') {
    try {
      const appearance = systemPreferences.getUserDefault('AppleInterfaceStyle', 'string');
      if (appearance === 'Dark' || appearance === 'Light') return appearance === 'Dark';
    } catch {
      // 系统未提供该默认值时继续用 nativeTheme 判定
    }
  }
  return nativeTheme.shouldUseDarkColors;
}

/**
 * 应用主题与原生外观必须同源：themeSource 固定为 light/dark 时，macOS 窗口框架、
 * vibrancy 材质、系统菜单及渲染层 prefers-color-scheme 都会忽略系统深浅色；
 * system 则继续跟随系统。已固定主题下再改系统外观不会让两侧配色分叉。
 */
function applyNativeTheme(config: AppConfig): void {
  if (nativeTheme.themeSource !== config.theme) nativeTheme.themeSource = config.theme;
}

/** 主进程统一解析主题，渲染层不再各自把 config 与系统媒体查询拼在一起 */
function currentThemeState(): ThemeState {
  const config = getConfig();
  const setting = config.theme;
  const resolved = resolveIsDarkTheme(config) ? 'dark' : 'light';
  return { setting, resolved };
}

/** 主题是应用级偏好：所有已开窗口（登录、主窗、置顶弹窗）必须同步更新 */
function broadcastThemeState(): void {
  const state = currentThemeState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('theme:changed', state);
    }
  }
}

/** macOS vibrancy 兜底底色：对齐 dsh desktop chromeFallbackFill（resolved --dsw-static-neutral-bluish-900 / -50） */
function macVibrancyFallbackFill(): string {
  return resolveIsDarkTheme(getConfig()) ? '#1b1b1c' : '#f9fafb';
}

function currentWindowStyle(): WindowStyleState {
  const setting = getConfig().windowStyle;
  if (setting === 'classic') return { setting, material: 'none' };
  if (process.platform === 'darwin') return { setting, material: 'vibrancy' };
  return { setting, material: WINDOWS_MICA ? 'mica' : 'none' };
}

/**
 * macOS 主窗背景态：可见时透明底 + sidebar vibrancy（材质深浅由 nativeTheme.themeSource 跟随应用主题）；
 * 最小化/隐藏期间摘除 vibrancy 并铺不透明兜底底——deminiaturize 会晚挂 NSVisualEffectView
 * （electron/electron#25368），透明窗在还原动画里会瞬透桌面，先实底、还原后切回。
 * 与 dsh desktop main.ts applyBackdrop 同做法。
 */
function applyMacMainWindowBackdrop(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (currentWindowStyle().material === 'none' || mainWindow.isMinimized() || !mainWindow.isVisible()) {
    mainWindow.setVibrancy(null);
    mainWindow.setBackgroundColor(macVibrancyFallbackFill());
  } else {
    mainWindow.setVibrancy('sidebar');
    mainWindow.setBackgroundColor(TRANSPARENT_BACKGROUND);
  }
}

function createLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) {
    focusExistingWindow();
    return;
  }
  const config = getConfig();
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(960, workArea.width);
  const height = Math.min(640, workArea.height);
  loginWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    resizable: false,
    // 登录窗不显示窗口按钮，使用页面四周留白与插画区拖拽。
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'diteng agent',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const } : { frame: false }),
    // Win11 云母与主窗同款：透明底 + 整窗材质，登录页四周留白透出（卡片保持实底）；
    // 其余平台实底色避免加载瞬间透出桌面
    backgroundColor: WINDOWS_MICA ? TRANSPARENT_BACKGROUND : resolveIsDarkTheme(config) ? THEME_DARK_BACKGROUND : THEME_LIGHT_BACKGROUND,
    ...(WINDOWS_MICA && { backgroundMaterial: 'mica' as const }),
    webPreferences: {
      // 安全基线：渲染层无 Node 能力，仅经 preload 暴露白名单 API
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
    },
  });
  // macOS 隐藏原生红绿灯；其他平台使用无边框窗口。
  if (process.platform === 'darwin') loginWindow.setWindowButtonVisibility(false);
  const createdLoginWindow = loginWindow;
  createdLoginWindow.once('ready-to-show', () => { if (!createdLoginWindow.isDestroyed()) createdLoginWindow.show(); });
  createdLoginWindow.on('closed', () => {
    if (loginWindow === createdLoginWindow) loginWindow = null;
  });
  if (isDevMode()) void loginWindow.loadURL(DEV_SERVER_URL);
  else void loginWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

/** 壳页面自身允许加载的 URL：dev 为 vite 入口，打包后为本地 index.html（含 #main hash 切换） */
function isShellUrl(url: string): boolean {
  return isShellEntryUrl(url, join(__dirname, '../renderer/index.html'), isDevMode() ? DEV_SERVER_URL : undefined);
}

/**
 * 登录成功后创建主窗（tab 壳 + 渲染层 <webview> 标签）。
 * 主窗 ready-to-show 后才关登录窗，避免出现零窗口瞬间。
 */
function createMainWindow(session: SessionInfo, entryUrl: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return;
  }
  const isDark = resolveIsDarkTheme(getConfig());
  // 首个标签在窗口加载前登记（壳挂载时经 tabs:pop-entry 拉取，避免 ready-to-show 竞态）
  pendingEntry = { url: entryUrl, corpNo: session.corpNo };
  // 窗口尺寸：优先恢复上次关闭时记录的大小；未记录时取主屏工作区的 80%
  // （钳制在 minWidth/minHeight 与工作区之间，避免换小屏后恢复出屏外超大窗口）
  const workArea = screen.getPrimaryDisplay().workArea;
  const clampSize = (width: number, height: number): { width: number; height: number } => ({
    width: Math.min(Math.max(Math.round(width), 940), workArea.width),
    height: Math.min(Math.max(Math.round(height), 640), workArea.height),
  });
  const saved = getConfig().windowBounds;
  const initialSize = saved
    ? clampSize(saved.width, saved.height)
    : clampSize(workArea.width * 0.8, workArea.height * 0.8);
  mainWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: 'diteng agent',
    // macOS 整窗 vibrancy / Windows 11 云母需要透明底色让材质透出；其余平台维持实心底色
    backgroundColor:
      currentWindowStyle().material !== 'none'
        ? TRANSPARENT_BACKGROUND
        : isDark
          ? THEME_DARK_BACKGROUND
          : THEME_LIGHT_BACKGROUND,
    // Windows 11：整窗云母（对齐 macOS 整窗 vibrancy 的做法），替代 transparent 窗口且无性能损耗
    ...(WINDOWS_MICA && { backgroundMaterial: currentWindowStyle().material === 'mica' ? 'mica' as const : 'none' as const }),
    // macOS：hiddenInset + 红绿灯落在 tab 条左侧，整窗 sidebar 毛玻璃（rail 由 CSS 半透明透出）；
    // Windows：系统 overlay 与 tab 条同高（参考 dsh desktop）
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset' as const,
      // 红绿灯位于标签侧栏顶部；收起侧栏时，内容工具栏预留同一位置。
      trafficLightPosition: { x: 16, y: 18 },
      ...(currentWindowStyle().material === 'vibrancy' && { vibrancy: 'sidebar' as const }),
      // 'active'：失焦时材质保持稳定；'followWindow' 失焦会把侧栏洗白发灰（dsh 同款）
      visualEffectState: 'active' as const,
    }),
    // Windows/Linux：无系统标题栏，内容直达窗口顶边（rail 通顶与 macOS 一致）；
    // 不用 titleBarOverlay——它会在整窗顶部压出一条系统 caption 按钮条。
    // 窗口控制（—/□/×）由壳通栏工具栏自绘（window:minimize 等 IPC）
    ...(process.platform !== 'darwin' && { titleBarStyle: 'hidden' as const }),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // ERP 标签页为壳页内 <webview>（页内合成，与 macOS 整窗 vibrancy 兼容）；
      // 仅主窗壳开启，登录/弹窗窗不受影响
      webviewTag: true,
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  // guest 安全基线：webview 标签属性不可提权（剥 preload、关 Node），ERP guest 保持纯浏览器形态
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  mainWindow.webContents.on('did-attach-webview', (_event, contents) => requestGate.register(contents));

  // 壳导航锁死：壳页面只允许自己的 dev/prod 入口，ERP 页把壳顶掉或开新窗一律拒绝
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 壳内打开的外部链接（如帮助文档）仅限 http/https 走系统浏览器，其余协议直接拒绝
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
      void shell.openExternal(parsed.toString()).catch(() => {});
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isShellUrl(url)) event.preventDefault();
  });
  // 壳整页刷新/崩溃恢复后编辑器已不存在：复位快捷键接管开关，避免 Esc/⌘Z/⌘W 被错误拦截
  mainWindow.webContents.on('did-start-loading', () => {
    isFeedbackEditorActive = false;
  });

  const createdMainWindow = mainWindow;
  const previousLoginWindow = loginWindow;
  mainWindow.once('ready-to-show', () => {
    if (getSession() && !createdMainWindow.isDestroyed()) createdMainWindow.show();
    if (previousLoginWindow && !previousLoginWindow.isDestroyed()) previousLoginWindow.close();
  });
  if (process.platform === 'darwin') {
    // 最小化/隐藏（托盘）/还原/显示期间切换背景态，见 applyMacMainWindowBackdrop 注释
    mainWindow.on('minimize', applyMacMainWindowBackdrop);
    mainWindow.on('hide', applyMacMainWindowBackdrop);
    mainWindow.on('restore', applyMacMainWindowBackdrop);
    mainWindow.on('show', applyMacMainWindowBackdrop);
  }
  // 窗口大小记忆：resize 防抖落盘（500ms），隐藏/关闭/退出前兜底再存一次
  let saveBoundsTimer: NodeJS.Timeout | null = null;
  const persistBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    // 最大化时记录还原前的常规大小，下次启动按普通尺寸恢复
    const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    saveWindowBounds({ width: bounds.width, height: bounds.height });
  };
  mainWindow.on('resize', () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      saveBoundsTimer = null;
      persistBounds();
    }, 500);
  });
  mainWindow.on('hide', persistBounds);
  mainWindow.on('close', persistBounds);
  // 自绘窗口控制的最大化态推送：□/❐ 图标随窗口最大化/还原切换
  mainWindow.on('maximize', () => {
    if (!createdMainWindow.isDestroyed()) createdMainWindow.webContents.send('window:maximized-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    if (!createdMainWindow.isDestroyed()) createdMainWindow.webContents.send('window:maximized-changed', false);
  });
  // macOS/Windows 惯例：托盘常驻期间关窗仅隐藏，托盘"关闭应用"才真正退出；
  // 未登录（无托盘）时保持原行为：关窗即退出
  mainWindow.on('close', (event) => {
    if (!isQuitting && trayService.isActive()) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    pendingEntry = null;
    // 编辑器随主窗一起销毁，复位快捷键接管开关
    isFeedbackEditorActive = false;
    if (mainWindow === createdMainWindow) mainWindow = null;
  });
  loadShellEntry(mainWindow, MAIN_WINDOW_HASH);
}

/** 主题变化时同步原生窗口底色，避免缩放/刷新瞬间露底 */
function applyWindowTheme(): void {
  const isDark = resolveIsDarkTheme(getConfig());
  const color = isDark ? THEME_DARK_BACKGROUND : THEME_LIGHT_BACKGROUND;
  // 云母窗口（登录/主窗）保持透明底，材质由 DWM 绘制；其余平台实底色随主题刷新
  if (!WINDOWS_MICA) loginWindow?.setBackgroundColor(color);
  if (process.platform === 'darwin') {
    // 主窗可见时保持透明（vibrancy 材质深浅跟随应用主题）；不可见期间的兜底底色随主题刷新
    applyMacMainWindowBackdrop();
  } else if (WINDOWS_MICA && mainWindow && !mainWindow.isDestroyed()) {
    const isMica = currentWindowStyle().material === 'mica';
    mainWindow.setBackgroundMaterial(isMica ? 'mica' : 'none');
    mainWindow.setBackgroundColor(isMica ? TRANSPARENT_BACKGROUND : color);
  } else {
    mainWindow?.setBackgroundColor(color);
  }
}

/**
 * 登录成功：会话入库（token 只留主进程内存）并打开主窗。
 * SvrUserLogin.getToken 不返回 userId（MQTT 未读 topic 依赖它）：开窗前并行经 getTokenInfo 补齐
 * userId/用户名/子账号、经 listMyLivingUsers 取账套名称并暖账套列表缓存；失败不阻断登录
 * （userId 空时未读通知降级，resolveUserDisplay 兜底重试；corpName 空时渲染层回落账套号）。
 */
async function keepSession(serverBase: string, result: LoginResult, loginId: string): Promise<void> {
  const config = getConfig();
  const session: SessionInfo = {
    serverBase,
    loginId,
    token: result.token,
    // 原始登录 token：账套切换始终用它换新 token（getNuewToken 换出的永久 token 不能再作换票凭据）
    rootToken: result.token,
    userId: result.userId,
    corpNo: result.corpNo,
    corpName: '',
    homeForm: result.homeForm,
    machineCode: config.machineCode,
    userName: '',
    userCode: '',
  };
  // 日志只留 token 前 8 位，避免完整凭据落进控制台
  console.log(
    `[auth] 登录成功，token=${result.token.slice(0, 8)}… corpNo=${result.corpNo} homeForm=${result.homeForm}`,
  );
  // getTokenInfo（userId/用户名/子账号）与账套列表（账套名称 + 暖缓存）互不依赖，并行拉取；
  // 账套列表失败不影响登录，仅 corpName 暂缺（由下方后台重试补齐）
  const [info, corps] = await Promise.all([
    serverApi.getTokenInfo(serverBase, session.machineCode, result.token),
    serverApi.listMyLivingUsers(serverBase, result.token, session.machineCode),
  ]);
  // 补齐信息期间其他登录可能已经完成；会话和主窗只提交一次。
  if (getSession()) return;
  saveCorpList(corps.ok ? corps.data : []);
  if (!corps.ok) {
    console.warn(`[auth] 登录后拉取账套列表失败（账套名称暂缺）：${corps.message}`);
    // 壳内账套菜单已移除，没有“打开卡片补名”入口：登录后后台重试一次，避免本会话账套名称长期为空
    void ensureCorpList(serverBase, session.token, session.machineCode).then((list) => {
      if (getSession() === session) backfillCorpName(session, list);
    });
  }
  if (info.ok) {
    session.userId = info.data.userId || result.userId;
    session.userName = info.data.userName || info.data.userCode;
    session.userCode = info.data.userCode;
    // 账套号以 token 绑定账套为准（与登录响应 startPage 同源，异常时也能保证 URL 与 token 一致）
    if (info.data.corpNo) {
      if (result.corpNo && info.data.corpNo !== result.corpNo) {
        console.warn(
          `[auth] 登录落点账套 ${result.corpNo} 与 token 绑定账套 ${info.data.corpNo} 不一致，按 token 绑定账套处理`,
        );
      }
      session.corpNo = info.data.corpNo;
    }
  } else {
    console.warn(`[auth] 登录后 getTokenInfo 失败（userId 未就绪，MQTT 未读降级）：${info.message}`);
  }
  // 账套名称只依赖账套列表：即使 getTokenInfo 失败也尽量补上
  session.corpName = resolveCorpName(session.corpNo, getCorpList());
  saveSession(session);
  corpSwitch.reset();
  importantNotifier.setEnabled(getConfig().importantPopups);
  // forceRedirect + 绝对 URL（服务端显式指定落点）优先；否则开当前账套首页表单
  const forcedUrl =
    result.forceRedirect && /^https?:\/\//i.test(result.redirectUrl) ? result.redirectUrl : '';
  createMainWindow(session, forcedUrl || buildErpUrl(session, session.homeForm));
  // 登录成功进入托盘常驻 + MQTT 未读通知（mqttConfig 失败仅告警，不阻断主流程）
  trayService.create();
  void mqttService.start(session);
  // getTokenInfo 失败时后台兜底补齐用户显示名（含 userId，补齐后 MQTT 可经 refreshUnread 恢复）
  if (!info.ok) void resolveUserDisplay(session);
}

/**
 * 补齐会话的用户显示名、子账号代码与账套名称：
 * 首选 getTokenInfo（userName 为账号级名称、与账套无关；依据 UserCenterService.getTokenInfo），
 * 失败时回落账套列表匹配当前账套的 Code_/Name_（顺路暖缓存）。两者都拿不到时保持空串。
 */
async function resolveUserDisplay(session: SessionInfo): Promise<void> {
  const patch = await resolveTokenSessionPatch(session, session.token, session.corpNo);
  // 等待网络期间会话可能已被替换（登出/重新登录），旧会话对象不得再写回 store
  if (getSession() !== session || corpSwitch.isBlocked()) return;
  if (patch) {
    applyTokenSessionPatch(session, patch);
    saveSession(session);
    void mqttService.start(session);
    pushSessionChanged();
    return;
  }
  // getTokenInfo 失败时回落账套列表：按当前账套的子账号 Code_/Name_ 取展示名
  const corpList = await ensureCorpList(session.serverBase, session.token, session.machineCode);
  if (getSession() !== session) return;
  const match = corpList.find((corp) => corp.corpNo === session.corpNo);
  if (!match) return;
  session.userName = match.name || match.code;
  session.userCode = match.code;
  session.corpName = resolveCorpName(session.corpNo, corpList);
  saveSession(session);
  pushSessionChanged();
}

/**
 * 退出登录：服务端 logout 使 token 失效（只发请求不等待——失败/超时不阻塞本地登出）→
 * 清会话/断 MQTT/关置顶弹窗/销毁托盘 → 开登录窗 → 登录窗就绪后关主窗。
 * 托盘先销毁，主窗 close 拦截（隐藏到托盘）随之失效，真正关闭而非退出应用；
 * 登录窗先建、就绪后再关主窗，避免出现零窗口瞬间（与登录→主窗过渡同款顺序，反向）。
 */
function performLogout(): void {
  const session = getSession();
  if (!session || isLoggingOut) return;
  if (corpSwitch.getActive()) { reportSwitchError('正在核验账套切换，请稍候再退出'); return; }
  isLoggingOut = true;
  corpSwitch.reset();
  requestGate.reset(); // 未登录（重复触发）：登录窗已存在，避免开出第二扇
  void serverApi.logout(session.serverBase, session.token).then((result) => {
    if (result.ok) console.log('[auth] 服务端登出成功');
    else console.warn(`[auth] 服务端登出失败（不阻塞本地登出）：${result.message}`);
  });
  clearSession();
  // 退出登录只清自动登录凭据（下次冷启动不再自动登录）；savedLoginId 保留供登录页预填账号，
  // 历史账号及其密码密文保留，登录页下拉仍可选中账号并回填密码
  clearAutoLoginCredential();
  testNotification?.close();
  testNotification = null;
  mqttService.stop('logout');
  importantNotifier.close('logout');
  trayService.destroy();
  createLoginWindow();
  isLoggingOut = false;
  const closing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!closing) return;
  if (loginWindow) loginWindow.once('ready-to-show', () => { if (!closing.isDestroyed()) closing.close(); });
  else closing.close();
}

/** 账套切换/会话信息补齐后推送会话摘要，壳据此刷新账套指示并关闭旧账套的其他标签 */
function pushSessionChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session:changed', getSessionSummary());
  }
}

// 账套列表拉取的在途请求：登录/切账套/页内导航可能同时触发，共用同一次只读查询，避免重复请求与后写覆盖
let corpListFetch: Promise<CorpAccount[]> | null = null;

/** 账套显示名：账套简称 ShortName_ 优先，其次子账号名称 Name_；不在列表内返回空串（未知） */
function resolveCorpName(corpNo: string, corpList: CorpAccount[]): string {
  const match = corpList.find((corp) => corp.corpNo === corpNo);
  return match?.shortName || match?.name || '';
}

/**
 * 用账套列表补齐会话的账套名称：登录时列表拉取失败会让 corpName 暂缺，由登录后的后台重试补上，
 * 变化后推送会话摘要（壳/设置页不必重新拉取会话）。已有名称时不覆盖。
 */
function backfillCorpName(session: SessionInfo, corpList: CorpAccount[]): void {
  if (session.corpName) return;
  const corpName = resolveCorpName(session.corpNo, corpList);
  if (!corpName) return;
  session.corpName = corpName;
  saveSession(session);
  pushSessionChanged();
}

/**
 * 取当前主账号可用账套列表：主进程缓存优先，缓存为空时只读拉取一次并写缓存。
 * 拉取失败只告警并返回空数组——账套名称缺失不应阻断登录/会话同步，后续入口会重试。
 */
async function ensureCorpList(serverBase: string, token: string, machineCode: string): Promise<CorpAccount[]> {
  const cached = getCorpList();
  if (cached.length > 0) return cached;
  if (corpListFetch) return corpListFetch;
  corpListFetch = serverApi
    .listMyLivingUsers(serverBase, token, machineCode)
    .then((result) => {
      if (!result.ok) {
        console.warn(`[auth] 拉取账套列表失败（账套名称暂缺）：${result.message}`);
        return [] as CorpAccount[];
      }
      saveCorpList(result.data);
      return result.data;
    })
    .finally(() => {
      corpListFetch = null;
    });
  return corpListFetch;
}

/** getTokenInfo 解析出的会话补丁：网络等待期间不落库，由调用方确认无更新的导航后再提交 */
interface TokenSessionPatch {
  corpNo: string;
  corpName: string;
  userCode: string;
  userName: string;
  userId: string;
}

/**
 * 按 token 查权威会话信息（/center/UserServer/getTokenInfo）并解析账套名称：
 * corpNo 为 token 绑定的账套（缺失时回落 fallbackCorpNo），userCode 为 token 绑定的子账号代码，
 * userName 为账号级用户名。依据 UserCenterService.getTokenInfo：三字段均按 token 的
 * CurrentUserEntity 返回，与 URL 无关；账套名称取自账套列表（ShortName_ 优先）。查询失败返回 null。
 */
async function resolveTokenSessionPatch(
  session: SessionInfo,
  token: string,
  fallbackCorpNo: string,
): Promise<TokenSessionPatch | null> {
  // 两个只读查询互不依赖，并行拉取；账套列表失败只影响 corpName（留空）
  const [info, corpList] = await Promise.all([
    serverApi.getTokenInfo(session.serverBase, session.machineCode, token),
    ensureCorpList(session.serverBase, token, session.machineCode),
  ]);
  if (!info.ok) {
    console.warn(`[auth] getTokenInfo 查询失败（token=${token.slice(0, 8)}…）：${info.message}`);
    return null;
  }
  const corpNo = info.data.corpNo || fallbackCorpNo || session.corpNo;
  return {
    corpNo,
    corpName: resolveCorpName(corpNo, corpList),
    userCode: info.data.userCode,
    userName: info.data.userName || info.data.userCode,
    userId: info.data.userId,
  };
}

/**
 * 提交 token 会话补丁：账套号以 token 绑定值为准；账套名称/子账号代码只随账套号一起更新——
 * 同一账套取不到时保留旧值，换账套时必须用新值或空串，避免把旧账套的名称/子账号挂到新账套号上。
 * 用户名与 userId 是账号级信息、与账套无关，缺失时保留已取值。
 */
function applyTokenSessionPatch(session: SessionInfo, patch: TokenSessionPatch): void {
  const isSameCorp = patch.corpNo === session.corpNo;
  session.corpNo = patch.corpNo;
  session.corpName = patch.corpName || (isSameCorp ? session.corpName : '');
  session.userCode = patch.userCode || (isSameCorp ? session.userCode : '');
  if (patch.userName) session.userName = patch.userName;
  if (patch.userId) session.userId = patch.userId;
}

/** IPC 入参做最小类型校验，非法输入按失败返回而不是让 handler 抛异常 */
function readString(source: unknown): string {
  return typeof source === 'string' ? source : '';
}

function invalid(message: string): ApiFailure {
  return { ok: false, code: -1, message };
}

/**
 * 登录成功记录历史账号并按「记住密码」勾选状态保存密码：
 * - 历史账号始终记录（账号 + 服务器），供登录页下拉选择与管理；未勾选时清除该账号已存密文
 * - 勾选且加密可用时同时更新 savedLoginId/savedPassword 兼容字段（自动登录只读这两项），
 *   历史与凭据在同一次落盘中写入
 * - safeStorage 不可用时只刷新账号历史，保留已有密文与自动登录凭据（避免临时 keyring 故障清掉密码）
 */
function persistLoginAccount(
  serverBase: string,
  loginId: string,
  isRememberPassword: boolean,
  password: string,
): void {
  if (!isRememberPassword) {
    recordSavedAccountLogin(loginId, serverBase, '', { savedLoginId: '', savedPassword: '' });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[auth] safeStorage 加密不可用，本次登录不保存密码（保留已存密文）');
    recordSavedAccountLogin(loginId, serverBase, null);
    return;
  }
  const passwordCipher = safeStorage.encryptString(password).toString('base64');
  recordSavedAccountLogin(loginId, serverBase, passwordCipher, {
    savedLoginId: loginId,
    savedPassword: passwordCipher,
  });
}

/** 渲染层可见的 config：剥离仅主进程使用的历史账号密文列表（与 AppConfig 契约一致） */
function publicConfig(): AppConfig {
  const config: AppConfig & { savedAccounts?: unknown } = { ...getConfig() };
  delete config.savedAccounts;
  return config;
}

/** 历史账号 IPC 入参：账号 + 服务器地址，缺一不可（不做当前服务器回退，避免误操作同名账号） */
function readSavedAccountKey(request: unknown): SavedAccountKey {
  return {
    loginId: readString((request as { loginId?: unknown } | null)?.loginId).trim(),
    serverBase: readString((request as { serverBase?: unknown } | null)?.serverBase).trim(),
  };
}

/**
 * 一键反馈：主窗整窗截图，PNG 原始字节回渲染层做标注。
 * 截图对象是主窗壳 webContents——rail/工具栏与 <webview> 标签页均为页内合成，一次 capturePage
 * 即可拿到整幅画面；截图前的 macOS vibrancy 透明底处理由渲染层临时摘掉 data-platform 完成
 * （见 Shell captureFeedback）。写系统剪贴板改由标注确认后调 feedback:copy-image 完成
 * （Electron 44 起剪贴板图片只能走异步 ClipboardItem，旧的 clipboard.writeImage 已移除）。
 */
async function captureFeedbackScreenshot(): Promise<FeedbackScreenshotResult> {
  if (!mainWindow || mainWindow.isDestroyed()) return invalid('主窗口不可用，请重新登录后再试');
  try {
    const image = await mainWindow.webContents.capturePage();
    const { width, height } = image.getSize();
    if (width <= 0 || height <= 0) return invalid('请稍后重试');
    const png = image.toPNG();
    if (png.length === 0) return invalid('请稍后重试');
    console.log(`[feedback] 整窗截图完成：${width}x${height}（PNG ${png.length} 字节）`);
    return { ok: true, png };
  } catch (error) {
    console.warn('[feedback] 主窗截图失败：', error);
    return invalid('请稍后重试');
  }
}

// 反馈 PNG 长度上限：渲染层传标注后的 canvas 导出，30MB 足够且能挡住误传大对象
const FEEDBACK_PNG_MAX_BYTES = 30 * 1024 * 1024;
// PNG 文件头魔数，用于拒绝非 PNG 字节写入剪贴板
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * feedback:copy-image 入参校验：接受 Uint8Array/ArrayBuffer，长度 0<len<=30MB 且带 PNG 魔数；
 * 非法输入返回 null 由调用方按 invalid 处理，不让 handler 抛异常。
 */
function readFeedbackPng(source: unknown): Uint8Array | null {
  let bytes: Uint8Array | null = null;
  if (source instanceof Uint8Array) bytes = source;
  else if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
  if (!bytes || bytes.length === 0 || bytes.length > FEEDBACK_PNG_MAX_BYTES) return null;
  if (bytes.length < PNG_MAGIC.length) return null;
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (bytes[i] !== PNG_MAGIC[i]) return null;
  }
  return bytes;
}

/** feedback:copy-image：校验 PNG 字节后写入系统剪贴板（Electron 44 异步 ClipboardItem） */
async function copyFeedbackImage(source: unknown): Promise<FeedbackCopyResult> {
  const png = readFeedbackPng(source);
  if (!png) return invalid('截图数据无效，请重新截图');
  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  } catch (error) {
    console.warn('[feedback] 标注截图写入系统剪贴板失败：', error);
    return invalid('复制截图到剪贴板失败，请重试');
  }
  console.log(`[feedback] 标注截图已写入系统剪贴板（PNG ${png.length} 字节）`);
  return { ok: true };
}

/**
 * 主窗自绘窗口控制（Windows/Linux 无系统标题栏）：
 * 渲染层按钮只发意图，动作全部落在主进程；close 不绕过 close 拦截
 * （托盘常驻时与系统关闭一致，隐藏到托盘而非退出）。
 */
function registerWindowIpcHandlers(): void {
  const aliveWindow = (): BrowserWindow | null =>
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  ipcMain.handle('window:is-maximized', () => aliveWindow()?.isMaximized() ?? false);
  ipcMain.on('window:minimize', () => aliveWindow()?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    const window = aliveWindow();
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on('window:close-main', () => aliveWindow()?.close());
}

function registerIpcHandlers(): void {
  registerWindowIpcHandlers();
  const trustedUpdateSender = (event: Electron.IpcMainInvokeEvent) =>
    (event.sender === loginWindow?.webContents || event.sender === mainWindow?.webContents)
    && event.senderFrame === event.sender.mainFrame && isShellUrl(event.sender.getURL());
  for (const [channel, action] of [
    ['update:state', () => updateService.getState()],
    ['update:check', () => updateService.check(true)],
    ['update:download', () => updateService.download()],
    ['update:install', () => updateService.install()],
  ] as const) {
    ipcMain.handle(channel, event => {
      if (!trustedUpdateSender(event)) throw new Error('仅应用窗口可操作更新');
      return action();
    });
  }
  registerContextMenuIpc(isShellUrl);
  ipcMain.handle('config:get', () => publicConfig());

  ipcMain.handle('device:info', (event) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || !isShellUrl(event.sender.getURL())) throw new Error('无权读取设备信息');
    return getDeviceInfo(getConfig().machineCode);
  });
  ipcMain.handle('device:public-ip', (event) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || !isShellUrl(event.sender.getURL())) return invalid('无权读取网络信息');
    return getPublicIp();
  });

  // preload 首帧同步读取；只含非敏感主题状态，数据量极小
  ipcMain.on('theme:get-sync', (event) => {
    event.returnValue = currentThemeState();
  });
  ipcMain.handle('theme:get', () => currentThemeState());

  // 登录窗保留现有云母效果；主窗按保存的窗口材质设置启动并即时更新。
  ipcMain.on('material:get-sync', (event) => {
    event.returnValue = event.sender === mainWindow?.webContents ? currentWindowStyle().material : WINDOWS_MICA ? 'mica' : 'none';
  });
  ipcMain.on('window-style:get-sync', (event) => {
    event.returnValue = currentWindowStyle();
  });

  ipcMain.handle('config:set', (event, patch: unknown) => {
    if (!isShellUrl(event.sender.getURL())) throw new Error('无权更改客户端配置');
    updateConfig((patch ?? {}) as AppConfigPatch);
    applyNativeTheme(getConfig());
    applyWindowTheme();
    broadcastThemeState();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window-style:changed', currentWindowStyle());
    }
    importantNotifier.setEnabled(getConfig().importantPopups);
    if ((patch as AppConfigPatch | null)?.autoCheckUpdates === true) void updateService.check();
    return publicConfig();
  });

  ipcMain.handle('auth:login', async (event, request: unknown) => {
    if (event.sender !== loginWindow?.webContents || !isShellUrl(event.sender.getURL())) return invalid('仅登录窗口可执行认证');
    if (getSession()) return invalid('当前已经登录');
    if (!(await updateService.isCompatible())) return invalid('当前版本过低，请先更新客户端');
    const loginId = readString((request as { loginId?: unknown } | null)?.loginId).trim();
    const password = readString((request as { password?: unknown } | null)?.password);
    // 设备验证登录（-8 后）携带 6 位短信验证码，同接口完成验证并登录
    const verifyCode = readString((request as { verifyCode?: unknown } | null)?.verifyCode).trim();
    if (!loginId || !password) return invalid('账号和密码不能为空');
    const serverBase = getConfig().serverBase;
    const isRememberPassword = (request as { rememberPassword?: unknown } | null)?.rememberPassword === true;
    const result = await serverApi.svrUserLogin(
      serverBase,
      getConfig().machineCode,
      loginId,
      password,
      verifyCode || undefined,
    );
    if (updateService.getState().isRequired) return invalid('当前版本过低，请先更新客户端');
    if (result.ok) {
      // 「记住密码」按本次登录勾选记录历史账号并保存/清除密文；历史账号始终记录（供下拉选择与管理）。
      // 无条件执行：竞态下自动登录可能先成功并关掉登录窗，迟到的手动登录结果送不回渲染层，
      // 账号历史与偏好不能依赖渲染层的 setConfig 补写。持久化失败不影响本次登录。
      try {
        persistLoginAccount(serverBase, loginId, isRememberPassword, password);
      } catch (error) {
        console.warn('[auth] 记录历史账号失败（不影响登录）：', error);
      }
      // 竞态守卫：等待期间可能已有会话（如自动登录先成功开窗），迟到的成功不再开第二扇主窗
      if (!getSession()) await keepSession(serverBase, result.data, loginId);
    }
    return result;
  });

  // 发送登录短信验证码（SvrUserLogin.getToken verifyCode 指令；服务端 5 分钟冷却）
  ipcMain.handle('auth:login-send-code', async (event, request: unknown) => {
    if (event.sender !== loginWindow?.webContents || !isShellUrl(event.sender.getURL())) return invalid('仅登录窗口可发送验证码');
    if (!(await updateService.isCompatible())) return invalid('当前版本过低，请先更新客户端');
    const loginId = readString((request as { loginId?: unknown } | null)?.loginId).trim();
    const password = readString((request as { password?: unknown } | null)?.password);
    if (!loginId || !password) return invalid('账号和密码不能为空');
    return serverApi.svrSendLoginVerifyCode(getConfig().serverBase, getConfig().machineCode, loginId, password);
  });

  // 登录窗自绘 × 关闭按钮（macOS 隐藏原生红绿灯后唯一的关闭入口）
  ipcMain.handle('app:close-login', (event) => {
    if (event.sender !== loginWindow?.webContents) return;
    loginWindow?.close();
  });

  // 自动登录：config 保存的账号 + safeStorage 密文密码走 SvrUserLogin.getToken，成功复用 keepSession 开窗
  ipcMain.handle('auth:auto-login', async (event) => {
    if (event.sender !== loginWindow?.webContents) return invalid('仅登录窗口可执行认证');
    if (!(await updateService.isCompatible())) return invalid('当前版本过低，请先更新客户端');
    if (getSession()) return invalid('当前已经登录');
    const config = getConfig();
    if (!config.autoLogin) {
      return { ok: false as const, code: 0, message: '自动登录未开启' };
    }
    if (!config.savedLoginId || !config.savedPassword) {
      return { ok: false as const, code: 0, message: '无已保存的登录凭据，请手动登录' };
    }
    let savedPlain = '';
    try {
      savedPlain = safeStorage.decryptString(Buffer.from(config.savedPassword, 'base64'));
    } catch (error) {
      console.warn('[auth] 已保存密码解密失败，转手动登录：', error);
      return { ok: false as const, code: 0, message: '已保存的密码无法解密，请手动登录' };
    }
    if (!savedPlain) return { ok: false as const, code: 0, message: '已保存的密码为空，请手动登录' };
    const result = await serverApi.svrUserLogin(
      config.serverBase,
      config.machineCode,
      config.savedLoginId,
      savedPlain,
    );
    if (updateService.getState().isRequired) return invalid('当前版本过低，请先更新客户端');
    // 竞态守卫：等待期间用户可能已手动登录成功（会话已建立），迟到的成功忽略，避免开出第二扇主窗
    if (result.ok) {
      // 自动登录成功即刷最近登录时间，保证下次启动/下拉顺序仍以最近使用的账号优先；失败不影响登录
      try {
        touchSavedAccount(config.savedLoginId, config.serverBase);
      } catch (error) {
        console.warn('[auth] 刷新历史账号最近登录时间失败（不影响登录）：', error);
      }
      if (!getSession()) await keepSession(config.serverBase, result.data, config.savedLoginId);
    }
    return result;
  });

  // 历史账号：登录页下拉展示、选择时按需解密密码、逐条删除、清空
  ipcMain.handle('auth:list-saved-accounts', () => listSavedAccounts());

  ipcMain.handle('auth:get-saved-account-password', (event, request: unknown) => {
    // 明文密码只允许登录窗读取，避免主窗/置顶弹窗的本地页面顺手解任意历史密码
    if (!loginWindow || event.sender !== loginWindow.webContents) return invalid('仅登录窗可读取历史密码');
    const key = readSavedAccountKey(request);
    if (!key.loginId || !key.serverBase) return invalid('账号和服务器地址不能为空');
    const account = findSavedAccount(key);
    if (!account) return invalid('历史账号不存在或已被删除');
    if (!account.passwordCipher) return invalid('该账号未保存密码，请手动输入');
    try {
      const password = safeStorage.decryptString(Buffer.from(account.passwordCipher, 'base64'));
      if (!password) return invalid('该账号保存的密码为空，请手动输入');
      return { ok: true as const, data: password };
    } catch (error) {
      console.warn('[auth] 历史账号密码解密失败：', error);
      return invalid('已保存的密码无法解密，请手动输入');
    }
  });

  ipcMain.handle('auth:remove-saved-account', (_event, request: unknown) => {
    const key = readSavedAccountKey(request);
    if (!key.loginId || !key.serverBase) return invalid('账号和服务器地址不能为空');
    try {
      // 删除与自动登录凭据清理在同一次落盘内完成
      if (!removeSavedAccount(key.loginId, key.serverBase)) return invalid('历史账号不存在或已被删除');
    } catch (error) {
      console.warn('[auth] 删除历史账号落盘失败：', error);
      return invalid('保存历史账号失败，请重试');
    }
    return { ok: true as const, data: listSavedAccounts() };
  });

  ipcMain.handle('auth:clear-saved-accounts', () => {
    try {
      // 历史账号与自动登录凭据在同一次落盘内清空
      clearSavedAccounts();
    } catch (error) {
      console.warn('[auth] 清空历史账号落盘失败：', error);
      return invalid('保存历史账号失败，请重试');
    }
    return { ok: true as const, data: listSavedAccounts() };
  });

  // 退出登录：本地登出必然完成（服务端失败不阻塞）；主窗随即销毁，回包不保证送达
  ipcMain.handle('auth:logout', (event) => {
    if (event.sender !== mainWindow?.webContents || !isShellUrl(event.sender.getURL())) return;
    performLogout();
  });

  ipcMain.handle('auth:relogin', async (event) => {
    const owner = mainWindow;
    if (!owner || event.sender !== owner.webContents || !isShellUrl(event.sender.getURL())) return invalid('无权重新登录');
    if (isConfirmingRelogin || isLoggingOut) return invalid('正在处理重新登录，请稍候');
    if (corpSwitch.getActive()) return invalid('正在切换或核验账套，请稍后重试');
    const session = getSession();
    if (!session) return invalid('当前登录已结束');
    isConfirmingRelogin = true;
    try {
      const result = await dialog.showMessageBox(owner, {
        type: 'warning', title: '重新登录', message: '返回登录页？',
        detail: '请先保存需要保留的表单。继续将关闭全部业务标签并退出当前登录，随后可更换账号。网络不可用时也会完成本地退出。',
        buttons: ['取消，返回保存', '退出并重新登录'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) return { ok: true, data: false };
      if (getSession() !== session || owner.isDestroyed()) return invalid('登录状态已变化，请重试');
      if (corpSwitch.getActive()) return invalid('正在切换或核验账套，请稍后重试');
      performLogout();
      return { ok: true, data: true };
    } finally { isConfirmingRelogin = false; }
  });

  // 一键反馈：主窗整窗截图（PNG 字节回渲染层标注，不在此写剪贴板）
  ipcMain.handle('feedback:capture-screenshot', () => captureFeedbackScreenshot());

  // 一键反馈：标注后的 PNG 写系统剪贴板，成功后渲染层再启动微信/企业微信
  ipcMain.handle('feedback:copy-image', (_event, source: unknown) => copyFeedbackImage(source));

  // 一键反馈：启动/前置微信、企业微信（只启动，不模拟粘贴）
  ipcMain.handle('feedback:open-app', async (_event, target: unknown) => {
    if (target !== 'wechat' && target !== 'wecom') return invalid('反馈聊天应用参数不正确');
    const failure = await openFeedbackChatApp(target);
    return failure ?? { ok: true };
  });

  // 一键反馈：标注编辑器打开状态（主窗级开关；打开期间主窗接管 Esc/撤销/重做/⌘W）
  ipcMain.on('feedback:editor-active', (event, isActive: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    isFeedbackEditorActive = isActive === true;
  });

  registerTabsIpcHandlers();
  registerNotifyIpcHandlers();
}

/** MQTT 状态与重要消息置顶弹窗 IPC */
function registerNotifyIpcHandlers(): void {
  ipcMain.handle('mqtt:get-state', (event) => {
    if (event.sender !== mainWindow?.webContents || !isShellUrl(event.sender.getURL())) throw new Error('无权读取消息状态');
    return mqttService.getState();
  });
  ipcMain.handle('mqtt:refresh', async (event) => {
    if (event.sender !== mainWindow?.webContents || !isShellUrl(event.sender.getURL())) throw new Error('无权刷新消息状态');
    await mqttService.refreshUnread();
    return mqttService.getState();
  });
  ipcMain.handle('notifications:test', (event) => {
    if (event.sender !== mainWindow?.webContents || !isShellUrl(event.sender.getURL()) || !getSession()) return invalid('仅登录后的客户端可测试通知');
    if (!Notification.isSupported()) return invalid('当前系统不支持桌面通知');
    try {
      testNotification?.close();
      const notification = new Notification({ title: '帝擎 · 测试通知', body: '看到这条通知，说明本机系统通知可以显示。此测试不会产生业务消息。' });
      testNotification = notification;
      const release = () => { if (testNotification === notification) testNotification = null; };
      notification.on('close', release);
      notification.on('failed', release);
      notification.show();
      return { ok: true, data: null };
    } catch { return invalid('无法请求系统通知，请检查系统通知设置'); }
  });

  ipcMain.handle('notify-popup:get', (event) => {
    if (!importantNotifier.isSender(event.sender)) return null;
    const payload = importantNotifier.getPayload();
    if (!payload) return null;
    return {
      title: payload.subject || '紧急消息',
      body: `${payload.senderName ? `${payload.senderName}：` : ''}${toPlainExcerpt(payload.content || payload.subject)}`,
      corpName: resolveCorpName(payload.corpNo, getCorpList()) || payload.corpNo,
      pendingCount: importantNotifier.getPendingCount(),
    };
  });
  ipcMain.on('notify-popup:activate', (event) => { if (importantNotifier.isSender(event.sender)) void importantNotifier.activate(); });
  ipcMain.on('notify-popup:close', (event) => { if (importantNotifier.isSender(event.sender)) importantNotifier.dismiss(); });

}

/** 主窗壳 tabs / session IPC；标签状态在渲染层，主进程只做会话与 URL 策略 */
function registerTabsIpcHandlers(): void {
  ipcMain.handle('session:get', () => getSessionSummary());
  ipcMain.on('tabs:active-guest', (event, id: unknown) => {
    if (event.sender !== mainWindow?.webContents) return;
    if (id === null || (typeof id === 'number' && Number.isInteger(id))) requestGate.setActive(id);
  });
  ipcMain.handle('corp-switch:retry', async (event) => {
    if (event.sender !== mainWindow?.webContents) return invalid('无权核验会话');
    return corpSwitch.retryVerification();
  });

  /**
   * 开 URL 统一入口（地址栏 / guest window.open / 消息中心 / 快捷入口）：
   * URL 策略归主进程——分类（ERP 站点家族 / AI 站 / 外域 / 拦截）与站内补 sid/CLIENTID/device
   * 都在此完成，渲染层拿到最终 URL 才创建 <webview>；外域由主进程转系统浏览器。
   */
  ipcMain.handle('tabs:resolve', async (event, request: unknown) => {
    if (event.sender !== mainWindow?.webContents) return invalid('无权打开页面');
    if (updateService.getState().isRequired) return invalid('当前版本过低，请先更新客户端');
    if (corpSwitch.isBlocked()) return invalid('正在切换或核验账套，请稍后重试');
    const typed = (request ?? {}) as TabsResolveRequest;
    const session = getSession();
    if (!session) return invalid('尚未登录');
    let rawUrl = '';
    if (typed.home === true) {
      rawUrl = buildErpUrl(session, session.homeForm);
    } else if (typed.page === 'accounts' || typed.page === 'messages') {
      rawUrl = buildErpUrl(session, typed.page === 'accounts' ? 'TFrmChooseAccount' : 'FrmMyMessage');
    } else if (typed.ai === true) {
      rawUrl = buildAiUrl(session, currentAiBase());
    } else {
      rawUrl = readString(typed.url).trim();
    }
    if (!rawUrl) return invalid('地址不能为空');
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return invalid('地址格式不正确');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return invalid('仅支持 http/https 地址');
    }
    const kind = classifyUrl(rawUrl, session, currentAiBase());
    if (kind !== 'same-server' && kind !== 'ai-site') {
      void shell.openExternal(rawUrl).catch(() => {});
      return { ok: true as const, action: 'external' as const };
    }
    const corpNo = readString(typed.corpNo).trim() || session.corpNo;
    return {
      ok: true as const,
      action: 'in-app' as const,
      url: withSessionParams(rawUrl, session, currentAiBase()),
      corpNo,
    };
  });

  // 壳挂载时取首个标签（登录落点），消费一次；壳整页刷新后不再重复打开
  ipcMain.handle('tabs:pop-entry', () => {
    const entry = pendingEntry;
    pendingEntry = null;
    return entry;
  });
}

app.whenReady().then(() => {
  // 去掉 Electron 默认应用菜单（macOS 顶部会显示 Electron/File/Edit/View/Window，
  // Windows/Linux 是窗口内菜单条），业务壳用不到这些入口。
  // macOS 用空菜单模板而不是 null：null 在 macOS 上会残留上一次的原生菜单栏，
  // 空模板才会真正清空；清空菜单会连带带走 ⌘C/⌘V/⌘Z 等系统快捷键，
  // 已在 handleAppShortcut 里手动补回。
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([]) : null);
  // 必须在创建任何窗口前同步应用主题，首帧的 vibrancy 才不会先取系统外观。
  applyNativeTheme(getConfig());
  requestGate.install();
  registerIpcHandlers();
  updateService.start();
  nativeTheme.on('updated', () => {
    applyWindowTheme();
    broadcastThemeState();
  });
  createLoginWindow();
});

/**
 * webview guest（ERP/AI 标签页）统一拦截，规则与壳导航锁同一 URL 策略：
 * - 菜单卡片新标签：菜单模组页卡片点击按网页版 `_blank` 语义转壳新标签（见 erp-menu-newtab.ts）；
 * - 网页版退出入口（{corpNo}/TFrmLogout 及其 .exit 动作）：不加载网页版退出页，
 *   改走壳退出（performLogout）回壳登录窗，避免壳退出与网页版退出两套流程并存；
 * - window.open / target=_blank：ERP 站点家族与 AI 站转壳新标签（tabs:open-request，
 *   壳经 tabs:resolve 补参后建 <webview>），外域走系统浏览器，应用内一律不开新窗；
 * - 页内导航/重定向：ERP 站点家族与 AI 站放行（正常业务跳转），外域拦下转系统浏览器。
 */
app.on('web-contents-created', (_event, contents) => {
  // 右键菜单对所有 webContents 生效（外壳/登录窗提供文本操作，webview 额外提供刷新）
  installContextMenu(contents, isShellUrl);
  if (contents.getType() !== 'webview') return;
  // 应用快捷键：焦点在 ERP 页面内时同样接管（⌘/Ctrl+B、⌘/Ctrl+, 与 macOS 编辑快捷键）
  contents.on('before-input-event', (event, input) => handleAppShortcut(event, input, contents));
  // 经典菜单页卡片默认走 location.href 同标签替换，与网页版 _blank 不一致：注入补丁转 window.open
  installErpMenuNewTabPatch(contents);
  /** 网页版退出入口统一映射到壳退出；返回是否已受理（受理后不再按普通导航处理） */
  const handleWebLogout = (url: string): boolean => {
    if (!isErpLogoutUrl(url, getSession(), currentAiBase())) return false;
    console.log('[auth] 捕获网页版退出入口，改走外壳退出');
    performLogout();
    return true;
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (handleWebLogout(url)) return { action: 'deny' };
    const kind = classifyUrl(url, getSession(), currentAiBase());
    if (kind === 'same-server' || kind === 'ai-site') {
      sendToShell('tabs:open-request', { url });
    } else if (kind === 'external') {
      void shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (handleWebLogout(url)) {
      event.preventDefault();
      return;
    }
    const kind = classifyUrl(url, getSession(), currentAiBase());
    if (kind === 'same-server' || kind === 'ai-site') return;
    event.preventDefault();
    if (kind === 'external') void shell.openExternal(url).catch(() => {});
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  // 整页/页内导航后的账套同步（网页版切换账套检测，见 syncSessionCorpFromNavigation）；
  // 页内导航仅主框架参与（SPA pushState 切账套发生在主框架）；
  // 退出入口若绕过 will-navigate（如 SPA pushState），在导航落定后同样改走壳退出。
  contents.on('did-navigate', (_event, url) => {
    if (handleWebLogout(url)) return;
    // 身份变更由请求闸门核验并提交；导航完成不能自行修改主进程会话。
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (handleWebLogout(url)) return;
    // 身份变更由请求闸门核验并提交；导航完成不能自行修改主进程会话。
  });
});

// 真正退出前统一收尾：断开 MQTT、关置顶弹窗、销毁托盘
app.on('before-quit', (event) => {
  if (corpSwitch.getActive()) { isRestartRequested = false; event.preventDefault(); reportSwitchError('正在核验账套切换，请稍候再退出'); return; }
  // 退出获准后才安排重启，避免被账套切换拦下时留下延迟重启请求。
  if (isRestartRequested) {
    isRestartRequested = false;
    app.relaunch();
  }
  isQuitting = true;
  updateService.stop();
  corpSwitch.reset();
  requestGate.reset();
  mqttService.stop('quit');
  importantNotifier.close('quit');
  trayService.destroy();
});

// 登录前（无托盘）关窗即退出；登录后主窗关闭被拦截为隐藏到托盘，不会走到这里，
// 保险起见仍保留"托盘存活期间不退出"
app.on('window-all-closed', () => {
  if (trayService.isActive()) return;
  app.quit();
});

app.on('second-instance', focusExistingWindow);

// macOS 点 Dock 图标：还原已有的主窗或登录窗。
app.on('activate', focusExistingWindow);
