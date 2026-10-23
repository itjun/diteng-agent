/**
 * 主进程 / preload / renderer 三方共享的契约类型。
 * renderer 侧对纯类型一律 `import type`，对常量（DEVICE_UNCHECKED_CODE）按值导入。
 */

/** 主题设置：默认跟随系统，手动切换后存入 config.theme */
export type ThemeSetting = 'system' | 'light' | 'dark';

/** 主进程统一解析后的应用实际外观；所有窗口共用，避免原生窗口与 CSS 主题分叉 */
export interface ThemeState {
  setting: ThemeSetting;
  resolved: 'light' | 'dark';
}

/** userData/config.json 的持久化结构 */
export interface AppConfig {
  /** 后端 diteng-im-server 地址，默认 http://127.0.0.1:8101 */
  serverBase: string;
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
  /** 上次关闭时的主窗大小；null = 从未记录（首启用主屏工作区 80% 作默认）。仅主进程读写 */
  windowBounds: WindowBounds | null;
  /** 左侧标签栏宽度；0 = 未自定义（用默认 300，对齐 Cursor/VS Code 侧栏默认宽度）。仅渲染层使用 */
  railWidth: number;
  /** 登录页「记住密码」勾选状态（通用软件两勾选设计），默认 true */
  rememberPassword: boolean;
  /** 登录页「自动登录」勾选状态；仅在记住密码勾选时可开，默认 true */
  autoLogin: boolean;
}

/** 主窗尺寸记录（只记宽高，不记位置） */
export interface WindowBounds {
  width: number;
  height: number;
}

/**
 * config:set 允许更新的字段。自动登录凭据（savedLoginId/savedPassword）只由主进程账号存储写入，
 * 不在渲染层可写范围内；machineCode/windowBounds 同样仅主进程维护。
 */
export type AppConfigPatch = Partial<
  Pick<AppConfig, 'serverBase' | 'aiBase' | 'theme' | 'railWidth' | 'rememberPassword' | 'autoLogin'>
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
 * auth:login 请求参数；serverBase 为表单当前值，避免 config 旧值把请求打到错误服务器。
 * verifyCode 为 6 位短信验证码（密码登录返回 -8 设备未验证后携带，同接口完成验证并登录）。
 */
export interface LoginRequest {
  serverBase: string;
  loginId: string;
  password: string;
  /** 「记住密码」勾选状态：成功后主进程据此加密保存/清除 config.savedPassword */
  rememberPassword: boolean;
  /** 短信验证码（设备验证登录）；密码登录不传 */
  verifyCode?: string;
}

/** auth:login-send-code 请求参数：同登录接口 verifyCode="??????" 指令发送短信（服务端 5 分钟冷却） */
export interface LoginSendCodeRequest {
  serverBase: string;
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
  userId: string;
  corpNo: string;
  /** 当前账套名称（账套列表 ShortName_ 优先、否则 Name_）；空串表示未知，渲染层可回落 corpNo */
  corpName: string;
  homeForm: string;
  /** 用户显示名（账号级、账套无关）；空串表示主进程尚未取到。壳内身份展示用 corpName，此字段保留供会话展示 */
  userName: string;
  /** 当前子账号代码（当前 token 绑定的子账号）；空串表示未知 */
  userCode: string;
}

/** listMyLivingUsers 返回的一条子账号记录（渲染层展示用，不含凭据） */
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

/** session:switch-corp 请求参数：目标账套号（主进程校验须在可用列表内） */
export interface CorpSwitchRequest {
  corpNo: string;
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
 * tabs:resolve 请求（URL 策略归主进程）：url / home / ai 三选一。
 * - url：任意地址（地址栏、guest window.open、消息中心入口）
 * - home：当前会话 ERP 首页（{corpNo}/{homeForm}）
 * - ai：AI 对话页（{aiBase}/{corpNo}/chat）
 * corpNo 缺省取当前会话账套，用于渲染层给标签记账套（切换账套时关旧账套标签）。
 */
export interface TabsResolveRequest {
  url?: string;
  home?: boolean;
  ai?: boolean;
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

/** corp:switched 载荷：账套切换成功，壳据此关旧账套标签并开新账套首页 */
export interface CorpSwitchedPayload {
  corpNo: string;
  entryUrl: string;
}

/** tabs:open-request 载荷：guest window.open 等入口请求开新标签 */
export interface TabsOpenRequestPayload {
  url: string;
}

/**
 * MQTT 未读通知链路状态（主进程 MqttService 对 renderer / e2e 暴露的只读摘要）。
 * broker/username/password 等连接凭据不下发 renderer，只回连接与订阅结果。
 */
export interface MqttState {
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
export interface DitengApi {
  /** preload 加载时同步取得的主题快照，供 React 首帧直接使用，避免先闪系统主题 */
  initialThemeState: ThemeState;
  getConfig(): Promise<AppConfig>;
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
  /** 历史登录账号摘要（最近登录在前；不含密码密文） */
  listSavedAccounts(): Promise<SavedAccountSummary[]>;
  /**
   * 取某条历史账号已记住的密码（选择历史账号时按需解密，未保存密码/解密失败返回 ApiFailure）。
   */
  getSavedAccountPassword(key: SavedAccountKey): Promise<ApiCallResult<string>>;
  /** 删除一条历史账号（连同已记住的密码），返回删除后的摘要列表 */
  removeSavedAccount(key: SavedAccountKey): Promise<ApiCallResult<SavedAccountSummary[]>>;
  /** 清空历史账号（连同已记住的密码与自动登录凭据），返回空列表 */
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
  /** 当前会话摘要；未登录返回 null */
  getSession(): Promise<SessionSummary | null>;
  /** 当前主账号可用账套列表（主进程缓存，首次调用走 listMyLivingUsers） */
  sessionListCorps(): Promise<ApiCallResult<CorpAccount[]>>;
  /**
   * 切换账套：getNuewToken 换目标账套 token；主进程只广播 corp:switched，
   * 关旧账套标签 + 开新首页由壳（标签状态在渲染层）完成。
   */
  sessionSwitchCorp(request: CorpSwitchRequest): Promise<ApiCallResult<SessionSummary>>;
  /** 请求开 URL（地址栏 / guest window.open / 消息中心 / 快捷入口）：主进程做分类与补参 */
  tabsResolve(request: TabsResolveRequest): Promise<TabsResolveResult>;
  /** 主窗壳挂载时取首个标签（forceRedirect 落点或 ERP 首页）；已消费或不存在返回 null */
  tabsPopEntry(): Promise<TabsEntry | null>;
  /** MQTT 未读通知链路状态（连接/订阅/未读/最近通知；不含 broker 凭据） */
  getMqttState(): Promise<MqttState>;
  /** 订阅 MQTT 状态推送（连接、未读、通知触发时），返回取消订阅函数 */
  onMqttChanged(listener: (state: MqttState) => void): () => void;
  /** 重要消息置顶弹窗页（#/notify-popup）加载时拉取当前弹窗内容 */
  notifyPopupLoad(): Promise<{ title: string; body: string } | null>;
  /** 弹窗主体被点击：聚焦主窗并打开消息中心 */
  notifyPopupOpen(): void;
  /** 关闭置顶弹窗 */
  notifyPopupClose(): void;
  /** 弹窗 hover 状态上报：true 暂停 8 秒自动关闭，false 恢复计时 */
  notifyPopupHover(isHovering: boolean): void;
  /** 订阅开标签请求（guest window.open、消息中心入口），返回取消订阅函数 */
  onTabsOpenRequest(listener: (payload: TabsOpenRequestPayload) => void): () => void;
  /** 订阅账套切换广播（壳关旧账套标签并开新首页），返回取消订阅函数 */
  onCorpSwitched(listener: (payload: CorpSwitchedPayload) => void): () => void;
  /** 订阅会话变化推送（账套切换后触发），返回取消订阅函数 */
  onSessionChanged(listener: (summary: SessionSummary | null) => void): () => void;
}
