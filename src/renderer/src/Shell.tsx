import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  CorpAccount,
  SessionSummary,
  TabInfo,
  TabsResolveRequest,
  TabsResolveResult,
} from '../../shared/types';
import type { WebviewDomEvent, WebviewElement } from './env';
import {
  CheckIcon,
  CloseIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SignOutIcon,
  SunIcon,
} from './theme-icons';
import { SettingsPage } from './Settings';
import { useThemeSetting } from './use-theme';
import styles from './Shell.module.css';

/** 平台判定：rail 顶部让位形态（macOS 红绿灯让 rail 内 52px，Windows 由根 padding 让出 overlay 高） */
const isMacPlatform = /Macintosh/.test(navigator.userAgent);

/**
 * 主窗壳：左侧竖向标签栏（rail）+ 内容区都在渲染层，每 tab 一个 <webview>（页内合成，与 macOS 整窗 vibrancy 兼容）。
 * 标签状态（id/url/title/favicon/corpNo/isLoading）归渲染层，标题/favicon/loading 由 webview 元素事件维护；
 * URL 策略（分类 + 同域补 sid）归主进程：任何开标签入口先经 tabs:resolve 拿最终 URL 再建 webview。
 * 壳内另有「设置页」视图：内容区整体替换为设置页（webview 隐藏不销毁），rail 保留，ESC/返回回标签视图。
 * 关闭到 0 个 tab 时内容区被新建标签页覆盖，窗口不销毁。
 */
export function Shell() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [session, setSession] = useState<SessionSummary | null>(null);
  // 侧栏宽度：默认 300 对齐 Cursor/VS Code 侧栏默认宽度；0=未自定义（双击手柄复位时写 0）
  const [railWidth, setRailWidth] = useState(300);
  const [savedLoginId, setSavedLoginId] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRailDrag, setIsRailDrag] = useState(false);
  const nextIdRef = useRef(1);

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

  /** webview 事件回写标签元数据（title/favicon/loading/url） */
  const updateTab = useCallback((id: string, patch: Partial<Pick<TabInfo, 'url' | 'title' | 'favicon' | 'isLoading'>>) => {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  }, []);

  // 挂载：会话/配置拉取、首个标签（登录落点）、guest 开标签请求、账套切换广播
  useEffect(() => {
    void window.diteng.getSession().then(setSession);
    void window.diteng.getConfig().then((config) => {
      setSavedLoginId(config.savedLoginId);
      if (config.railWidth >= 200 && config.railWidth <= 480) setRailWidth(config.railWidth);
    });
    void window.diteng.tabsPopEntry().then((entry) => {
      if (entry) openTab(entry.url, entry.corpNo);
    });
    const unsubscribeOpen = window.diteng.onTabsOpenRequest(({ url }) => {
      void resolveAndOpen({ url });
    });
    const unsubscribeCorp = window.diteng.onCorpSwitched(({ corpNo, entryUrl }) => {
      // 关旧账套全部标签（AI 标签记打开时账套，一并关闭），再开新账套首页
      setTabs((prev) => prev.filter((tab) => tab.corpNo === corpNo));
      openTab(entryUrl, corpNo);
    });
    // 账套切换后主进程推送新摘要，底部用户行与快捷入口文案随之刷新
    const unsubscribeSession = window.diteng.onSessionChanged((summary) => setSession(summary));
    return () => {
      unsubscribeOpen();
      unsubscribeCorp();
      unsubscribeSession();
    };
  }, [openTab, resolveAndOpen]);

  // 激活态自愈：激活 tab 被关掉后落到剩余最后一个（与旧主进程实现一致），全关则空（新建标签页）
  useEffect(() => {
    setActiveTabId((current) => {
      if (current && tabs.some((tab) => tab.id === current)) return current;
      return tabs.length > 0 ? tabs[tabs.length - 1].id : '';
    });
  }, [tabs]);

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

  /** 进设置页（rail 齿轮 / 卡片「设置…」共用） */
  const openSettings = useCallback(() => {
    setIsSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  // ===== 侧栏宽度拖拽：拖拽期间盖全窗透明盾牌（z-index 高于一切，含 webview），
  // 否则指针移入 webview 区域后事件被路由进 guest 进程，宿主页收不到 move/up（真实拖拽同样会卡住）；
  // 松手持久化；双击手柄复位默认 300（写 0=跟随默认） =====
  const DEFAULT_RAIL_WIDTH = 300;
  const RAIL_WIDTH_MIN = 200;
  const RAIL_WIDTH_MAX = 480;
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

  // 底部用户行显示名：会话用户名优先，主进程未取到时回落记住的账号
  const userDisplayName = session?.userName || savedLoginId || '未登录';

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
      <aside className={styles.rail} data-testid="tabstrip" style={{ width: railWidth }}>
        {/* 宽度拖拽手柄：贴 rail 右缘，命中区 7px；双击复位默认 300 */}
        <div
          className={styles.railResizeHandle}
          data-testid="rail-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整标签栏宽度（双击恢复默认）"
          onPointerDown={handleRailResizeStart}
        />
        {/* 顶部让位：macOS 红绿灯拖拽区；Windows 由 shellRailWin 根 padding 让出 overlay，此占位不渲染 */}
        <div className={styles.railTop} aria-hidden="true" />
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
            <RailTab key={tab.id} tab={tab} isActive={tab.id === activeTabId} onClose={closeTab} onActivate={activateTab} />
          ))}
        </div>
        <div className={styles.railFooter}>
          <UserChip session={session} displayName={userDisplayName} onOpenSettings={openSettings} />
        </div>
      </aside>

      <main className={styles.body}>
        {/* webview 宿主：非激活标签 display:none 隐藏（保留 DOM，guest 不销毁不重载）；
            设置页打开时整体隐藏（webview 不销毁，返回后标签原样恢复） */}
        <div className={styles.viewport} style={{ display: isSettingsOpen ? 'none' : undefined }}>
          {tabs.map((tab) => (
            <TabWebview key={tab.id} tab={tab} isActive={tab.id === activeTabId} onMeta={updateTab} />
          ))}
        </div>
        {!isSettingsOpen && tabs.length === 0 && <NewTabPage session={session} openViaMain={resolveAndOpen} />}
        {isSettingsOpen && (
          <SettingsPage session={session} userDisplayName={userDisplayName} onBack={closeSettings} />
        )}
      </main>
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
}: {
  tab: TabInfo;
  isActive: boolean;
  onMeta: (id: string, patch: Partial<Pick<TabInfo, 'url' | 'title' | 'favicon' | 'isLoading'>>) => void;
}) {
  const initialSrc = useRef(tab.url).current;
  const elementRef = useRef<WebviewElement | null>(null);

  // 标题/favicon/loading 全部由 webview 元素事件在渲染层维护，不走主进程
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const meta = (patch: Partial<Pick<TabInfo, 'url' | 'title' | 'favicon' | 'isLoading'>>) => onMeta(tab.id, patch);
    const onTitle = (event: WebviewDomEvent) => meta({ title: event.title ?? '' });
    const onFavicon = (event: WebviewDomEvent) => {
      if (event.favicons && event.favicons.length > 0) meta({ favicon: event.favicons[0] });
    };
    const onStartLoading = () => meta({ isLoading: true });
    const onStopLoading = () => meta({ isLoading: false });
    const onNavigate = (event: WebviewDomEvent) => meta({ url: event.url ?? element.getURL() });
    const onDomReady = () => meta({ url: element.getURL() });
    element.addEventListener('page-title-updated', onTitle);
    element.addEventListener('page-favicon-updated', onFavicon);
    element.addEventListener('did-start-loading', onStartLoading);
    element.addEventListener('did-stop-loading', onStopLoading);
    element.addEventListener('did-navigate', onNavigate);
    element.addEventListener('dom-ready', onDomReady);
    return () => {
      element.removeEventListener('page-title-updated', onTitle);
      element.removeEventListener('page-favicon-updated', onFavicon);
      element.removeEventListener('did-start-loading', onStartLoading);
      element.removeEventListener('did-stop-loading', onStopLoading);
      element.removeEventListener('did-navigate', onNavigate);
      element.removeEventListener('dom-ready', onDomReady);
    };
  }, [tab.id, onMeta]);

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
 * 底部用户行（Cursor 式）：圆形头像（用户名首字符，账套无关）+ 用户名单行省略 + 右端齿轮，
 * 扁平融入侧栏无边框；点击整行向上弹出用户卡片，齿轮单独点击直达设置页。
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
  const [corps, setCorps] = useState<CorpAccount[]>([]);
  const [isListLoading, setIsListLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [hint, setHint] = useState('');
  const { themeSetting, setTheme } = useThemeSetting();
  const wrapRef = useRef<HTMLDivElement>(null);

  // 挂载即拉取一次：账套列表主进程缓存，用于卡片账套组展示
  useEffect(() => {
    void loadCorps();
  }, []);

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

  async function loadCorps() {
    setIsListLoading(true);
    const result = await window.diteng.sessionListCorps();
    setIsListLoading(false);
    if (result.ok) {
      setCorps(result.data);
      setHint('');
    } else {
      setHint(result.message);
    }
  }

  function toggleOpen() {
    if (isSwitching) return;
    const next = !isOpen;
    setIsOpen(next);
    // 空列表（首次拉取失败或未完成）时展开重试
    if (next && corps.length === 0) void loadCorps();
  }

  /** 账套切换：getNuewToken 免密切换由主进程完成并广播 corp:switched（关旧账套标签 + 开新账套首页） */
  async function switchCorp(corpNo: string) {
    if (isSwitching) return;
    setIsSwitching(true);
    setHint('');
    const result = await window.diteng.sessionSwitchCorp({ corpNo });
    setIsSwitching(false);
    if (result.ok) setIsOpen(false);
    else setHint(result.message);
  }

  const avatarChar = displayName.charAt(0).toUpperCase();

  return (
    <div className={styles.userChipWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.userChip} ${styles.userChipRail}`}
        data-testid="user-chip"
        data-switching={isSwitching ? 'true' : 'false'}
        onClick={toggleOpen}
        disabled={!session || isSwitching}
        title={session ? `当前账套 ${session.corpNo}（服务器 ${session.serverBase}）` : '未登录'}
      >
        {isSwitching && <span className={styles.spinner} aria-hidden="true" />}
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
          <div className={styles.userCardLabel}>账套</div>
          <div className={styles.userCardCorps} role="listbox" aria-label="可用账套">
            {isListLoading && corps.length === 0 && <div className={styles.userCardHint}>加载中…</div>}
            {!isListLoading && corps.length === 0 && !hint && (
              <div className={styles.userCardHint}>暂无可用账套</div>
            )}
            {corps.map((corp) => {
              const isCurrent = corp.corpNo === session?.corpNo;
              return (
                <button
                  key={corp.corpNo}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  data-testid={`corp-option-${corp.corpNo}`}
                  className={
                    isCurrent ? `${styles.userCardRow} ${styles.userCardRowCurrent}` : styles.userCardRow
                  }
                  disabled={isSwitching || isCurrent}
                  onClick={() => void switchCorp(corp.corpNo)}
                >
                  <span className={styles.userCardCorpDot} aria-hidden="true">
                    {(corp.shortName || corp.name || corp.corpNo).charAt(0)}
                  </span>
                  <span className={styles.userCardCorpText}>
                    <span className={styles.userCardCorpName}>{corp.shortName || corp.name || corp.corpNo}</span>
                    <span className={styles.userCardCorpNo}>{corp.corpNo}</span>
                  </span>
                  {isCurrent && (
                    <span className={styles.userCardCheck}>
                      <CheckIcon />
                    </span>
                  )}
                </button>
              );
            })}
            {hint && <div className={styles.userCardHint}>{hint}</div>}
          </div>
          <div className={styles.userCardDivider} />
          <div className={styles.userCardLabel}>外观</div>
          <button
            type="button"
            data-testid="card-theme-system"
            className={styles.userCardRow}
            onClick={() => setTheme('system')}
          >
            <MonitorIcon />
            <span className={styles.userCardRowText}>跟随系统</span>
            {themeSetting === 'system' && (
              <span className={styles.userCardCheck}>
                <CheckIcon />
              </span>
            )}
          </button>
          <button
            type="button"
            data-testid="card-theme-light"
            className={styles.userCardRow}
            onClick={() => setTheme('light')}
          >
            <SunIcon />
            <span className={styles.userCardRowText}>浅色</span>
            {themeSetting === 'light' && (
              <span className={styles.userCardCheck}>
                <CheckIcon />
              </span>
            )}
          </button>
          <button
            type="button"
            data-testid="card-theme-dark"
            className={styles.userCardRow}
            onClick={() => setTheme('dark')}
          >
            <MoonIcon />
            <span className={styles.userCardRowText}>深色</span>
            {themeSetting === 'dark' && (
              <span className={styles.userCardCheck}>
                <CheckIcon />
              </span>
            )}
          </button>
          <div className={styles.userCardDivider} />
          <button
            type="button"
            data-testid="card-settings"
            className={styles.userCardRow}
            onClick={() => {
              setIsOpen(false);
              onOpenSettings();
            }}
          >
            <SettingsIcon />
            <span className={styles.userCardRowText}>设置…</span>
            <span className={styles.userCardKbd}>⌘,</span>
          </button>
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
