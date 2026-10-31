import { useRef, useState, type CSSProperties } from 'react';
import { CheckIcon, DesktopIcon, LayersIcon, MoonIcon, OpacityIcon, SunIcon } from '@radix-ui/react-icons';
import type { AppConfig, AppConfigPatch } from '../../shared/types';
import { CHROME_COLOR_OPTIONS, applyChromeColor } from './chrome-color';
import { useThemeSetting } from './use-theme';
import styles from './AppearanceSettings.module.css';

const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统', desc: '自动切换', Icon: DesktopIcon },
  { value: 'light', label: '浅色模式', desc: '明亮清晰', Icon: SunIcon },
  { value: 'dark', label: '深色模式', desc: '柔和专注', Icon: MoonIcon },
] as const;

const WINDOW_STYLE_OPTIONS = [
  { value: 'auto', label: '自动模式', desc: '跟随系统', Icon: DesktopIcon },
  { value: 'classic', label: '经典模式', desc: '实色背景', Icon: LayersIcon },
  { value: 'translucent', label: '透明模式', desc: '系统材质', Icon: OpacityIcon },
] as const;

/** 配色缩略预览使用真实文本布局，颜色与实际侧栏、内容卡片一致。 */
function PalettePreview({ light, dark, isDark }: { light: string; dark: string; isDark: boolean }) {
  return (
    <span className={styles.preview} data-dark={isDark} style={{ '--preview-chrome': isDark ? dark : light } as CSSProperties} aria-hidden="true">
      <span className={styles.previewRail}>
        <DesktopIcon />
        <span>工作区</span>
        <span className={styles.previewNav}>设置</span>
      </span>
      <span className={styles.previewContent}>
        <span className={styles.previewTitle}>外观</span>
        <span className={styles.previewText}>让工作区更合心意</span>
        <span className={styles.previewTag}>Aa</span>
      </span>
    </span>
  );
}

export function AppearanceSettings({ config, onConfigChange }: {
  config: AppConfig | null;
  onConfigChange: (config: AppConfig) => void;
}) {
  const { themeSetting, resolvedTheme } = useThemeSetting();
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const isSavingRef = useRef(false);
  const color = config?.chromeColor ?? 'auto';
  const windowStyle = config?.windowStyle ?? 'auto';
  const selectedPalette = CHROME_COLOR_OPTIONS.find((option) => option.value === color) ?? CHROME_COLOR_OPTIONS[0];
  const selectedTheme = THEME_OPTIONS.find((option) => option.value === themeSetting)!;

  async function selectAppearance(patch: Pick<AppConfigPatch, 'theme' | 'windowStyle' | 'chromeColor'>) {
    if (!config || isSavingRef.current) return;
    if ((!patch.theme || patch.theme === themeSetting) && (!patch.windowStyle || patch.windowStyle === windowStyle) && (!patch.chromeColor || patch.chromeColor === color)) return;
    isSavingRef.current = true;
    setIsSaving(true);
    setSaveError('');
    if (patch.chromeColor) {
      applyChromeColor(patch.chromeColor);
      onConfigChange({ ...config, chromeColor: patch.chromeColor });
    }
    try {
      const saved = await window.diteng.setConfig(patch);
      onConfigChange(saved);
      applyChromeColor(saved.chromeColor);
    } catch {
      onConfigChange(config);
      applyChromeColor(config.chromeColor);
      setSaveError('外观未能保存，请重新选择。');
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }

  return (
    <div className={styles.appearance} data-testid="appearance-settings">
      <section className={styles.section} aria-labelledby="appearance-mode-title">
        <div className={styles.sectionHead}>
          <h3 id="appearance-mode-title">显示模式</h3>
          <span>{themeSetting === 'system' ? `当前${resolvedTheme === 'dark' ? '深色' : '浅色'}` : selectedTheme.label}</span>
        </div>
        <div className={styles.themeGrid} role="radiogroup" aria-label="主题">
          {THEME_OPTIONS.map(({ value, label, desc, Icon }) => (
            <label key={value} className={styles.themeOption} data-selected={themeSetting === value} data-testid={`settings-theme-${value}`}>
              <input type="radio" name="appearance-theme" value={value} aria-label={label} checked={themeSetting === value} disabled={!config} aria-disabled={isSaving} onChange={() => void selectAppearance({ theme: value })} />
              <span className={styles.modeSurface} data-mode={value}><Icon aria-hidden="true" /></span>
              <span className={styles.modeMeta}><strong>{label}</strong><span>{desc}</span></span>
              <span className={styles.selectionMark} aria-hidden="true">{themeSetting === value && <CheckIcon aria-hidden="true" />}</span>
            </label>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="appearance-window-style-title">
        <div className={styles.sectionHead}>
          <h3 id="appearance-window-style-title">窗口材质</h3>
          <span>实色回退</span>
        </div>
        <div className={styles.themeGrid} role="radiogroup" aria-label="窗口材质">
          {WINDOW_STYLE_OPTIONS.map(({ value, label, desc, Icon }) => (
            <label key={value} className={styles.themeOption} data-selected={windowStyle === value} data-testid={`settings-window-style-${value}`}>
              <input type="radio" name="appearance-window-style" value={value} aria-label={label} checked={windowStyle === value} disabled={!config || isSaving} onChange={() => void selectAppearance({ windowStyle: value })} />
              <span className={styles.modeSurface} data-mode="system"><Icon aria-hidden="true" /></span>
              <span className={styles.modeMeta}><strong>{label}</strong><span>{desc}</span></span>
              <span className={styles.selectionMark} aria-hidden="true">{windowStyle === value && <CheckIcon aria-hidden="true" />}</span>
            </label>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="appearance-color-title">
        <div className={styles.sectionHead}>
          <h3 id="appearance-color-title">外观配色 <span className={styles.count}>{CHROME_COLOR_OPTIONS.length}</span></h3>
          <span>全局外观</span>
        </div>
        <div className={styles.paletteGrid} role="radiogroup" aria-label="外围颜色">
          {CHROME_COLOR_OPTIONS.map((option) => (
            <label key={option.value} className={styles.paletteOption} data-selected={color === option.value} data-testid={`settings-chrome-${option.value}`}>
              <input type="radio" name="appearance-color" value={option.value} aria-label={option.label} checked={color === option.value} disabled={!config} aria-disabled={isSaving} onChange={() => void selectAppearance({ chromeColor: option.value })} />
              <PalettePreview light={option.light} dark={option.dark} isDark={resolvedTheme === 'dark'} />
              <span className={styles.paletteMeta}>
                <strong>{option.label}</strong>
                {color === option.value && <span className={styles.inUse}><CheckIcon aria-hidden="true" />正在使用</span>}
              </span>
            </label>
          ))}
        </div>
      </section>
      <div className={styles.footer} role="status">
        <span>{config ? `${selectedTheme.label} / ${WINDOW_STYLE_OPTIONS.find((option) => option.value === windowStyle)?.label} / ${selectedPalette.label}` : '正在读取…'}</span>
        <span>{isSaving ? '正在保存…' : '即时生效'}</span>
      </div>
      {saveError && <p className={styles.error} role="alert">{saveError}</p>}
    </div>
  );
}
