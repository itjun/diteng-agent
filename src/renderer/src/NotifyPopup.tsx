import { useEffect, useState } from 'react';
import { CloseIcon } from './theme-icons';
import { useThemeSetting } from './use-theme';
import styles from './NotifyPopup.module.css';

/**
 * 重要消息置顶弹窗（主进程 ImportantNotifier 创建的 #/notify-popup 页面）。
 * 内容经 notify-popup:get 拉取；hover 暂停 8 秒自动关闭（上报主进程暂停/恢复计时）；
 * 点击主体聚焦主窗并打开消息中心，右上角关闭按钮仅关弹窗。
 */
export function NotifyPopup() {
  const [content, setContent] = useState<{ title: string; body: string } | null>(null);
  // 复用主题 hook：把深浅色写到 body[data-ds-dark-theme]，弹窗配色随主题
  useThemeSetting();

  useEffect(() => {
    void window.diteng.notifyPopupLoad().then(setContent);
  }, []);

  if (!content) return null;
  return (
    <div
      className={styles.card}
      data-testid="important-popup"
      onClick={() => window.diteng.notifyPopupOpen()}
      onMouseEnter={() => window.diteng.notifyPopupHover(true)}
      onMouseLeave={() => window.diteng.notifyPopupHover(false)}
    >
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
