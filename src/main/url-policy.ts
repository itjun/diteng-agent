import type { SessionInfo } from '../shared/types';

/**
 * ERP/AI 标签的 URL 策略（安全边界，全部在主进程执行）：
 * 渲染层请求开任何 URL 前都经 tabs:resolve 在此分类补参，guest 页内导航/开窗也按同一口径拦截。
 * 标签的视图与状态已下沉渲染层 <webview>，本模块只管「哪个 URL 允许进应用内、以什么形态进」。
 */

export type UrlKind = 'same-server' | 'ai-site' | 'external' | 'blocked';

/** 与登录 serverBase 同 host（含端口）视为站内；AI 站同 host 视为站内白名单；非 http/https 一律拦截 */
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
      // serverBase 非法时按外域处理
    }
  }
  try {
    if (parsed.host === new URL(aiBase).host) return 'ai-site';
  } catch {
    // aiBase 非法时按外域处理
  }
  return 'external';
}

/** URL 是否进应用内标签（同 serverBase 或 AI 站）；供地址栏入口共用外链拦截口径 */
export function isInAppUrl(url: string, session: SessionInfo | null, aiBase: string): boolean {
  const kind = classifyUrl(url, session, aiBase);
  return kind === 'same-server' || kind === 'ai-site';
}

/**
 * 同 serverBase 且未带 sid 的 URL 自动补 sid/CLIENTID/device：
 * ERP 页 window.open 的站内相对地址不带凭据，直接打开会被后端判为未登录；
 * 已带 sid 的 URL 与 AI 站地址（自行携带会话，AI 页无需补全）原样返回。
 */
export function withSessionParams(rawUrl: string, session: SessionInfo | null): string {
  if (!session) return rawUrl;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (url.searchParams.has('sid')) return rawUrl;
  try {
    if (url.host !== new URL(session.serverBase).host) return rawUrl;
  } catch {
    return rawUrl;
  }
  url.searchParams.set('sid', session.token);
  url.searchParams.set('CLIENTID', session.machineCode);
  url.searchParams.set('device', 'pc');
  return url.toString();
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
