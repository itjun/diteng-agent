import { contextBridge, ipcRenderer } from 'electron';
import type {
  CorpSwitchedPayload,
  MqttState,
  SessionSummary,
  TabsOpenRequestPayload,
} from '../shared/types';
import type { DitengApi } from '../shared/types';

// 最小暴露面：渲染层只经 window.diteng 访问主进程能力，不直接接触 ipcRenderer。
// 编译为 CJS（tsconfig module commonjs）以满足 sandbox preload 的加载要求。
const diteng: DitengApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  login: (request) => ipcRenderer.invoke('auth:login', request),
  getCheckCode: (serverBase) => ipcRenderer.invoke('auth:check-code', { serverBase }),
  smsSend: (request) => ipcRenderer.invoke('auth:sms-send', request),
  smsLogin: (request) => ipcRenderer.invoke('auth:sms-login', request),
  autoLogin: () => ipcRenderer.invoke('auth:auto-login'),
  // 记住密码✓且自动登录✗时，登录页预填账号与密码用（本机 Keychain 解密）
  getSavedCredential: () => ipcRenderer.invoke('auth:get-saved-credential'),
  // 登录窗自绘 × 按钮用；关闭后 window-all-closed 退出应用
  closeLoginWindow: () => ipcRenderer.invoke('app:close-login'),
  // 退出登录：主窗随即销毁，回包不保证送达，调用方无需等待结果
  logout: () => ipcRenderer.invoke('auth:logout'),
  getSession: () => ipcRenderer.invoke('session:get'),
  sessionListCorps: () => ipcRenderer.invoke('session:list-corps'),
  sessionSwitchCorp: (request) => ipcRenderer.invoke('session:switch-corp', request),
  tabsResolve: (request) => ipcRenderer.invoke('tabs:resolve', request),
  tabsPopEntry: () => ipcRenderer.invoke('tabs:pop-entry'),
  getMqttState: () => ipcRenderer.invoke('mqtt:get-state'),
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
  onCorpSwitched: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: CorpSwitchedPayload) => listener(payload);
    ipcRenderer.on('corp:switched', handler);
    return () => {
      ipcRenderer.removeListener('corp:switched', handler);
    };
  },
  onSessionChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, summary: SessionSummary | null) => listener(summary);
    ipcRenderer.on('session:changed', handler);
    return () => {
      ipcRenderer.removeListener('session:changed', handler);
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
