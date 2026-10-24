import type { ReactNode } from 'react';
import styles from './Settings.module.css';

/** 账号、连接、外观和通知共用同一设置行。 */
export function SettingRow({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return <div className={styles.row}>
    <div className={styles.rowMain}>
      <div className={styles.rowTitle}>{title}</div>
      {desc && <div className={styles.rowDesc}>{desc}</div>}
    </div>
    {children}
  </div>;
}
