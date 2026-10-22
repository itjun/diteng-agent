import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, screen, shell } from 'electron';
import { join } from 'node:path';
import { getConfig, resolveAiBase, saveWindowBounds, updateConfig } from './config';
import * as serverApi from './api';
import { clearSession, getCorpList, getSession, getSessionSummary, saveCorpList, saveSession } from './session-store';
import { buildAiUrl, buildErpUrl, classifyUrl, withSessionParams } from './url-policy';
import { MqttService, toPlainExcerpt, type UnreadMessagePayload } from './mqtt-service';
import { ImportantNotifier } from './important-notifier';
import { TrayService } from './tray-service';
import type { AppConfig, AppConfigPatch, ApiFailure, LoginResult, MqttState, SessionInfo, TabsResolveRequest } from '../shared/types';

const DEV_SERVER_URL = 'http://127.0.0.1:5173';
// 对应 --dsw-static-neutral-bluish-950 / 00，避免深色主题下窗口底色闪白
const THEME_DARK_BACKGROUND = '#151517';
const THEME_LIGHT_BACKGROUND = '#ffffff';
// macOS 主窗整窗 vibrancy（dsh desktop 同款）：底色全透明（#RRGGBBAA），让 NSVisualEffectView 材质透出
const MAC_TRANSPARENT_BACKGROUND = '#00000000';
// 主窗壳路由 hash：与登录窗共用同一入口页，仅 hash 区分（App.tsx 判定 #/main，需带斜杠）
const MAIN_WINDOW_HASH = '/main';
// Windows 标题栏高度与壳 tab 条（40px）对齐，参考 dsh apps/desktop windows-layout.ts
const WINDOWS_TITLEBAR_HEIGHT = 40;

let loginWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
// 主窗创建时的首个标签（forceRedirect 落点或 ERP 首页），壳挂载后经 tabs:pop-entry 取走（仅一次）
let pendingEntry: { url: string; corpNo: string } | null = null;
// 托盘退出（托盘菜单/Dock 退出）时置位，主窗 close 拦截据此放行真正关闭
let isQuitting = false;

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

/** 当前 AI 站基址（config 推导），URL 分类白名单用 */
function currentAiBase(): string {
  return resolveAiBase(getConfig());
}

/** 主进程 → 主窗壳单向推送；壳未开/已销毁时静默丢弃（壳挂载后自会经 resolve 重新拿到状态） */
function sendToShell(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/**
 * 打开消息中心标签：FrmMyMessage（消息管理，execute 重定向到 IM 前端并自动带会话凭证）。
 * 注意不是 FrmMessages：其 execute 已停止使用（仅剩 unreadTotal/mqttConfig 等子接口）。
 * 标签状态在渲染层：URL 交给壳走 tabs:resolve 流程开 <webview>。
 */
function openMessageCenter(): void {
  const session = getSession();
  if (!session) {
    focusMainWindow();
    return;
  }
  focusMainWindow();
  sendToShell('tabs:open-request', { url: buildErpUrl(session, 'FrmMyMessage') });
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
  openMessageCenter,
  onStateChanged: broadcastMqttState,
});

const importantNotifier = new ImportantNotifier({
  loadEntry: (window) => loadShellEntry(window, '/notify-popup'),
  getOwnerWindow: () => mainWindow,
  openMessageCenter,
  onShown: (title) => mqttService.reportPopupShown(title),
});

const trayService = new TrayService({
  showMainWindow: focusMainWindow,
  quitApp: () => {
    isQuitting = true;
    app.quit();
  },
});

function isDevMode(): boolean {
  // 未打包时页面由 vite dev server 提供；打包后加载本地构建产物
  return !app.isPackaged;
}

function resolveIsDarkTheme(config: AppConfig): boolean {
  if (config.theme === 'dark') return true;
  if (config.theme === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

/** macOS vibrancy 兜底底色：对齐 dsh desktop chromeFallbackFill（resolved --dsw-static-neutral-bluish-900 / -50） */
function macVibrancyFallbackFill(): string {
  return resolveIsDarkTheme(getConfig()) ? '#1b1b1c' : '#f9fafb';
}

/**
 * macOS 主窗背景态：可见时透明底 + sidebar vibrancy（材质深浅跟随系统，无需按主题切换）；
 * 最小化/隐藏期间摘除 vibrancy 并铺不透明兜底底——deminiaturize 会晚挂 NSVisualEffectView
 * （electron/electron#25368），透明窗在还原动画里会瞬透桌面，先实底、还原后切回。
 * 与 dsh desktop main.ts applyBackdrop 同做法。
 */
function applyMacMainWindowBackdrop(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || !mainWindow.isVisible()) {
    mainWindow.setVibrancy(null);
    mainWindow.setBackgroundColor(macVibrancyFallbackFill());
  } else {
    mainWindow.setVibrancy('sidebar');
    mainWindow.setBackgroundColor(MAC_TRANSPARENT_BACKGROUND);
  }
}

function createLoginWindow(): void {
  const config = getConfig();
  loginWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    // 登录窗只保留关闭按钮：macOS 隐藏整套原生红绿灯、页面自绘 ×（minimizable:false 只会禁用成灰点，不是消失）；
    // Windows 去掉最小化/最大化后原生标题栏天然只剩 ×
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'diteng agent',
    // 顶部留出页面拖拽区高度，与 App.module.css loginPage padding-top 对应
    ...(process.platform === 'darwin' && { titleBarStyle: 'hidden' as const }),
    backgroundColor: resolveIsDarkTheme(config) ? THEME_DARK_BACKGROUND : THEME_LIGHT_BACKGROUND,
    webPreferences: {
      // 安全基线：渲染层无 Node 能力，仅经 preload 暴露白名单 API
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
    },
  });
  // macOS 隐藏原生红绿灯后由页面自绘 × 关闭按钮（app:close-login）
  if (process.platform === 'darwin') loginWindow.setWindowButtonVisibility(false);
  loginWindow.once('ready-to-show', () => loginWindow?.show());
  loginWindow.on('closed', () => {
    loginWindow = null;
  });
  if (isDevMode()) void loginWindow.loadURL(DEV_SERVER_URL);
  else void loginWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

/** 壳页面自身允许加载的 URL：dev 为 vite 入口，打包后为本地 index.html（含 #main hash 切换） */
function isShellUrl(url: string): boolean {
  if (isDevMode()) {
    try {
      return new URL(url).origin === new URL(DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  return url.startsWith('file://') && url.endsWith('index.html');
}

/**
 * 登录成功后创建主窗（tab 壳 + 渲染层 <webview> 标签）。
 * 主窗 ready-to-show 后才关登录窗，避免出现零窗口瞬间。
 */
function createMainWindow(session: SessionInfo, entryUrl: string): void {
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
    // macOS 整窗 vibrancy 需要透明底色让材质透出；Windows 维持实心底色
    backgroundColor:
      process.platform === 'darwin' ? MAC_TRANSPARENT_BACKGROUND : isDark ? THEME_DARK_BACKGROUND : THEME_LIGHT_BACKGROUND,
    // macOS：hiddenInset + 红绿灯落在 tab 条左侧，整窗 sidebar 毛玻璃（rail 由 CSS 半透明透出）；
    // Windows：系统 overlay 与 tab 条同高（参考 dsh desktop）
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      // 'active'：失焦时材质保持稳定；'followWindow' 失焦会把侧栏洗白发灰（dsh 同款）
      visualEffectState: 'active' as const,
    }),
    ...(process.platform === 'win32' && {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        height: WINDOWS_TITLEBAR_HEIGHT,
        color: isDark ? THEME_DARK_BACKGROUND : THEME_LIGHT_BACKGROUND,
        symbolColor: isDark ? '#f9fafb' : '#0f1115',
      },
    }),
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
  });

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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    loginWindow?.close();
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
  // macOS/Windows 惯例：托盘常驻期间关窗仅隐藏，托盘"退出"才真正退出；
  // 未登录（无托盘）时保持原行为：关窗即退出
  mainWindow.on('close', (event) => {
    if (!isQuitting && trayService.isActive()) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    pendingEntry = null;
    mainWindow = null;
  });
  loadShellEntry(mainWindow, MAIN_WINDOW_HASH);
}

/** 主题变化时同步原生窗口底色，避免缩放/刷新瞬间露底 */
function applyWindowTheme(): void {
  const color = resolveIsDarkTheme(getConfig()) ? THEME_DARK_BACKGROUND : THEME_LIGHT_BACKGROUND;
  loginWindow?.setBackgroundColor(color);
  if (process.platform === 'darwin') {
    // 主窗可见时保持透明（vibrancy 材质深浅跟随系统）；不可见期间的兜底底色随主题刷新
    applyMacMainWindowBackdrop();
  } else {
    mainWindow?.setBackgroundColor(color);
  }
}

/** 登录成功：会话入库（token 只留主进程内存）并打开主窗 */
function keepSession(serverBase: string, result: LoginResult): void {
  const config = getConfig();
  const session: SessionInfo = {
    serverBase,
    token: result.token,
    // 原始登录 token：账套切换始终用它换新 token（getNuewToken 换出的永久 token 不能再作换票凭据）
    rootToken: result.token,
    userId: result.userId,
    corpNo: result.corpNo,
    homeForm: result.homeForm,
    machineCode: config.machineCode,
    userName: '',
    userCode: '',
  };
  saveSession(session);
  saveCorpList([]);
  // 日志只留 token 前 8 位，避免完整凭据落进控制台
  console.log(
    `[auth] 登录成功，token=${result.token.slice(0, 8)}… corpNo=${result.corpNo} homeForm=${result.homeForm}`,
  );
  // forceRedirect + 绝对 URL（服务端显式指定落点）优先；否则开当前账套首页表单
  const forcedUrl =
    result.forceRedirect && /^https?:\/\//i.test(result.redirectUrl) ? result.redirectUrl : '';
  createMainWindow(session, forcedUrl || buildErpUrl(session, session.homeForm));
  // 登录成功进入托盘常驻 + MQTT 未读通知（mqttConfig 失败仅告警，不阻断主流程）
  trayService.create();
  void mqttService.start(session);
  // 用户显示名后台补齐（不阻塞开窗），就绪后推送会话摘要刷新底部用户行
  void resolveUserDisplay(session);
}

/**
 * 补齐会话的用户显示名与代码：
 * 首选 getTokenInfo（userName 为账号级名称、与账套无关；依据 UserCenterService.getTokenInfo），
 * 失败时回落 listMyLivingUsers 匹配当前账套的 Code_/Name_（顺路暖缓存）。两者都拿不到时保持空串，
 * 渲染层自行回落 savedLoginId 展示。
 */
async function resolveUserDisplay(session: SessionInfo): Promise<void> {
  const info = await serverApi.getTokenInfo(session.serverBase, session.machineCode, session.token);
  if (info.ok) {
    session.userName = info.data.userName || info.data.userCode;
    session.userCode = info.data.userCode;
    saveSession(session);
    pushSessionChanged();
    return;
  }
  console.warn(`[auth] getTokenInfo 失败，回落账套列表取用户名：${info.message}`);
  const list = await serverApi.listMyLivingUsers(session.serverBase, session.token, session.machineCode);
  if (!list.ok) return;
  saveCorpList(list.data);
  const match = list.data.find((corp) => corp.corpNo === session.corpNo);
  if (!match) return;
  session.userName = match.name || match.code;
  session.userCode = match.code;
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
  if (!session) return; // 未登录（重复触发）：登录窗已存在，避免开出第二扇
  void serverApi.logout(session.serverBase, session.token).then((result) => {
    if (result.ok) console.log('[auth] 服务端登出成功');
    else console.warn(`[auth] 服务端登出失败（不阻塞本地登出）：${result.message}`);
  });
  clearSession();
  // 退出登录清除已存密码（下次冷启动不再自动登录）；savedLoginId 保留，登录页继续预填账号
  if (getConfig().savedPassword) updateConfig({ savedPassword: '' });
  mqttService.stop('logout');
  importantNotifier.close('logout');
  trayService.destroy();
  createLoginWindow();
  const closing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!closing) return;
  if (loginWindow) loginWindow.once('ready-to-show', () => closing.close());
  else closing.close();
}

/** 账套切换成功后推送会话摘要，壳据此刷新账套指示 */
function pushSessionChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session:changed', getSessionSummary());
  }
}

/** IPC 入参做最小类型校验，非法输入按失败返回而不是让 handler 抛异常 */
function readString(source: unknown): string {
  return typeof source === 'string' ? source : '';
}

function invalid(message: string): ApiFailure {
  return { ok: false, code: -1, message };
}

/**
 * 按登录页「记住密码」勾选状态保存/清除加密密码：
 * 勾选且 safeStorage 可用时以 base64 密文写入 config.savedPassword（armor 文本）；
 * 未勾选清除已存密文；safeStorage 不可用一律不存（避免明文落盘），仅告警。
 */
function persistSavedPassword(isRemember: boolean, password: string): void {
  if (!isRemember) {
    if (getConfig().savedPassword) updateConfig({ savedPassword: '' });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[auth] safeStorage 加密不可用，本次登录不保存密码（不落明文）');
    return;
  }
  updateConfig({ savedPassword: safeStorage.encryptString(password).toString('base64') });
}

/** 从请求里取表单当前服务器地址，缺省回退 config（登录页必填，正常不会走回退） */
function readServerBase(request: unknown): string {
  const fromRequest = readString((request as { serverBase?: unknown } | null)?.serverBase).trim();
  return fromRequest || getConfig().serverBase;
}

function registerIpcHandlers(): void {
  ipcMain.handle('config:get', () => getConfig());

  ipcMain.handle('config:set', (_event, patch: unknown) => {
    const config = updateConfig((patch ?? {}) as AppConfigPatch);
    applyWindowTheme();
    return config;
  });

  ipcMain.handle('auth:login', async (_event, request: unknown) => {
    const loginId = readString((request as { loginId?: unknown } | null)?.loginId).trim();
    const password = readString((request as { password?: unknown } | null)?.password);
    if (!loginId || !password) return invalid('账号和密码不能为空');
    const serverBase = readServerBase(request);
    const isRememberPassword = (request as { rememberPassword?: unknown } | null)?.rememberPassword === true;
    const result = await serverApi.loginByPassword(serverBase, getConfig().machineCode, loginId, password);
    if (result.ok) {
      // 「记住密码」按本次登录勾选落盘（取消勾选即清除已存密码）；
      // 无条件执行：竞态下自动登录可能先成功并关掉登录窗，迟到的手动登录结果送不回渲染层，
      // 清除偏好不能依赖渲染层的 setConfig 补写
      persistSavedPassword(isRememberPassword, password);
      // 竞态守卫：等待期间可能已有会话（如自动登录先成功开窗），迟到的成功不再开第二扇主窗
      if (!getSession()) keepSession(serverBase, result.data);
    }
    return result;
  });

  ipcMain.handle('auth:check-code', (_event, request: unknown) => {
    const config = getConfig();
    return serverApi.getCheckCode(readServerBase(request), config.machineCode);
  });

  ipcMain.handle('auth:sms-send', async (_event, request: unknown) => {
    const loginId = readString((request as { loginId?: unknown } | null)?.loginId).trim();
    const checkCode = readString((request as { checkCode?: unknown } | null)?.checkCode).trim();
    if (!loginId || !checkCode) return invalid('账号和图形验证码不能为空');
    const config = getConfig();
    return serverApi.sendVerifyCode(
      readServerBase(request),
      config.machineCode,
      loginId,
      checkCode,
    );
  });

  ipcMain.handle('auth:sms-login', async (_event, request: unknown) => {
    const loginId = readString((request as { loginId?: unknown } | null)?.loginId).trim();
    const verifyCode = readString((request as { verifyCode?: unknown } | null)?.verifyCode).trim();
    if (!loginId || !verifyCode) return invalid('账号和短信验证码不能为空');
    const serverBase = readServerBase(request);
    const result = await serverApi.getTokenBySms(serverBase, getConfig().machineCode, loginId, verifyCode);
    if (result.ok && !getSession()) {
      // 短信登录无密码可存，不写 savedPassword（已有密文保持原样，供下次冷启动自动登录）
      keepSession(serverBase, result.data);
    }
    return result;
  });

  // 登录窗自绘 × 关闭按钮（macOS 隐藏原生红绿灯后唯一的关闭入口）
  ipcMain.handle('app:close-login', () => {
    loginWindow?.close();
  });

  // 自动登录：config 保存的账号 + safeStorage 密文密码走 loginByPassword，成功复用 keepSession 开窗
  ipcMain.handle('auth:auto-login', async () => {
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
    const result = await serverApi.loginByPassword(config.serverBase, config.machineCode, config.savedLoginId, savedPlain);
    // 竞态守卫：等待期间用户可能已手动登录成功（会话已建立），迟到的成功忽略，避免开出第二扇主窗
    if (result.ok && !getSession()) keepSession(config.serverBase, result.data);
    return result;
  });

  // 取已保存凭据（记住密码✓ 且自动登录✗ 时登录页预填账号与密码）
  ipcMain.handle('auth:get-saved-credential', () => {
    const config = getConfig();
    if (!config.savedLoginId || !config.savedPassword) {
      return { ok: false as const, code: 0, message: '未保存登录凭据' };
    }
    try {
      const password = safeStorage.decryptString(Buffer.from(config.savedPassword, 'base64'));
      if (!password) return { ok: false as const, code: 0, message: '未保存登录凭据' };
      return { ok: true as const, data: { loginId: config.savedLoginId, password } };
    } catch (error) {
      console.warn('[auth] 预填密码解密失败：', error);
      return { ok: false as const, code: 0, message: '已保存的密码无法解密' };
    }
  });

  // 退出登录：本地登出必然完成（服务端失败不阻塞）；主窗随即销毁，回包不保证送达
  ipcMain.handle('auth:logout', () => {
    performLogout();
  });

  registerTabsIpcHandlers();
  registerNotifyIpcHandlers();
}

/** MQTT 状态与重要消息置顶弹窗 IPC */
function registerNotifyIpcHandlers(): void {
  ipcMain.handle('mqtt:get-state', () => mqttService.getState());

  ipcMain.handle('notify-popup:get', () => {
    const payload = importantNotifier.getPayload();
    if (!payload) return null;
    // 弹窗文案与系统通知同源：标题=摘要（缺省"紧急消息"），正文=发送人+内容摘要（去 HTML）
    return {
      title: payload.subject || '紧急消息',
      body: payload.senderName
        ? `${payload.senderName}：${toPlainExcerpt(payload.subject || payload.content)}`
        : toPlainExcerpt(payload.subject || payload.content),
    };
  });

  ipcMain.on('notify-popup:activate', () => importantNotifier.activate());
  ipcMain.on('notify-popup:close', () => importantNotifier.close('user'));
  ipcMain.on('notify-popup:hover', (_event, value: unknown) => {
    if (value === true) importantNotifier.pauseAutoClose();
    else importantNotifier.armAutoClose();
  });
}

/** 主窗壳 tabs / session IPC；标签状态在渲染层，主进程只做会话与 URL 策略 */
function registerTabsIpcHandlers(): void {
  ipcMain.handle('session:get', () => getSessionSummary());

  // 可用账套列表：主进程缓存，无缓存时走 listMyLivingUsers（仅查询）
  ipcMain.handle('session:list-corps', async () => {
    const session = getSession();
    if (!session) return invalid('尚未登录');
    const cached = getCorpList();
    if (cached.length > 0) return { ok: true as const, data: cached };
    const result = await serverApi.listMyLivingUsers(session.serverBase, session.token, session.machineCode);
    if (result.ok) saveCorpList(result.data);
    return result;
  });

  // 账套切换：getNuewToken 免密换票 → 广播 corp:switched，壳（标签状态在渲染层）关旧账套标签并开新首页
  ipcMain.handle('session:switch-corp', async (_event, request: unknown) => {
    const corpNo = readString((request as { corpNo?: unknown } | null)?.corpNo).trim();
    const session = getSession();
    if (!session) return invalid('尚未登录');
    if (!corpNo) return invalid('目标账套不能为空');
    // 幂等：切当前账套直接成功返回
    if (corpNo === session.corpNo) return { ok: true as const, data: getSessionSummary() };
    // 目标必须在缓存列表内（防拼corpNo越权；服务端 getNuewToken 仍会校验）
    const target = getCorpList().find((corp) => corp.corpNo === corpNo);
    if (!target) return invalid('目标账套不在可用列表，请刷新后重试');
    // 请求 sid 用当前 token（会话存活），换票凭据固定用 rootToken
    const result = await serverApi.getNuewToken(
      session.serverBase,
      session.token,
      session.rootToken || session.token,
      session.machineCode,
      corpNo,
    );
    if (!result.ok) return result;
    // 旧 token 不调 logout：浏览器端可能仍在使用，此处仅本地替换；rootToken 保留供下次切换
    session.token = result.data;
    session.corpNo = corpNo;
    // 切账套固定进 FrmDefault，不走喜好页（对齐 TFrmChooseAccount 切换语义）
    session.homeForm = 'FrmDefault';
    // 用户代码随账套更新为该账套子账号代码；账号级用户名与账套无关，仅空时借账套名补一次
    session.userCode = target.code;
    if (!session.userName) session.userName = target.name || target.code;
    saveSession(session);
    console.log(`[auth] 切换账套成功，corpNo=${corpNo} token=${result.data.slice(0, 8)}…`);
    // MQTT topic 按主账号订阅与账套无关，无需重连；仅用新 token 重拉未读刷新角标
    void mqttService.refreshUnread();
    pushSessionChanged();
    // 旧账套页在新 token 下已无访问权：让壳关掉旧账套全部标签（含按账套记账的 AI 标签）并开新首页
    sendToShell('corp:switched', { corpNo, entryUrl: buildErpUrl(session, session.homeForm) });
    return { ok: true as const, data: getSessionSummary() };
  });

  /**
   * 开 URL 统一入口（地址栏 / guest window.open / 消息中心 / 快捷入口）：
   * URL 策略归主进程——分类（同 serverBase / AI 站 / 外域 / 拦截）与同域补 sid/CLIENTID/device
   * 都在此完成，渲染层拿到最终 URL 才创建 <webview>；外域由主进程转系统浏览器。
   */
  ipcMain.handle('tabs:resolve', (_event, request: unknown) => {
    const typed = (request ?? {}) as TabsResolveRequest;
    const session = getSession();
    if (!session) return invalid('尚未登录');
    let rawUrl = '';
    if (typed.home === true) {
      rawUrl = buildErpUrl(session, session.homeForm);
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
    return { ok: true as const, action: 'in-app' as const, url: withSessionParams(rawUrl, session), corpNo };
  });

  // 壳挂载时取首个标签（登录落点），消费一次；壳整页刷新后不再重复打开
  ipcMain.handle('tabs:pop-entry', () => {
    const entry = pendingEntry;
    pendingEntry = null;
    return entry;
  });
}

app.whenReady().then(() => {
  getConfig();
  registerIpcHandlers();
  nativeTheme.on('updated', applyWindowTheme);
  createLoginWindow();
});

/**
 * webview guest（ERP/AI 标签页）统一拦截，规则与壳导航锁同一 URL 策略：
 * - window.open / target=_blank：同 serverBase 与 AI 站转壳新标签（tabs:open-request，
 *   壳经 tabs:resolve 补参后建 <webview>），外域走系统浏览器，应用内一律不开新窗；
 * - 页内导航/重定向：同 serverBase 与 AI 站放行（正常业务跳转），外域拦下转系统浏览器。
 */
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    const kind = classifyUrl(url, getSession(), currentAiBase());
    if (kind === 'same-server' || kind === 'ai-site') {
      sendToShell('tabs:open-request', { url });
    } else if (kind === 'external') {
      void shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  const guardNavigation = (event: Electron.Event, url: string) => {
    const kind = classifyUrl(url, getSession(), currentAiBase());
    if (kind === 'same-server' || kind === 'ai-site') return;
    event.preventDefault();
    if (kind === 'external') void shell.openExternal(url).catch(() => {});
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
});

// 真正退出前统一收尾：断开 MQTT、关置顶弹窗、销毁托盘
app.on('before-quit', () => {
  isQuitting = true;
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

// macOS 点 Dock 图标：有主窗则还原显示（无窗时保持登录前不自动开窗的原行为）
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) focusMainWindow();
});
