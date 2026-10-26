import { clipboard, ipcMain } from 'electron';
import type { ContextMenuItem, ContextMenuRequest } from '../shared/types';

interface PendingContextMenu {
  request: ContextMenuRequest;
  source: Electron.WebContents;
  owner: Electron.WebContents;
  frame: Electron.WebFrameMain | null;
  linkURL: string;
}

const pendingMenus = new Map<number, PendingContextMenu>();
let nextRequestId = 0;

export function isContextMenuOpen(contents: Electron.WebContents): boolean {
  return pendingMenus.has((contents.hostWebContents || contents).id);
}

async function dismissContextMenu(ownerId: number, isRestoreFocus = false): Promise<boolean> {
  const pending = pendingMenus.get(ownerId);
  if (!pending) return false;
  pendingMenus.delete(ownerId);
  if (!pending.owner.isDestroyed()) pending.owner.send('context-menu:changed', null);
  if (isRestoreFocus && !pending.source.isDestroyed()) pending.source.focus();
  if (!pending.request.isGuest) return true;
  if (!pending.frame || pending.frame.isDestroyed()) return false;
  try {
    await pending.frame.executeJavaScript(`(() => {
      const key = Symbol.for('diteng-agent.context-menu-focus');
      const state = window[key];
      if (state?.id !== ${pending.request.id}) return;
      delete window[key];
      if (${isRestoreFocus}) { window.focus(); if (state.element?.isConnected) state.element.focus({ preventScroll: true }); }
    })()`, isRestoreFocus);
    return true;
  } catch (error) {
    if (!pending.source.isDestroyed() && !pending.frame.isDestroyed()) console.warn('[context-menu] 恢复网页焦点失败：', error);
    return false;
  }
}

/** 网页只提供上下文；菜单在可信外壳绘制，操作目标保留在主进程。 */
export function installContextMenu(contents: Electron.WebContents, isShellUrl: (url: string) => boolean): void {
  contents.on('context-menu', async (event, params) => {
    const owner = contents.hostWebContents || contents;
    if (owner.isDestroyed() || !isShellUrl(owner.getURL())) return;
    event.preventDefault();
    const items: ContextMenuItem[] = [];
    const isTextSelected = params.selectionText.length > 0;
    if (params.linkURL) {
      items.push({ action: 'copy-link', label: '复制链接地址', isEnabled: true }, { action: 'separator' });
    }
    if (params.isEditable) items.push({ action: 'cut', label: '剪切', isEnabled: isTextSelected && params.editFlags.canCut });
    items.push({ action: 'copy', label: '复制', isEnabled: isTextSelected && params.editFlags.canCopy });
    if (params.isEditable) items.push({ action: 'paste', label: '粘贴', isEnabled: params.editFlags.canPaste });
    items.push({ action: 'select-all', label: '全选', isEnabled: true });
    if (contents.getType() === 'webview') {
      items.push({ action: 'separator' }, { action: 'reload', label: '刷新', isEnabled: true });
    }
    const request: ContextMenuRequest = {
      id: ++nextRequestId, sourceId: contents.id, isGuest: contents !== owner,
      x: params.x, y: params.y, items,
    };
    void dismissContextMenu(owner.id);
    pendingMenus.set(owner.id, { request, source: contents, owner, frame: params.frame, linkURL: params.linkURL });
    if (request.isGuest && params.frame) {
      try {
        // 外壳接管焦点前保留原元素，iframe 的 activeElement 会在聚焦 webview 时被清空。
        await params.frame.executeJavaScript(`Object.defineProperty(window, Symbol.for('diteng-agent.context-menu-focus'), {
          configurable: true, value: { id: ${request.id}, element: document.activeElement }
        }); void 0`);
      } catch (error) {
        if (pendingMenus.get(owner.id)?.request.id === request.id) void dismissContextMenu(owner.id);
        if (!contents.isDestroyed()) console.warn('[context-menu] 记录网页焦点失败：', error);
        return;
      }
      if (pendingMenus.get(owner.id)?.request.id !== request.id || owner.isDestroyed()) return;
    }
    owner.send('context-menu:changed', request);
  });
  const dismiss = () => {
    for (const [ownerId, pending] of pendingMenus) {
      if (pending.source === contents || pending.owner === contents) void dismissContextMenu(ownerId);
    }
  };
  contents.on('did-start-navigation', dismiss);
  contents.once('destroyed', dismiss);
}

export function registerContextMenuIpc(isShellUrl: (url: string) => boolean): void {
  function findPending(event: Electron.IpcMainEvent, requestId: unknown): PendingContextMenu | undefined {
    const pending = pendingMenus.get(event.sender.id);
    if (!pending || pending.request.id !== requestId || event.senderFrame !== event.sender.mainFrame
      || !isShellUrl(event.sender.getURL())) return;
    return pending;
  }
  ipcMain.on('context-menu:close', (event, requestId: unknown, isRestoreFocus: unknown) => {
    if (findPending(event, requestId)) void dismissContextMenu(event.sender.id, isRestoreFocus === true);
  });
  ipcMain.on('context-menu:action', async (event, requestId: unknown, action: unknown) => {
    const pending = findPending(event, requestId);
    if (!pending || pending.source.isDestroyed()) return;
    const item = pending.request.items.find(item => item.action === action);
    if (!item || item.action === 'separator' || !item.isEnabled) return;
    if (!(await dismissContextMenu(event.sender.id, true))) return;
    if (pending.source.isDestroyed() || pending.frame?.isDestroyed() || pending.frame?.detached) return;
    switch (item.action) {
      case 'copy-link': void clipboard.writeText(pending.linkURL); break;
      case 'cut': pending.source.cut(); break;
      case 'copy': pending.source.copy(); break;
      case 'paste': pending.source.paste(); break;
      case 'select-all': pending.source.selectAll(); break;
      case 'reload': pending.source.reload(); break;
    }
  });
}
