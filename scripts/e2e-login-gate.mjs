/**
 * e2e 共用登录入口闸门：兼容「记住密码」自动登录。
 * 登录窗启动时若 config 已存 savedLoginId + savedPassword，登录页会先进入
 * 「自动登录中…」状态页（普通表单不在 DOM），直接 fill('#server-base') 会失败。
 * 所有用到登录表单的脚本统一先过此闸门：
 *   1. 先短等（默认 8s）#/main 出现 → 自动登录成功，返回主窗 page（按已登录继续）；
 *   2. 否则若 auto-login-state 状态页仍在 → 点「手动登录」转普通表单；
 *   3. 返回 null，调用方继续原登录流程（自动登录失败时页面已自行转回表单并带错误提示）。
 */

/**
 * @param {() => import('playwright-core').Page[]} allPages 当前全部 CDP target
 * @param {import('playwright-core').Page} login 登录窗页面
 * @param {number} waitMs 等待 #/main（自动登录成功）的时长
 * @returns {Promise<import('playwright-core').Page | null>} 已登录时返回主窗 page，否则 null
 */
export async function resolveAutoLoginGate(allPages, login, waitMs = 8000) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const findMain = () => allPages().find((p) => p.url().includes('#/main'));
  const deadline = Date.now() + waitMs;
  let shell = findMain();
  while (!shell && Date.now() < deadline) {
    await sleep(400);
    shell = findMain();
  }
  if (shell) return shell;
  try {
    if ((await login.locator('[data-testid="auto-login-state"]').count()) > 0) {
      await login.click('[data-testid="auto-login-cancel"]');
      await login.waitForSelector('#server-base', { timeout: 5000 });
    }
  } catch {
    // 点击/等待期间登录窗可能刚好被自动登录成功关闭：以 #/main 实际出现为准
    return findMain() ?? null;
  }
  return null;
}
