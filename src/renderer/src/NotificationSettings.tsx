import { useEffect, useRef, useState } from 'react';
import type { AppConfig, MqttState } from '../../shared/types';
import { SettingRow } from './SettingRow';
import { messageConnectionLabel } from './use-message-state';
import styles from './Settings.module.css';

/** 独立设置组件，变更仅作用于本客户端，不影响旧终端和服务端消息已读状态。 */
export function NotificationSettings({ state, stateError, onMessages }: {
  state: MqttState | null;
  stateError: string;
  onMessages: () => void;
}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isSavingRef = useRef(false);
  const isRefreshingRef = useRef(false);
  const isTestingRef = useRef(false);
  useEffect(() => {
    let isDisposed = false;
    void window.diteng.getConfig().then((next) => { if (!isDisposed) setConfig(next); })
      .catch(() => { if (!isDisposed) setError('无法读取通知设置，请返回后重试'); });
    return () => { isDisposed = true; };
  }, []);
  const save = async (key: 'systemNotifications' | 'importantPopups', value: boolean) => {
    if (isSavingRef.current || !config) return;
    isSavingRef.current = true;
    setIsSaving(true);
    setNotice('');
    try { setConfig(await window.diteng.setConfig({ [key]: value })); setError(''); setNotice('通知设置已保存'); }
    catch { setError('通知设置保存失败，请重试'); }
    finally { isSavingRef.current = false; setIsSaving(false); }
  };

  async function refresh() {
    if (isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    setIsRefreshing(true);
    setNotice('');
    try {
      const next = await window.diteng.refreshMessages();
      if (next.unreadError) setError('未读数同步失败，请检查网络后重试');
      else { setError(''); setNotice('未读数已同步'); }
    } catch { setError('无法同步未读数，请稍后重试'); }
    finally { isRefreshingRef.current = false; setIsRefreshing(false); }
  }

  async function testNotification() {
    if (isTestingRef.current) return;
    isTestingRef.current = true;
    setIsTesting(true);
    setNotice('');
    try {
      const result = await window.diteng.testSystemNotification();
      if (!result.ok) setError(result.message);
      else { setError(''); setNotice('已请求系统显示测试通知。若未看到，请检查系统通知权限或专注模式。'); }
    } catch { setError('无法发送测试通知，请重试'); }
    finally { isTestingRef.current = false; setIsTesting(false); }
  }

  const unreadLabel = state && state.unread >= 0 ? `${state.unread} 条未读` : '等待同步';
  const syncLabel = state?.unreadUpdatedAt ? `上次同步 ${new Date(state.unreadUpdatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '尚未同步';
  return <div className={styles.notificationSettings} aria-label="通知设置">
    <section className={styles.section} aria-label="消息接收">
      <h3 className={styles.sectionTitle}>消息接收</h3>
      <div className={styles.rowGroup}>
        <SettingRow title="消息中心" desc="独立消息模块的入口已保留，内容功能稍后提供。">
          <div className={styles.rowActions}><span className={styles.rowValue} data-testid="notification-unread">{unreadLabel}</span><button type="button" className={styles.actionButton} onClick={onMessages}>查看消息</button></div>
        </SettingRow>
        <SettingRow title="实时接收" desc={stateError || messageConnectionLabel(state)}>
          <span className={state?.connected ? styles.statusConnected : styles.statusWaiting} data-testid="notification-connection">{state ? state.connected ? '连接正常' : '连接断开' : '正在读取'}</span>
        </SettingRow>
        <SettingRow title="未读同步" desc={`${state?.unreadError ? '最近同步失败 · ' : ''}${syncLabel}`}>
          <button type="button" className={styles.actionButton} data-testid="refresh-messages" disabled={isRefreshing} onClick={() => void refresh()}>{isRefreshing ? '正在同步…' : '立即同步'}</button>
        </SettingRow>
      </div>
    </section>
    <section className={styles.section} aria-label="提醒方式">
      <h3 className={styles.sectionTitle}>提醒方式</h3>
      <div className={styles.rowGroup}>
        <SettingRow title="系统通知" desc="收到新消息时请求系统通知，实际显示受系统权限与专注模式影响。">
          <button type="button" role="switch" aria-label="系统通知" aria-checked={config?.systemNotifications ?? false} className={styles.switch} disabled={!config || isSaving} onClick={() => void save('systemNotifications', !config?.systemNotifications)} />
        </SettingRow>
        <SettingRow title="紧急置顶" desc="紧急消息依次保留，直到关闭提醒或打开消息。关闭提醒不会标为已读。">
          <button type="button" role="switch" aria-label="紧急置顶" aria-checked={config?.importantPopups ?? false} className={styles.switch} disabled={!config || isSaving} onClick={() => void save('importantPopups', !config?.importantPopups)} />
        </SettingRow>
      </div>
      <p className={styles.sectionNote}>仅影响本客户端。旧终端的提醒设置独立生效。</p>
    </section>
    <section className={styles.section} aria-label="通知测试">
      <h3 className={styles.sectionTitle}>通知测试</h3>
      <div className={styles.rowGroup}>
        <SettingRow title="本机测试" desc={state?.systemNotificationSupported === false ? '当前系统不支持桌面通知。' : '不创建业务消息，也不会改变未读数量。'}>
          <button type="button" className={styles.actionButton} data-testid="test-notification" disabled={isTesting || !state?.systemNotificationSupported} onClick={() => void testNotification()}>{isTesting ? '正在发送…' : '测试通知'}</button>
        </SettingRow>
      </div>
    </section>
    {(error || stateError) && <p className={styles.error} role="alert">{error || stateError}</p>}
    {notice && <p className={styles.sectionNote} role="status">{notice}</p>}
  </div>;
}
