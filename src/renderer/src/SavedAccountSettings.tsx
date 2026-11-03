import { useEffect, useRef, useState } from 'react';
import type { SavedAccountSummary, SessionSummary } from '../../shared/types';
import styles from './Settings.module.css';
import accountStyles from './SavedAccountSettings.module.css';

const lastUsedFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function SavedAccountSettings({ session, onRelogin, isReloggingIn }: {
  session: SessionSummary | null;
  onRelogin: () => void;
  isReloggingIn: boolean;
}) {
  const [accounts, setAccounts] = useState<SavedAccountSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingLoginId, setDeletingLoginId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const isDeletingRef = useRef(false);

  useEffect(() => {
    let isCancelled = false;
    setIsLoading(true);
    setError('');
    void window.diteng.listSavedAccounts().then((saved) => {
      if (!isCancelled) setAccounts(saved);
    }).catch(() => {
      if (!isCancelled) setError('无法读取登录记录，请重试');
    }).finally(() => {
      if (!isCancelled) setIsLoading(false);
    });
    return () => { isCancelled = true; };
  }, [session?.loginId, session?.serverBase, reload]);

  async function handleRemove(account: SavedAccountSummary) {
    if (account.isCurrent || isDeletingRef.current) return;
    isDeletingRef.current = true;
    setDeletingLoginId(account.loginId);
    setError('');
    try {
      // 主进程弹出原生确认框，并再次核对当前登录账号。
      const result = await window.diteng.removeSavedAccount({ loginId: account.loginId, serverBase: account.serverBase });
      if (result.ok) setAccounts(result.data);
      else setError(result.message);
    } catch {
      setError('删除失败，请重试');
    } finally {
      isDeletingRef.current = false;
      setDeletingLoginId(null);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="saved-accounts-title">
      <div className={accountStyles.sectionHead}>
        <h3 id="saved-accounts-title" className={styles.sectionTitle}>本机登录账号</h3>
        <button type="button" className={styles.actionButton} data-testid="settings-relogin" disabled={isReloggingIn || deletingLoginId !== null} onClick={onRelogin}>
          {isReloggingIn ? '正在处理…' : '重新登录'}
        </button>
      </div>
      <div className={accountStyles.tableFrame}>
        <table className={accountStyles.table} aria-label="本机登录账号" aria-busy={isLoading} data-testid="settings-saved-accounts">
          <thead><tr><th scope="col">登录账号</th><th scope="col">密码</th><th scope="col">上次使用</th><th scope="col" className={accountStyles.actionCell}>操作</th></tr></thead>
          <tbody>
            {isLoading ? <tr><td colSpan={4} className={accountStyles.empty}>正在读取登录记录…</td></tr> : accounts.length === 0 ? <tr><td colSpan={4} className={accountStyles.empty}>{error ? '登录记录暂不可用' : '此客户端暂无登录记录'}</td></tr> : accounts.map((account) => (
              <tr key={`${account.serverBase}\n${account.loginId}`} data-current={account.isCurrent || undefined}>
                <td><div className={accountStyles.accountIdentity}>
                  <span className={accountStyles.loginId}>{account.loginId}</span>
                  {account.isCurrent && <span className={accountStyles.currentBadge}>使用中</span>}
                </div></td>
                <td className={account.maskedPassword ? accountStyles.password : accountStyles.muted}>{account.maskedPassword ?? (account.hasPassword ? '暂不可用' : '未保存')}</td>
                <td className={accountStyles.lastUsed}>{account.lastLoginAt > 0 ? <time dateTime={new Date(account.lastLoginAt).toISOString()}>{lastUsedFormatter.format(account.lastLoginAt)}</time> : '暂无记录'}</td>
                <td className={accountStyles.actionCell}>
                  <button type="button" className={accountStyles.deleteButton} aria-label={`删除账号 ${account.loginId}`} title={account.isCurrent ? '正在使用的账号不能删除' : `删除账号 ${account.loginId}`} disabled={account.isCurrent || deletingLoginId !== null || isReloggingIn} onClick={() => void handleRemove(account)}>
                    {deletingLoginId === account.loginId ? '处理中…' : '删除'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className={accountStyles.errorRow}><p className={styles.error} role="alert">{error}</p><button type="button" className={styles.actionButton} disabled={isLoading || deletingLoginId !== null} onClick={() => setReload((value) => value + 1)}>重试</button></div>}
      <p className={styles.sectionNote}>仅记录此客户端成功登录的账号。正在使用的账号不能删除。</p>
    </section>
  );
}
