import type { TabInfo } from '../../shared/types';

/** 页面继续使用原 URL；仅展示和复制时去掉登录凭据，保留业务查询条件。 */
export function shareablePageUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    const isPrivateKey = (key: string) => /^(sid|clientid|device|.*token.*|.*password.*|authorization|.*secret.*|api[_-]?key)$/i.test(key);
    for (const key of [...url.searchParams.keys()]) {
      if (isPrivateKey(key)) url.searchParams.delete(key);
    }
    // 仅保留明确的客户端路由，查询参数沿用同一脱敏策略；未知片段不对外分享。
    const route = url.hash.replace(/^#!?/, '');
    url.hash = '';
    if (route.startsWith('/') && !route.startsWith('//')) {
      const routeUrl = new URL(route, url.origin);
      for (const key of [...routeUrl.searchParams.keys()]) {
        if (isPrivateKey(key)) routeUrl.searchParams.delete(key);
      }
      url.hash = `${routeUrl.pathname}${routeUrl.search}`;
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function pageLabel(url: string, title: string): string {
  if (!url) return '新建标签页';
  if (title.trim() && !/^https?:\/\//i.test(title.trim())) return title.trim();
  try { return new URL(url).hostname; } catch { return '页面'; }
}

/** 同名页面附加序号，首次加载不用包含会话参数的原始地址充当标题。 */
export function tabLabel(tab: TabInfo, tabs: TabInfo[]): string {
  const label = pageLabel(tab.url, tab.title);
  const matches = tabs.filter((item) => (pageLabel(item.url, item.title)) === label);
  const index = matches.findIndex((item) => item.id === tab.id);
  return matches.length > 1 ? `${label} · ${index + 1}` : label;
}
