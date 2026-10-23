import { useEffect, useState } from 'react';
import type { AppConfig, ChromeColor, SessionSummary } from '../../shared/types';
import { ArrowLeftIcon, SignOutIcon } from './theme-icons';
import { useThemeSetting } from './use-theme';
import { CHROME_COLOR_OPTIONS, applyChromeColor } from './chrome-color';
import styles from './Settings.module.css';

/** 应用版本（与 package.json version 同步；发版时一起改） */
const APP_VERSION = '0.2.2';

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

/** 外围颜色色板选项（Dia 式圆形色点） */
interface SwatchOption {
  value: string;
  label: string;
  /** 色点填充（CSS 颜色或渐变），auto 用黑白双色渐变 */
  swatch: string;
  testid: string;
  onSelect: () => void;
}

/** 行右侧控件形态：分段选择 / 外围颜色色板 / 只读值 / 占位禁用按钮 */
type RowControl =
  | { kind: 'segmented'; ariaLabel: string; value: string; options: SegmentOption[] }
  | { kind: 'swatches'; ariaLabel: string; value: string; options: SwatchOption[] }
  | { kind: 'value'; testid?: string; text: string }
  | { kind: 'disabledButton'; label: string };

/** 一行设置项：左侧名称+次级描述，右侧控件 */
interface SettingRowDef {
  key: string;
  title: string;
  desc?: string;
  control: RowControl;
}

/**
 * 设置态 rail 导航：复用主窗口最左侧侧栏，不再在内容区额外占一列。
 * 顶部只留返回入口，分类列表直接排在下方；内容区只保留当前分类的设置项。
 */
export function SettingsRail({
  activeCategory,
  onSelectCategory,
  onBack,
}: {
  activeCategory: SettingsCategoryKey;
  onSelectCategory: (category: SettingsCategoryKey) => void;
  onBack: () => void;
}) {
  return (
    <div className={styles.settingsRail} data-testid="settings-rail">
      <button type="button" className={styles.back} data-testid="settings-back" onClick={onBack}>
        <ArrowLeftIcon />
        <span>返回</span>
      </button>
      <nav className={styles.nav} aria-label="设置分类">
        {CATEGORIES.map((cat) => (
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
  if (control.kind === 'swatches') {
    return (
      <div className={styles.swatches} role="radiogroup" aria-label={control.ariaLabel}>
        {control.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={control.value === option.value}
            aria-label={option.label}
            title={option.label}
            data-testid={option.testid}
            className={control.value === option.value ? styles.swatchActive : styles.swatch}
            style={{ background: option.swatch }}
            onClick={option.onSelect}
          />
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

/** 账号页顶部大卡片：圆形头像 + 账套名称/账套代码，底部「退出登录」红字链接（走现有 auth:logout 链路） */
function ProfileCard({ corpName, corpNo }: { corpName: string; corpNo: string }) {
  // 账套名称由会话摘要下发，主进程尚未取到时回落账套号，避免大标题空白
  const name = corpName || corpNo;
  return (
    <div className={styles.profileCard}>
      <div className={styles.profileMain}>
        <span className={styles.profileAvatar} aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </span>
        <div className={styles.profileMeta}>
          <div className={styles.profileName} data-testid="settings-corp-name">
            {name || '—'}
          </div>
          <div className={styles.profileCode} data-testid="settings-corp-no">
            {corpNo || '—'}
          </div>
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
 * 分类大标题 + 副标题 + 行式设置项居中展示。
 * v1 内容：账号（大卡片 + 设备码）、外观（主题）、连接（只读，变更入口统一在登录页）、关于。
 */
export function SettingsPage({
  session,
  activeCategory,
}: {
  session: SessionSummary | null;
  activeCategory: SettingsCategoryKey;
}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const { themeSetting, setTheme } = useThemeSetting();

  // 账套名称随会话摘要下发；session:changed 推送后 Shell 更新 session，本页随之重渲染
  useEffect(() => {
    void window.diteng.getConfig().then(setConfig);
  }, []);

  const corpName = session?.corpName ?? '';
  const corpNo = session?.corpNo ?? '';
  const activeCat = categoryOf(activeCategory);

  /** 外围颜色：立即改 DOM（CSS 按 data-chrome-color 取混色）并落盘，无需重启 */
  function selectChromeColor(value: ChromeColor) {
    applyChromeColor(value);
    setConfig((current) => (current ? { ...current, chromeColor: value } : current));
    void window.diteng.setConfig({ chromeColor: value });
  }

  const rowsByCategory: Record<SettingsCategoryKey, SettingRowDef[]> = {
    account: [
      {
        key: 'device',
        title: '设备码',
        desc: '设备在服务端的唯一标识（展示前 8 位）',
        control: { kind: 'value', text: config ? config.machineCode.slice(0, 8) : '' },
      },
    ],
    appearance: [
      {
        key: 'theme',
        title: '主题',
        desc: '跟随系统深浅色或固定外观',
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
      {
        key: 'chrome-color',
        title: '外围颜色',
        desc: '侧栏与悬浮卡片外框的底色，默认自动跟随黑白灰',
        control: {
          kind: 'swatches',
          ariaLabel: '外围颜色',
          value: config?.chromeColor ?? 'auto',
          options: CHROME_COLOR_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
            swatch: option.swatch,
            testid: `settings-chrome-${option.value}`,
            onSelect: () => selectChromeColor(option.value),
          })),
        },
      },
    ],
    connection: [
      {
        key: 'server-base',
        title: '服务器地址',
        desc: '修改后需重新登录，请在登录页修改',
        control: { kind: 'value', testid: 'settings-server-base', text: config?.serverBase ?? '' },
      },
      {
        key: 'ai-base',
        title: 'AI 站点',
        desc: '未手动设置时按服务器地址推导',
        control: { kind: 'value', testid: 'settings-ai-base', text: config ? deriveAiBase(config) : '' },
      },
    ],
    about: [
      {
        key: 'version',
        title: '版本',
        control: { kind: 'value', text: APP_VERSION },
      },
      {
        key: 'update',
        title: '软件更新',
        desc: '当前安装包未签名，更新通道建设中',
        control: { kind: 'disabledButton', label: '检查更新' },
      },
    ],
  };

  return (
    <div className={styles.page} data-testid="settings-page">
      <main className={styles.main}>
        <div className={styles.mainInner} data-testid="settings-content">
          <header className={styles.pageHead}>
            <h2 className={styles.pageTitle} data-testid="settings-page-title">
              {activeCat.name}
            </h2>
            <p className={styles.pageDesc}>{activeCat.desc}</p>
          </header>
          <div className={styles.pageContent}>
            {activeCategory === 'account' && <ProfileCard corpName={corpName} corpNo={corpNo} />}
            <SettingRows rows={rowsByCategory[activeCategory]} />
          </div>
        </div>
      </main>
    </div>
  );
}
