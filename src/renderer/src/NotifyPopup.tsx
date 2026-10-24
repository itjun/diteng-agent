import { useEffect, useState } from 'react';
import type { NotificationPopupContent } from '../../shared/types';
import { CloseIcon } from './theme-icons';
import { useThemeSetting } from './use-theme';
import styles from './NotifyPopup.module.css';

/**
 * 重要消息置顶弹窗（主进程 ImportantNotifier 创建的 #/notify-popup 页面）。
 * 内容经 notify-popup:get 拉取，并随持久队列更新；不自动关闭。
 * 点击主体聚焦主窗并打开消息中心，右上角关闭按钮仅关弹窗。
 */
export function NotifyPopup() {
  const [content, setContent] = useState<NotificationPopupContent | null>(null);
  // 复用主题 hook：把深浅色写到 body[data-ds-dark-theme]，弹窗配色随主题
  useThemeSetting();

  useEffect(() => {
    const reload = () => { void window.diteng.notifyPopupLoad().then(setContent); };
    reload();
    return window.diteng.onNotifyPopupChanged(reload);
  }, []);

  if (!content) return null;
  return (
    <div
      className={styles.card}
      data-testid="important-popup"
      onClick={() => window.diteng.notifyPopupOpen()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') window.diteng.notifyPopupOpen(); }}
    >
      <div className={styles.body}>{content.corpName} · 待处理 {content.pendingCount} 条</div>
      <div className={styles.title}>{content.title}</div>
      <div className={styles.body}>{content.body}</div>
      <button
        type="button"
        className={styles.close}
        aria-label="关闭提醒"
        onClick={(event) => {
          event.stopPropagation();
          window.diteng.notifyPopupClose();
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
