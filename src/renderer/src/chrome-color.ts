import type { ChromeColor } from '../../shared/types';

/** 外围颜色色板选项（对齐 Dia 浏览器 Theme Color：中性黑白灰 + 低饱和预设色） */
export interface ChromeColorOption {
  value: ChromeColor;
  /** 色板 tooltip / 无障碍标签 */
  label: string;
  /** 色板展示色；auto 用黑白双色渐变表示「自动跟随黑白灰」 */
  swatch: string;
  /** 跟随外围颜色着色的图标（Chat）用实色；auto 为空 = 保持主题中性色 */
  accent: string;
}

export const CHROME_COLOR_OPTIONS: ChromeColorOption[] = [
  { value: 'auto', label: '自动（黑白灰）', swatch: 'linear-gradient(135deg, #23252a 50%, #f7f8fa 50%)', accent: '' },
  { value: 'ink', label: '墨黑', swatch: '#2b2d31', accent: '#2b2d31' },
  { value: 'slate', label: '雾灰', swatch: '#64748b', accent: '#64748b' },
  { value: 'green', label: '苔绿', swatch: '#3f8f6b', accent: '#3f8f6b' },
  { value: 'blue', label: '海蓝', swatch: '#3b6fd4', accent: '#3b6fd4' },
  { value: 'purple', label: '鸢尾', swatch: '#6d5bd0', accent: '#6d5bd0' },
  { value: 'orange', label: '琥珀', swatch: '#c97a2b', accent: '#c97a2b' },
  { value: 'pink', label: '胭粉', swatch: '#d05a7a', accent: '#d05a7a' },
];

/**
 * 把外围颜色落到 <html data-chrome-color>：Shell.module.css 依据该属性给 rail 与卡片外框
 * 换成对应混色（深浅色各一档）；auto 移除属性，走默认的黑白灰实底。
 * 同时把预设色实色写到 --dsw-chrome-accent，供 Chat 图标等强调元素跟随外壳颜色着色；
 * auto 不写该变量，相关样式回落主题中性色。
 */
export function applyChromeColor(value: ChromeColor): void {
  const root = document.documentElement;
  const accent = CHROME_COLOR_OPTIONS.find((option) => option.value === value)?.accent ?? '';
  if (!accent) {
    delete root.dataset.chromeColor;
    root.style.removeProperty('--dsw-chrome-accent');
    return;
  }
  root.dataset.chromeColor = value;
  root.style.setProperty('--dsw-chrome-accent', accent);
}
