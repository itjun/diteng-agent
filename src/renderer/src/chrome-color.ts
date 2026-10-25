import type { ChromeColor } from '../../shared/types';
import { CHROME_COLOR_OPTIONS } from '../../shared/appearance';

export { CHROME_COLOR_OPTIONS } from '../../shared/appearance';

/** 预览与外壳使用相同深浅色值，系统外观切换时由 CSS 选择对应的一档。 */
export function applyChromeColor(value: ChromeColor): void {
  const root = document.documentElement;
  const option = CHROME_COLOR_OPTIONS.find((item) => item.value === value);
  if (!option?.accent) {
    delete root.dataset.chromeColor;
    root.style.removeProperty('--dsw-chrome-accent');
    root.style.removeProperty('--dsw-chrome-fill-light');
    root.style.removeProperty('--dsw-chrome-fill-dark');
    return;
  }
  root.dataset.chromeColor = value;
  root.style.setProperty('--dsw-chrome-accent', option.accent);
  root.style.setProperty('--dsw-chrome-fill-light', option.light);
  root.style.setProperty('--dsw-chrome-fill-dark', option.dark);
}
