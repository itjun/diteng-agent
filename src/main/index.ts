import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  safeStorage,
  screen,
  shell,
  systemPreferences,
} from 'electron';
import { join } from 'node:path';
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
import { buildAiUrl, buildErpUrl, classifyUrl, isErpLogoutUrl, readErpCorpNo, withSessionParams } from './url-policy';
import { MqttService, toPlainExcerpt, type UnreadMessagePayload } from './mqtt-service';
import { ImportantNotifier } from './important-notifier';
import { TrayService } from './tray-service';
import type {
  AppConfig,
  AppConfigPatch,
  ApiFailure,
  CorpAccount,
  LoginResult,
  MqttState,
  SavedAccountKey,
  SessionInfo,
  TabsResolveRequest,
  ThemeState,
} from '../shared/types';

const DEV_SERVER_URL = 'http://127.0.0.1:5173';
// 对应 --dsw-static-neutral-bluish-950 / 00，避免深色主题下窗口底色闪白
const THEME_DARK_BACKGROUND = '#151517';
const THEME_LIGHT_BACKGROUND = '#ffffff';
// macOS 主窗整窗 vibrancy（dsh desktop 同款）：底色全透明（#RRGGBBAA），让 NSVisualEffectView 材质透出
const MAC_TRANSPARENT_BACKGROUND = '#00000000';
// 主窗壳路由 hash：与登录窗共用同一入口页，仅 hash 区分（App.tsx 判定 #/main，需带斜杠）
const MAIN_WINDOW_HASH = '/main';

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

/**
 * macOS 主窗背景态：可见时透明底 + sidebar vibrancy（材质深浅由 nativeTheme.themeSource 跟随应用主题）；
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
  // 登录窗顶部的系统菜单（File/Edit/View/Window）无业务用途，直接移除菜单栏；
  // macOS 的应用菜单在屏幕顶部系统栏，系统级菜单（Cmd+Q 等）保留不动
  else loginWindow.removeMenu();
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
    // macOS：hiddenInset + 红绿灯落在 rail 顶栏左侧，整窗 sidebar 毛玻璃（rail 由 CSS 半透明透出）；
    // 'active'：失焦时材质保持稳定；'followWindow' 失焦会把侧栏洗白发灰（dsh 同款）
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 16 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'active' as const,
    }),
    // Windows：同样无系统标题栏（内容直达窗口顶边，与 macOS rail 通顶一致），
    // 但不用 titleBarOverlay——它会在整窗顶部压出一条系统 caption（旧版"空白栏"）；
    // 窗口控制（—/□/×）由壳内容列顶部 caption 条自绘（window:minimize 等 IPC）
    ...(process.platform === 'win32' && { titleBarStyle: 'hidden' as const }),
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
  // 自绘 caption（Windows）的最大化态推送：□/❐ 图标随窗口最大化/还原切换
  mainWindow.on('maximize', () => sendToShell('window:maximized-changed', true));
  mainWindow.on('unmaximize', () => sendToShell('window:maximized-changed', false));
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
  const isDark = resolveIsDarkTheme(getConfig());
  const color = isDark ? THEME_DARK_BACKGROUND : THEME_LIGHT_BACKGROUND;
  loginWindow?.setBackgroundColor(color);
  if (process.platform === 'darwin') {
    // 主窗可见时保持透明（vibrancy 材质深浅跟随应用主题）；不可见期间的兜底底色随主题刷新
    applyMacMainWindowBackdrop();
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
async function keepSession(serverBase: string, result: LoginResult): Promise<void> {
  const config = getConfig();
  const session: SessionInfo = {
    serverBase,
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
  // 账套列表失败不影响登录，仅 corpName 留空（后续切换账套/打开账套列表时再补）
  const [info, corps] = await Promise.all([
    serverApi.getTokenInfo(serverBase, session.machineCode, result.token),
    serverApi.listMyLivingUsers(serverBase, result.token, session.machineCode),
  ]);
  saveCorpList(corps.ok ? corps.data : []);
  if (!corps.ok) console.warn(`[auth] 登录后拉取账套列表失败（账套名称暂缺）：${corps.message}`);
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
  if (getSession() !== session) return;
  if (patch) {
    applyTokenSessionPatch(session, patch);
    saveSession(session);
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
  if (!session) return; // 未登录（重复触发）：登录窗已存在，避免开出第二扇
  void serverApi.logout(session.serverBase, session.token).then((result) => {
    if (result.ok) console.log('[auth] 服务端登出成功');
    else console.warn(`[auth] 服务端登出失败（不阻塞本地登出）：${result.message}`);
  });
  clearSession();
  // 退出登录只清自动登录凭据（下次冷启动不再自动登录）；savedLoginId 保留供登录页预填账号，
  // 历史账号及其密码密文保留，登录页下拉仍可选中账号并回填密码
  clearAutoLoginCredential();
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

// 账套列表拉取的在途请求：登录/切账套/页内导航可能同时触发，共用同一次只读查询，避免重复请求与后写覆盖
let corpListFetch: Promise<CorpAccount[]> | null = null;

/** 账套显示名：账套简称 ShortName_ 优先，其次子账号名称 Name_；不在列表内返回空串（未知） */
function resolveCorpName(corpNo: string, corpList: CorpAccount[]): string {
  const match = corpList.find((corp) => corp.corpNo === corpNo);
  return match?.shortName || match?.name || '';
}

/**
 * 用账套列表补齐会话的账套名称：登录时列表拉取失败会让 corpName 留空，打开账套列表时顺路补上，
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

/** 切换/登录流程表单页不作为账套同步依据：TFrmChooseAccount 本身挂在 000000 下，浏览切换页不等于已切换 */
const CORP_SYNC_SKIP_FORMS = /(TFrmChooseAccount|FrmLogin|TFrmLogin|FrmLogout|TFrmLogout|FrmVerifyClient)/;

// 页内导航账套同步的并发控制：pendingNavKey 记录在途同步的去重键（sid 或账套号），
// 同一键的连续事件只处理一次；navSyncSeq 保证「后发起的导航优先」——快速连续切账套时，
// 先发起但慢返回的结果若已不是最新序号则丢弃，避免旧账套覆盖新账套。
let pendingNavKey = '';
let navSyncSeq = 0;

/** 开始一次导航同步：同一去重键在途时返回 false（跳过重复事件），否则占用该键并推进序号 */
function beginNavSync(key: string): boolean {
  if (key === pendingNavKey) return false;
  pendingNavKey = key;
  navSyncSeq += 1;
  return true;
}

/** 结束导航同步：只有该键仍归本次同步时才释放（已被更新导航接管则保留，避免破坏后来者去重） */
function finishNavSync(key: string): void {
  if (pendingNavKey === key) pendingNavKey = '';
}

/** 导航同步成功后收尾：落库 + 日志 + 重拉未读（凭证已换） + 推送会话摘要（壳/设置页刷新账套与子账号） */
function commitNavigationSession(session: SessionInfo, source: string): void {
  saveSession(session);
  console.log(
    `[auth] 同步网页切换账套 corpNo=${session.corpNo} corpName=${session.corpName || '(未知)'} ` +
      `userCode=${session.userCode || '(未知)'} token=${session.token.slice(0, 8)}… 来源=${source}`,
  );
  // MQTT topic 按主账号订阅与账套无关，无需重连；凭证已换，重拉未读刷新角标
  void mqttService.refreshUnread();
  pushSessionChanged();
}

/**
 * ERP 页内账套同步：网页版切换账套（页头账套卡片 TFrmChooseAccount.switchUser，按目标
 * 子账号代码切换）发生在 webview 内部，主进程会话不随之更新，壳与设置页的账套号、账套名称、
 * 子账号会滞后。以 getTokenInfo 为权威来源分两条路径同步：
 * - URL 带 sid：直接用该 sid 查 getTokenInfo。经典页切账套只刷新同一 token 的会话选项
 *   （refreshUser 不换 token）再整页跳转，所以「同 sid + 新账套号」也必须重新确认；
 * - URL 不带 sid（SPA 切账套剥掉 URL 凭证）：用 rootToken 免密换票（与壳内
 *   session:switch-corp 同一链路），再对新 token 查 getTokenInfo。
 * 账套号/子账号/用户名一律取 getTokenInfo 返回值（corpNo 缺失时回落 URL 首段账套号，两者一致）；
 * 账套名称按账套列表解析。成功后经 session:changed 下发，AI 站页面不参与同步。
 */
async function syncSessionCorpFromNavigation(rawUrl: string): Promise<void> {
  const session = getSession();
  if (!session) return;
  if (classifyUrl(rawUrl, session, currentAiBase()) !== 'same-server') return;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (CORP_SYNC_SKIP_FORMS.test(parsed.pathname)) return;
  const urlCorpNo = readErpCorpNo(rawUrl);
  const sid = parsed.searchParams.get('sid') || '';

  if (sid) {
    // ① URL 带 sid：以该 token 的 getTokenInfo 为权威。同一凭证且 URL 账套未变 = 普通导航
    // （同账套换表单）无需同步；同一凭证但 URL 账套变了必须同步——经典页切账套走的就是这条路。
    if (sid === session.token && (!urlCorpNo || urlCorpNo === session.corpNo)) return;
    const key = `sid:${sid}`;
    if (!beginNavSync(key)) return;
    const seq = navSyncSeq;
    let patch: TokenSessionPatch | null = null;
    try {
      patch = await resolveTokenSessionPatch(session, sid, urlCorpNo);
    } finally {
      finishNavSync(key); // 异常路径同样释放去重键，避免后续导航被永久跳过
    }
    // await 期间会话被替换（登出/重新登录）或有更新的导航时放弃本次写入
    if (seq !== navSyncSeq || getSession() !== session || !patch) return;
    applyTokenSessionPatch(session, patch);
    session.token = sid;
    // 切账套固定进 FrmDefault，不走喜好页（对齐 TFrmChooseAccount 切换语义）
    session.homeForm = 'FrmDefault';
    commitNavigationSession(session, 'sid');
    return;
  }

  // ② 无 sid（SPA 切账套被剥掉 URL 凭证）：仅当首段账套号与当前会话不同才换票
  if (!urlCorpNo || urlCorpNo === session.corpNo) return;
  const key = `corp:${urlCorpNo}`;
  if (!beginNavSync(key)) return;
  const seq = navSyncSeq;
  let nextToken = '';
  let patch: TokenSessionPatch | null = null;
  try {
    const exchanged = await serverApi.getNuewToken(
      session.serverBase,
      session.token,
      session.rootToken || session.token,
      session.machineCode,
      urlCorpNo,
    );
    // 换票失败只告警、不写会话：页面可能还没切完，留待下一次导航重试
    if (!exchanged.ok) {
      console.warn(
        `[auth] 网页切换账套 ${session.corpNo}->${urlCorpNo} 换票失败，会话保持不变：${exchanged.message}`,
      );
      return;
    }
    nextToken = exchanged.data;
    patch = await resolveTokenSessionPatch(session, nextToken, urlCorpNo);
  } finally {
    finishNavSync(key);
  }
  if (seq !== navSyncSeq || getSession() !== session || !patch) return;
  applyTokenSessionPatch(session, patch);
  session.token = nextToken;
  session.homeForm = 'FrmDefault';
  commitNavigationSession(session, 'exchange');
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
    recordSavedAccountLogin(loginId, serverBase, '', { serverBase, savedLoginId: '', savedPassword: '' });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[auth] safeStorage 加密不可用，本次登录不保存密码（保留已存密文）');
    recordSavedAccountLogin(loginId, serverBase, null);
    return;
  }
  const passwordCipher = safeStorage.encryptString(password).toString('base64');
  recordSavedAccountLogin(loginId, serverBase, passwordCipher, {
    serverBase,
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

/** 从请求里取表单当前服务器地址，缺省回退 config（登录页必填，正常不会走回退） */
function readServerBase(request: unknown): string {
  const fromRequest = readString((request as { serverBase?: unknown } | null)?.serverBase).trim();
  return fromRequest || getConfig().serverBase;
}

function registerIpcHandlers(): void {
  ipcMain.handle('config:get', () => publicConfig());

  // preload 首帧同步读取；只含非敏感主题状态，数据量极小
  ipcMain.on('theme:get-sync', (event) => {
    event.returnValue = currentThemeState();
  });
  ipcMain.handle('theme:get', () => currentThemeState());

  ipcMain.handle('config:set', (_event, patch: unknown) => {
    updateConfig((patch ?? {}) as AppConfigPatch);
    applyNativeTheme(getConfig());
    applyWindowTheme();
    broadcastThemeState();
    return publicConfig();
  });

  ipcMain.handle('auth:login', async (_event, request: unknown) => {
    const loginId = readString((request as { loginId?: unknown } | null)?.loginId).trim();
    const password = readString((request as { password?: unknown } | null)?.password);
    // 设备验证登录（-8 后）携带 6 位短信验证码，同接口完成验证并登录
    const verifyCode = readString((request as { verifyCode?: unknown } | null)?.verifyCode).trim();
    if (!loginId || !password) return invalid('账号和密码不能为空');
    const serverBase = readServerBase(request);
    const isRememberPassword = (request as { rememberPassword?: unknown } | null)?.rememberPassword === true;
    const result = await serverApi.svrUserLogin(
      serverBase,
      getConfig().machineCode,
      loginId,
      password,
      verifyCode || undefined,
    );
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
      if (!getSession()) await keepSession(serverBase, result.data);
    }
    return result;
  });

  // 发送登录短信验证码（SvrUserLogin.getToken verifyCode 指令；服务端 5 分钟冷却）
  ipcMain.handle('auth:login-send-code', async (_event, request: unknown) => {
    const loginId = readString((request as { loginId?: unknown } | null)?.loginId).trim();
    const password = readString((request as { password?: unknown } | null)?.password);
    if (!loginId || !password) return invalid('账号和密码不能为空');
    return serverApi.svrSendLoginVerifyCode(readServerBase(request), getConfig().machineCode, loginId, password);
  });

  // 登录窗自绘 × 关闭按钮（macOS 隐藏原生红绿灯后唯一的关闭入口）
  ipcMain.handle('app:close-login', () => {
    loginWindow?.close();
  });

  // 自动登录：config 保存的账号 + safeStorage 密文密码走 SvrUserLogin.getToken，成功复用 keepSession 开窗
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
    const result = await serverApi.svrUserLogin(
      config.serverBase,
      config.machineCode,
      config.savedLoginId,
      savedPlain,
    );
    // 竞态守卫：等待期间用户可能已手动登录成功（会话已建立），迟到的成功忽略，避免开出第二扇主窗
    if (result.ok) {
      // 自动登录成功即刷最近登录时间，保证下次启动/下拉顺序仍以最近使用的账号优先；失败不影响登录
      try {
        touchSavedAccount(config.savedLoginId, config.serverBase);
      } catch (error) {
        console.warn('[auth] 刷新历史账号最近登录时间失败（不影响登录）：', error);
      }
      if (!getSession()) await keepSession(config.serverBase, result.data);
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
  ipcMain.handle('auth:logout', () => {
    performLogout();
  });

  registerWindowIpcHandlers();
  registerTabsIpcHandlers();
  registerNotifyIpcHandlers();
}

/**
 * 主窗自绘 caption（Windows 无系统标题栏）窗口控制：
 * 渲染层按钮只发意图，动作全部落在主进程；close 不绕过 close 拦截
 * （托盘常驻时与系统 caption 关闭一致，隐藏到托盘而非退出）。
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
    if (cached.length > 0) {
      backfillCorpName(session, cached);
      return { ok: true as const, data: cached };
    }
    const result = await serverApi.listMyLivingUsers(session.serverBase, session.token, session.machineCode);
    if (result.ok) {
      saveCorpList(result.data);
      // 登录时账套列表拉取失败会让 corpName 留空，这里顺路补齐（不覆盖已有名称）
      if (getSession() === session) backfillCorpName(session, result.data);
    }
    return result;
  });

  // 账套切换：getNuewToken 免密换票 → getTokenInfo 取权威会话信息 → 广播 corp:switched，
  // 壳（标签状态在渲染层）关旧账套标签并开新首页
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
    // 竞态：等待换票期间会话可能已被替换（登出/并发切换），新 token 不再写入旧会话
    if (getSession() !== session) return invalid('会话已失效，请重新登录');
    // 新 token 绑定的账套号/子账号/用户名以 getTokenInfo 为准（网页版切账套后 token 已换成目标账套）；
    // 查询失败不阻断切换：凭证已换，退化为账套列表缓存的子账号信息
    const patch = await resolveTokenSessionPatch(session, result.data, corpNo);
    if (getSession() !== session) return invalid('会话已失效，请重新登录');
    // 旧 token 不调 logout：浏览器端可能仍在使用，此处仅本地替换；rootToken 保留供下次切换
    session.token = result.data;
    if (patch) {
      // 账套名称由补丁按账套列表（ShortName_ → Name_）解析
      applyTokenSessionPatch(session, patch);
      if (patch.corpNo !== corpNo) {
        console.warn(`[auth] 切换账套请求 ${corpNo} 与 token 绑定账套 ${patch.corpNo} 不一致，按 token 绑定账套处理`);
      }
    } else {
      session.corpNo = corpNo;
      // 用户代码随账套更新为该账套子账号代码；账号级用户名与账套无关，仅空时借账套名补一次
      session.userCode = target.code;
      if (!session.userName) session.userName = target.name || target.code;
      session.corpName = resolveCorpName(corpNo, getCorpList());
    }
    // 切账套固定进 FrmDefault，不走喜好页（对齐 TFrmChooseAccount 切换语义）
    session.homeForm = 'FrmDefault';
    saveSession(session);
    console.log(
      `[auth] 切换账套成功，corpNo=${session.corpNo} corpName=${session.corpName || '(未知)'} ` +
        `token=${result.data.slice(0, 8)}…`,
    );
    // MQTT topic 按主账号订阅与账套无关，无需重连；仅用新 token 重拉未读刷新角标
    void mqttService.refreshUnread();
    pushSessionChanged();
    // 旧账套页在新 token 下已无访问权：让壳关掉旧账套全部标签（含按账套记账的 AI 标签）并开新首页
    sendToShell('corp:switched', { corpNo: session.corpNo, entryUrl: buildErpUrl(session, session.homeForm) });
    return { ok: true as const, data: getSessionSummary() };
  });

  /**
   * 开 URL 统一入口（地址栏 / guest window.open / 消息中心 / 快捷入口）：
   * URL 策略归主进程——分类（ERP 站点家族 / AI 站 / 外域 / 拦截）与站内补 sid/CLIENTID/device
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
  // 必须在创建任何窗口前同步应用主题，首帧的 vibrancy 才不会先取系统外观。
  applyNativeTheme(getConfig());
  registerIpcHandlers();
  nativeTheme.on('updated', () => {
    applyWindowTheme();
    broadcastThemeState();
  });
  createLoginWindow();
});

/**
 * webview guest（ERP/AI 标签页）统一拦截，规则与壳导航锁同一 URL 策略：
 * - 网页版退出入口（{corpNo}/TFrmLogout 及其 .exit 动作）：不加载网页版退出页，
 *   改走壳退出（performLogout）回壳登录窗，避免壳退出与网页版退出两套流程并存；
 * - window.open / target=_blank：ERP 站点家族与 AI 站转壳新标签（tabs:open-request，
 *   壳经 tabs:resolve 补参后建 <webview>），外域走系统浏览器，应用内一律不开新窗；
 * - 页内导航/重定向：ERP 站点家族与 AI 站放行（正常业务跳转），外域拦下转系统浏览器。
 */
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  /** 网页版退出入口统一映射到壳退出；返回是否已受理（受理后不再按普通导航处理） */
  const handleWebLogout = (url: string): boolean => {
    if (!isErpLogoutUrl(url, getSession(), currentAiBase())) return false;
    console.log(`[auth] 捕获网页版退出入口，改走外壳退出：${url}`);
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
    void syncSessionCorpFromNavigation(url);
  });
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (handleWebLogout(url)) return;
    void syncSessionCorpFromNavigation(url);
  });
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
