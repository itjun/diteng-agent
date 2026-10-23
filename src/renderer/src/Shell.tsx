import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {
  SessionSummary,
  ShortcutAction,
  TabInfo,
  TabsResolveRequest,
  TabsResolveResult,
} from '../../shared/types';
import type { WebviewDomEvent, WebviewElement } from './env';
import {
  AlertIcon,
  BackIcon,
  CameraIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ForwardIcon,
  HomeIcon,
  PlusIcon,
  ReloadIcon,
  SettingsIcon,
  SidebarToggleIcon,
  SignOutIcon,
} from './theme-icons';
import {
  DEFAULT_SETTINGS_CATEGORY,
  SettingsPage,
  SettingsRail,
} from './Settings';
import type { SettingsCategoryKey } from './Settings';
import styles from './Shell.module.css';

/** 平台判定：macOS 红绿灯落在 rail 顶部工具栏内；Windows 由根 padding 让出 overlay 高 */
const isMacPlatform = /Macintosh/.test(navigator.userAgent);
const DEFAULT_RAIL_WIDTH = 300;
/** macOS 左栏要容纳红绿灯让位与整组导航按钮，避免窄栏裁切。 */
const RAIL_WIDTH_MIN = isMacPlatform ? 272 : 200;
const RAIL_WIDTH_MAX = 480;

interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 一键反馈提示：成功时引导粘贴给客服，失败时展示主进程给出的原因 */
interface FeedbackToast {
  kind: 'ok' | 'fail';
  title: string;
  desc: string;
}

/**
 * 等两帧再截图：摘掉 macOS vibrancy 透明分支后要先完成一次合成，
 * 否则 capturePage 可能仍拿到半透明画面（粘贴到聊天窗口发黑/发白）。
 */
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** webview 尚未 dom-ready 时调用历史 API 可能抛错，工具栏状态统一安全读取 */
function navigationStateOf(webview: WebviewElement | undefined): NavigationState {
  if (!webview) return { canGoBack: false, canGoForward: false };
  try {
    return { canGoBack: webview.canGoBack(), canGoForward: webview.canGoForward() };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}

/**
 * 标签归属账套重记账：ERP/AI 页路径首段为账套号（/{corpNo}/…）。guest 内部切换账套
 * （网页版右上角账套卡片）后标签实际账套已变，仅按此修正归属；关闭旧账套标签由会话账套
 * 变化驱动（见 Shell 内 session.corpNo effect）。非 /{corpNo}/ 形态返回空串表示维持原值，
 * URL 放行/补参策略仍归主进程。
 */
function corpNoOfUrl(url: string): string {
  try {
    const first = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
    return /^\d{5,8}$/.test(first) ? first : '';
  } catch {
    return '';
  }
}

/**
 * 主窗壳：左侧竖向标签栏（rail）+ 内容区都在渲染层，每 tab 一个 <webview>（页内合成，与 macOS 整窗 vibrancy 兼容）。
 * 标签状态（id/url/title/favicon/corpNo/isLoading）归渲染层，标题/favicon/loading 由 webview 元素事件维护；
 * URL 策略（分类 + 同域补 sid）归主进程：任何开标签入口先经 tabs:resolve 拿最终 URL 再建 webview。
 * 左栏拥有独立顶部工具区；右栏另起地址与 Chat，两栏从窗口顶部到底部完全分开。
 * 壳内另有「设置页」视图：rail 原地切换为设置导航，内容区替换为设置项（webview 隐藏不销毁），
 * ESC/返回切回标签视图。
 * 关闭到 0 个 tab 时内容区被新建标签页覆盖，窗口不销毁。
 */
export function Shell() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [session, setSession] = useState<SessionSummary | null>(null);
  // 侧栏宽度：默认 300 对齐 Cursor/VS Code 侧栏默认宽度；0=未自定义（双击手柄复位时写 0）
  const [railWidth, setRailWidth] = useState(300);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategoryKey>(DEFAULT_SETTINGS_CATEGORY);
  const [isRailCollapsed, setIsRailCollapsed] = useState(false);
  const [navigationState, setNavigationState] = useState<NavigationState>({
    canGoBack: false,
    canGoForward: false,
  });
  const [isRailDrag, setIsRailDrag] = useState(false);
  const [feedbackToast, setFeedbackToast] = useState<FeedbackToast | null>(null);
  const nextIdRef = useRef(1);
  const webviewRefs = useRef(new Map<string, WebviewElement>());
  const activeTabIdRef = useRef('');
  activeTabIdRef.current = activeTabId;
  const sessionCorpNoRef = useRef('');
  // 防重不落到 state：截图只有百毫秒级，处理中再点直接忽略，也避免禁用态被截进画面
  const isFeedbackCapturingRef = useRef(false);

  /** 开新标签（URL 必须经主进程 resolve 拿到的最终值），并激活 */
  const openTab = useCallback((url: string, corpNo: string) => {
    const id = String(nextIdRef.current++);
    setTabs((prev) => [...prev, { id, url, title: url, favicon: '', corpNo, isLoading: true }]);
    setActiveTabId(id);
  }, []);

  /** 经主进程开标签：in-app 拿最终 URL 建 webview；external 已由主进程转系统浏览器，返回结果供调用方提示 */
  const resolveAndOpen = useCallback(
    async (request: TabsResolveRequest): Promise<TabsResolveResult> => {
      const result = await window.diteng.tabsResolve(request);
      if (result.ok && result.action === 'in-app') openTab(result.url, result.corpNo);
      return result;
    },
    [openTab],
  );

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => prev.filter((tab) => tab.id !== id));
  }, []);

  const activateTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  /** webview 事件回写标签元数据（title/favicon/loading/url，导航跨账套时重记 corpNo） */
  const updateTab = useCallback(
    (id: string, patch: Partial<Pick<TabInfo, 'url' | 'title' | 'favicon' | 'isLoading' | 'corpNo'>>) => {
      setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
    },
    [],
  );

  /** 注册 webview 元素：工具栏经该表直接操作当前标签的历史/刷新/主页导航 */
  const registerWebview = useCallback((id: string, webview: WebviewElement | null) => {
    if (webview) {
      webviewRefs.current.set(id, webview);
    } else {
      webviewRefs.current.delete(id);
    }
    if (id === activeTabIdRef.current) setNavigationState(navigationStateOf(webview ?? undefined));
  }, []);

  /** 仅当前可见标签的历史状态驱动工具栏前进/后退按钮 */
  const handleNavigationState = useCallback((id: string, state: NavigationState) => {
    if (id === activeTabIdRef.current) setNavigationState(state);
  }, []);

  const toggleRail = useCallback(() => {
    setIsRailCollapsed((collapsed) => !collapsed);
  }, []);

  const navigateBack = useCallback(() => {
    const webview = webviewRefs.current.get(activeTabIdRef.current);
    if (!webview || !navigationStateOf(webview).canGoBack) return;
    webview.goBack();
  }, []);

  const navigateForward = useCallback(() => {
    const webview = webviewRefs.current.get(activeTabIdRef.current);
    if (!webview || !navigationStateOf(webview).canGoForward) return;
    webview.goForward();
  }, []);

  const reloadActiveTab = useCallback(() => {
    webviewRefs.current.get(activeTabIdRef.current)?.reload();
  }, []);

  /** 主页键在当前标签内导航；没有标签时才新建首页标签（与浏览器主页行为一致） */
  const navigateHome = useCallback(async () => {
    setIsSettingsOpen(false);
    const result = await window.diteng.tabsResolve({ home: true });
    if (!result.ok || result.action !== 'in-app') return;
    const activeId = activeTabIdRef.current;
    const webview = activeId ? webviewRefs.current.get(activeId) : undefined;
    if (!webview) {
      openTab(result.url, result.corpNo);
      return;
    }
    updateTab(activeId, { url: result.url, isLoading: true });
    try {
      await webview.loadURL(result.url);
    } catch {
      updateTab(activeId, { isLoading: false });
    }
  }, [openTab, updateTab]);

  /** 右上角 Chat 走真实 AI 助手路由；设置页中点击时先回到标签视图 */
  const openChat = useCallback(() => {
    setIsSettingsOpen(false);
    void resolveAndOpen({ ai: true });
  }, [resolveAndOpen]);

  /**
   * 一键反馈：主进程把整个主窗画面（rail + 工具栏 + 当前页）截图写入系统剪贴板，
   * 这里只负责入口、截图前的透明底处理与结果提示。
   */
  const captureFeedback = useCallback(async () => {
    if (isFeedbackCapturingRef.current) return;
    isFeedbackCapturingRef.current = true;
    // 上一次提示不能留在画面里（用户可能连续反馈）
    setFeedbackToast(null);
    // macOS vibrancy 靠 data-platform 切透明分支：直接截图会带半透明像素，粘贴到
    // 聊天窗口易发黑/发白。截图期间摘掉标记退化为实心底色，finally 立即恢复。
    const root = document.documentElement;
    const platformMarker = root.getAttribute('data-platform');
    if (platformMarker) root.removeAttribute('data-platform');
    try {
      await waitForPaint();
      const result = await window.diteng.captureFeedbackScreenshot();
      setFeedbackToast(
        result.ok
          ? {
              kind: 'ok',
              title: '截图已复制到系统剪贴板',
              desc: `打开客服会话，直接粘贴（${isMacPlatform ? '⌘V' : 'Ctrl+V'}）发送即可完成反馈`,
            }
          : { kind: 'fail', title: '截图复制失败', desc: result.message },
      );
    } catch {
      setFeedbackToast({ kind: 'fail', title: '截图复制失败', desc: '复制截图到剪贴板失败，请重试' });
    } finally {
      if (platformMarker) root.setAttribute('data-platform', platformMarker);
      isFeedbackCapturingRef.current = false;
    }
  }, []);

  // 挂载：会话/配置拉取、首个标签（登录落点）、guest 开标签请求、会话变化推送
  useEffect(() => {
    void window.diteng.getSession().then(setSession);
    void window.diteng.getConfig().then((config) => {
      if (config.railWidth > 0) {
        setRailWidth(Math.min(Math.max(config.railWidth, RAIL_WIDTH_MIN), RAIL_WIDTH_MAX));
      }
    });
    void window.diteng.tabsPopEntry().then((entry) => {
      if (entry) openTab(entry.url, entry.corpNo);
    });
    const unsubscribeOpen = window.diteng.onTabsOpenRequest(({ url }) => {
      void resolveAndOpen({ url });
    });
    // 账套切换后主进程推送新摘要，底部用户行与快捷入口文案随之刷新
    const unsubscribeSession = window.diteng.onSessionChanged((summary) => setSession(summary));
    return () => {
      unsubscribeOpen();
      unsubscribeSession();
    };
  }, [openTab, resolveAndOpen]);

  // 网页版切账套：主进程完成会话同步后推送 session:changed，账套号变化即意味着旧账套标签
  // 在新 token 下已无访问权。切换发生在当前可见标签，故保留该标签、关闭其余全部标签（含 AI 标签）；
  // 首次拿到会话与仅名称/用户信息回填（账套号不变）不动标签。
  useEffect(() => {
    const corpNo = session?.corpNo ?? '';
    const previousCorpNo = sessionCorpNoRef.current;
    sessionCorpNoRef.current = corpNo;
    if (!previousCorpNo || !corpNo || corpNo === previousCorpNo) return;
    const activeId = activeTabIdRef.current;
    setTabs((prev) => prev.filter((tab) => tab.id === activeId).map((tab) => ({ ...tab, corpNo })));
  }, [session?.corpNo]);

  // 激活态自愈：激活 tab 被关掉后落到剩余最后一个（与旧主进程实现一致），全关则空（新建标签页）
  useEffect(() => {
    setActiveTabId((current) => {
      if (current && tabs.some((tab) => tab.id === current)) return current;
      return tabs.length > 0 ? tabs[tabs.length - 1].id : '';
    });
  }, [tabs]);

  // 切标签后立即同步历史可用状态；webview 首次挂载还会由 registerWebview 再同步一次
  useEffect(() => {
    setNavigationState(navigationStateOf(webviewRefs.current.get(activeTabId)));
  }, [activeTabId]);

  // 平台标记（纯 renderer 判定，不加 IPC）：macOS 主窗在 <html> 标 data-platform，
  // CSS 据此走 vibrancy 半透明分支（dsh 同名约定，design-platform.css 已有配套规则）；
  // 登录/通知窗不挂 Shell，永不标记，保持实心底色
  useEffect(() => {
    if (!isMacPlatform) return;
    document.documentElement.setAttribute('data-platform', 'darwin');
    return () => document.documentElement.removeAttribute('data-platform');
  }, []);

  // e2e 调试快照：标签状态归渲染层后的 tabsList 等价物（断言用，非业务入口）
  useEffect(() => {
    window.__ditengTabsList = () => ({ tabs, activeTabId });
    return () => {
      delete window.__ditengTabsList;
    };
  }, [tabs, activeTabId]);

  /** 进设置页（rail 齿轮唯一入口；外观/主题等统一在设置页处理） */
  const openSettings = useCallback(() => {
    setSettingsCategory(DEFAULT_SETTINGS_CATEGORY);
    setIsSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  /** 点设置分类：切到该分类；分类导航在最左 rail 内 */
  const selectSettingsCategory = useCallback((category: SettingsCategoryKey) => {
    setSettingsCategory(category);
  }, []);

  // 应用快捷键：⌘/Ctrl+B 展开收起侧栏、⌘/Ctrl+, 进入设置页。
  // 按键在主进程 before-input-event 统一拦截（含 webview guest 焦点），这里只执行 UI 动作。
  useEffect(() => {
    const unsubscribe = window.diteng.onShortcut((action: ShortcutAction) => {
      if (action === 'toggle-rail') toggleRail();
      else openSettings();
    });
    return unsubscribe;
  }, [openSettings, toggleRail]);

  // ===== 侧栏宽度拖拽：拖拽期间盖全窗透明盾牌（z-index 高于一切，含 webview），
  // 否则指针移入 webview 区域后事件被路由进 guest 进程，宿主页收不到 move/up（真实拖拽同样会卡住）；
  // 松手持久化；双击手柄复位默认 300（写 0=跟随默认） =====
  const railDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // 手动双击识别：盾牌会让原生 dblclick 的两次 click 目标不一致（第二次被盾牌接走），不能依赖 onDoubleClick
  const railLastDownRef = useRef<{ x: number; t: number } | null>(null);
  const clampRailWidth = (width: number): number =>
    Math.min(Math.max(Math.round(width), RAIL_WIDTH_MIN), Math.min(RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.6)));
  const handleRailResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const now = Date.now();
      const last = railLastDownRef.current;
      railLastDownRef.current = { x: event.clientX, t: now };
      if (last && now - last.t < 450 && Math.abs(event.clientX - last.x) < 6) {
        railLastDownRef.current = null;
        handleRailResizeReset();
        return;
      }
      railDragRef.current = { startX: event.clientX, startWidth: railWidth };
      setIsRailDrag(true);
    },
    [railWidth],
  );
  const handleRailResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = railDragRef.current;
    if (!drag) return;
    setRailWidth(clampRailWidth(drag.startWidth + event.clientX - drag.startX));
  }, []);
  const handleRailResizeEnd = useCallback(() => {
    if (!railDragRef.current) return;
    railDragRef.current = null;
    setIsRailDrag(false);
    setRailWidth((finalWidth) => {
      void window.diteng.setConfig({ railWidth: finalWidth });
      return finalWidth;
    });
  }, []);
  const handleRailResizeReset = useCallback(() => {
    setRailWidth(DEFAULT_RAIL_WIDTH);
    void window.diteng.setConfig({ railWidth: 0 });
  }, []);

  // 设置页内 ESC 返回标签视图（标签不丢，仅视图切换）
  useEffect(() => {
    if (!isSettingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSettingsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isSettingsOpen]);

  // 反馈提示自动消失：成功留足阅读时间（引导粘贴给客服），失败略短；再次截图会先清掉旧提示
  useEffect(() => {
    if (!feedbackToast) return;
    const timer = setTimeout(() => setFeedbackToast(null), feedbackToast.kind === 'ok' ? 10000 : 6000);
    return () => clearTimeout(timer);
  }, [feedbackToast]);

  // 底部用户行显示名：当前账套名称优先，名称未下发时回落账套代码
  const corpDisplayName = session?.corpName || session?.corpNo || '未登录';

  // 当前激活标签（激活态自愈保证有标签时必命中；0 标签为 undefined，地址栏显示新建标签页）
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const shellClass = `${styles.shell} ${styles.shellRail}${isMacPlatform ? '' : ` ${styles.shellRailWin}`}`;

  return (
    <div className={shellClass} data-testid="shell-rail">
      {/* 拖宽期间的全窗事件盾牌：挡住 webview/guest 输入路由，保证宿主页持续收到 move/up */}
      {isRailDrag && (
        <div
          className={styles.railDragShield}
          data-testid="rail-drag-shield"
          onPointerMove={handleRailResizeMove}
          onPointerUp={handleRailResizeEnd}
          onContextMenu={(event) => event.preventDefault()}
        />
      )}
      <div className={styles.workspace}>
        {!isRailCollapsed && (
          <aside className={styles.rail} data-testid="tabstrip" style={{ width: railWidth }}>
            <SidebarToolbar onToggleRail={toggleRail} />
            {/* 宽度拖拽手柄：贴 rail 右缘，命中区 7px；双击复位默认 300 */}
            <div
              className={styles.railResizeHandle}
              data-testid="rail-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整标签栏宽度（双击恢复默认）"
              onPointerDown={handleRailResizeStart}
            />
            {isSettingsOpen ? (
              <SettingsRail
                activeCategory={settingsCategory}
                onSelectCategory={selectSettingsCategory}
                onBack={closeSettings}
              />
            ) : (
              <>
                <button
                  type="button"
                  data-testid="new-tab"
                  className={styles.railNewTab}
                  title="新建标签页（打开 ERP 首页）"
                  onClick={() => void resolveAndOpen({ home: true })}
                >
                  <PlusIcon />
                  <span>新建标签</span>
                </button>
                <div className={styles.railTabs} data-testid="rail-tabs" role="tablist" aria-label="ERP 标签页">
                  {tabs.map((tab) => (
                    <RailTab
                      key={tab.id}
                      tab={tab}
                      isActive={tab.id === activeTabId}
                      onClose={closeTab}
                      onActivate={activateTab}
                    />
                  ))}
                </div>
              </>
            )}
            {/* 底部用户行只在标签视图出现：设置态 rail 由设置导航接管，账号卡片与齿轮都是重复入口 */}
            {!isSettingsOpen && (
              <div className={styles.railFooter}>
                <UserChip session={session} displayName={corpDisplayName} onOpenSettings={openSettings} />
              </div>
            )}
          </aside>
        )}

        {/* 设置页直接接管内容区，不再复用浏览器工具栏；返回标签视图后恢复 webview 内容 */}
        <main className={isSettingsOpen ? `${styles.body} ${styles.bodySettings}` : styles.body}>
          {!isSettingsOpen && (
            <ContentToolbar
              url={activeTab?.url ?? ''}
              pageTitle={activeTab?.title ?? ''}
              showSidebarToggle={isRailCollapsed}
              onToggleRail={toggleRail}
              canGoBack={Boolean(activeTab) && navigationState.canGoBack}
              canGoForward={Boolean(activeTab) && navigationState.canGoForward}
              isLoading={Boolean(activeTab?.isLoading)}
              hasActiveTab={Boolean(activeTab)}
              onBack={navigateBack}
              onForward={navigateForward}
              onReload={reloadActiveTab}
              onHome={() => void navigateHome()}
              chatDisabled={!session}
              onChat={openChat}
              onFeedback={() => void captureFeedback()}
            />
          )}
          {/* webview 宿主：非激活标签 display:none 隐藏（保留 DOM，guest 不销毁不重载）；
              设置页打开时整体隐藏（webview 不销毁，返回后标签原样恢复） */}
          <div className={styles.viewport} style={{ display: isSettingsOpen ? 'none' : undefined }}>
            {tabs.map((tab) => (
              <TabWebview
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                onMeta={updateTab}
                onRegister={registerWebview}
                onNavigationState={handleNavigationState}
              />
            ))}
          </div>
          {!isSettingsOpen && tabs.length === 0 && <NewTabPage session={session} openViaMain={resolveAndOpen} />}
          {isSettingsOpen && (
            <>
              {isRailCollapsed && (
                <div className={styles.settingsRailToggle}>
                  <ToolbarButton label="展开侧栏" testId="sidebar-toggle" pressed={false} onClick={toggleRail}>
                    <SidebarToggleIcon />
                  </ToolbarButton>
                </div>
              )}
              <SettingsPage session={session} activeCategory={settingsCategory} />
            </>
          )}
          {/* 一键反馈结果提示：成功引导用户直接粘贴给客服；浮在内容区底部，不占布局 */}
          {feedbackToast && (
            <div
              className={styles.feedbackToast}
              data-testid="feedback-toast"
              data-state={feedbackToast.kind}
              role="status"
              aria-live="polite"
            >
              <span
                className={[
                  styles.feedbackToastIcon,
                  feedbackToast.kind === 'fail' ? styles.feedbackToastIconFail : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {feedbackToast.kind === 'ok' ? <CheckIcon /> : <AlertIcon />}
              </span>
              <div className={styles.feedbackToastBody}>
                <div className={styles.feedbackToastTitle}>{feedbackToast.title}</div>
                <div className={styles.feedbackToastDesc}>{feedbackToast.desc}</div>
              </div>
              <button
                type="button"
                className={styles.feedbackToastClose}
                data-testid="feedback-toast-close"
                aria-label="关闭提示"
                title="关闭"
                onClick={() => setFeedbackToast(null)}
              >
                <CloseIcon />
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * 一个标签一个 <webview>：absolute 铺满内容区容器。
 * src 只取挂载时的 URL——did-navigate 会持续回写 tab.url，若直接绑定 src，
 * ERP 重定向后的地址变化会触发整页重载；加载失败保留标签，guest 内展示错误页。
 */
function TabWebview({
  tab,
  isActive,
  onMeta,
  onRegister,
  onNavigationState,
}: {
  tab: TabInfo;
  isActive: boolean;
  onMeta: (id: string, patch: Partial<Pick<TabInfo, 'url' | 'title' | 'favicon' | 'isLoading' | 'corpNo'>>) => void;
  onRegister: (id: string, webview: WebviewElement | null) => void;
  onNavigationState: (id: string, state: NavigationState) => void;
}) {
  const initialSrc = useRef(tab.url).current;
  const elementRef = useRef<WebviewElement | null>(null);

  // 标题/favicon/loading 全部由 webview 元素事件在渲染层维护，不走主进程
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const meta = (patch: Partial<Pick<TabInfo, 'url' | 'title' | 'favicon' | 'isLoading' | 'corpNo'>>) =>
      onMeta(tab.id, patch);
    const syncNavigation = () => onNavigationState(tab.id, navigationStateOf(element));
    const onTitle = (event: WebviewDomEvent) => meta({ title: event.title ?? '' });
    const onFavicon = (event: WebviewDomEvent) => {
      if (event.favicons && event.favicons.length > 0) meta({ favicon: event.favicons[0] });
    };
    const onStartLoading = () => {
      meta({ isLoading: true });
      syncNavigation();
    };
    const onStopLoading = () => {
      meta({ isLoading: false });
      syncNavigation();
    };
    const onNavigate = (event: WebviewDomEvent) => {
      const url = event.url ?? element.getURL();
      const corpNo = corpNoOfUrl(url);
      meta(corpNo ? { url, corpNo } : { url });
      syncNavigation();
    };
    const onDomReady = () => {
      const url = element.getURL();
      const corpNo = corpNoOfUrl(url);
      meta(corpNo ? { url, corpNo } : { url });
      syncNavigation();
    };
    onRegister(tab.id, element);
    syncNavigation();
    element.addEventListener('page-title-updated', onTitle);
    element.addEventListener('page-favicon-updated', onFavicon);
    element.addEventListener('did-start-loading', onStartLoading);
    element.addEventListener('did-stop-loading', onStopLoading);
    element.addEventListener('did-navigate', onNavigate);
    element.addEventListener('did-navigate-in-page', onNavigate);
    element.addEventListener('did-fail-load', onNavigate);
    element.addEventListener('dom-ready', onDomReady);
    return () => {
      onRegister(tab.id, null);
      element.removeEventListener('page-title-updated', onTitle);
      element.removeEventListener('page-favicon-updated', onFavicon);
      element.removeEventListener('did-start-loading', onStartLoading);
      element.removeEventListener('did-stop-loading', onStopLoading);
      element.removeEventListener('did-navigate', onNavigate);
      element.removeEventListener('did-navigate-in-page', onNavigate);
      element.removeEventListener('did-fail-load', onNavigate);
      element.removeEventListener('dom-ready', onDomReady);
    };
  }, [tab.id, onMeta, onRegister, onNavigationState]);

  return (
    <webview
      ref={elementRef}
      src={initialSrc}
      allowpopups="true"
      className={styles.tabWebview}
      style={{ display: isActive ? undefined : 'none' }}
    />
  );
}

/** 左侧竖向标签项：favicon（无则首字符圆点）+ 单行省略标题 + hover 显关闭 × */
function RailTab({
  tab,
  isActive,
  onClose,
  onActivate,
}: {
  tab: TabInfo;
  isActive: boolean;
  onClose: (id: string) => void;
  onActivate: (id: string) => void;
}) {
  // 标题取不到时用 URL 首字符（去协议），保证圆点不空
  const firstChar = (tab.title.trim() || tab.url.replace(/^https?:\/\//i, '')).charAt(0);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      data-testid={`tab-${tab.id}`}
      className={isActive ? styles.railTabActive : styles.railTab}
      onClick={() => onActivate(tab.id)}
      title={tab.title || tab.url}
    >
      {tab.isLoading ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : tab.favicon ? (
        <img src={tab.favicon} alt="" className={styles.railFavicon} />
      ) : (
        <span className={styles.railTabDot} aria-hidden="true">
          {firstChar}
        </span>
      )}
      <span className={styles.railTabTitle}>{tab.title || tab.url}</span>
      <span
        role="button"
        aria-label="关闭标签页"
        data-testid={`tab-close-${tab.id}`}
        className={styles.railTabClose}
        onClick={(event) => {
          event.stopPropagation();
          onClose(tab.id);
        }}
      >
        <CloseIcon />
      </span>
    </button>
  );
}

/**
 * 底部用户行（Cursor 式）：圆形头像（当前账套名称首字符）+ 账套名称单行省略 + 右端齿轮，
 * 扁平融入侧栏无边框；点击整行向上弹出用户卡片（仅退出登录——账套切换统一在网页版内完成），
 * 齿轮单独点击直达设置页（外观、账号等设置项统一在设置页处理）。
 */
function UserChip({
  session,
  displayName,
  onOpenSettings,
}: {
  session: SessionSummary | null;
  displayName: string;
  onOpenSettings: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 展开时点外/Escape 收起
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const avatarChar = displayName.charAt(0).toUpperCase();
  // tooltip：当前账套「名称（代码）」，名称未下发时只显示代码；服务器随会话展示
  const corpLabel = session?.corpName ? `${session.corpName}（${session.corpNo}）` : (session?.corpNo ?? '');
  const chipTitle = session ? `当前账套 ${corpLabel} / 服务器 ${session.serverBase}` : '未登录';

  return (
    <div className={styles.userChipWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.userChip} ${styles.userChipRail}`}
        data-testid="user-chip"
        onClick={() => setIsOpen((open) => !open)}
        disabled={!session}
        title={chipTitle}
      >
        <span className={styles.userAvatar} aria-hidden="true">
          {avatarChar}
        </span>
        <span className={styles.userChipName}>{displayName}</span>
        <span
          role="button"
          aria-label="打开设置"
          data-testid="open-settings"
          className={styles.userGear}
          title="设置"
          onClick={(event) => {
            event.stopPropagation();
            setIsOpen(false);
            onOpenSettings();
          }}
        >
          <SettingsIcon />
        </span>
      </button>
      {isOpen && (
        <div className={`${styles.userCard} ${styles.userCardUp}`} data-testid="user-card" role="menu" aria-label="用户菜单">
          <button
            type="button"
            data-testid="logout"
            className={`${styles.userCardRow} ${styles.userCardRowDanger}`}
            onClick={() => {
              void window.diteng.logout();
            }}
          >
            <SignOutIcon />
            <span className={styles.userCardRowText}>退出登录</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 两栏工具栏图标按钮：32px 方形命中区，hover 才出现柔和底色 */
function ToolbarButton({
  label,
  testId,
  disabled = false,
  pressed,
  className,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={[styles.toolbarButton, className].filter(Boolean).join(' ')}
      data-testid={testId}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 左侧栏顶部只负责栏开关，按钮贴 rail 右上角（对齐 DeepSeek Harness 顶栏）；页面导航与地址栏留在右侧内容区。 */
function SidebarToolbar({ onToggleRail }: { onToggleRail: () => void }) {
  return (
    <div
      className={styles.sidebarToolbar}
      data-testid="sidebar-toolbar"
      role="toolbar"
      aria-label="侧栏工具栏"
    >
      <ToolbarButton
        label="收起侧栏"
        testId="sidebar-toggle"
        pressed
        className={styles.railToggleButton}
        onClick={onToggleRail}
      >
        <SidebarToggleIcon />
      </ToolbarButton>
    </div>
  );
}

/**
 * 右侧内容区工具栏：导航组紧贴地址栏左侧（Chrome 式）。
 * 地址栏只读展示页面原始地址（完整 URL，含 sid 等会话参数），复制按钮拷贝同一地址。仅浏览页使用，设置页不渲染。
 */
function ContentToolbar({
  url,
  pageTitle,
  showSidebarToggle,
  onToggleRail,
  canGoBack,
  canGoForward,
  isLoading,
  hasActiveTab,
  onBack,
  onForward,
  onReload,
  onHome,
  chatDisabled,
  onChat,
  onFeedback,
}: {
  url: string;
  pageTitle: string;
  showSidebarToggle: boolean;
  onToggleRail: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  hasActiveTab: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onHome: () => void;
  chatDisabled: boolean;
  onChat: () => void;
  onFeedback: () => void;
}) {
  // 复制反馈：ok 成功 / fail 剪贴板不可用，2 秒后还原
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const hasUrl = url.trim() !== '';

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copyUrl() {
    if (!hasUrl) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('ok');
    } catch {
      setCopyState('fail');
    }
  }

  const copyLabel =
    copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制当前网址';
  const locationText = toolbarLocationText(url, pageTitle);
  return (
    <div
      className={[styles.contentToolbar, showSidebarToggle ? styles.contentToolbarCollapsed : '']
        .filter(Boolean)
        .join(' ')}
      data-testid="browser-toolbar"
      role="toolbar"
      aria-label="浏览器工具栏"
    >
      {showSidebarToggle && (
        <ToolbarButton label="展开侧栏" testId="sidebar-toggle" pressed={false} onClick={onToggleRail}>
          <SidebarToggleIcon />
        </ToolbarButton>
      )}
      <div className={styles.toolbarNav}>
        <ToolbarButton label="后退" testId="nav-back" disabled={!canGoBack} onClick={onBack}>
          <BackIcon />
        </ToolbarButton>
        <ToolbarButton label="前进" testId="nav-forward" disabled={!canGoForward} onClick={onForward}>
          <ForwardIcon />
        </ToolbarButton>
        <ToolbarButton label="刷新" testId="nav-reload" disabled={!hasActiveTab} onClick={onReload}>
          <span
            className={[styles.toolbarIcon, isLoading ? styles.toolbarReloading : '']
              .filter(Boolean)
              .join(' ')}
          >
            <ReloadIcon />
          </span>
        </ToolbarButton>
        <ToolbarButton label="主页" testId="nav-home" onClick={onHome}>
          <HomeIcon />
        </ToolbarButton>
      </div>
      <div className={styles.toolbarAddress} data-testid="url-bar" role="group" aria-label="当前页面网址">
        <span className={styles.toolbarAddressText} title={locationText}>
          {locationText}
        </span>
        <button
          type="button"
          className={[
            styles.toolbarCopy,
            copyState === 'ok' ? styles.toolbarCopyOk : '',
            copyState === 'fail' ? styles.toolbarCopyFail : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid="url-bar-copy"
          disabled={!hasUrl}
          onClick={() => void copyUrl()}
          title={copyLabel}
          aria-label={copyLabel}
        >
          {copyState === 'ok' ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <button
        type="button"
        className={styles.toolbarFeedback}
        data-testid="feedback-button"
        onClick={onFeedback}
        title="一键反馈：把当前画面截图复制到剪贴板，粘贴给客服即可"
        aria-label="一键反馈（截图复制到剪贴板）"
      >
        <span className={styles.toolbarFeedbackIcon}>
          <CameraIcon />
        </span>
        <span>反馈</span>
      </button>
      <button
        type="button"
        className={styles.toolbarChat}
        data-testid="toolbar-chat"
        disabled={chatDisabled}
        onClick={onChat}
        title="打开 Ravenclaw AI 对话"
        aria-label="打开 Ravenclaw AI 对话"
      >
        <span className={styles.toolbarChatIcon}>
          <ChatIcon />
        </span>
        <span>Chat</span>
      </button>
    </div>
  );
}

/** 地址栏文案：直接展示页面原始地址（完整 URL，含 sid 等会话参数）；无地址时回落页面标题或新建标签页占位 */
function toolbarLocationText(url: string, title: string): string {
  const address = url.trim();
  if (address) return address;
  return title.trim() || '新建标签页';
}

/** 新建标签页：地址栏 + 快捷入口（renderer 自绘，直接覆盖在 webview 宿主之上） */
function NewTabPage({
  session,
  openViaMain,
}: {
  session: SessionSummary | null;
  openViaMain: (request: TabsResolveRequest) => Promise<TabsResolveResult>;
}) {
  const [address, setAddress] = useState('');
  const [hint, setHint] = useState('');

  function openAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = address.trim();
    if (!input) return;
    // 无协议时按 https 补全（浏览器地址栏同款容错）
    const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    setHint('');
    void openViaMain({ url }).then((result) => {
      if (!result.ok) setHint(result.message);
      else if (result.action === 'external') {
        setHint('外域地址已在系统浏览器打开');
        setAddress('');
      } else {
        setAddress('');
      }
    });
  }

  return (
    <div className={styles.newTabPage}>
      <form className={styles.addressForm} onSubmit={openAddress} noValidate>
        <div className={styles.addressWrap}>
          <input
            className={styles.addressInput}
            data-testid="address-input"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="输入 ERP 页面地址打开新标签"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <button type="submit" className={styles.addressGo}>
          打开
        </button>
      </form>
      {hint && <p className={styles.newTabHint}>{hint}</p>}
      <div className={styles.quicklinks}>
        <button
          type="button"
          className={styles.quicklink}
          data-testid="quicklink-erp"
          onClick={() => void openViaMain({ home: true })}
        >
          <span className={styles.quicklinkTitle}>ERP 首页</span>
          <span className={styles.quicklinkDesc}>
            {session ? `${session.corpNo}/${session.homeForm || 'FrmDefault'}` : '登录会话失效，请重新登录'}
          </span>
        </button>
        <button
          type="button"
          className={styles.quicklink}
          data-testid="quicklink-ai"
          onClick={() => void openViaMain({ ai: true })}
        >
          <span className={styles.quicklinkTitle}>AI 对话</span>
          <span className={styles.quicklinkDesc}>
            {session ? `${session.corpNo} 的 AI 助手` : '登录会话失效，请重新登录'}
          </span>
        </button>
      </div>
    </div>
  );
}
