import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppConfig, UpdateState } from '../../shared/types';
import { SettingRow } from './SettingRow';
import styles from './Settings.module.css';
import updateStyles from './UpdateSettings.module.css';

function useUpdateState() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let isChanged = false;
    const unsubscribe = window.diteng.onUpdateChanged(next => { isChanged = true; setState(next); });
    void window.diteng.getUpdateState().then(next => { if (!isChanged) setState(next); })
      .catch(() => setError('无法读取更新状态，请重新打开后重试'));
    return unsubscribe;
  }, []);
  return { state, error };
}

function updateLabel(state: UpdateState): string {
  switch (state.status) {
    case 'disabled': case 'error': return state.error;
    case 'idle': return '尚未检查更新';
    case 'checking': return '正在检查更新…';
    case 'latest': return '已是最新版本';
    case 'available': return `新版本 ${state.latestVersion} 可用`;
    case 'downloading': return `正在下载 ${state.latestVersion} · ${Math.round(state.progress)}%`;
    case 'downloaded': return `版本 ${state.latestVersion} 已下载`;
    case 'installing': return '正在安装更新…';
  }
}

function UpdateAction({ state }: { state: UpdateState }) {
  const isBusyRef = useRef(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');
  const isDisabled = isBusy || ['disabled', 'checking', 'downloading', 'installing'].includes(state.status);
  async function run() {
    if (isBusyRef.current || isDisabled) return;
    isBusyRef.current = true; setIsBusy(true); setError('');
    try {
      if (state.status === 'downloaded') await window.diteng.installUpdate();
      else if (state.status === 'available') await window.diteng.downloadUpdate();
      else await window.diteng.checkForUpdates();
    } catch { setError('更新操作失败，请稍后重试'); }
    finally { isBusyRef.current = false; setIsBusy(false); }
  }
  return <div className={styles.rowActions}>
    {error && <span role="alert" className={styles.error}>{error}</span>}
    <button type="button" className={styles.actionButton} data-testid="update-action" disabled={isDisabled} onClick={() => void run()}>
      {state.status === 'downloaded' ? '重启并安装' : state.status === 'available' ? '下载更新' : '检查更新'}
    </button>
  </div>;
}

export function UpdateSettings({ config, onConfigChange }: { config: AppConfig | null; onConfigChange(config: AppConfig): void }) {
  const { state, error } = useUpdateState();
  const isSavingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  async function save(key: 'autoCheckUpdates' | 'autoDownloadUpdates', value: boolean) {
    if (isSavingRef.current) return;
    isSavingRef.current = true; setIsSaving(true); setSaveError('');
    try { onConfigChange(await window.diteng.setConfig({ [key]: value })); }
    catch { setSaveError('无法保存更新设置，请重试'); }
    finally { isSavingRef.current = false; setIsSaving(false); }
  }
  return <section className={styles.section} aria-label="软件更新">
    <div className={styles.rowGroup}>
      <SettingRow title="当前版本"><span className={styles.rowValue}>{state?.currentVersion || '—'}</span></SettingRow>
      <SettingRow title="软件更新" desc={state ? updateLabel(state) : error || '读取中…'}>
        {state && <UpdateAction state={state} />}
      </SettingRow>
      {state?.minimumVersion && <SettingRow title="最低支持版本"><span className={styles.rowValue} data-testid="update-minimum-version">{state.minimumVersion}</span></SettingRow>}
      <SettingRow title="自动检查更新" desc="启动时及每 6 小时检查。">
        <button type="button" role="switch" aria-label="自动检查更新" aria-checked={config?.autoCheckUpdates ?? true} className={styles.switch}
          disabled={!config || isSaving} onClick={() => void save('autoCheckUpdates', !config?.autoCheckUpdates)} />
      </SettingRow>
      <SettingRow title="自动下载更新" desc="下载完成后由你确认重启安装。">
        <button type="button" role="switch" aria-label="自动下载更新" aria-checked={config?.autoDownloadUpdates ?? true} className={styles.switch}
          disabled={!config || isSaving} onClick={() => void save('autoDownloadUpdates', !config?.autoDownloadUpdates)} />
      </SettingRow>
    </div>
    {saveError && <p className={styles.error} role="alert">{saveError}</p>}
  </section>;
}

/** 登录页同样接收更新状态；强制更新覆盖应用，普通提醒可稍后处理。 */
export function UpdateNotice() {
  const { state } = useUpdateState();
  const [dismissed, setDismissed] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const isRequired = state?.isRequired ?? false;
  useEffect(() => {
    if (!isRequired) return;
    const root = document.getElementById('root');
    if (root) root.inert = true;
    panelRef.current?.focus();
    return () => { if (root) root.inert = false; };
  }, [isRequired]);
  if (!state) return null;
  const key = `${state.status}:${state.latestVersion}:${state.checkedAt}:${state.isManual}`;
  const isVisible = state.isRequired || ((state.isManual || ['available', 'downloaded'].includes(state.status)) && dismissed !== key);
  if (!isVisible) return null;
  return createPortal(<div className={state.isRequired ? updateStyles.backdrop : updateStyles.notice} data-testid="update-notice">
    <section ref={panelRef} tabIndex={-1} className={updateStyles.panel} role={state.isRequired ? 'alertdialog' : 'status'} aria-modal={state.isRequired || undefined}
      aria-label={state.isRequired ? '需要更新客户端' : '软件更新'} onKeyDown={event => {
        if (!state.isRequired || event.key !== 'Tab') return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault();
        if (!buttons.length) panelRef.current?.focus();
        else buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }}>
      <div><strong>{state.isRequired ? '需要更新客户端' : '软件更新'}</strong>
        {state.isRequired && <p>当前版本 {state.currentVersion} 已停止支持，最低要求 {state.minimumVersion}。</p>}
        <p data-testid="update-status">{updateLabel(state)}</p>
      </div>
      <div className={styles.rowActions}>
        <UpdateAction state={state} />
        {!state.isRequired && <button type="button" className={styles.actionButton} onClick={() => setDismissed(key)}>稍后</button>}
      </div>
    </section>
  </div>, document.body);
}
