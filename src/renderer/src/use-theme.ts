import { useEffect, useState } from 'react';
import type { ThemeSetting } from '../../shared/types';

/** 同窗口内多实例（壳/用户卡片/设置页）同步主题变更的自定义事件 */
const THEME_CHANGED_EVENT = 'diteng:theme-changed';

/**
 * 主题状态：config 持久化 + 跟随系统实时切换 + 写 body[data-ds-dark-theme]。
 * 登录窗与主窗壳共用，避免多处各抄一份 matchMedia 逻辑；
 * 多个实例各自持状态，写入 config 后广播 THEME_CHANGED_EVENT 互相同步。
 */
export function useThemeSetting(): {
  resolvedTheme: 'light' | 'dark';
  themeSetting: ThemeSetting;
  setTheme: (next: ThemeSetting) => void;
  toggleTheme: () => void;
} {
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>('system');
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    void window.diteng.getConfig().then((config) => setThemeSetting(config.theme));
  }, []);

  // 其他实例（用户卡片/设置页）改主题后同步本地状态
  useEffect(() => {
    const onThemeChanged = () => void window.diteng.getConfig().then((config) => setThemeSetting(config.theme));
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onThemeChanged);
  }, []);

  // 跟随系统：theme 为 system 时，系统深浅色变化实时生效
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    themeSetting === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themeSetting;

  useEffect(() => {
    if (resolvedTheme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
  }, [resolvedTheme]);

  function setTheme(next: ThemeSetting) {
    setThemeSetting(next);
    void window.diteng.setConfig({ theme: next }).then(() => {
      window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
    });
  }

  function toggleTheme() {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }

  return { resolvedTheme, themeSetting, setTheme, toggleTheme };
}
