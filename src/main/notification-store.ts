import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnreadMessagePayload } from './mqtt-service';

interface NotificationData {
  seen: Record<string, number>;
  pending: UnreadMessagePayload[];
  cursor: string;
  isInitialized: boolean;
}

/** 按服务器与主账号隔离，关闭提醒只移出本地待提醒队列，从不修改服务端已读状态。 */
export class NotificationStore {
  private data: NotificationData = { seen: {}, pending: [], cursor: '', isInitialized: false };
  private readonly file: string;

  constructor(directory: string, scope: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, `${createHash('sha256').update(scope).digest('hex')}.json`);
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<NotificationData>;
      if (raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen)) this.data.seen = raw.seen;
      if (Array.isArray(raw.pending)) this.data.pending = raw.pending.filter((item) => item && typeof item.uid === 'string' && item.uid && item.level === 2 && typeof item.corpNo === 'string');
      if (typeof raw.cursor === 'string') this.data.cursor = raw.cursor;
      this.data.isInitialized = raw.isInitialized === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[notify] 通知缓存无法读取，将通过未读接口重新核验');
    }
  }

  getPending(): UnreadMessagePayload[] { return this.data.pending.map((item) => ({ ...item })); }
  getCursor(): string { return this.data.cursor; }
  isInitialized(): boolean { return this.data.isInitialized; }
  has(uid: string): boolean { return Object.hasOwn(this.data.seen, uid); }

  accept(payload: UnreadMessagePayload, isPopupEnabled: boolean): boolean {
    if (!payload.uid || this.has(payload.uid)) return false;
    const pending = payload.level === 2 && isPopupEnabled ? [...this.data.pending, payload] : this.data.pending;
    this.persist({ ...this.data, seen: { ...this.data.seen, [payload.uid]: Date.now() }, pending });
    return true;
  }

  dismiss(uid: string): void {
    this.persist({ ...this.data, pending: this.data.pending.filter((item) => item.uid !== uid) });
  }

  checkpoint(cursor: string): void {
    this.persist({ ...this.data, cursor, isInitialized: true });
  }

  private persist(next: NotificationData): void {
    // 长期已处理 UID 有界保留；仍待提醒的 UID 不淘汰，重启后也不会重复入队。
    const retained = new Set(next.pending.map((item) => item.uid));
    const entries = Object.entries(next.seen).sort((a, b) => b[1] - a[1]);
    next.seen = Object.fromEntries(entries.filter(([uid, at], index) => retained.has(uid) || (index < 50_000 && at > Date.now() - 90 * 86400_000)));
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.file);
    // 持久化失败不占用内存去重标记；后续补查仍可重试同一 UID。
    this.data = next;
  }
}
