import React from 'react';
import { createRoot } from 'react-dom/client';
// dsh 主题：token 定义 -> 字体/圆角基础 -> 焦点环 -> 滚动条 -> Montserrat @font-face
import '../theme/base.css';
import '../theme/design-platform.css';
import '../theme/focus.css';
import '../theme/scrollbar.css';
import '../theme/brand-font.css';
import './global.css';
import { App } from './App';
import { ContextMenu } from './ContextMenu';
import { UpdateNotice } from './UpdateSettings';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <ContextMenu />
    {!window.location.hash.startsWith('#/notify-popup') && <UpdateNotice />}
  </React.StrictMode>,
);
