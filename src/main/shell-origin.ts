import { pathToFileURL } from 'node:url';

/** 本地壳使用 hash 路由，凭据 IPC 必须识别准确入口文件而非后缀匹配。 */
export function isShellEntryUrl(raw: string, entryFile: string, developmentUrl?: string): boolean {
  try {
    const parsed = new URL(raw);
    if (developmentUrl) return parsed.origin === new URL(developmentUrl).origin;
    parsed.hash = ''; parsed.search = '';
    return parsed.href === pathToFileURL(entryFile).href;
  } catch { return false; }
}
