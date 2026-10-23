import { useEffect, useState } from 'react';
import type { AppConfig, SessionSummary } from '../../shared/types';
import { ArrowLeftIcon, SignOutIcon } from './theme-icons';
import { useThemeSetting } from './use-theme';
import styles from './Settings.module.css';

/** 应用版本（package.json version，v1 固定展示） */
const APP_VERSION = '0.1.0';

/**
 * AI 站点展示推导：与主进程 config.ts resolveAiBase 同规则（仅设置页展示用；
 * 手改 aiBase 空串时按 serverBase 推导，生产 m.cdcp.site → https://ai.cdcp.site，其余回本地 dev）。
 */
function deriveAiBase(config: AppConfig): string {
  if (config.aiBase.trim()) return config.aiBase.trim().replace(/\/+$/, '');
  return config.serverBase.includes('cdcp.site') ? 'https://ai.cdcp.site' : 'http://127.0.0.1:3060';
}

/** 设置分类：key 同时用于 data-testid=settings-nav-{key} */
export type SettingsCategoryKey = 'account' | 'appearance' | 'connection' | 'about';

export interface SettingsCategoryDef {
  key: SettingsCategoryKey;
  name: string;
  desc: string;
}

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryKey = 'appearance';

/** 导航顺序即展示顺序：账号 / 外观 / 连接 / 关于 */
const CATEGORIES: SettingsCategoryDef[] = [
  { key: 'account', name: '账号', desc: '登录身份与凭据' },
  { key: 'appearance', name: '外观', desc: '主题外观' },
  { key: 'connection', name: '连接', desc: '服务器与 AI 站点' },
  { key: 'about', name: '关于', desc: '版本与更新' },
];

function categoryOf(key: SettingsCategoryKey): SettingsCategoryDef {
  const found = CATEGORIES.find((cat) => cat.key === key);
  return found ?? CATEGORIES[0];
}

/** 分段选择器选项（主题 / 标签布局共用形态） */
interface SegmentOption {
  value: string;
  label: string;
  testid: string;
  onSelect: () => void;
}

/** 行右侧控件三形态：分段选择 / 只读值 / 占位禁用按钮 */
type RowControl =
  | { kind: 'segmented'; ariaLabel: string; value: string; options: SegmentOption[] }
  | { kind: 'value'; testid?: string; text: string }
  | { kind: 'disabledButton'; label: string };

/** 一行设置项：左侧名称+次级描述，右侧控件；keywords 为搜索同义词（标题/描述自动参与匹配） */
interface SettingRowDef {
  key: string;
  title: string;
  desc?: string;
  keywords?: string;
  control: RowControl;
}

/** 搜索命中：空查询全中，包含匹配且大小写不敏感（输 ai / AI 都能命中） */
function isHit(query: string, ...texts: string[]): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  return texts.some((text) => text.toLowerCase().includes(keyword));
}

function isRowHit(row: SettingRowDef, query: string): boolean {
  return isHit(query, row.title, row.desc ?? '', row.keywords ?? '');
}

/** rail 导航搜索索引：包含各分类下设置行与账号卡片的搜索词，避免导航和内容过滤结果不一致 */
const CATEGORY_SEARCH_TERMS: Record<SettingsCategoryKey, string[]> = {
  account: [
    '设备码',
    '设备在服务端的唯一标识（展示前 8 位）',
    '当前账套',
    '当前登录的 ERP 账套',
    '用户名',
    '账号代码',
    '退出登录',
    '头像',
  ],
  appearance: ['主题', '跟随系统深浅色或固定外观', '深色', '浅色', '外观', 'dark', 'light'],
  connection: ['服务器地址', '修改后需重新登录', 'AI 站点', '未手动设置时按服务器地址推导', 'server'],
  about: ['版本', '软件更新', '当前安装包未签名', '检查更新', 'version'],
};

/** 搜索态下 rail 可见分类：分类标题/描述或分类内任一设置项命中 */
export function getVisibleSettingsCategories(
  query: string,
  userDisplayName = '',
  userCode = '',
): SettingsCategoryDef[] {
  return CATEGORIES.filter((cat) =>
    isHit(
      query,
      cat.name,
      cat.desc,
      ...CATEGORY_SEARCH_TERMS[cat.key],
      ...(cat.key === 'account' ? [userDisplayName, userCode] : []),
    ),
  );
}

/** 搜索态下某分类的可见行：分类名命中时整组展示，否则按行过滤；空查询即整组 */
function visibleRowsOf(
  cat: SettingsCategoryDef,
  rows: SettingRowDef[],
  query: string,
): SettingRowDef[] {
  if (isHit(query, cat.name)) return rows;
  return rows.filter((row) => isRowHit(row, query));
}

/** 搜索放大镜（仅设置页使用，暂不入 theme-icons） */
function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5L21 21" />
    </svg>
  );
}

/**
 * 设置态 rail 导航：复用主窗口最左侧侧栏，不再在内容区额外占一列。
 * 返回/标题、搜索和分类列表均收进 rail；内容区只保留当前分类的设置项。
 */
export function SettingsRail({
  categories,
  activeCategory,
  query,
  onQueryChange,
  onSelectCategory,
  onBack,
}: {
  categories: SettingsCategoryDef[];
  activeCategory: SettingsCategoryKey;
  query: string;
  onQueryChange: (query: string) => void;
  onSelectCategory: (category: SettingsCategoryKey) => void;
  onBack: () => void;
}) {
  return (
    <div className={styles.settingsRail} data-testid="settings-rail">
      <div className={styles.sidebarHead}>
        <button type="button" className={styles.back} data-testid="settings-back" onClick={onBack}>
          <ArrowLeftIcon />
          <span>返回</span>
        </button>
        <h1 className={styles.title}>设置</h1>
      </div>
      <div className={styles.searchWrap}>
        <div className={styles.searchBox}>
          <span className={styles.searchIcon} aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            type="text"
            className={styles.searchInput}
            data-testid="settings-search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索设置项"
            aria-label="搜索设置项"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
        </div>
      </div>
      <nav className={styles.nav} aria-label="设置分类">
        {categories.map((cat) => (
          <button
            key={cat.key}
            type="button"
            data-testid={`settings-nav-${cat.key}`}
            className={cat.key === activeCategory ? styles.navItemActive : styles.navItem}
            aria-current={cat.key === activeCategory ? 'page' : undefined}
            onClick={() => onSelectCategory(cat.key)}
          >
            <span className={styles.navName}>{cat.name}</span>
            <span className={styles.navDesc}>{cat.desc}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/** 行右侧控件渲染 */
function RowControlView({ control }: { control: RowControl }) {
  if (control.kind === 'segmented') {
    return (
      <div className={styles.segmented} role="radiogroup" aria-label={control.ariaLabel}>
        {control.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={control.value === option.value}
            data-testid={option.testid}
            className={control.value === option.value ? styles.segmentActive : styles.segment}
            onClick={option.onSelect}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }
  if (control.kind === 'disabledButton') {
    return (
      <button type="button" className={styles.disabledButton} disabled>
        {control.label}
      </button>
    );
  }
  return (
    <span className={styles.rowValue} data-testid={control.testid}>
      {control.text}
    </span>
  );
}

/** 行式设置项：左「名称 + 次级描述」、右控件，弱分隔线（Cursor 行距） */
function SettingRowView({ row }: { row: SettingRowDef }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>{row.title}</div>
        {row.desc && <div className={styles.rowDesc}>{row.desc}</div>}
      </div>
      <RowControlView control={row.control} />
    </div>
  );
}

/** 一组设置行共用一张卡片，避免行内容直接散落在整页背景上。 */
function SettingRows({ rows }: { rows: SettingRowDef[] }) {
  if (rows.length === 0) return null;
  return (
    <div className={styles.rowGroup}>
      {rows.map((row) => (
        <SettingRowView key={row.key} row={row} />
      ))}
    </div>
  );
}

/** 账号页顶部大卡片：圆形头像 + 用户名/账号代码，底部「退出登录」红字链接（走现有 auth:logout 链路） */
function ProfileCard({ userDisplayName, userCode }: { userDisplayName: string; userCode: string }) {
  return (
    <div className={styles.profileCard}>
      <div className={styles.profileMain}>
        <span className={styles.profileAvatar} aria-hidden="true">
          {userDisplayName.charAt(0).toUpperCase()}
        </span>
        <div className={styles.profileMeta}>
          <div className={styles.profileName}>{userDisplayName}</div>
          <div className={styles.profileCode}>{userCode || '—'}</div>
        </div>
      </div>
      <div className={styles.profileFooter}>
        <button
          type="button"
          className={styles.logoutLink}
          data-testid="logout"
          onClick={() => {
            void window.diteng.logout();
          }}
        >
          <SignOutIcon />
          <span>退出登录</span>
        </button>
      </div>
    </div>
  );
}

/**
 * 设置内容区（壳内视图，替换 webview 区域；左侧 rail 由 SettingsRail 复用）：
 * 分类大标题 + 副标题 + 行式设置项居中展示；搜索同时过滤 rail 分类与内容区设置行，无匹配出空态。
 * v1 内容：账号（大卡片 + 设备码/账套）、外观（主题）、连接（只读，变更入口统一在登录页）、关于。
 */
export function SettingsPage({
  session,
  userDisplayName,
  activeCategory,
  query,
}: {
  session: SessionSummary | null;
  userDisplayName: string;
  activeCategory: SettingsCategoryKey;
  query: string;
}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const { themeSetting, setTheme } = useThemeSetting();

  useEffect(() => {
    void window.diteng.getConfig().then(setConfig);
  }, []);

  const isSearching = query.trim() !== '';
  const userCode = session?.userCode ?? '';
  const activeCat = categoryOf(activeCategory);

  const rowsByCategory: Record<SettingsCategoryKey, SettingRowDef[]> = {
    account: [
      {
        key: 'device',
        title: '设备码',
        desc: '设备在服务端的唯一标识（展示前 8 位）',
        control: { kind: 'value', text: config ? config.machineCode.slice(0, 8) : '' },
      },
      {
        key: 'corp',
        title: '当前账套',
        desc: '当前登录的 ERP 账套',
        control: { kind: 'value', text: session?.corpNo || '—' },
      },
    ],
    appearance: [
      {
        key: 'theme',
        title: '主题',
        desc: '跟随系统深浅色或固定外观',
        keywords: '深色 浅色 外观 dark light',
        control: {
          kind: 'segmented',
          ariaLabel: '主题',
          value: themeSetting,
          options: [
            { value: 'system', label: '跟随系统', testid: 'settings-theme-system', onSelect: () => setTheme('system') },
            { value: 'light', label: '浅色', testid: 'settings-theme-light', onSelect: () => setTheme('light') },
            { value: 'dark', label: '深色', testid: 'settings-theme-dark', onSelect: () => setTheme('dark') },
          ],
        },
      },
    ],
    connection: [
      {
        key: 'server-base',
        title: '服务器地址',
        desc: '修改后需重新登录，请在登录页修改',
        keywords: 'server 地址',
        control: { kind: 'value', testid: 'settings-server-base', text: config?.serverBase ?? '' },
      },
      {
        key: 'ai-base',
        title: 'AI 站点',
        desc: '未手动设置时按服务器地址推导',
        keywords: 'ai 对话',
        control: { kind: 'value', testid: 'settings-ai-base', text: config ? deriveAiBase(config) : '' },
      },
    ],
    about: [
      {
        key: 'version',
        title: '版本',
        keywords: 'version',
        control: { kind: 'value', text: APP_VERSION },
      },
      {
        key: 'update',
        title: '软件更新',
        desc: '当前安装包未签名，更新通道建设中',
        keywords: '更新 检查更新',
        control: { kind: 'disabledButton', label: '检查更新' },
      },
    ],
  };

  /** 与 rail 导航共用同一搜索索引，保证两侧可见分类一致 */
  const visibleCategories = getVisibleSettingsCategories(query, userDisplayName, userCode);

  /** 搜索态下账号卡片是否展示：分类信息或卡片自身关键词命中 */
  const accountCat = categoryOf('account');
  const isAccountCardVisible = isHit(
    query,
    accountCat.name,
    accountCat.desc,
    ...CATEGORY_SEARCH_TERMS.account,
    userDisplayName,
    userCode,
  );

  return (
    <div className={styles.page} data-testid="settings-page">
      <main className={styles.main}>
        <div className={styles.mainInner} data-testid="settings-content">
          {isSearching ? (
            visibleCategories.length === 0 ? (
              <div className={styles.empty} data-testid="settings-empty">
                无匹配设置项
              </div>
            ) : (
              visibleCategories.map((cat) => (
                <section key={cat.key} className={styles.section}>
                  <h3 className={styles.sectionTitle}>{cat.name}</h3>
                  <div className={styles.sectionContent}>
                    {cat.key === 'account' && isAccountCardVisible && (
                      <ProfileCard userDisplayName={userDisplayName} userCode={userCode} />
                    )}
                    <SettingRows rows={visibleRowsOf(cat, rowsByCategory[cat.key], query)} />
                  </div>
                </section>
              ))
            )
          ) : (
            <>
              <header className={styles.pageHead}>
                <h2 className={styles.pageTitle} data-testid="settings-page-title">
                  {activeCat.name}
                </h2>
                <p className={styles.pageDesc}>{activeCat.desc}</p>
              </header>
              <div className={styles.pageContent}>
                {activeCategory === 'account' && (
                  <ProfileCard userDisplayName={userDisplayName} userCode={userCode} />
                )}
                <SettingRows rows={rowsByCategory[activeCategory]} />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
