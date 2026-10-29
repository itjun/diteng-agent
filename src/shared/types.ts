/**
 * 主进程 / preload / renderer 三方共享的契约类型。
 * renderer 侧对纯类型一律 `import type`，对常量（DEVICE_UNCHECKED_CODE）按值导入。
 */

/** 主题设置：默认跟随系统，手动切换后存入 config.theme */
export type ThemeSetting = 'system' | 'light' | 'dark';

/**
 * 外围颜色（rail 侧栏 + 内容卡片四周留白的底色）：
 * auto = 自动黑白灰（跟随深浅色主题的中性实底，默认值），其余为 Dia 式低饱和预设色。
 * 地址栏跟随网页内容取色，不属于外围色。
 */
export type { ChromeColor } from './appearance';
import type { ChromeColor } from './appearance';

/** 主进程统一解析后的应用实际外观；所有窗口共用，避免原生窗口与 CSS 主题分叉 */
export interface ThemeState {
  setting: ThemeSetting;
  resolved: 'light' | 'dark';
}

/**
 * 主窗实际材质：macOS 磨砂、Windows 11 22H2+ 云母，或不透明底色。
 */
export type WindowMaterial = 'vibrancy' | 'mica' | 'none';
export type WindowStyle = 'auto' | 'classic' | 'translucent';
export interface WindowStyleState {
  setting: WindowStyle;
  material: WindowMaterial;
}

/** userData/config.json 的持久化结构 */
export interface AppConfig {
  /** 配置结构版本：3 = 服务器固定为构建环境，旧凭据按原服务器隔离。 */
  configVersion: number;
  /** 打包时确定的后端地址，运行时只读。 */
  readonly serverBase: string;
  /** AI 对话站地址；空串表示未手动设置，按 serverBase 推导（cdcp.site → https://ai.cdcp.site，否则 http://127.0.0.1:3060） */
  aiBase: string;
  /** 设备机器码，首次启动生成后终身持久化，渲染层不可修改 */
  machineCode: string;
  /**
   * 自动登录兼容凭据：最近一次登录且勾选「记住密码」时写入的登录 ID；
   * 未勾选或退出登录后可能为空。历史账号列表由主进程单独维护，不下发渲染层。
   */
  savedLoginId: string;
  /**
   * 自动登录兼容凭据：savedLoginId 对应的密码密文（safeStorage 加密后的 base64 文本），
   * 空串表示无自动登录凭据；同时会同步到历史账号中该账号的记录。仅主进程可解密。
   */
  savedPassword: string;
  theme: ThemeSetting;
  /** 窗口材质：自动、实色或半透明。 */
  windowStyle: WindowStyle;
  /** 外围颜色：rail 侧栏与内容卡片四周留白的底色；默认 auto（黑白灰实底，跟随深浅色主题） */
  chromeColor: ChromeColor;
  /** 上次关闭时的主窗大小；null = 从未记录（首启用主屏工作区 80% 作默认）。仅主进程读写 */
  windowBounds: WindowBounds | null;
  /** 标签侧栏宽度（200–480）；0 = 默认 224，兼容旧版自定义宽度。仅渲染层使用 */
  railWidth: number;
  /** 登录页「记住密码」勾选状态（通用软件两勾选设计），默认 true */
  rememberPassword: boolean;
  /** 登录页「自动登录」勾选状态；仅在记住密码勾选时可开，默认 true */
  autoLogin: boolean;
  /** 新客户端独立的系统通知与紧急置顶开关，不修改旧终端设置。 */
  systemNotifications: boolean;
  importantPopups: boolean;
  autoCheckUpdates: boolean;
  autoDownloadUpdates: boolean;
}

/** 主窗尺寸记录（只记宽高，不记位置） */
export interface WindowBounds {
  width: number;
  height: number;
}

/** 本机只读信息；硬件 UUID 与登录使用的 CLIENTID 分开显示。 */
export interface DeviceInfo {
  hostname: string;
  model: string | null;
  hardwareId: string | null;
  hardwareError: string;
  clientId: string;
  system: string;
  architecture: string;
  cpu: string;
  cpuCores: number;
  memoryTotal: number;
  memoryFree: number;
  storage: { total: number; available: number } | null;
  storageError: string;
  displays: { name: string; width: number; height: number; scaleFactor: number; isPrimary: boolean }[];
  networks: { name: string; mac: string; addresses: { address: string; family: string; netmask: string }[] }[];
  dnsServers: string[];
  appVersion: string;
}

/**
 * config:set 允许更新的字段。自动登录凭据（savedLoginId/savedPassword）只由主进程账号存储写入，
 * 不在渲染层可写范围内；serverBase 由构建确定，machineCode/windowBounds 仅主进程维护。
 */
export type AppConfigPatch = Partial<
  Pick<AppConfig, 'aiBase' | 'theme' | 'windowStyle' | 'chromeColor' | 'railWidth' | 'rememberPassword' | 'autoLogin' | 'systemNotifications' | 'importantPopups' | 'autoCheckUpdates' | 'autoDownloadUpdates'>
>;

/**
 * 历史登录账号摘要（登录页下拉展示与管理用）。
 * 密码密文只存主进程 config.json，这里仅下发「是否已记住密码」，需要密码时按账号单独解密。
 */
export interface SavedAccountSummary {
  loginId: string;
  serverBase: string;
  /** 该账号是否已记住密码（主进程持密文，可解密） */
  hasPassword: boolean;
  /** 最近一次成功登录时间（epoch ms）；0 表示旧版配置迁移而来（原时间未知） */
  lastLoginAt: number;
}

/** 历史账号定位：账号 + 服务器地址唯一确定一条记录（同一账号可登录不同服务器） */
export interface SavedAccountKey {
  loginId: string;
  serverBase: string;
}

/**
 * 登录成功响应（网页版同款 SvrUserLogin.getToken 的 head 出参映射；userId 不随登录返回，由主进程 getTokenInfo 回填）。
 * 外围应用须按 forceRedirect + redirectUrl 处理跳转，主窗壳在下一步使用。
 */
export interface LoginResult {
  token: string;
  forceRedirect: boolean;
  redirectUrl: string;
  corpNo: string;
  homeForm: string;
  userId: string;
  machineCode: string;
}

/**
 * 主进程 HTTP 调用的统一返回。
 * ok=false 时 code 含义：-8 设备未验证（须转短信验证码登录）、0 参数/业务错误、
 * -1 网络或解析异常；其余为后端透传的 HTTP 状态码。
 */
export type ApiCallResult<T> = { ok: true; data: T } | ApiFailure;

export interface ApiFailure {
  ok: false;
  code: number;
  message: string;
}

/** UserServerController ApiErrorCode.DEVICE_UNCHECKED：HTTP 400 + {"code":-8,"message":"..."} */
export const DEVICE_UNCHECKED_CODE = -8;

/**
 * auth:login 请求参数；服务器地址由主进程的构建配置决定。
 * verifyCode 为 6 位短信验证码（密码登录返回 -8 设备未验证后携带，同接口完成验证并登录）。
 */
export interface LoginRequest {
  loginId: string;
  password: string;
  /** 「记住密码」勾选状态：成功后主进程据此加密保存/清除 config.savedPassword */
  rememberPassword: boolean;
  /** 短信验证码（设备验证登录）；密码登录不传 */
  verifyCode?: string;
}

/** auth:login-send-code 请求参数：同登录接口 verifyCode="??????" 指令发送短信（服务端 5 分钟冷却） */
export interface LoginSendCodeRequest {
  loginId: string;
  /** 发码须先通过密码校验，与服务端 SvrUserLogin.getToken 流程一致 */
  password: string;
}

/**
 * 主进程内存中的登录会话（登录成功时填入）。
 * rootToken 为本次登录的原始 token：getNuewToken 换出的目标账套 token 是永久令牌（viability=999999），
 * 不能再次作为 current_book_token，故始终用 rootToken 换取任意账套 token。
 */
export interface SessionInfo {
  serverBase: string;
  /** 本次登录实际输入的账号，切账套后保留，不作为凭据使用 */
  loginId?: string;
  token: string;
  /** 原始登录 token（账套切换的换票根凭据），登录时等于 token，切换后不变 */
  rootToken: string;
  userId: string;
  corpNo: string;
  /** 当前账套名称：listMyLivingUsers 的 ShortName_ 优先、否则 Name_；空串表示尚未取到 */
  corpName: string;
  homeForm: string;
  machineCode: string;
  /** 用户显示名（账号级、账套无关）：登录后 getTokenInfo 回填，空表示尚未取到 */
  userName: string;
  /** 当前子账号代码（当前 token 绑定的子账号）：登录/切账套后 getTokenInfo 回填 */
  userCode: string;
}

/** renderer 可见的会话摘要（不含 token 等凭据，仅展示用） */
export interface SessionSummary {
  serverBase: string;
  loginId?: string;
  userId: string;
  corpNo: string;
  /** 当前账套名称（账套列表 ShortName_ 优先、否则 Name_）；空串表示未知，渲染层可回落 corpNo */
  corpName: string;
  homeForm: string;
  /** 登录用户显示名；空串表示主进程尚未取到 */
  userName: string;
  /** 当前子账号代码（当前 token 绑定的子账号）；空串表示未知 */
  userCode: string;
}

/** listMyLivingUsers 返回的一条子账号记录（主进程解析账套名称用，不含凭据） */
export interface CorpAccount {
  /** 账套号（CorpNo_） */
  corpNo: string;
  /** 子账号代码（Code_） */
  code: string;
  /** 子账号名称（Name_） */
  name: string;
  /** 账套简称（ShortName_，可为空） */
  shortName: string;
}

/**
 * 一个 ERP 标签页的元数据（渲染层持有，每 tab 对应一个 <webview>）；
 * favicon 为空串表示尚未取到。
 */
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  favicon: string;
  corpNo: string;
  isLoading: boolean;
}

/** 标签全量状态（渲染层 window.__ditengTabsList 调试快照的返回形态，供 e2e 断言） */
export interface TabsState {
  tabs: TabInfo[];
  activeTabId: string;
}

/**
 * tabs:resolve 请求（URL 策略归主进程）：url / home / ai / page 选择一种。
 * - url：任意地址（地址栏、guest window.open、消息中心入口）
 * - home：当前会话 ERP 首页（{corpNo}/{homeForm}）
 * - ai：AI 对话页（{aiBase}/{corpNo}/chat）
 * - page：当前账套的选择账套页或消息中心，由主进程生成路由
 * corpNo 缺省取当前会话账套，用于渲染层给标签记账套。
 */
export interface TabsResolveRequest {
  url?: string;
  home?: boolean;
  ai?: boolean;
  page?: 'accounts' | 'messages';
  corpNo?: string;
}

/**
 * tabs:resolve 返回：
 * - in-app：最终可加载 URL（ERP 站点家族自动补 sid/CLIENTID/device 已在主进程完成）与标签归属账套
 * - external：外域地址，主进程已转系统浏览器打开，渲染层不建标签
 */
export type TabsResolveResult =
  | { ok: true; action: 'in-app'; url: string; corpNo: string }
  | { ok: true; action: 'external' }
  | ApiFailure;

/** tabs:pop-entry 返回：主窗创建时的首个标签（forceRedirect 落点或 ERP 首页），仅首次挂载可取到 */
export interface TabsEntry {
  url: string;
  corpNo: string;
}

/** tabs:open-request 载荷：guest window.open 等入口请求开新标签 */
export interface TabsOpenRequestPayload {
  url: string;
}

/**
 * 应用级快捷键动作（主进程 before-input-event 统一接管主窗与 webview guest 焦点，
 * 壳收到后执行对应 UI 动作）：⌘/Ctrl+B 展开收起侧栏、⌘/Ctrl+, 打开设置页；
 * editor-* 仅在反馈标注编辑器打开期间下发（Esc 取消、⌘Z 撤销、⇧⌘Z 重做）。
 */
export type ShortcutAction =
  | 'toggle-rail'
  | 'open-settings'
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'editor-cancel'
  | 'editor-undo'
  | 'editor-redo';

/**
 * feedback:capture-screenshot 返回：整窗截图的 PNG 原始字节。
 * 截图只回渲染层做标注，不再由主进程写剪贴板；像素尺寸由渲染层解码后决定
 * （物理像素 = 窗口内容区 DIP × 设备缩放比）。
 */
export type FeedbackScreenshotResult = { ok: true; png: Uint8Array } | ApiFailure;

/**
 * 反馈截图要交给哪个聊天应用：微信 / 企业微信。
 * 壳只负责「复制 + 启动/前置应用」，不选择会话、不模拟粘贴。
 */
export type FeedbackChatApp = 'wechat' | 'wecom';

/** feedback:copy-image 返回：标注后的 PNG 已写入系统剪贴板 */
export type FeedbackCopyResult = { ok: true } | ApiFailure;

/** feedback:open-app 返回：已发起启动/前置（不代表用户一定已登录或已打开聊天窗口） */
export type FeedbackOpenAppResult = { ok: true } | ApiFailure;

/**
 * MQTT 未读通知链路状态（主进程 MqttService 对 renderer / e2e 暴露的只读摘要）。
 * broker/username/password 等连接凭据不下发 renderer，只回连接与订阅结果。
 */
export interface MqttState {
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';
  /** 最近成功同步未读数的时间；失败时保留旧值并附带错误状态 */
  unreadUpdatedAt: number | null;
  unreadError: boolean;
  systemNotificationSupported: boolean;
  /** 是否已连接 broker */
  connected: boolean;
  /** 当前订阅的 topic（{userId}/unreadMessage）；未启动为空串 */
  topic: string;
  /** 最近一次 REST 拉取的未读总数；-1 表示尚未拉取 */
  unread: number;
  /**
   * 最近一次触发的系统通知（通知发送前记录，供 e2e 断言内部事件，
   * 不依赖 macOS 通知授权弹窗）；null 表示尚无。
   */
  lastNotification: { title: string; body: string; at: number } | null;
  /** 最近一次重要消息置顶弹窗的标题；null 表示尚未弹过 */
  lastPopupTitle: string | null;
}

/** mqttConfig（FrmMessages.mqttConfig）返回的连接配置 */
export interface MqttBrokerConfig {
  /** WebSocket 地址，如 ws://mqtt.diteng.vip/mqtt；空串表示服务端未启用 */
  broker: string;
  username: string;
  password: string;
}

/** preload 暴露给渲染层的最小 API（window.diteng） */
export interface CorpSwitchCommitted {
  sourceWebContentsId: number | null;
  generation: number;
  session: SessionSummary;
  url?: string;
}

export interface NotificationPopupContent { title: string; body: string; corpName: string; pendingCount: number; }

export type ContextMenuAction = 'copy-link' | 'cut' | 'copy' | 'paste' | 'select-all' | 'reload';
export type ContextMenuItem = { action: 'separator' } | { action: ContextMenuAction; label: string; isEnabled: boolean };
export interface ContextMenuRequest {
  id: number;
  sourceId: number;
  isGuest: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  currentVersion: string;
  latestVersion: string;
  minimumVersion: string;
  isRequired: boolean;
  progress: number;
  checkedAt: number | null;
  error: string;
  isManual: boolean;
}

export interface DitengApi {
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  onUpdateChanged(listener: (state: UpdateState) => void): () => void;
  onContextMenuChanged(listener: (request: ContextMenuRequest | null) => void): () => void;
  closeContextMenu(requestId: number, isRestoreFocus?: boolean): void;
  runContextMenuAction(requestId: number, action: ContextMenuAction): void;
  tabsSetActiveGuest(id: number | null): void;
  onCorpSwitchCommitted(listener: (payload: CorpSwitchCommitted) => void): () => void;
  retryCorpVerification(): Promise<{ ok: boolean; message?: string }>;
  /** preload 加载时同步取得的主题快照，供 React 首帧直接使用，避免先闪系统主题 */
  initialThemeState: ThemeState;
  /** preload 加载时取得的窗口材质快照，登录窗用它判断是否显示云母。 */
  initialWindowMaterial: WindowMaterial;
  initialWindowStyle: WindowStyleState;
  onWindowStyleChanged(listener: (state: WindowStyleState) => void): () => void;
  getConfig(): Promise<AppConfig>;
  getDeviceInfo(): Promise<DeviceInfo>;
  getPublicIp(): Promise<ApiCallResult<string>>;
  setConfig(patch: AppConfigPatch): Promise<AppConfig>;
  /** 当前应用主题设置与主进程解析后的实际外观 */
  getThemeState(): Promise<ThemeState>;
  /** 订阅主题变化（设置切换或 system 模式下系统外观变化），返回取消订阅函数 */
  onThemeChanged(listener: (state: ThemeState) => void): () => void;
  login(request: LoginRequest): Promise<ApiCallResult<LoginResult>>;
  /**
   * 发送登录短信验证码（SvrUserLogin.getToken verifyCode 指令，服务端 5 分钟冷却）。
   * data 为服务端提示文案。
   */
  loginSendCode(request: LoginSendCodeRequest): Promise<ApiCallResult<string>>;
  /**
   * 自动登录：主进程用 config 保存的 savedLoginId + savedPassword（safeStorage 解密）
   * 走 SvrUserLogin.getToken；成功复用 keepSession 单一路径开主窗。凭据缺失/解密失败/登录失败
   * 返回 ApiFailure，渲染层转普通登录表单。
   */
  autoLogin(): Promise<ApiCallResult<LoginResult>>;
  /** 当前构建环境的历史登录账号摘要（最近登录在前；不含密码密文） */
  listSavedAccounts(): Promise<SavedAccountSummary[]>;
  /**
   * 取某条历史账号已记住的密码（选择历史账号时按需解密，未保存密码/解密失败返回 ApiFailure）。
   */
  getSavedAccountPassword(key: SavedAccountKey): Promise<ApiCallResult<string>>;
  /** 删除一条历史账号（连同已记住的密码），返回删除后的摘要列表 */
  removeSavedAccount(key: SavedAccountKey): Promise<ApiCallResult<SavedAccountSummary[]>>;
  /** 清空当前环境的历史账号（连同已记住的密码与自动登录凭据），返回空列表 */
  clearSavedAccounts(): Promise<ApiCallResult<SavedAccountSummary[]>>;
  /**
   * 关闭登录窗（自绘 × 按钮用；登录窗是唯一窗口时应用随之退出）。
   */
  closeLoginWindow(): Promise<void>;
  /**
   * 退出登录：主进程调 UserServer/logout 使 token 失效（失败不阻塞），
   * 清会话、断 MQTT、销毁托盘后关主窗回登录窗。主窗随即销毁，返回值不保证送达。
   */
  logout(): Promise<void>;
  /** 主窗本地入口：确认放弃未保存页面后回登录窗；取消返回 false */
  relogin(): Promise<ApiCallResult<boolean>>;
  /** 当前会话摘要；未登录返回 null */
  getSession(): Promise<SessionSummary | null>;
  /** 请求开 URL（地址栏 / guest window.open / 消息中心 / 快捷入口）：主进程做分类与补参 */
  tabsResolve(request: TabsResolveRequest): Promise<TabsResolveResult>;
  /** 主窗壳挂载时取首个标签（forceRedirect 落点或 ERP 首页）；已消费或不存在返回 null */
  tabsPopEntry(): Promise<TabsEntry | null>;
  /** MQTT 未读通知链路状态（连接/订阅/未读/最近通知；不含 broker 凭据） */
  getMqttState(): Promise<MqttState>;
  refreshMessages(): Promise<MqttState>;
  /** 仅向本机发送测试通知，不创建服务端消息或改变未读数 */
  testSystemNotification(): Promise<ApiCallResult<null>>;
  /** 订阅 MQTT 状态推送（连接、未读、通知触发时），返回取消订阅函数 */
  onMqttChanged(listener: (state: MqttState) => void): () => void;
  /** 重要消息置顶弹窗页（#/notify-popup）加载时拉取当前弹窗内容 */
  notifyPopupLoad(): Promise<NotificationPopupContent | null>;
  onNotifyPopupChanged(listener: () => void): () => void;
  /** 弹窗主体被点击：聚焦主窗并打开消息中心 */
  notifyPopupOpen(): void;
  /** 关闭置顶弹窗 */
  notifyPopupClose(): void;
  /** 弹窗 hover 状态上报：true 暂停 8 秒自动关闭，false 恢复计时 */
  notifyPopupHover(isHovering: boolean): void;
  /** 订阅开标签请求（guest window.open、消息中心入口），返回取消订阅函数 */
  onTabsOpenRequest(listener: (payload: TabsOpenRequestPayload) => void): () => void;
  /** 订阅会话变化推送（网页版切账套同步后触发，壳据此关闭旧账套的其余标签），返回取消订阅函数 */
  onSessionChanged(listener: (summary: SessionSummary | null) => void): () => void;
  /**
   * 一键反馈：把整个主窗（rail + 内容工具栏 + 当前页，含 webview 页内合成内容）截图，
   * 以 PNG 字节返回渲染层做标注；不写系统剪贴板（标注确认后由 copyFeedbackImage 写入）。
   */
  captureFeedbackScreenshot(): Promise<FeedbackScreenshotResult>;
  /** 把标注后的 PNG 字节写入系统剪贴板（主进程统一调用异步 ClipboardItem API） */
  copyFeedbackImage(png: Uint8Array): Promise<FeedbackCopyResult>;
  /** 启动/前置微信或企业微信，让用户自己粘贴发送；只做启动，不模拟按键 */
  openFeedbackApp(app: FeedbackChatApp): Promise<FeedbackOpenAppResult>;
  /** 标注编辑器打开/关闭通知：主进程据此放行 Esc/⌘Z/⌘W 并转发 editor-* 动作 */
  setFeedbackEditorActive(isActive: boolean): void;
  /** 订阅应用快捷键动作（⌘/Ctrl+B 侧栏、⌘/Ctrl+, 设置、编辑器撤销/重做/取消），返回取消订阅函数 */
  onShortcut(listener: (action: ShortcutAction) => void): () => void;
  /** 主窗自绘窗口控制（Windows/Linux 无系统标题栏）：最小化主窗 */
  windowMinimize(): void;
  /** 主窗自绘窗口控制：最大化/向下还原切换 */
  windowToggleMaximize(): void;
  /** 主窗自绘窗口控制：关闭主窗（托盘常驻时与系统关闭一致，隐藏到托盘） */
  windowClose(): void;
  /** 主窗当前是否最大化（自绘 □/❐ 图标态） */
  windowIsMaximized(): Promise<boolean>;
  /** 订阅主窗最大化状态变化（最大化/还原时推送），返回取消订阅函数 */
  onWindowMaximizedChanged(listener: (maximized: boolean) => void): () => void;
}
