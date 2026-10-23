/**
 * ERP 经典页「菜单卡片新标签打开」兼容补丁。
 *
 * 背景：菜单模组页（FrmDefault.moduleMenu / FrmMenu）的卡片点击由 myapp.js 的
 * appendTodayMenuSummary(menuCode, isOpenNewWindow, navUrl) 处理，isOpenNewWindow 来自用户参数
 * 「模组子菜单默认新窗口打开」（MenuAutoNewWindow，默认关）。关闭时桌面端走 safeNavigate
 * （location.href）把当前菜单页替换掉，与网页版点击菜单的 `_blank` 新标签行为不一致。
 *
 * 外壳不改服务端页面，改为在 webview guest 主世界注入补丁：把卡片点击固定为 window.open，
 * 再由主进程 setWindowOpenHandler 转成壳内新标签。补丁只覆盖 appendTodayMenuSummary——
 * 该函数仅由菜单类页面（一级轻壳）加载的 myapp.js 定义；其它页面注入为空操作。
 * 菜单使用统计、URL 合法性校验仍在原函数内执行，补丁只改分支参数。
 * 页面每次整页导航都会产生新文档，故在 dom-ready / did-finish-load 各注入一次（幂等）。
 */
const MENU_NEW_TAB_PATCH = `(() => {
  if (window.__ditengErpMenuNewTabPatch) return 'already';
  const openMenu = window.appendTodayMenuSummary;
  if (typeof openMenu !== 'function') return 'absent';
  window.__ditengErpMenuNewTabPatch = true;
  window.appendTodayMenuSummary = function (menuCode, isOpenNewWindow, navUrl) {
    // 第二个参数固定为 true：原函数走 safeWindowOpen（window.open）分支，转壳内新标签
    return openMenu.call(this, menuCode, true, navUrl);
  };
  return 'patched';
})()`;

/** 给一个 webview guest 装配补丁：每次新文档就绪后注入一次（函数不存在时为空操作） */
export function installErpMenuNewTabPatch(contents: Electron.WebContents): void {
  const apply = (): void => {
    void contents
      .executeJavaScript(MENU_NEW_TAB_PATCH, false)
      .then((result) => {
        if (result === 'patched') console.log(`[erp] 菜单卡片已切换为壳内新标签打开：${contents.getURL()}`);
      })
      .catch(() => {
        // 页面正在导航或已销毁：下一轮导航事件会重新注入
      });
  };
  contents.on('dom-ready', apply);
  contents.on('did-finish-load', apply);
}
