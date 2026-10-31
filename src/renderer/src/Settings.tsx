import { useEffect, useState } from 'react';
import type { AppConfig, MqttState, SessionSummary } from '../../shared/types';
import { ArrowLeftIcon } from './theme-icons';
import { AppearanceSettings } from './AppearanceSettings';
import styles from './Settings.module.css';
import { DeviceInfo } from './DeviceInfo';
import { NetworkDiagnostics } from './NetworkDiagnostics';
import { NotificationSettings } from './NotificationSettings';
import { SettingRow } from './SettingRow';
import { UpdateSettings } from './UpdateSettings';

/** 设置分类：key 同时用于 data-testid=settings-nav-{key} */
export type SettingsCategoryKey = 'account' | 'appearance' | 'connection' | 'notifications' | 'about';

export interface SettingsCategoryDef {
  key: SettingsCategoryKey;
  name: string;
  desc: string;
}

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryKey = 'account';

/** 导航顺序即展示顺序；名称与副标题统一四字文案。「连接」合并服务器/设备信息与网络检测；「关于应用」合并版本更新与本机信息，置底。 */
const CATEGORIES: SettingsCategoryDef[] = [
  { key: 'account', name: '账号管理', desc: '登录账套' },
  { key: 'appearance', name: '外观主题', desc: '界面配色' },
  { key: 'connection', name: '连接设置', desc: '连接质量' },
  { key: 'notifications', name: '通知设置', desc: '消息提醒' },
  { key: 'about', name: '关于应用', desc: '版本更新' },
];

function categoryOf(key: SettingsCategoryKey): SettingsCategoryDef {
  const found = CATEGORIES.find((cat) => cat.key === key);
  return found ?? CATEGORIES[0];
}

/** 行右侧控件：只读值或占位禁用按钮。外观选择使用独立预览卡片。 */
type RowControl =
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
  isCompact = false,
}: {
  activeCategory: SettingsCategoryKey;
  onSelectCategory: (category: SettingsCategoryKey) => void;
  onBack: () => void;
  isCompact?: boolean;
}) {
  return (
    <div className={`${styles.settingsRail} ${isCompact ? styles.settingsRailCompact : ''}`} data-testid="settings-rail">
      <button type="button" className={styles.back} data-testid="settings-back" aria-label="返回标签" title="返回标签页" onClick={onBack}>
        <ArrowLeftIcon />
        <span>返回标签</span>
      </button>
      <nav className={styles.nav} aria-label="设置分类">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            type="button"
            data-testid={`settings-nav-${cat.key}`}
            className={cat.key === activeCategory ? styles.navItemActive : styles.navItem}
            title={`${cat.name}：${cat.desc}`}
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
  return <SettingRow title={row.title} desc={row.desc}><RowControlView control={row.control} /></SettingRow>;
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

/** 登录用户与账套独立展示，不把企业名称当成用户身份。 */
function ProfileCard({ session }: { session: SessionSummary | null }) {
  const name = session?.userName || session?.loginId || '登录用户';
  return (
    <div className={styles.profileCard}>
      <div className={styles.profileMain}>
        <span className={styles.profileAvatar} aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </span>
        <div className={styles.profileMeta}>
          <div className={styles.profileName} data-testid="settings-user-name">
            {name || '—'}
          </div>
          <div className={styles.profileCode} data-testid="settings-login-id">
            登录账号 · {session?.loginId || '暂未获取'}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 设置内容区（壳内视图，替换 webview 区域；左侧 rail 由 SettingsRail 复用）：
 * 分类大标题 + 副标题 + 行式设置项居中展示。
 * 登录身份与当前账套分别展示；会话恢复不依赖内嵌网页。
 */
export function SettingsPage({
  session,
  activeCategory,
  messageState,
  messageError,
  onAccounts,
  onMessages,
  onRelogin,
  isReloggingIn,
}: {
  session: SessionSummary | null;
  activeCategory: SettingsCategoryKey;
  messageState: MqttState | null;
  messageError: string;
  onAccounts: () => void;
  onMessages: () => void;
  onRelogin: () => void;
  isReloggingIn: boolean;
}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState('');

  // 账套名称随会话摘要下发；session:changed 推送后 Shell 更新 session，本页随之重渲染
  useEffect(() => {
    void window.diteng.getConfig().then(setConfig).catch(() => setConfigError('无法读取客户端设置，请返回后重试'));
  }, []);

  const activeCat = categoryOf(activeCategory);

  const rowsByCategory: Record<SettingsCategoryKey, SettingRowDef[]> = {
    account: [],
    appearance: [],
    connection: [
      {
        key: 'server-base',
        title: '服务地址',
        desc: '当前登录使用的服务器',
        control: { kind: 'value', testid: 'settings-server-base', text: config?.serverBase ?? '' },
      },
      {
        key: 'device', title: '设备标识', desc: '联系客服排查登录问题时使用（前 8 位）',
        control: { kind: 'value', text: config ? config.machineCode.slice(0, 8) : '—' },
      },
    ],
    notifications: [],
    about: [],
  };

  return (
    <div className={styles.page} data-testid="settings-page">
      <main className={styles.main}>
        <div className={`${styles.mainInner} ${activeCategory === 'appearance' ? styles.appearanceInner : ''}`} data-testid="settings-content">
          <header className={styles.pageHead}>
            <h2 className={styles.pageTitle} data-testid="settings-page-title">
              {activeCat.name}
            </h2>
            <p className={styles.pageDesc}>{activeCat.desc}</p>
          </header>
          <div className={styles.pageContent}>
            {configError && <p className={styles.error} role="alert">{configError}</p>}
            <SettingRows rows={rowsByCategory[activeCategory]} />
            {activeCategory === 'account' && <>
              <section className={styles.section} aria-label="登录身份">
                <h3 className={styles.sectionTitle}>登录身份</h3>
                <ProfileCard session={session} />
              </section>
              <section className={styles.section} aria-label="当前账套">
                <h3 className={styles.sectionTitle}>当前账套</h3>
                <div className={styles.rowGroup}>
                  <SettingRow title={session?.corpName || session?.corpNo || '暂未获取'} desc={`账套编号 · ${session?.corpNo || '—'}`}>
                    <button type="button" className={styles.actionButton} data-testid="settings-switch-account" onClick={onAccounts} disabled={!session}>切换账套</button>
                  </SettingRow>
                  <SettingRow title="账套账号"><span className={styles.rowValue} data-testid="settings-user-code">{session?.userCode || '—'}</span></SettingRow>
                </div>
                <p className={styles.sectionNote}>切换前请保存表单。切换成功后，只保留新账套页面，其余标签将关闭。</p>
              </section>
              <section className={styles.section} aria-label="登录管理">
                <h3 className={styles.sectionTitle}>登录管理</h3>
                <div className={styles.rowGroup}>
                  <SettingRow title="重新登录" desc="更换账号，或在网页无法打开时恢复登录。">
                    <button type="button" className={styles.actionButton} data-testid="settings-relogin" disabled={isReloggingIn} onClick={onRelogin}>{isReloggingIn ? '正在处理…' : '重新登录'}</button>
                  </SettingRow>
                </div>
              </section>
            </>}
            {activeCategory === 'appearance' && <AppearanceSettings config={config} onConfigChange={setConfig} />}
            {activeCategory === 'connection' && <section className={styles.section} aria-label="网络检测">
              <h3 className={styles.sectionTitle}>网络检测</h3>
              <NetworkDiagnostics />
            </section>}
            {activeCategory === 'notifications' && <NotificationSettings state={messageState} stateError={messageError} onMessages={onMessages} />}
            {activeCategory === 'about' && <>
              <UpdateSettings config={config} onConfigChange={setConfig} />
              <DeviceInfo />
            </>}
          </div>
        </div>
      </main>
    </div>
  );
}
