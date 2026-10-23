import { useEffect, useLayoutEffect, useState } from 'react';
import type { ThemeSetting } from '../../shared/types';

/**
 * 主题状态由主进程统一解析并广播：setting 是用户选择，resolved 是最终应用外观。
 * 原生窗口材质、渲染层 token 和原生控件都消费同一份状态，系统外观只影响 system 模式。
 */
export function useThemeSetting(): {
  resolvedTheme: 'light' | 'dark';
  themeSetting: ThemeSetting;
  setTheme: (next: ThemeSetting) => void;
  toggleTheme: () => void;
} {
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(
    () => window.diteng.initialThemeState.setting,
  );
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(
    () => window.diteng.initialThemeState.resolved,
  );

  useEffect(() => {
    let active = true;
    const unsubscribe = window.diteng.onThemeChanged((state) => {
      setThemeSetting(state.setting);
      setResolvedTheme(state.resolved);
    });
    // preload 快照与监听之间若刚好发生主题切换，主动拉一次补齐
    void window.diteng.getThemeState().then((state) => {
      if (!active) return;
      setThemeSetting(state.setting);
      setResolvedTheme(state.resolved);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // 在绘制前同时更新 token 开关和原生控件/滚动条配色，避免首帧或切换时短暂混搭
  useLayoutEffect(() => {
    document.documentElement.style.colorScheme = resolvedTheme;
    if (resolvedTheme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
  }, [resolvedTheme]);

  function setTheme(next: ThemeSetting) {
    // 选择器状态立即反馈；最终外观由主进程广播回来
    setThemeSetting(next);
    void window.diteng.setConfig({ theme: next });
  }

  function toggleTheme() {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }

  return { resolvedTheme, themeSetting, setTheme, toggleTheme };
}
