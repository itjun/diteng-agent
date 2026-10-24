import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
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
  AccountBookIcon,
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
} from './theme-icons';
import {
  DEFAULT_SETTINGS_CATEGORY,
  SettingsPage,
  SettingsRail,
} from './Settings';
import type { SettingsCategoryKey } from './Settings';
import { applyChromeColor } from './chrome-color';
import { probePageSurface } from './page-surface';
import type { PageSurface } from './page-surface';
import styles from './Shell.module.css';
import { pageLabel, shareablePageUrl, tabLabel } from './shell-presentation';

/** 平台判定：macOS 红绿灯落在 rail 顶部工具栏内；Windows 由根 padding 让出 overlay 高 */
const isMacPlatform = /Macintosh/.test(navigator.userAgent);
const DEFAULT_RAIL_WIDTH = 224;
/** 导航已移至内容区，侧栏只需容纳红绿灯和展开开关。 */
const RAIL_WIDTH_MIN = 200;
const RAIL_WIDTH_MAX = 480;

interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 反馈提示：成功时引导粘贴到聊天窗口，失败时展示主进程给出的原因 */
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
 * 左栏拥有独立顶部工具区；右栏另起页面信息与助手入口，两栏从窗口顶部到底部完全分开。
 * 壳内另有「设置页」视图：rail 原地切换为设置导航，内容区替换为设置项（webview 隐藏不销毁），
 * ESC/返回切回标签视图。
 * 关闭到 0 个 tab 时内容区被新建标签页覆盖，窗口不销毁。
 */
export function Shell() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [isReloggingIn, setIsReloggingIn] = useState(false);
  const isReloggingInRef = useRef(false);
  const isOpeningWorkspaceRef = useRef(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // 0=未自定义；旧版手动保存的宽度继续尊重，双击恢复紧凑默认宽度。
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
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
  // 标签页顶部底色（地址栏跟随网页内容变色）：按标签存，切换标签直接复用，采不到时留空走应用主题默认色
  const [pageSurfaces, setPageSurfaces] = useState<Record<string, PageSurface>>({});
  const nextIdRef = useRef(1);
  const webviewRefs = useRef(new Map<string, WebviewElement>());
  const activeTabIdRef = useRef('');
  activeTabIdRef.current = activeTabId;
  const blankTabIdRef = useRef('');
  blankTabIdRef.current = tabs.find((tab) => tab.id === activeTabId && !tab.url)?.id ?? '';
  // 防重不落到 state：截图只有百毫秒级，处理中再点直接忽略，也避免禁用态被截进画面
  const isFeedbackCapturingRef = useRef(false);

  /** 开新标签（URL 必须经主进程 resolve 拿到的最终值），并激活 */
  const openTab = useCallback((url: string, corpNo: string) => {
    const id = String(nextIdRef.current++);
    const activeId = activeTabIdRef.current;
    const isBlank = blankTabIdRef.current === activeId && Boolean(activeId);
    const targetId = isBlank ? activeId : id;
    setTabs((prev) => {
      const blank = prev.find((tab) => tab.id === targetId && !tab.url);
      const next = { id: targetId, url, title: '', favicon: '', corpNo, isLoading: true };
      return blank ? prev.map((tab) => tab.id === blank.id ? next : tab) : [...prev, next];
    });
    setActiveTabId(targetId);
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
    setIsSettingsOpen(false);
    setActiveTabId(id);
  }, []);

  const createNewTab = useCallback(() => {
    const id = `new-${nextIdRef.current++}`;
    setTabs((prev) => [...prev, { id, url: '', title: '新建标签页', favicon: '', corpNo: '', isLoading: false }]);
    setActiveTabId(id);
    setIsSettingsOpen(false);
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
    if (id === activeTabIdRef.current) {
      setNavigationState(navigationStateOf(webview ?? undefined));
      try { window.diteng.tabsSetActiveGuest(webview?.getWebContentsId() ?? null); } catch { window.diteng.tabsSetActiveGuest(null); }
    }
  }, []);

  /** 仅当前可见标签的历史状态驱动工具栏前进/后退按钮 */
  const handleNavigationState = useCallback((id: string, state: NavigationState) => {
    if (id === activeTabIdRef.current) {setNavigationState(state);try { window.diteng.tabsSetActiveGuest(webviewRefs.current.get(id)?.getWebContentsId() ?? null); } catch { /* guest 未 ready */ }}
  }, []);

  /** 网页顶部底色回写（同色重复上报不触发重渲染，避免每次加载都抖一下） */
  const handlePageSurface = useCallback((id: string, surface: PageSurface) => {
    setPageSurfaces((current) => {
      const previous = current[id];
      if (previous && previous.color === surface.color && previous.isDark === surface.isDark) return current;
      return { ...current, [id]: surface };
    });
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

  /** 固定入口复用当前账套已有页面；普通业务链接仍允许多标签。 */
  const openWorkspace = useCallback(async (destination: 'ai' | 'accounts' | 'messages') => {
    if (isOpeningWorkspaceRef.current) return;
    isOpeningWorkspaceRef.current = true;
    try {
      const result = await window.diteng.tabsResolve(destination === 'ai' ? { ai: true } : { page: destination });
      if (!result.ok) {
        setFeedbackToast({ kind: 'fail', title: '无法打开页面', desc: result.message });
        return;
      }
      if (result.action !== 'in-app') return;
      const target = new URL(result.url);
      const existing = tabsRef.current.find((tab) => {
        if (!tab.url || tab.corpNo !== result.corpNo) return false;
        try {
          const url = new URL(tab.url);
          return url.pathname === target.pathname && (destination !== 'ai' || url.origin === target.origin);
        } catch { return false; }
      });
      setIsSettingsOpen(false);
      if (existing) setActiveTabId(existing.id);
      else openTab(result.url, result.corpNo);
    } catch {
      setFeedbackToast({ kind: 'fail', title: '无法打开页面', desc: '请检查登录状态后重试' });
    } finally { isOpeningWorkspaceRef.current = false; }
  }, [openTab]);

  const openChat = useCallback(() => { void openWorkspace('ai'); }, [openWorkspace]);
  const openAccounts = useCallback(() => { void openWorkspace('accounts'); }, [openWorkspace]);

  const relogin = useCallback(async () => {
    if (isReloggingInRef.current) return;
    isReloggingInRef.current = true;
    setIsReloggingIn(true);
    try {
      const result = await window.diteng.relogin();
      if (!result.ok) setFeedbackToast({ kind: 'fail', title: '无法重新登录', desc: result.message });
    } catch {
      setFeedbackToast({ kind: 'fail', title: '无法重新登录', desc: '请稍后重试' });
    } finally {
      isReloggingInRef.current = false;
      setIsReloggingIn(false);
    }
  }, []);

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
      // 外围颜色（rail + 卡片四周留白）：设置页改选时也会即时应用，这里负责首帧后恢复上次选择
      applyChromeColor(config.chromeColor);
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

  useEffect(() => window.diteng.onCorpSwitchCommitted(payload => {
    const source = [...webviewRefs.current.entries()].find(([,view]) => {
      try { return view.getWebContentsId() === payload.sourceWebContentsId; } catch { return false; }
    })?.[0];
    setSession(payload.session);
    if (source) {
      setTabs(previous => previous.filter(tab => tab.id === source).map(tab => ({ ...tab, corpNo: payload.session.corpNo, url: payload.url || tab.url })));
      setActiveTabId(source);
      if(payload.url) void webviewRefs.current.get(source)?.loadURL(payload.url).catch(() => undefined);
    } else {
      setTabs([]);setActiveTabId('');
      if(payload.url) openTab(payload.url,payload.session.corpNo);else void resolveAndOpen({home:true});
    }
  }), [openTab,resolveAndOpen]);

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
    try { window.diteng.tabsSetActiveGuest(webviewRefs.current.get(activeTabId)?.getWebContentsId() ?? null); } catch { window.diteng.tabsSetActiveGuest(null); }
  }, [activeTabId]);

  // 页面底色只保留仍存在的标签（关标签 / 切账套只保留当前标签）
  useEffect(() => {
    setPageSurfaces((current) => {
      const alive = new Set(tabs.map((tab) => tab.id));
      const kept = Object.fromEntries(Object.entries(current).filter(([id]) => alive.has(id)));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    });
  }, [tabs]);

  // 切到尚未采到底色的标签（首屏采样还没回来）时补采一次，避免地址栏一直停在默认底色
  useEffect(() => {
    if (!activeTabId || pageSurfaces[activeTabId]) return;
    const webview = webviewRefs.current.get(activeTabId);
    if (!webview) return;
    void probePageSurface(webview).then((surface) => {
      if (surface) handlePageSurface(activeTabId, surface);
    });
  }, [activeTabId, pageSurfaces, handlePageSurface]);

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

  /** 设置齿轮保留上次分类；身份入口直接进入账号分类。 */
  const openSettings = useCallback(() => {
    setIsSettingsOpen(true);
  }, []);
  const openAccountSettings = useCallback(() => {
    setSettingsCategory('account');
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
  useEffect(() => {
    const unsubscribe = window.diteng.onShortcut((action: ShortcutAction) => {
      if (action === 'toggle-rail') toggleRail();
      else if (action === 'open-settings') openSettings();
      else if (action === 'new-tab') createNewTab();
      else if (action === 'close-tab') {
        if (isSettingsOpen) closeSettings();
        else closeTab(activeTabIdRef.current);
      }
      else if (action === 'next-tab' || action === 'previous-tab') {
        const index = tabs.findIndex((tab) => tab.id === activeTabIdRef.current);
        const next = tabs[(index + (action === 'next-tab' ? 1 : -1) + tabs.length) % tabs.length];
        if (next) activateTab(next.id);
      }
    });
    return unsubscribe;
  }, [openSettings, closeSettings, toggleRail, createNewTab, closeTab, activateTab, tabs, isSettingsOpen]);

  // ===== 侧栏宽度拖拽：拖拽期间盖全窗透明盾牌（z-index 高于一切，含 webview），
  // 否则指针移入 webview 区域后事件被路由进 guest 进程，宿主页收不到 move/up（真实拖拽同样会卡住）；
  // 松手持久化；双击手柄复位默认 224（写 0=跟随默认） =====
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

  const corpDisplayName = session?.corpName || session?.corpNo || '未登录';
  const userDisplayName = session?.userName || session?.loginId || '登录用户';

  // 当前激活标签（激活态自愈保证有标签时必命中；0 标签为 undefined，地址栏显示新建标签页）
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  // 内容卡片/地址栏底色跟随当前标签的网页顶部底色；没有采样结果（新建标签页、加载中）时
  // 不写 --card-surface，回落到应用主题的卡片底色。tone 决定工具条文字/图标走深色还是浅色档。
  const activeSurface = activeTabId ? pageSurfaces[activeTabId] : undefined;
  const cardTone = activeSurface ? (activeSurface.isDark ? 'dark' : 'light') : undefined;
  const cardStyle = activeSurface
    ? ({ '--card-surface': activeSurface.color } as CSSProperties)
    : undefined;

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
        <aside className={`${styles.rail} ${isRailCollapsed ? styles.railCompact : ''}`} data-testid="tabstrip" data-collapsed={isRailCollapsed} style={{ width: isRailCollapsed ? 76 : railWidth }}>
            <SidebarToolbar isCollapsed={isRailCollapsed} onToggleRail={toggleRail} />
            {/* 宽度拖拽手柄：贴 rail 右缘，命中区 7px；双击复位默认 224 */}
            {!isRailCollapsed && <div
              className={styles.railResizeHandle}
              data-testid="rail-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整标签栏宽度（双击恢复默认）"
              onPointerDown={handleRailResizeStart}
            />}
            {isSettingsOpen ? (
              <SettingsRail
                activeCategory={settingsCategory}
                onSelectCategory={selectSettingsCategory}
                onBack={closeSettings}
                isCompact={isRailCollapsed}
              />
            ) : (
              <>
                <button
                  type="button"
                  data-testid="new-tab"
                  className={styles.railNewTab}
                  title="新建标签页"
                  aria-label="新建标签页"
                  onClick={createNewTab}
                >
                  <PlusIcon />
                  <span>新建标签</span>
                </button>
                <div className={styles.railTabs} data-testid="rail-tabs" role="tablist" aria-label="标签页">
                  {tabs.map((tab) => (
                    <RailTab
                      key={tab.id}
                      tab={tab}
                      label={tabLabel(tab, tabs)}
                      isActive={tab.id === activeTabId}
                      onReload={(id) => webviewRefs.current.get(id)?.reload()}
                      onCloseOthers={(id) => { setTabs((prev) => prev.filter((item) => item.id === id)); activateTab(id); }}
                      onCloseRight={(id) => setTabs((prev) => prev.slice(0, prev.findIndex((item) => item.id === id) + 1))}
                      hasOthers={tabs.length > 1}
                      hasRight={tabs[tabs.length - 1].id !== tab.id}
                      onClose={closeTab}
                      onActivate={activateTab}
                    />
                  ))}
                </div>
              </>
            )}
            <div className={styles.railFooter}>
              <button type="button" className={styles.railAction} data-testid="switch-account" onClick={openAccounts}
                title={`当前账套 ${corpDisplayName}（${session?.corpNo ?? ''}）· 切换账套`} aria-label={`当前账套 ${corpDisplayName}，切换账套`}>
                <AccountBookIcon />
                <span className={styles.railActionText}><small>当前账套 · {session?.corpNo || '—'}</small><strong>{corpDisplayName}</strong></span>
                <span className={styles.railActionHint}>切换</span>
              </button>
              <div className={styles.identityRow}>
                <button type="button" className={styles.identityButton} data-testid="user-chip" onClick={openAccountSettings}
                  title={`登录用户 ${userDisplayName} · 账号与账套`} aria-label={`登录用户 ${userDisplayName}，查看账号与账套`}>
                  <span className={styles.userAvatar} aria-hidden="true">{userDisplayName.charAt(0)}</span>
                  <span className={styles.railActionText}><strong>{userDisplayName}</strong><small>{session?.loginId || '查看登录身份'}</small></span>
                </button>
                <button type="button" className={styles.settingsButton} data-testid="open-settings" onClick={openSettings} title="设置" aria-label="打开设置"><SettingsIcon /></button>
              </div>
            </div>
          </aside>

        {/* 设置页直接接管内容区，不再复用浏览器工具栏；返回标签视图后恢复 webview 内容 */}
        <main className={isSettingsOpen ? `${styles.body} ${styles.bodySettings}` : styles.body}>
          {/* 内容卡片：地址栏与网页同处一张 16px 圆角卡片，四边 5px 外围色留白（上/下/右等宽）；
              地址栏底色跟随网页内容，卡片内部不再出现一条横向的外壳色色带。
              设置页打开时整卡 display:none 隐藏（webview 不销毁，返回后标签原样恢复）。 */}
          <div
            className={styles.contentCard}
            data-testid="content-card"
            data-tone={cardTone}
            style={{ display: isSettingsOpen ? 'none' : undefined, ...cardStyle }}
          >
            {!isSettingsOpen && (
              <ContentToolbar
                url={activeTab?.url ?? ''}
                pageTitle={activeTab?.title ?? ''}
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
                新建标签页盖在地址栏下方的页面区域里，与网页共用同一张卡片 */}
            <div className={styles.viewport}>
              {tabs.filter((tab) => tab.url).map((tab) => (
                <TabWebview
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  onMeta={updateTab}
                  onRegister={registerWebview}
                  onNavigationState={handleNavigationState}
                  onPageSurface={handlePageSurface}
                />
              ))}
              {!isSettingsOpen && !activeTab?.url && (
                <NewTabPage key={activeTabId} session={session} openViaMain={resolveAndOpen} onChat={openChat} />
              )}
            </div>
          </div>

          {isSettingsOpen && (
            <>
              <SettingsPage session={session} activeCategory={settingsCategory}
                onAccounts={openAccounts} onRelogin={() => void relogin()} isReloggingIn={isReloggingIn} />
            </>
          )}
          {/* 一键反馈结果提示：复制/启动聊天应用后引导粘贴；浮在内容区底部，不占布局 */}
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
  onPageSurface,
}: {
  tab: TabInfo;
  isActive: boolean;
  onMeta: (id: string, patch: Partial<Pick<TabInfo, 'url' | 'title' | 'favicon' | 'isLoading' | 'corpNo'>>) => void;
  onRegister: (id: string, webview: WebviewElement | null) => void;
  onNavigationState: (id: string, state: NavigationState) => void;
  onPageSurface: (id: string, surface: PageSurface) => void;
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
    // 页面顶部底色采样：延迟一拍等首屏样式/字体生效；页面还没绘制完时采不到就保留上次颜色
    let surfaceTimer: number | undefined;
    const probeSurface = () => {
      void probePageSurface(element).then((surface) => {
        if (surface) onPageSurface(tab.id, surface);
      });
    };
    const scheduleSurfaceProbe = (delay = 240) => {
      window.clearTimeout(surfaceTimer);
      surfaceTimer = window.setTimeout(probeSurface, delay);
    };
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
      // 首屏资源加载完成后页面底色才是最终值（部分站点靠脚本改主题色）
      scheduleSurfaceProbe(260);
    };
    const onNavigate = (event: WebviewDomEvent) => {
      const url = event.url ?? element.getURL();
      const corpNo = corpNoOfUrl(url);
      meta(corpNo ? { url, corpNo } : { url });
      syncNavigation();
      // 页内路由（SPA）切换后重采；整页导航等 dom-ready/did-finish-load 再采
      scheduleSurfaceProbe(320);
    };
    const onDomReady = () => {
      const url = element.getURL();
      const corpNo = corpNoOfUrl(url);
      meta(corpNo ? { url, corpNo } : { url });
      syncNavigation();
      scheduleSurfaceProbe(160);
    };
    const onFinishLoad = () => scheduleSurfaceProbe(120);
    onRegister(tab.id, element);
    syncNavigation();
    element.addEventListener('page-title-updated', onTitle);
    element.addEventListener('page-favicon-updated', onFavicon);
    element.addEventListener('did-start-loading', onStartLoading);
    element.addEventListener('did-stop-loading', onStopLoading);
    element.addEventListener('did-navigate', onNavigate);
    element.addEventListener('did-navigate-in-page', onNavigate);
    element.addEventListener('did-fail-load', onNavigate);
    element.addEventListener('did-finish-load', onFinishLoad);
    element.addEventListener('dom-ready', onDomReady);
    return () => {
      window.clearTimeout(surfaceTimer);
      onRegister(tab.id, null);
      element.removeEventListener('page-title-updated', onTitle);
      element.removeEventListener('page-favicon-updated', onFavicon);
      element.removeEventListener('did-start-loading', onStartLoading);
      element.removeEventListener('did-stop-loading', onStopLoading);
      element.removeEventListener('did-navigate', onNavigate);
      element.removeEventListener('did-navigate-in-page', onNavigate);
      element.removeEventListener('did-fail-load', onNavigate);
      element.removeEventListener('did-finish-load', onFinishLoad);
      element.removeEventListener('dom-ready', onDomReady);
    };
  }, [tab.id, onMeta, onRegister, onNavigationState, onPageSurface]);

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

/** 标签选择与关闭是两个独立按钮，支持键盘、紧凑栏及专用标签菜单。 */
function RailTab({ tab, label, isActive, onClose, onActivate, onReload, onCloseOthers, onCloseRight, hasOthers, hasRight }: {
  tab: TabInfo;
  label: string;
  isActive: boolean;
  onClose: (id: string) => void;
  onActivate: (id: string) => void;
  onReload: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseRight: (id: string) => void;
  hasOthers: boolean;
  hasRight: boolean;
}) {
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [isCopyFailed, setCopyFailed] = useState(false);
  const [failedFavicon, setFailedFavicon] = useState('');
  const selectRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissMenu = useCallback(() => { setMenuOpen(false); selectRef.current?.focus(); }, []);
  useEffect(() => {
    if (!isMenuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const resize = () => setMenuOpen(false);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', resize); };
  }, [isMenuOpen]);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareablePageUrl(tab.url)); dismissMenu(); }
    catch { setCopyFailed(true); }
  };
  return (
    <div className={isActive ? styles.railTabActive : styles.railTab} role="presentation"
      onContextMenu={(event) => {
        event.preventDefault();
        setCopyFailed(false);
        setMenuPosition({ left: Math.max(8, Math.min(event.clientX || 8, window.innerWidth - 224)), top: Math.max(8, Math.min(event.clientY || 80, window.innerHeight - 228)) });
        setMenuOpen(true);
      }}>
      <button type="button" role="tab" aria-selected={isActive} ref={selectRef}
        data-testid={`tab-${tab.id}`} className={styles.railTabSelect} title={label} aria-label={label}
        onClick={() => onActivate(tab.id)}
        onKeyDown={(event) => { if (event.key === 'Delete') { event.preventDefault(); onClose(tab.id); } }}>
        {tab.isLoading ? <span className={styles.spinner} aria-hidden="true" /> : tab.favicon && tab.favicon !== failedFavicon ?
          <img src={tab.favicon} alt="" className={styles.railFavicon} onError={() => setFailedFavicon(tab.favicon)} /> :
          <span className={styles.railTabDot} aria-hidden="true">{label.charAt(0)}</span>}
        <span className={styles.railTabTitle}>{label}</span>
      </button>
      <button type="button" aria-label={`关闭标签页：${label}`} title={`关闭 ${label}`} data-testid={`tab-close-${tab.id}`}
        className={styles.railTabClose} onClick={() => onClose(tab.id)}><CloseIcon /></button>
      {isMenuOpen && <div ref={menuRef} role="menu" aria-label={`${label} 标签菜单`} className={styles.tabMenu} style={menuPosition}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); dismissMenu(); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
          }
        }}>
        <button type="button" role="menuitem" disabled={!tab.url} onClick={() => { onReload(tab.id); dismissMenu(); }}>刷新页面</button>
        <button type="button" role="menuitem" disabled={!shareablePageUrl(tab.url)} onClick={() => void copyLink()}>{isCopyFailed ? '复制失败，请重试' : '复制页面链接'}</button>
        <div role="separator" />
        <button type="button" role="menuitem" onClick={() => onClose(tab.id)}>关闭标签页</button>
        <button type="button" role="menuitem" disabled={!hasOthers} onClick={() => { onCloseOthers(tab.id); dismissMenu(); }}>关闭其他标签页</button>
        <button type="button" role="menuitem" disabled={!hasRight} onClick={() => { onCloseRight(tab.id); dismissMenu(); }}>关闭右侧标签页</button>
      </div>}
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
function SidebarToolbar({ onToggleRail, isCollapsed }: { onToggleRail: () => void; isCollapsed: boolean }) {
  return (
    <div
      className={styles.sidebarToolbar}
      data-testid="sidebar-toolbar"
      role="toolbar"
      aria-label="侧栏工具栏"
    >
      <ToolbarButton
        label={isCollapsed ? '展开侧栏' : '收起侧栏'}
        testId="sidebar-toggle"
        pressed={!isCollapsed}
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
 * 展示页面名与域名；复制链接剥离会话参数，不修改真实导航地址。仅浏览页使用，设置页不渲染。
 */
function ContentToolbar({
  url,
  pageTitle,
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
  const safeUrl = shareablePageUrl(url);
  const hasUrl = Boolean(safeUrl);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copyUrl() {
    if (!hasUrl) return;
    try {
      await navigator.clipboard.writeText(safeUrl);
      setCopyState('ok');
    } catch {
      setCopyState('fail');
    }
  }

  const copyLabel =
    copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制页面链接（不含登录凭据）';
  const locationText = pageLabel(url, pageTitle);
  const siteName = safeUrl ? new URL(safeUrl).host : '';
  return (
    <div
      className={styles.contentToolbar}
      data-testid="browser-toolbar"
      role="toolbar"
      aria-label="浏览器工具栏"
    >
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
      <div className={styles.toolbarAddress} data-testid="url-bar" role="group" aria-label="当前页面信息">
        <span className={styles.toolbarAddressText} title={locationText}>{locationText}</span>
        {siteName && <span className={styles.toolbarSite} title={safeUrl}>{siteName}</span>}
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
        title="一键反馈：截图后可标注，再复制并打开微信/企业微信粘贴发送"
        aria-label="一键反馈（截图标注后复制给客服）"
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
        title="打开 AI 助手"
        aria-label="打开 AI 助手"
      >
        <span className={styles.toolbarChatIcon}>
          <ChatIcon />
        </span>
        <span>AI 助手</span>
      </button>
    </div>
  );
}

/** 新建标签页：地址栏 + 快捷入口（renderer 自绘，直接覆盖在 webview 宿主之上） */
function NewTabPage({
  session,
  openViaMain,
  onChat,
}: {
  session: SessionSummary | null;
  openViaMain: (request: TabsResolveRequest) => Promise<TabsResolveResult>;
  onChat: () => void;
}) {
  const [address, setAddress] = useState('');
  const [hint, setHint] = useState('');
  const [isOpening, setOpening] = useState(false);
  const isOpeningRef = useRef(false);

  async function openRequest(request: TabsResolveRequest) {
    if (isOpeningRef.current) return;
    isOpeningRef.current = true;
    setOpening(true);
    setHint('');
    try {
      const result = await openViaMain(request);
      if (!result.ok) setHint(result.message);
      else if (result.action === 'external') { setHint('外域地址已在系统浏览器打开'); setAddress(''); }
    } catch { setHint('打开失败，请重试'); }
    finally { isOpeningRef.current = false; setOpening(false); }
  }

  function openAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = address.trim();
    if (!input) return;
    // 无协议时按 https 补全（浏览器地址栏同款容错）
    const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    void openRequest({ url });
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
            aria-label="ERP 页面地址"
            placeholder="输入 ERP 页面地址"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
        </div>
        <button type="submit" disabled={isOpening} className={styles.addressGo}>
          打开
        </button>
      </form>
      {hint && <p className={styles.newTabHint}>{hint}</p>}
      <div className={styles.quicklinks}>
        <button
          type="button"
          className={styles.quicklink}
          data-testid="quicklink-erp"
          disabled={isOpening || !session}
          onClick={() => void openRequest({ home: true })}
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
          onClick={onChat}
        >
          <span className={styles.quicklinkTitle}>AI 助手</span>
          <span className={styles.quicklinkDesc}>
            {session ? `${session.corpNo} 的 AI 助手` : '登录会话失效，请重新登录'}
          </span>
        </button>
      </div>
    </div>
  );
}
