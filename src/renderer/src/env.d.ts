/// <reference types="vite/client" />
import type { DitengApi, TabsState } from '../../shared/types';
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * Electron <webview> 元素的最小类型声明（React 18 无内置类型）。
 * 只声明本项目用到的事件与方法；事件载荷字段直接挂在 event 上（Electron 约定，非 detail）。
 */
export interface WebviewDomEvent extends Event {
  /** page-title-updated */
  title?: string;
  /** did-navigate / did-navigate-in-page / did-fail-load 等 */
  url?: string;
  /** page-favicon-updated */
  favicons?: string[];
}

export interface WebviewElement extends HTMLElement {
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  /** guest 页内执行脚本（地址栏跟随网页底色的采样用） */
  executeJavaScript<T>(code: string, userGesture?: boolean): Promise<T>;
}

/** <webview> 的 JSX 属性（src 只在挂载时生效；allowpopups 见 IntrinsicElements 注释） */
type WebviewJsxProps = DetailedHTMLProps<HTMLAttributes<WebviewElement>, WebviewElement> & {
  src?: string;
  /** 允许 guest 触发 window.open 流程（实际开窗仍被主进程 setWindowOpenHandler deny 并转新标签） */
  allowpopups?: string;
};

declare global {
  interface Window {
    diteng: DitengApi;
    /**
     * 标签全量状态调试快照（e2e 断言用，tabsList 等价物——标签状态归渲染层后不再有主进程 IPC）。
     * 由 Shell 每次状态变化时刷新。
     */
    __ditengTabsList?(): TabsState;
  }

  /** JSX 内 <webview> 标签（仅主窗壳渲染，见 Shell.tsx）；React 18 全局 JSX 与 React.JSX 双声明兜底 */
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewJsxProps;
    }
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewJsxProps;
    }
  }
}
