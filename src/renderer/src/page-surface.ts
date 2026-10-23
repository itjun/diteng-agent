import type { WebviewElement } from './env';

/**
 * 网页底色（页面顶部实际可见的底色）：用来让地址栏与网页内容同色。
 * 悬浮卡片把地址栏与网页装进同一张圆角卡片，地址栏若仍是外壳色，就会在卡片内部
 * 多出一条横向色带；跟随网页底色后，卡片上半部分和网页连成一体（对齐 Dia 浏览器
 * 地址栏随站点主题变色的做法），卡片四周的外围色边框才能上/下/右等宽。
 */
export interface PageSurface {
  /** 归一化后的 CSS 颜色（rgb(...) / rgba(...)），直接用作卡片与地址栏底色 */
  color: string;
  /** 底色明暗：地址栏图标/文字按此切深色或浅色档，避免浅色页面 + 深色应用主题下看不清 */
  isDark: boolean;
}

/**
 * guest 页内采样脚本（webview.executeJavaScript 执行，返回 JSON 可序列化对象）：
 * 1. 页面顶部一窄条多点取「该点最靠上的不透明背景色」，按出现次数投票——
 *    比 theme-color 更贴近用户实际看到的页面顶部，也避免被一侧的深色侧栏带偏；
 * 2. 顶部取不到时退回 <meta name="theme-color">（站点声明的浏览器配色）；
 * 3. 再退回 body / html 背景色；
 * 4. 都取不到时按 prefers-color-scheme 给浏览器默认白/深底。
 */
const PROBE_SCRIPT = `(() => {
  const normalize = (value) => {
    const text = String(value || '').trim();
    if (!text || text === 'transparent') return '';
    if (!window.CSS || !CSS.supports('color', text)) return '';
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return '';
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = text;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    // 近透明底色视为没有底色，继续向上找祖先；半透明保留原始色（真实站点极少见）
    if (data[3] < 15) return '';
    if (data[3] === 255) return 'rgb(' + data[0] + ', ' + data[1] + ', ' + data[2] + ')';
    return 'rgba(' + data[0] + ', ' + data[1] + ', ' + data[2] + ', ' + Math.round((data[3] / 255) * 1000) / 1000 + ')';
  };
  const isDarkColor = (color) => {
    const match = String(color).match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i);
    if (!match) return false;
    const channel = (raw) => {
      const value = Number(raw) / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    const luminance = 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3]);
    return luminance < 0.42;
  };
  const votedColor = (colors) => {
    const counts = new Map();
    for (const color of colors) counts.set(color, (counts.get(color) || 0) + 1);
    let best = '';
    let bestCount = 0;
    counts.forEach((count, color) => {
      if (count > bestCount) {
        best = color;
        bestCount = count;
      }
    });
    return best;
  };
  // 页面顶部（地址栏紧邻的区域）多点采样：左/中/右都取，一侧有深色侧栏时由多数票兜底
  const samples = [];
  const xs = [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98];
  const ys = [4, 18];
  for (const ratio of xs) {
    for (const y of ys) {
      if (y >= window.innerHeight) continue;
      const x = Math.min(Math.max(Math.round(window.innerWidth * ratio), 1), Math.max(window.innerWidth - 1, 1));
      let element = document.elementFromPoint(x, y);
      while (element) {
        const color = normalize(getComputedStyle(element).backgroundColor);
        if (color) {
          samples.push(color);
          break;
        }
        element = element.parentElement;
      }
    }
  }
  let color = votedColor(samples);
  if (!color) {
    const metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'))
      .filter((meta) => {
        const media = meta.getAttribute('media');
        return !media || (typeof window.matchMedia === 'function' && window.matchMedia(media).matches);
      })
      .map((meta) => normalize(meta.getAttribute('content')))
      .filter(Boolean);
    color = metas.length > 0 ? metas[metas.length - 1] : '';
  }
  if (!color && document.body) color = normalize(getComputedStyle(document.body).backgroundColor);
  if (!color) color = normalize(getComputedStyle(document.documentElement).backgroundColor);
  if (!color) {
    const colorScheme =
      String(getComputedStyle(document.documentElement).colorScheme || '') +
      (document.body ? String(getComputedStyle(document.body).colorScheme || '') : '');
    const prefersDark =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    color =
      /dark/.test(colorScheme) || (!/light/.test(colorScheme) && prefersDark)
        ? 'rgb(21, 21, 23)'
        : 'rgb(255, 255, 255)';
  }
  return { color, isDark: isDarkColor(color) };
})()`;

/** 采样当前 webview 页面顶部底色；页面尚未就绪或执行失败时返回 null（调用方保留上次颜色） */
export async function probePageSurface(webview: WebviewElement): Promise<PageSurface | null> {
  try {
    const result = (await webview.executeJavaScript(PROBE_SCRIPT, false)) as
      | { color?: unknown; isDark?: unknown }
      | null
      | undefined;
    if (!result || typeof result.color !== 'string' || !result.color) return null;
    return { color: result.color, isDark: Boolean(result.isDark) };
  } catch {
    return null;
  }
}
