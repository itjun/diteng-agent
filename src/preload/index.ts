import { contextBridge, ipcRenderer } from 'electron';
import type {
  ContextMenuRequest,
  MqttState,
  CorpSwitchCommitted,
  SessionSummary,
  ShortcutAction,
  TabsOpenRequestPayload,
  ThemeState,
  UpdateState,
  WindowMaterial,
  WindowStyleState,
} from '../shared/types';
import type { DitengApi } from '../shared/types';

// 最小暴露面：渲染层只经 window.diteng 访问主进程能力，不直接接触 ipcRenderer。
// 编译为 CJS（tsconfig module commonjs）以满足 sandbox preload 的加载要求。
// 主题在首帧前同步取一次：固定浅/深色时不能先按系统外观绘制再跳变。
const initialThemeState = ipcRenderer.sendSync('theme:get-sync') as ThemeState;
// 主窗原生材质同样首帧同步取：透明/实底分支不能先画实底再跳变（Win11 云母 build 门槛只在主进程判定）
const initialWindowMaterial = ipcRenderer.sendSync('material:get-sync') as WindowMaterial;
const initialWindowStyle = ipcRenderer.sendSync('window-style:get-sync') as WindowStyleState;

const diteng: DitengApi = {
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on('update:changed', handler);
    return () => ipcRenderer.removeListener('update:changed', handler);
  },
  onContextMenuChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: ContextMenuRequest | null) => listener(request);
    ipcRenderer.on('context-menu:changed', handler);
    return () => ipcRenderer.removeListener('context-menu:changed', handler);
  },
  closeContextMenu: (requestId, isRestoreFocus) => ipcRenderer.send('context-menu:close', requestId, isRestoreFocus),
  runContextMenuAction: (requestId, action) => ipcRenderer.send('context-menu:action', requestId, action),
  initialThemeState,
  initialWindowMaterial,
  initialWindowStyle,
  onWindowStyleChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WindowStyleState) => listener(state);
    ipcRenderer.on('window-style:changed', handler);
    return () => ipcRenderer.removeListener('window-style:changed', handler);
  },
  tabsSetActiveGuest: (id) => ipcRenderer.send('tabs:active-guest', id),
  retryCorpVerification: () => ipcRenderer.invoke('corp-switch:retry'),
  onCorpSwitchCommitted: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: CorpSwitchCommitted) => listener(value);
    ipcRenderer.on('corp-switch:committed', handler);
    return () => ipcRenderer.removeListener('corp-switch:committed', handler);
  },
  onNotifyPopupChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('notify-popup:changed', handler);
    return () => ipcRenderer.removeListener('notify-popup:changed', handler);
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  getDeviceInfo: () => ipcRenderer.invoke('device:info'),
  getPublicIp: () => ipcRenderer.invoke('device:public-ip'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getThemeState: () => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ThemeState) => listener(state);
    ipcRenderer.on('theme:changed', handler);
    return () => {
      ipcRenderer.removeListener('theme:changed', handler);
    };
  },
  login: (request) => ipcRenderer.invoke('auth:login', request),
  loginSendCode: (request) => ipcRenderer.invoke('auth:login-send-code', request),
  autoLogin: () => ipcRenderer.invoke('auth:auto-login'),
  // 历史登录账号：列表只含摘要，密码密文留在主进程、选中账号时才按需解密
  listSavedAccounts: () => ipcRenderer.invoke('auth:list-saved-accounts'),
  getSavedAccountPassword: (key) => ipcRenderer.invoke('auth:get-saved-account-password', key),
  removeSavedAccount: (key) => ipcRenderer.invoke('auth:remove-saved-account', key),
  clearSavedAccounts: () => ipcRenderer.invoke('auth:clear-saved-accounts'),
  // 登录窗自绘 × 按钮用；关闭后 window-all-closed 退出应用
  closeLoginWindow: () => ipcRenderer.invoke('app:close-login'),
  // 退出登录：主窗随即销毁，回包不保证送达，调用方无需等待结果
  logout: () => ipcRenderer.invoke('auth:logout'),
  relogin: () => ipcRenderer.invoke('auth:relogin'),
  getSession: () => ipcRenderer.invoke('session:get'),
  tabsResolve: (request) => ipcRenderer.invoke('tabs:resolve', request),
  tabsPopEntry: () => ipcRenderer.invoke('tabs:pop-entry'),
  // 一键反馈：主进程只截整窗并回 PNG 字节；标注与复制时机由渲染层编辑器决定
  captureFeedbackScreenshot: () => ipcRenderer.invoke('feedback:capture-screenshot'),
  copyFeedbackImage: (png) => ipcRenderer.invoke('feedback:copy-image', png),
  openFeedbackApp: (app) => ipcRenderer.invoke('feedback:open-app', app),
  setFeedbackEditorActive: (isActive) => ipcRenderer.send('feedback:editor-active', isActive),
  getMqttState: () => ipcRenderer.invoke('mqtt:get-state'),
  refreshMessages: () => ipcRenderer.invoke('mqtt:refresh'),
  testSystemNotification: () => ipcRenderer.invoke('notifications:test'),
  notifyPopupLoad: () => ipcRenderer.invoke('notify-popup:get'),
  notifyPopupOpen: () => ipcRenderer.send('notify-popup:activate'),
  notifyPopupClose: () => ipcRenderer.send('notify-popup:close'),
  notifyPopupHover: (isHovering) => ipcRenderer.send('notify-popup:hover', isHovering),
  // 订阅即登记 listener，返回取消函数供 React effect 清理，避免重复累积
  onTabsOpenRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TabsOpenRequestPayload) => listener(payload);
    ipcRenderer.on('tabs:open-request', handler);
    return () => {
      ipcRenderer.removeListener('tabs:open-request', handler);
    };
  },
  onSessionChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, summary: SessionSummary | null) => listener(summary);
    ipcRenderer.on('session:changed', handler);
    return () => {
      ipcRenderer.removeListener('session:changed', handler);
    };
  },
  // 主窗自绘窗口控制（Windows/Linux 无系统标题栏）；close 不绕过主进程的托盘拦截
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close-main'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizedChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
    ipcRenderer.on('window:maximized-changed', handler);
    return () => {
      ipcRenderer.removeListener('window:maximized-changed', handler);
    };
  },
  onShortcut: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, action: ShortcutAction) => listener(action);
    ipcRenderer.on('shortcut:action', handler);
    return () => {
      ipcRenderer.removeListener('shortcut:action', handler);
    };
  },
  onMqttChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: MqttState) => listener(state);
    ipcRenderer.on('mqtt:changed', handler);
    return () => {
      ipcRenderer.removeListener('mqtt:changed', handler);
    };
  },
};

contextBridge.exposeInMainWorld('diteng', diteng);
