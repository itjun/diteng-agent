import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardIcon, FrameIcon, Link2Icon, ScissorsIcon } from '@radix-ui/react-icons';
import type { ContextMenuAction, ContextMenuRequest } from '../../shared/types';
import type { WebviewElement } from './env';
import { CopyIcon, ReloadIcon } from './theme-icons';
import menuStyles from './Shell.module.css';
import styles from './ContextMenu.module.css';

const icons = { 'copy-link': Link2Icon, cut: ScissorsIcon, copy: CopyIcon, paste: ClipboardIcon, 'select-all': FrameIcon, reload: ReloadIcon };
const shortcutKeys = { 'copy-link': '', cut: 'X', copy: 'C', paste: 'V', 'select-all': 'A', reload: 'R' };
const shortcutPrefix = /Macintosh/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';

interface MenuState {
  request: ContextMenuRequest;
  target: HTMLElement | null;
  x: number;
  y: number;
}

/** 与三点菜单共用样式，挂到应用主题层，覆盖页内 webview。 */
export function ContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  useEffect(() => window.diteng.onContextMenuChanged(request => {
    if (!request) { setMenu(null); return; }
    let target = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (request.isGuest) {
      const guest = [...document.querySelectorAll<WebviewElement>('webview')]
        .find(view => {
          try { return view.getWebContentsId() === request.sourceId; } catch { return false; }
        });
      if (!guest) { window.diteng.closeContextMenu(request.id); return; }
      target = guest;
    }
    // Electron 已将 guest / iframe 的右键坐标转换到所属窗口，无需再叠加 webview 偏移。
    setMenu({ request, target, x: request.x, y: request.y });
  }), []);
  return menu ? <ContextMenuPopup key={menu.request.id} menu={menu} onClose={() => setMenu(null)} /> : null;
}

function ContextMenuPopup({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isClosingRef = useRef(false);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const dismiss = useCallback((isRestoreFocus: boolean) => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    if (isRestoreFocus && menu.target?.isConnected) menu.target.focus({ preventScroll: true });
    window.diteng.closeContextMenu(menu.request.id, isRestoreFocus);
    onClose();
  }, [menu, onClose]);

  useLayoutEffect(() => {
    const bounds = menuRef.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8)),
    });
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    const close = () => dismiss(false);
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) dismiss(true);
    };
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', onScroll, true);
    const unsubscribe = window.diteng.onShortcut(close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', onScroll, true);
      unsubscribe();
    };
  }, [dismiss]);

  function runAction(action: ContextMenuAction) {
    if (isClosingRef.current) return;
    // 先占用关闭状态，避免恢复 guest 焦点触发 blur 抢先取消菜单操作。
    isClosingRef.current = true;
    if (menu.target?.isConnected) menu.target.focus({ preventScroll: true });
    window.diteng.runContextMenuAction(menu.request.id, action);
    onClose();
  }

  return createPortal(<>
    <div className={`${menuStyles.appMenuBackdrop} ${styles.backdrop}`} data-testid="context-menu-backdrop"
      onPointerDown={event => { event.preventDefault(); dismiss(true); }}
      onContextMenu={event => { event.preventDefault(); dismiss(true); }} />
    <div ref={menuRef} role="menu" aria-label="右键菜单" data-testid="context-menu"
      className={`${menuStyles.appMenu} ${styles.menu}`} style={position}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault(); event.stopPropagation(); dismiss(true);
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}>
      {menu.request.items.map((item, index) => {
        if (item.action === 'separator') return <div key={index} role="separator" />;
        const Icon = icons[item.action];
        const shortcut = shortcutKeys[item.action];
        return <button key={item.action} type="button" role="menuitem" disabled={!item.isEnabled}
          data-testid={`context-menu-${item.action}`} onClick={() => runAction(item.action)}>
          <Icon /><span>{item.label}</span>
          {shortcut && <span className={menuStyles.appMenuShortcut}>{shortcutPrefix}{shortcut}</span>}
        </button>;
      })}
    </div>
  </>, document.body);
}
