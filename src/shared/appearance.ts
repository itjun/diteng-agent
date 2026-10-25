/** 设置预览、外壳着色与主进程配置校验共用同一份配色。旧取值保持兼容。 */
export const CHROME_COLOR_OPTIONS = [
  { value: 'auto', label: '经典', accent: '', light: '#f9fafb', dark: '#1b1b1c' },
  { value: 'ink', label: '墨黑', accent: '#2b2d31', light: '#d9dadd', dark: '#202125' },
  { value: 'slate', label: '雾灰', accent: '#64748b', light: '#e0e6ee', dark: '#29323f' },
  { value: 'blue', label: '海蓝', accent: '#3b6fd4', light: '#dbe7fb', dark: '#233655' },
  { value: 'green', label: '苔绿', accent: '#3f8f6b', light: '#dcece1', dark: '#263d33' },
  { value: 'teal', label: '青瓷', accent: '#278b91', light: '#d5eceb', dark: '#203d40' },
  { value: 'purple', label: '鸢尾', accent: '#6d5bd0', light: '#e7e1f8', dark: '#36304e' },
  { value: 'pink', label: '胭粉', accent: '#d05a7a', light: '#f4e0e7', dark: '#4a2d39' },
  { value: 'rose', label: '莓红', accent: '#b94e55', light: '#f1ddde', dark: '#482a2f' },
  { value: 'orange', label: '琥珀', accent: '#c97a2b', light: '#f3e5d2', dark: '#453626' },
  { value: 'sand', label: '燕麦', accent: '#a38a64', light: '#ece6d9', dark: '#3c372e' },
  { value: 'coffee', label: '可可', accent: '#946f5b', light: '#e9ddd6', dark: '#3c302b' },
] as const;

export type ChromeColor = (typeof CHROME_COLOR_OPTIONS)[number]['value'];
