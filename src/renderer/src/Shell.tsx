import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DotsVerticalIcon, PlusIcon } from '@radix-ui/react-icons';
import type {
  FeedbackChatApp,
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
  BellIcon,
  CameraIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ForwardIcon,
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
import { FeedbackEditor } from './FeedbackEditor';
import type { FeedbackEditorDraft, FeedbackEditorResult } from './FeedbackEditor';
import { applyChromeColor } from './chrome-color';
import { useThemeSetting } from './use-theme';
import { probePageSurface } from './page-surface';
import type { PageSurface } from './page-surface';
import styles from './Shell.module.css';
import { shareablePageUrl, tabLabel } from './shell-presentation';
import { messageConnectionLabel, useMessageState } from './use-message-state';

/** 平台判定：macOS 红绿灯落在 rail 顶部工具栏内；Windows 由根 padding 让出 overlay 高 */
const isMacPlatform = /Macintosh/.test(navigator.userAgent);
const isWindowsPlatform = /Windows/.test(navigator.userAgent);
/** 剪贴板粘贴快捷键文案：反馈成功提示里引导用户到聊天窗口粘贴 */
const PASTE_SHORTCUT = isMacPlatform ? '⌘V' : 'Ctrl+V';
const DEFAULT_RAIL_WIDTH = 224;
/** 标签侧栏宽度；沿用原有持久化范围。 */
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

/** 聊天应用展示名（toast 用） */
function feedbackAppLabel(app: FeedbackChatApp): string {
  return app === 'wechat' ? '微信' : '企业微信';
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

function shortcutOfUrl(url: string): 'messages' | 'ai' | null {
  try {
    const path = new URL(url).pathname;
    if (/\/FrmMyMessage(?:\/|$)/.test(path)) return 'messages';
    if (/\/chat(?:\/|$)/.test(path)) return 'ai';
  } catch { /* 尚未导航到有效地址 */ }
  return null;
}

/**
 * 主窗壳：左侧竖向标签栏（rail）+ 内容区都在渲染层，每 tab 一个 <webview>（页内合成，与 macOS 整窗 vibrancy 兼容）。
 * 标签状态（id/url/title/favicon/corpNo/isLoading）归渲染层，标题/favicon/loading 由 webview 元素事件维护；
 * URL 策略（分类 + 同域补 sid）归主进程：任何开标签入口先经 tabs:resolve 拿最终 URL 再建 webview。
 * Dia 式两栏布局：左侧顶部放高频入口，下方放标签；右侧顶部放导航与统一应用菜单。
 * 壳内另有「设置页」视图：标签侧栏切换为设置导航，内容区替换为设置项（webview 隐藏不销毁），
 * ESC/返回切回标签视图。
 * 消息与 AI 复用现有 Web 页面；信息页展示本机硬件和网络，切换时保留 Web 实例。
 */
export function Shell() {
  useThemeSetting();
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [session, setSession] = useState<SessionSummary | null>(null);
  const { state: messageState, error: messageError } = useMessageState();
  const [isReloggingIn, setIsReloggingIn] = useState(false);
  const isReloggingInRef = useRef(false);
  const openingPagesRef = useRef(new Set<string>());
  const [activeModule, setActiveModule] = useState<'workspace'>('workspace');
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
  /** 待标注的整窗截图 PNG：非空即打开标注编辑器浮层 */
  const [feedbackShot, setFeedbackShot] = useState<Uint8Array | null>(null);
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackEditorDraft | null>(null);
  const [isFeedbackChoiceOpen, setIsFeedbackChoiceOpen] = useState(false);
  useEffect(() => {
    if (!feedbackDraft) return;
    const timer = setTimeout(() => setFeedbackDraft(null), 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [feedbackDraft]);
  useEffect(() => {
    if (isFeedbackChoiceOpen) document.querySelector<HTMLButtonElement>('[data-testid="feedback-resume-choice"]')?.focus();
  }, [isFeedbackChoiceOpen]);
  // 标签页顶部底色（地址栏跟随网页内容变色）：按标签存，切换标签直接复用，采不到时留空走应用主题默认色
  const [pageSurfaces, setPageSurfaces] = useState<Record<string, PageSurface>>({});
  const nextIdRef = useRef(1);
  const webviewRefs = useRef(new Map<string, WebviewElement>());
  const activeTabIdRef = useRef('');
  activeTabIdRef.current = activeTabId;
  const isWebVisibleRef = useRef(true);
  isWebVisibleRef.current = activeModule === 'workspace' && !isSettingsOpen;
  // 防重不落到 state：截图只有百毫秒级，处理中再点直接忽略，也避免禁用态被截进画面
  const isFeedbackCapturingRef = useRef(false);

  /** 开新标签（URL 必须经主进程 resolve 拿到的最终值），并激活 */
  const openTab = useCallback((url: string, corpNo: string) => {
    const id = String(nextIdRef.current++);
    const tab = { id, url, title: '', favicon: '', corpNo, isLoading: true };
    tabsRef.current = [...tabsRef.current, tab];
    setTabs((prev) => [...prev, tab]);
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
    setIsSettingsOpen(false);
    setActiveModule('workspace');
    setActiveTabId(id);
  }, []);

  /** 工作区新标签直接打开 Web 首页，不承载本地消息或 AI 功能。 */
  const createNewTab = useCallback(() => {
    setIsSettingsOpen(false);
    setActiveModule('workspace');
    void resolveAndOpen({ home: true }).then((result) => {
      if (!result.ok) setFeedbackToast({ kind: 'fail', title: '无法打开页面', desc: result.message });
    }).catch(() => setFeedbackToast({ kind: 'fail', title: '无法打开页面', desc: '请稍后重试' }));
  }, [resolveAndOpen]);

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
      try { window.diteng.tabsSetActiveGuest(isWebVisibleRef.current ? webview?.getWebContentsId() ?? null : null); } catch { window.diteng.tabsSetActiveGuest(null); }
    }
  }, []);

  /** 仅当前可见标签的历史状态驱动工具栏前进/后退按钮 */
  const handleNavigationState = useCallback((id: string, state: NavigationState) => {
    if (id === activeTabIdRef.current) {setNavigationState(state);try { window.diteng.tabsSetActiveGuest(isWebVisibleRef.current ? webviewRefs.current.get(id)?.getWebContentsId() ?? null : null); } catch { /* guest 未 ready */ }}
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
    if (isSettingsOpen) return;
    setIsRailCollapsed((collapsed) => !collapsed);
  }, [isSettingsOpen]);

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

  /** 固定入口复用当前账套已有页面；普通业务链接仍允许多标签。 */
  const openFixedPage = useCallback(async (page: 'accounts' | 'messages' | 'ai') => {
    if (openingPagesRef.current.has(page)) return;
    openingPagesRef.current.add(page);
    setIsSettingsOpen(false);
    setActiveModule('workspace');
    try {
      const result = await window.diteng.tabsResolve(page === 'ai' ? { ai: true } : { page });
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
          if (url.origin !== target.origin) return false;
          if (page !== 'accounts' && shortcutOfUrl(tab.url) === page) return true;
          return url.pathname === target.pathname;
        } catch { return false; }
      });
      if (existing) setActiveTabId(existing.id);
      else openTab(result.url, result.corpNo);
    } catch {
      setFeedbackToast({ kind: 'fail', title: '无法打开页面', desc: '请检查登录状态后重试' });
    } finally { openingPagesRef.current.delete(page); }
  }, [openTab]);

  const openAccounts = useCallback(() => { void openFixedPage('accounts'); }, [openFixedPage]);
  const openChat = useCallback(() => { void openFixedPage('ai'); }, [openFixedPage]);
  const openMessages = useCallback(() => { void openFixedPage('messages'); }, [openFixedPage]);

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
   * 一键反馈：主进程把整个主窗画面（rail + 工具栏 + 当前页）截成 PNG 字节，
   * 壳打开标注编辑器；复制与打开聊天应用由编辑器/本组件完成。
   */
  const captureFeedback = useCallback(async (isReplacing = false) => {
    if (isFeedbackCapturingRef.current) return;
    if (feedbackDraft && !isReplacing) { setIsFeedbackChoiceOpen(true); return; }
    setIsFeedbackChoiceOpen(false);
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
      if (result.ok) { setFeedbackDraft(null); setFeedbackShot(result.png); }
      else setFeedbackToast({ kind: 'fail', title: '截图失败', desc: result.message });
    } catch {
      setFeedbackToast({ kind: 'fail', title: '截图失败', desc: '请稍后重试' });
    } finally {
      if (platformMarker) root.setAttribute('data-platform', platformMarker);
      isFeedbackCapturingRef.current = false;
    }
  }, [feedbackDraft]);

  /**
   * 标注编辑器收尾：复制成功时按目标应用启动微信/企微并给出粘贴引导；
   * 取消或复制失败（编辑器自身保持打开并提示）不产生提示。
   */
  const closeFeedbackEditor = useCallback((result: FeedbackEditorResult) => {
    setFeedbackShot(null);
    if (result.action === 'cancel') return;
    if (feedbackShot) setFeedbackDraft({ png: feedbackShot, history: result.history });
    const target = result.target;
    if (!target) {
      setFeedbackToast({
        kind: 'ok',
        title: '标注截图已复制到系统剪贴板',
        desc: `打开聊天窗口，直接粘贴（${PASTE_SHORTCUT}）发送`,
      });
      return;
    }
    const label = feedbackAppLabel(target);
    void window.diteng
      .openFeedbackApp(target)
      .then((opened) => {
        setFeedbackToast(
          opened.ok
            ? {
                kind: 'ok',
                title: `已复制，正在打开${label}`,
                desc: `在聊天窗口粘贴（${PASTE_SHORTCUT}）发送`,
              }
            : {
                kind: 'fail',
                title: `已复制到剪贴板，但没能打开${label}`,
                desc: `${opened.message}；请手动打开${label}后粘贴发送`,
              },
        );
      })
      .catch(() => {
        setFeedbackToast({
          kind: 'fail',
          title: `已复制到剪贴板，但没能打开${label}`,
          desc: `请手动打开${label}后粘贴发送`,
        });
      });
  }, [feedbackShot]);

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
      setActiveModule('workspace');
      setIsSettingsOpen(false);
      void resolveAndOpen({ url });
    });
    // 账套切换后主进程推送新摘要，设置页身份与账套信息随之刷新
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

  // 激活态自愈：激活 tab 被关掉后落到剩余最后一个（与旧主进程实现一致），全关则保留空白 Web 工作区
  useEffect(() => {
    setActiveTabId((current) => {
      if (current && tabs.some((tab) => tab.id === current)) return current;
      return tabs.length > 0 ? tabs[tabs.length - 1].id : '';
    });
  }, [tabs]);

  // 切标签后立即同步历史可用状态；webview 首次挂载还会由 registerWebview 再同步一次
  useEffect(() => {
    setNavigationState(navigationStateOf(webviewRefs.current.get(activeTabId)));
    try { window.diteng.tabsSetActiveGuest(isWebVisibleRef.current ? webviewRefs.current.get(activeTabId)?.getWebContentsId() ?? null : null); } catch { window.diteng.tabsSetActiveGuest(null); }
  }, [activeTabId, activeModule, isSettingsOpen]);

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

  /** 设置入口保留上次分类。 */
  const openSettings = useCallback(() => {
    setIsSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  /** 点设置分类：切到该分类；分类导航在最左 rail 内 */
  const selectSettingsCategory = useCallback((category: SettingsCategoryKey) => {
    setSettingsCategory(category);
  }, []);

  // 应用快捷键：⌘/Ctrl+B 展开收起侧栏、⌘/Ctrl+, 进入设置页；编辑器快捷键（editor-*）
  // 由 FeedbackEditor 自行订阅处理，这里只认应用级动作。
  useEffect(() => {
    const unsubscribe = window.diteng.onShortcut((action: ShortcutAction) => {
      if (action === 'toggle-rail') toggleRail();
      else if (action === 'open-settings') openSettings();
      else if (action === 'new-tab') createNewTab();
      else if (action === 'close-tab') {
        if (isSettingsOpen) closeSettings();
        else if (activeModule !== 'workspace') setActiveModule('workspace');
        else closeTab(activeTabIdRef.current);
      }
      else if (action === 'next-tab' || action === 'previous-tab') {
        if (isSettingsOpen) return;
        const index = tabs.findIndex((tab) => tab.id === activeTabIdRef.current);
        const next = tabs[(index + (action === 'next-tab' ? 1 : -1) + tabs.length) % tabs.length];
        if (next) activateTab(next.id);
      }
    });
    return unsubscribe;
  }, [openSettings, closeSettings, toggleRail, createNewTab, closeTab, activateTab, tabs, isSettingsOpen, activeModule]);

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

  const messageLabel = messageError || `${messageState?.unreadError ? '未读数同步失败，' : ''}${messageConnectionLabel(messageState)}`;
  const isMessageWarning = Boolean(messageError || messageState?.unreadError || (messageState && !messageState.connected));
  const isWorkspaceVisible = !isSettingsOpen && activeModule === 'workspace';
  const isSidebarVisible = isSettingsOpen || !isRailCollapsed;
  const unreadCount = messageState?.unread ?? -1;
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeShortcut = isWorkspaceVisible && activeTab ? shortcutOfUrl(activeTab.url) : null;

  function returnToWorkspace() {
    setIsSettingsOpen(false);
    setActiveModule('workspace');
  }

  // 内容卡片/地址栏底色跟随当前标签的网页顶部底色；没有采样结果（新建标签页、加载中）时
  // 不写 --card-surface，回落到应用主题的卡片底色。tone 决定工具条文字/图标走深色还是浅色档。
  const activeSurface = activeTabId ? pageSurfaces[activeTabId] : undefined;
  const cardTone = activeSurface ? (activeSurface.isDark ? 'dark' : 'light') : undefined;
  const cardStyle = activeSurface
    ? ({ '--card-surface': activeSurface.color } as CSSProperties)
    : undefined;

  const shellClass = `${styles.shell} ${styles.shellRail}${isWindowsPlatform ? ` ${styles.shellRailWin}` : ''}`;

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
        <aside className={styles.rail} data-testid="tabstrip" data-collapsed={!isSidebarVisible}
          style={{ width: railWidth, display: isSidebarVisible ? undefined : 'none' }}>
            <div className={styles.sidebarToolbar} data-testid="sidebar-toolbar" aria-hidden="true" />
            {/* 宽度拖拽手柄：贴 rail 右缘，命中区 7px；双击复位默认 224 */}
            {isSidebarVisible && <div
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
              />
            ) : (
              <>
                <div className={styles.shortcuts} data-testid="sidebar-shortcuts" role="group" aria-label="常用入口">
                  <button type="button" className={styles.sidebarButton} data-testid="open-messages" aria-pressed={activeShortcut === 'messages'} disabled={!session}
                    title={`消息，${messageLabel}`} aria-label={`消息，${unreadCount >= 0 ? `${unreadCount} 条未读` : '未读数待同步'}，${messageLabel}`} onClick={openMessages}>
                    <BellIcon /><span>消息</span>
                    {unreadCount > 0 && <span className={styles.unreadBadge} data-testid="unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
                    {isMessageWarning && <i className={styles.messageWarning} data-testid="message-warning" />}
                  </button>
                  <button type="button" className={styles.sidebarButton} data-testid="open-ai" title="AI 助手" aria-label="Chat · AI 助手" aria-pressed={activeShortcut === 'ai'} disabled={!session} onClick={openChat}>
                    <ChatIcon /><span>Chat</span>
                  </button>
                </div>
                <div className={styles.railTabs} data-testid="rail-tabs" role="tablist" aria-label="标签页">
                  {tabs.map((tab) => (
                    <RailTab
                      key={tab.id}
                      tab={tab}
                      label={tabLabel(tab, tabs)}
                      isActive={isWorkspaceVisible && tab.id === activeTabId}
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
          </aside>

        {/* 设置页直接接管内容区，不再复用浏览器工具栏；返回标签视图后恢复 webview 内容 */}
        <main className={isSettingsOpen ? `${styles.body} ${styles.bodySettings}` : styles.body}>
          {/* 内容卡片：地址栏与网页同处一张 16px 圆角卡片，四边 5px 外围色留白（上/下/右等宽）；
              地址栏底色跟随网页内容，卡片内部不再出现一条横向的外壳色色带。
              设置页打开时整卡 display:none 隐藏（webview 不销毁，返回后标签原样恢复）。 */}
          <div
            className={styles.contentCard}
            data-testid="content-card"
            data-tone={isWorkspaceVisible ? cardTone : undefined}
            style={{ display: isSettingsOpen ? 'none' : undefined, ...(isWorkspaceVisible ? cardStyle : undefined) }}
          >
            {!isSettingsOpen && (
              <ContentToolbar
                isRailCollapsed={isRailCollapsed}
                onToggleRail={toggleRail}
                url={isWorkspaceVisible ? activeTab?.url ?? '' : ''}
                pageTitle={isWorkspaceVisible ? activeTab?.title ?? '' : ''}
                canGoBack={!isWorkspaceVisible || Boolean(activeTab) && navigationState.canGoBack}
                canGoForward={isWorkspaceVisible && Boolean(activeTab) && navigationState.canGoForward}
                isLoading={isWorkspaceVisible && Boolean(activeTab?.isLoading)}
                hasActiveTab={isWorkspaceVisible && Boolean(activeTab)}
                onBack={isWorkspaceVisible ? navigateBack : returnToWorkspace}
                onForward={navigateForward}
                onReload={reloadActiveTab}
                onNewTab={createNewTab}
                onSettings={openSettings}
                onFeedback={() => void captureFeedback()}
                onMessages={openMessages}
                onChat={openChat}
                isModuleDisabled={!session}
                isMessagesActive={activeShortcut === 'messages'}
                isChatActive={activeShortcut === 'ai'}
                unreadCount={unreadCount}
                messageLabel={messageLabel}
                isMessageWarning={isMessageWarning}
              />
            )}
            {/* 工作区隐藏时保留 webview DOM，切回后继续原网页状态。 */}
            <div className={styles.viewport} style={{ display: isWorkspaceVisible ? undefined : 'none' }}>
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

            </div>
          </div>

          {isSettingsOpen && (
            <>
              <SettingsPage session={session} activeCategory={settingsCategory} messageState={messageState} messageError={messageError}
                onAccounts={() => void openAccounts()} onMessages={openMessages} onRelogin={() => void relogin()} isReloggingIn={isReloggingIn} />
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
                {feedbackDraft && <button type="button" className={styles.feedbackResume} data-testid="feedback-resume" onClick={() => { setFeedbackShot(feedbackDraft.png); setFeedbackToast(null); }}>继续编辑</button>}
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
          {/* 截图标注编辑器：壳内全屏浮层，固定定位不受布局影响；关闭后按结果提示 */}
          {feedbackShot && <FeedbackEditor png={feedbackShot} initialHistory={feedbackDraft?.png === feedbackShot ? feedbackDraft.history : undefined} onClose={closeFeedbackEditor} />}
          {isFeedbackChoiceOpen && <div className={styles.feedbackChoiceBackdrop}>
            <div className={styles.feedbackChoice} role="alertdialog" aria-modal="true" aria-labelledby="feedback-choice-title" aria-describedby="feedback-choice-desc"
              onKeyDown={(event) => {
                if (event.key === 'Escape') { setIsFeedbackChoiceOpen(false); event.stopPropagation(); }
                if (event.key === 'Tab') {
                  const buttons = [...event.currentTarget.querySelectorAll('button')];
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
                }
              }}>
              <strong id="feedback-choice-title">继续编辑上一次截图？</strong>
              <p id="feedback-choice-desc">重新截图会替换上一次截图和标注。</p>
              <div className={styles.feedbackChoiceActions}>
                <button type="button" onClick={() => setIsFeedbackChoiceOpen(false)}>取消</button>
                <button type="button" data-testid="feedback-replace" onClick={() => void captureFeedback(true)}>重新截图</button>
                <button type="button" data-testid="feedback-resume-choice" onClick={() => { if (feedbackDraft) setFeedbackShot(feedbackDraft.png); setFeedbackToast(null); setIsFeedbackChoiceOpen(false); }}>继续编辑</button>
              </div>
            </div>
          </div>}
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

/**
 * 右侧内容区工具栏：导航组紧贴地址栏左侧（Chrome 式）。
 * 展示页面名与域名；复制链接剥离会话参数，不修改真实导航地址。仅浏览页使用，设置页不渲染。
 */
function ContentToolbar({
  isRailCollapsed,
  onToggleRail,
  url,
  pageTitle,
  canGoBack,
  canGoForward,
  isLoading,
  hasActiveTab,
  onBack,
  onForward,
  onReload,
  onNewTab,
  onSettings,
  onFeedback,
  onMessages,
  onChat,
  isModuleDisabled,
  isMessagesActive,
  isChatActive,
  unreadCount,
  messageLabel,
  isMessageWarning,
}: {
  isRailCollapsed: boolean;
  onToggleRail: () => void;
  url: string;
  pageTitle: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  hasActiveTab: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onNewTab: () => void;
  onSettings: () => void;
  onFeedback: () => void;
  onMessages: () => void;
  onChat: () => void;
  isModuleDisabled: boolean;
  isMessagesActive: boolean;
  isChatActive: boolean;
  unreadCount: number;
  messageLabel: string;
  isMessageWarning: boolean;
}) {
  // 复制反馈：ok 成功 / fail 剪贴板不可用，2 秒后还原
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });
  const safeUrl = shareablePageUrl(url);
  const hasUrl = Boolean(safeUrl);

  const dismissMenu = useCallback(() => {
    setIsMenuOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isMenuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = () => setIsMenuOpen(false);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [isMenuOpen]);

  function toggleMenu() {
    if (isMenuOpen) { dismissMenu(); return; }
    const bounds = menuButtonRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setMenuPosition({ top: bounds.bottom + 6, right: Math.max(8, window.innerWidth - bounds.right) });
    setIsMenuOpen(true);
  }

  function runMenuAction(action: () => void) {
    dismissMenu();
    action();
  }

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
  const locationText = safeUrl || pageTitle || '新建标签页';
  return (
    <div
      className={styles.contentToolbar}
      data-testid="browser-toolbar"
      data-sidebar-collapsed={isRailCollapsed}
      role="toolbar"
      aria-label="浏览器工具栏"
    >
      <ToolbarButton label={isRailCollapsed ? '展开侧栏' : '收起侧栏'} testId="sidebar-toggle" pressed={!isRailCollapsed} onClick={onToggleRail}>
        <SidebarToggleIcon />
      </ToolbarButton>
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
      </div>
      <div className={styles.toolbarAddress} data-testid="url-bar" role="group" aria-label="当前页面信息">
        <span className={styles.toolbarAddressText} data-testid="url-bar-text" title={locationText}>{locationText}</span>
      </div>
      <div className={styles.toolbarActions} role="group" aria-label="页面操作">
        <ToolbarButton label={copyLabel} testId="url-bar-copy" disabled={!hasUrl} onClick={() => void copyUrl()}>
          {copyState === 'ok' ? <CheckIcon /> : <CopyIcon />}
        </ToolbarButton>
        <ToolbarButton label="一键反馈" testId="feedback-button" onClick={onFeedback}>
          <CameraIcon />
        </ToolbarButton>
      </div>
      <button ref={menuButtonRef} type="button" className={`${styles.toolbarButton} ${styles.appMenuButton}`} data-testid="app-menu-button"
        title="功能与设置" aria-label={`功能与设置${unreadCount > 0 ? `，${unreadCount} 条未读消息` : ''}`} aria-haspopup="menu" aria-expanded={isMenuOpen} aria-controls={isMenuOpen ? 'app-menu' : undefined}
        onClick={toggleMenu} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!isMenuOpen) toggleMenu(); }
        }}>
        <DotsVerticalIcon width={18} height={18} />
        {isRailCollapsed && unreadCount > 0 ? <span className={styles.unreadBadge} data-testid="unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
        {isRailCollapsed && isMessageWarning ? <i className={styles.messageWarning} data-testid="message-warning" /> : null}
      </button>
      {isMenuOpen && createPortal(<>
        {/* 菜单挂到应用主题层，避免继承网页卡片按页面底色覆盖的文字和交互配色。 */}
        {/* 遮罩接住网页 guest 区域的外部点击，避免菜单打开时误操作网页。 */}
        <div className={styles.appMenuBackdrop} data-testid="app-menu-backdrop" onPointerDown={dismissMenu} onContextMenu={(event) => { event.preventDefault(); dismissMenu(); }} />
        <div ref={menuRef} id="app-menu" role="menu" aria-label="功能与设置" className={styles.appMenu} data-testid="app-menu" style={menuPosition}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); dismissMenu(); }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}>
          <button type="button" role="menuitem" data-testid="new-tab" onClick={() => runMenuAction(onNewTab)}>
            <PlusIcon /><span>打开新的标签页</span><span className={styles.appMenuShortcut}>{isMacPlatform ? '⌘T' : 'Ctrl+T'}</span>
          </button>
          <div role="separator" />
          <button type="button" role="menuitemcheckbox" aria-checked={isMessagesActive} data-testid="menu-open-messages" disabled={isModuleDisabled}
            title={messageLabel} aria-label={`消息中心，${unreadCount >= 0 ? `${unreadCount} 条未读` : '未读数待同步'}，${messageLabel}`} onClick={() => runMenuAction(onMessages)}>
            <BellIcon /><span>消息中心</span>{unreadCount > 0 ? <span className={styles.appMenuBadge}>{unreadCount > 99 ? '99+' : unreadCount}</span> : isMessagesActive ? <CheckIcon /> : null}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={isChatActive} data-testid="menu-open-ai" disabled={isModuleDisabled} onClick={() => runMenuAction(onChat)}>
            <ChatIcon /><span>AI 助手</span>{isChatActive && <CheckIcon />}
          </button>
          <div role="separator" />
          <button type="button" role="menuitem" data-testid="open-settings" onClick={() => runMenuAction(onSettings)}>
            <SettingsIcon /><span>设置</span><span className={styles.appMenuShortcut}>{isMacPlatform ? '⌘,' : 'Ctrl+,'}</span>
          </button>
        </div>
      </>, document.body)}
    </div>
  );
}
