import type { SessionInfo } from '../shared/types';

/**
 * ERP/AI 标签的 URL 策略（安全边界，全部在主进程执行）：
 * 渲染层请求开任何 URL 前都经 tabs:resolve 在此分类补参，guest 页内导航/开窗也按同一口径拦截。
 * 标签的视图与状态已下沉渲染层 <webview>，本模块只管「哪个 URL 允许进应用内、以什么形态进」。
 */

export type UrlKind = 'same-server' | 'ai-site' | 'external' | 'blocked';

/** 生产 ERP 使用同一根域名下的 m/std/... 多站点，菜单链接会跨子域但不能交给系统浏览器 */
const ERP_SITE_ROOTS = ['cdcp.site', 'diteng.vip'] as const;

function isHostWithinRoot(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
}

/**
 * 是否属于当前 ERP 站点家族：
 * - 登录 serverBase 完全同 host；
 * - 登录站点位于已确认的生产根域时，同根域、同协议、同端口的兄弟子域。
 * 本地地址仍只允许完全同 host，避免把任意 localhost/测试域名扩大为站内。
 */
function isErpSite(url: URL, serverBase: string): boolean {
  let base: URL;
  try {
    base = new URL(serverBase);
  } catch {
    return false;
  }
  if (url.host === base.host) return true;
  const root = ERP_SITE_ROOTS.find((candidate) => isHostWithinRoot(base.hostname, candidate));
  return Boolean(
    root &&
      url.protocol === base.protocol &&
      url.port === base.port &&
      isHostWithinRoot(url.hostname, root),
  );
}

/** 登录 ERP 站点家族视为站内；AI 站同 host 视为站内白名单；非 http/https 一律拦截 */
export function classifyUrl(url: string, session: SessionInfo | null, aiBase: string): UrlKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'blocked';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'blocked';
  if (session) {
    try {
      if (parsed.host === new URL(session.serverBase).host) return 'same-server';
    } catch {
      // serverBase 非法时继续按已知 AI 站与 ERP 根域判断
    }
  }
  try {
    if (parsed.host === new URL(aiBase).host) return 'ai-site';
  } catch {
    // aiBase 非法时按外域处理
  }
  if (session && isErpSite(parsed, session.serverBase)) return 'same-server';
  return 'external';
}

/** URL 是否进应用内标签（ERP 站点家族或 AI 站）；供地址栏入口共用外链拦截口径 */
export function isInAppUrl(url: string, session: SessionInfo | null, aiBase: string): boolean {
  const kind = classifyUrl(url, session, aiBase);
  return kind === 'same-server' || kind === 'ai-site';
}

/**
 * ERP 站点家族内且未带 sid 的 URL 自动补 sid/CLIENTID/device：
 * ERP 页 window.open 的站内相对地址不带凭据，直接打开会被后端判为未登录；
 * 已带 sid 的 URL 与 AI 站地址（自行携带会话，AI 页无需补全）原样返回。
 */
export function withSessionParams(rawUrl: string, session: SessionInfo | null, aiBase: string): string {
  if (!session) return rawUrl;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.searchParams.has('sid')) return rawUrl;
  try {
    if (url.host === new URL(aiBase).host) return rawUrl;
  } catch {
    // aiBase 非法时不影响 ERP 补参
  }
  if (!isErpSite(url, session.serverBase)) return rawUrl;
  url.searchParams.set('sid', session.token);
  url.searchParams.set('CLIENTID', session.machineCode);
  url.searchParams.set('device', 'pc');
  return url.toString();
}

/**
 * ERP 页 URL 首段路径的账套号（{serverBase}/{corpNo}/{form}…）：
 * 仅识别 5~8 位数字形态的首段（与 buildAiUrl 判定一致），其余返回空串。
 * AI 站路径同为 /{corpNo}/ 前缀，调用方须先经 classifyUrl 排除再取账套号。
 */
export function readErpCorpNo(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return '';
  }
  const first = url.pathname.split('/').filter(Boolean)[0] ?? '';
  return /^\d{5,8}$/.test(first) ? first : '';
}

/**
 * ERP 页 URL：{serverBase}/{corpNo}/{form}?sid={token}&CLIENTID={machineCode}&device=pc。
 * 参数名依据 summer ISession.java（TOKEN="sid"、CLIENT_ID="CLIENTID"、CLIENT_DEVICE="device"），
 * 形态依据 diteng-im-server TFrmChooseAccount.buildImDefaultHomeUrl：{entry}/{corpNo}/FrmDefault + 三参数。
 */
export function buildErpUrl(session: SessionInfo, form: string): string {
  const base = session.serverBase.replace(/\/+$/, '');
  const formName = form.replace(/^\/+/, '') || 'FrmDefault';
  const url = new URL(`${base}/${session.corpNo}/${formName}`);
  url.searchParams.set('sid', session.token);
  url.searchParams.set('CLIENTID', session.machineCode);
  url.searchParams.set('device', 'pc');
  return url.toString();
}

/**
 * AI 对话页 URL：{aiBase}/{corpNo}/chat?sid={token}&CLIENTID={machineCode}&device=pc。
 * 形态依据 diteng-im-server FrmUserAiAgent.redirect（AI 会话由 URL query 携带，
 * ai-agent im-cookies.ts resolveImAuth：URL 优先、rc_im_* cookie 兜底）；
 * corpNo 非 5~8 位数字时回落无前缀 /chat（对齐 ai-web-app buildAiWebChatPath）。
 */
export function buildAiUrl(session: SessionInfo, aiBase: string): string {
  const base = aiBase.replace(/\/+$/, '');
  const corpPath = /^\d{5,8}$/.test(session.corpNo) ? `${session.corpNo}/` : '';
  const url = new URL(`${base}/${corpPath}chat`);
  url.searchParams.set('sid', session.token);
  url.searchParams.set('CLIENTID', session.machineCode);
  url.searchParams.set('device', 'pc');
  return url.toString();
}
