import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
// 内部客户端：中文文案直接写死，暂不接入 Lang.as 翻译（后续多语言需求出现再迁移）
import { DEVICE_UNCHECKED_CODE, type SavedAccountSummary } from '../../shared/types';
import { NotifyPopup } from './NotifyPopup';
import { Shell } from './Shell';
import { useThemeSetting } from './use-theme';
import loginIllustration from './assets/login-illustration.webp';
import styles from './App.module.css';

type LoginMode = 'password' | 'sms';

/**
 * 自动登录阶段：
 * - checking：启动读 config 判定是否有已存凭据（只出品牌头，不闪表单）
 * - waiting：自动登录进行中（状态页 + 手动登录入口）
 * - manual：普通表单（无凭据 / 用户取消 / 自动登录失败）
 */
type AutoLoginPhase = 'checking' | 'waiting' | 'manual';

/** 短信验证码重发冷却秒数（服务端 5 分钟冷却，对齐 im-client 登录页） */
const SMS_RESEND_SECONDS = 300;

/**
 * 登录窗与主窗壳共用同一入口页，仅 hash 区分（主进程创建主窗时加载 #/main）。
 * 窗口角色创建后不再变化，直接在渲染时判定，无需监听 hashchange。
 * #/notify-popup 为重要消息置顶弹窗（ImportantNotifier 创建的无边框小窗）。
 */
export function App() {
  if (window.location.hash.startsWith('#/main')) return <Shell />;
  if (window.location.hash.startsWith('#/notify-popup')) return <NotifyPopup />;
  return <LoginPanel />;
}

function LoginPanel() {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  // 「记住密码 / 自动登录」双勾选（通用软件惯例）：关记住密码连带关自动登录；开自动登录连带开记住密码
  const [isRememberPassword, setIsRememberPassword] = useState(true);
  const [isAutoLogin, setIsAutoLogin] = useState(true);
  const [autoLoginPhase, setAutoLoginPhase] = useState<AutoLoginPhase>('checking');
  const [mode, setMode] = useState<LoginMode>('password');
  const [smsCode, setSmsCode] = useState('');
  const [smsHint, setSmsHint] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingSms, setIsSendingSms] = useState(false);
  const [isPasswordPending, setIsPasswordPending] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  // 登录成功后的过渡态：主进程随即打开主窗并关闭登录窗
  const [isEntering, setIsEntering] = useState(false);
  // 历史登录账号（最近登录在前）：账号输入框右侧出口，支持选择、删除、清空
  const [savedAccounts, setSavedAccounts] = useState<SavedAccountSummary[]>([]);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // 清空是破坏性操作：底部按钮先点一次进入确认态，再点一次才真正清空
  const [isClearHistoryConfirming, setIsClearHistoryConfirming] = useState(false);
  // 登录页不再提供手动切换入口，主题仍跟随 config.theme / 系统自动应用
  useThemeSetting();

  // 防重守卫：提交/发送处理中，回车与连点共用同一同步闸门
  const isBusyRef = useRef(false);
  // 自动登录只发起一次（StrictMode 双执行防重）
  const isAutoLoginStartedRef = useRef(false);
  // 自动登录阶段同步 ref：迟到结果据此判断用户是否已点「手动登录」（避免闭包旧值）
  const autoLoginPhaseRef = useRef<AutoLoginPhase>('checking');
  // 历史账号下拉的点击外部区域判定
  const accountFieldRef = useRef<HTMLDivElement>(null);
  // 密码回填（初始预填/选择历史账号）的请求序号：改账号、改密码或再次选择都会作废在途结果
  const passwordFillSeqRef = useRef(0);
  // 密码是否由历史账号/兼容凭据自动回填：手动改账号时据此清空，避免把 A 的密码带给 B
  const isPasswordAutoFilledRef = useRef(false);
  // 密码回填进行中（含状态与同步 ref）：解密返回前禁止提交，避免用空密码/旧密码登录
  const isPasswordPendingRef = useRef(false);
  // 历史账号删除/清空的防重守卫：连点与确认态共用同一同步闸门，避免重复发起写操作
  const isHistoryBusyRef = useRef(false);
  // 「清空」确认态起始时间：防止把一次物理双击当成两次独立确认
  const clearConfirmAtRef = useRef(0);

  /** 密码回填态同时写 ref 与 state：提交闸门读 ref，按钮禁用读 state */
  function updatePasswordPending(isPending: boolean) {
    isPasswordPendingRef.current = isPending;
    setIsPasswordPending(isPending);
  }

  /** 手动改账号：作废在途回填并清掉自动回填的密码，避免把上一个账号的密码带到新账号 */
  function invalidatePasswordFill() {
    passwordFillSeqRef.current += 1;
    updatePasswordPending(false);
    if (isPasswordAutoFilledRef.current) {
      isPasswordAutoFilledRef.current = false;
      setPassword('');
    }
  }

  function switchAutoLoginPhase(next: AutoLoginPhase) {
    autoLoginPhaseRef.current = next;
    setAutoLoginPhase(next);
  }

  /**
   * 自动登录结果处理（含迟到结果）：
   * - 成功：主进程已按 keepSession 单一路径开主窗；这里切「登录成功」过渡态（窗口即将关闭）。
   *   若用户已点「手动登录」但尚未用新账号登录成功，主窗照常开出、登录窗随之关闭。
   * - 失败：仅在仍处于自动登录等待态时转表单并展示错误；用户已取消则不打扰手动输入。
   */
  async function runAutoLogin() {
    const result = await window.diteng.autoLogin();
    if (result.ok) {
      // 切出自动登录页以展示「登录成功」过渡态；主窗开出后登录窗随即被主进程关闭
      switchAutoLoginPhase('manual');
      setIsEntering(true);
      return;
    }
    if (autoLoginPhaseRef.current !== 'waiting') return;
    // 连接失败（code -1）补「自动登录失败」前缀，其余（解密失败/-8 等）直接展示后端/主进程文案
    setErrorMsg(result.code === -1 ? `自动登录失败：${result.message}` : result.message);
    switchAutoLoginPhase('manual');
  }

  useEffect(() => {
    void (async () => {
      const [config, accounts] = await Promise.all([
        window.diteng.getConfig(),
        window.diteng.listSavedAccounts(),
      ]);
      setSavedAccounts(accounts);
      // 账号预填优先取「自动登录凭据对应的账号」，其次取最近登录的历史账号（记住密码未勾选时后者仍可用）
      setLoginId(config.savedLoginId || accounts[0]?.loginId || '');
      setIsRememberPassword(config.rememberPassword);
      setIsAutoLogin(config.autoLogin && config.rememberPassword);
      // 自动登录仅在「自动登录✓ 且已存凭据」时发起（StrictMode 双执行只发起一次，经 ref 防重）
      if (config.autoLogin && config.rememberPassword && config.savedLoginId && config.savedPassword) {
        switchAutoLoginPhase('waiting');
        if (!isAutoLoginStartedRef.current) {
          isAutoLoginStartedRef.current = true;
          void runAutoLogin();
        }
        return;
      }
      switchAutoLoginPhase('manual');
      // 记住密码✓ 且已存凭据（但未开自动登录）：预填密码；退出登录会清空该凭据，此时密码留空。
      // 按兼容凭据的 {账号, 服务器} 精确取密码，且用序号防止慢结果覆盖用户此后的输入/选择
      if (config.rememberPassword && config.savedLoginId && config.savedPassword) {
        const prefillSeq = ++passwordFillSeqRef.current;
        updatePasswordPending(true);
        try {
          const credential = await window.diteng.getSavedAccountPassword({
            loginId: config.savedLoginId,
            serverBase: config.serverBase,
          });
          if (prefillSeq !== passwordFillSeqRef.current) return;
          if (credential.ok) {
            setPassword(credential.data);
            isPasswordAutoFilledRef.current = true;
          }
        } finally {
          if (prefillSeq === passwordFillSeqRef.current) updatePasswordPending(false);
        }
      }
    })();
  }, []);

  // 历史账号下拉：点击账号区域以外关闭；关闭时重置「清空」确认态，避免下次打开误清空
  useEffect(() => {
    if (!isHistoryOpen) {
      setIsClearHistoryConfirming(false);
      return;
    }
    function handleMouseDown(event: MouseEvent) {
      if (!accountFieldRef.current?.contains(event.target as Node)) setIsHistoryOpen(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isHistoryOpen]);

  /** 双勾选联动并持久化：关记住密码 → 自动登录一并关；开自动登录 → 记住密码一并开 */
  function toggleRememberPassword(isChecked: boolean) {
    setIsRememberPassword(isChecked);
    if (!isChecked) setIsAutoLogin(false);
    void window.diteng.setConfig({ rememberPassword: isChecked, autoLogin: isChecked ? isAutoLogin : false });
  }

  function toggleAutoLogin(isChecked: boolean) {
    // 自动登录依赖记住密码，开启时强制勾上
    const isEffective = isChecked && isRememberPassword;
    setIsAutoLogin(isEffective);
    if (isEffective) setIsRememberPassword(true);
    void window.diteng.setConfig({ autoLogin: isEffective, rememberPassword: isEffective ? true : isRememberPassword });
  }

  /**
   * 选择当前环境的历史账号：回填账号；记住密码✓ 且该账号存有密码时解密回填。
   * 切换账号时同步清空旧密码并禁止提交，解密结果返回前绝不沿用上一个账号的密码；
   * 解密失败时保持密码为空并提示。
   */
  async function handleSelectSavedAccount(account: SavedAccountSummary) {
    const seq = ++passwordFillSeqRef.current;
    setIsHistoryOpen(false);
    setLoginId(account.loginId);
    setMode('password');
    setSmsCode('');
    setSmsHint('');
    setCountdown(0);
    setErrorMsg('');
    setPassword('');
    isPasswordAutoFilledRef.current = false;
    updatePasswordPending(false);
    if (!account.hasPassword || !isRememberPassword) return;
    updatePasswordPending(true);
    try {
      const result = await window.diteng.getSavedAccountPassword({
        loginId: account.loginId,
        serverBase: account.serverBase,
      });
      if (seq !== passwordFillSeqRef.current) return;
      if (result.ok) {
        setPassword(result.data);
        isPasswordAutoFilledRef.current = true;
      } else {
        setErrorMsg(result.message);
      }
    } finally {
      if (seq === passwordFillSeqRef.current) updatePasswordPending(false);
    }
  }

  async function handleRemoveSavedAccount(account: SavedAccountSummary) {
    if (isHistoryBusyRef.current) return;
    isHistoryBusyRef.current = true;
    try {
      const result = await window.diteng.removeSavedAccount({
        loginId: account.loginId,
        serverBase: account.serverBase,
      });
      if (!result.ok) {
        setErrorMsg(result.message);
        return;
      }
      setSavedAccounts(result.data);
      setIsClearHistoryConfirming(false);
      if (result.data.length === 0) setIsHistoryOpen(false);
    } finally {
      isHistoryBusyRef.current = false;
    }
  }

  async function handleClearSavedAccounts() {
    if (isHistoryBusyRef.current) return;
    if (!isClearHistoryConfirming) {
      clearConfirmAtRef.current = Date.now();
      setIsClearHistoryConfirming(true);
      return;
    }
    // 防止一次物理双击被当成「进入确认 + 确认清空」两次点击：确认态保持一小段时间才接受第二次确认
    if (Date.now() - clearConfirmAtRef.current < 800) return;
    isHistoryBusyRef.current = true;
    try {
      const result = await window.diteng.clearSavedAccounts();
      if (!result.ok) {
        setErrorMsg(result.message);
        return;
      }
      setSavedAccounts(result.data);
      setIsClearHistoryConfirming(false);
      setIsHistoryOpen(false);
    } finally {
      isHistoryBusyRef.current = false;
    }
  }

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 历史密码回填未完成时不允许提交：此时密码可能为空或仍是上一个账号的值
    if (isBusyRef.current || isEntering || isPasswordPendingRef.current) return;
    const id = loginId.trim();
    if (!id) {
      setErrorMsg('请填写账号');
      return;
    }
    // 密码留空按默认 123456 登录（与 web 端 im-client 缺省补 123456 的行为一致）
    const effectivePassword = password || '123456';
    if (mode === 'sms' && !smsCode.trim()) {
      setErrorMsg('请填写短信验证码');
      return;
    }

    isBusyRef.current = true;
    setIsSubmitting(true);
    setErrorMsg('');
    try {
      // 密码登录与设备验证登录共用 auth:login（SvrUserLogin.getToken 同接口，verifyCode 区分）
      const result = await window.diteng.login({
        loginId: id,
        password: effectivePassword,
        rememberPassword: isRememberPassword,
        verifyCode: mode === 'sms' ? smsCode.trim() : undefined,
      });
      if (result.ok) {
        // 账号历史与密码密文由主进程在登录成功时落盘，渲染层不再补写 config
        setIsEntering(true);
        return;
      }
      if (result.code === DEVICE_UNCHECKED_CODE && mode === 'password') {
        // 密码正确但设备未验证：切换短信子表单，沿用当前账号
        setMode('sms');
        setSmsCode('');
        setSmsHint('');
        setErrorMsg('当前设备未验证，请获取短信验证码完成登录');
        return;
      }
      setErrorMsg(result.message);
    } finally {
      isBusyRef.current = false;
      setIsSubmitting(false);
    }
  }

  // 发送短信验证码（SvrUserLogin.getToken verifyCode 指令；发码须先通过密码校验，同网页版）
  async function handleSendSms() {
    if (isBusyRef.current || countdown > 0 || isSendingSms) return;
    const id = loginId.trim();
    if (!id) {
      setErrorMsg('请填写账号');
      return;
    }
    isBusyRef.current = true;
    setIsSendingSms(true);
    setErrorMsg('');
    try {
      const result = await window.diteng.loginSendCode({
        loginId: id,
        password: password || '123456',
      });
      if (result.ok) {
        setCountdown(SMS_RESEND_SECONDS);
        setSmsHint(`${result.data}，请查收短信`);
      } else {
        setSmsHint('');
        setErrorMsg(result.message);
      }
    } finally {
      isBusyRef.current = false;
      setIsSendingSms(false);
    }
  }

  function handleBackToPassword() {
    setMode('password');
    setSmsCode('');
    setSmsHint('');
    setCountdown(0);
    setErrorMsg('');
  }

  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <div className={styles.illustrationPanel} aria-hidden="true">
          <img className={styles.illustration} src={loginIllustration} alt="" draggable={false} />
        </div>
        <div className={styles.formPanel}>
        <div className={styles.formContent}>
        {autoLoginPhase !== 'manual' ? (
          // waiting：自动登录状态页；checking：读 config 判定期（同壳架 + spinner，不带 testid，避免表单闪现）
          <section
            className={styles.autoLoginPanel}
            data-testid={autoLoginPhase === 'waiting' ? 'auto-login-state' : undefined}
          >
            <div className={styles.spinner} aria-hidden="true" />
            {autoLoginPhase === 'waiting' && (
              <>
                <p className={styles.autoLoginTitle}>自动登录中…</p>
                <button
                  type="button"
                  className={styles.outlineButton}
                  data-testid="auto-login-cancel"
                  onClick={() => switchAutoLoginPhase('manual')}
                >
                  手动登录
                </button>
              </>
            )}
          </section>
        ) : isEntering ? (
          <section className={styles.donePanel} role="status">
            <p className={styles.doneTitle}>登录成功</p>
            <p className={styles.hint}>正在打开主界面…</p>
          </section>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <h1 className={styles.formTitle}>登录账号</h1>

            <label className={styles.fieldLabel} htmlFor="login-id">
              账号
            </label>
            <div className={styles.accountField} ref={accountFieldRef}>
              <div className={styles.inputWrap}>
                <input
                  id="login-id"
                  className={styles.input}
                  value={loginId}
                  onChange={(event) => {
                    setLoginId(event.target.value);
                    // 手动输入即退出历史选择，避免输入框与下拉内容不一致；同时作废在途回填
                    setIsHistoryOpen(false);
                    invalidatePasswordFill();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && savedAccounts.length > 0) {
                      event.preventDefault();
                      setIsHistoryOpen(true);
                    }
                    if (event.key === 'Escape') setIsHistoryOpen(false);
                  }}
                  placeholder="账号 / 手机号 / 用户编码"
                  spellCheck={false}
                  autoComplete="username"
                />
                {savedAccounts.length > 0 && (
                  <button
                    type="button"
                    className={styles.historyToggle}
                    data-testid="account-history-toggle"
                    title="历史登录账号"
                    aria-label="历史登录账号"
                    aria-expanded={isHistoryOpen}
                    onClick={() => {
                      setIsClearHistoryConfirming(false);
                      setIsHistoryOpen((open) => !open);
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2.5 4.25L6 7.75l3.5-3.5" />
                    </svg>
                  </button>
                )}
              </div>
              {isHistoryOpen && savedAccounts.length > 0 && (
                <ul className={styles.historyList} data-testid="account-history-list" aria-label="历史登录账号">
                  {savedAccounts.map((account) => (
                    <li key={`${account.serverBase}\n${account.loginId}`} className={styles.historyItem}>
                      <button
                        type="button"
                        className={styles.historyAccount}
                        data-testid="account-history-item"
                        data-account={account.loginId}
                        data-server={account.serverBase}
                        onClick={() => void handleSelectSavedAccount(account)}
                      >
                        <span className={styles.historyAccountId}>{account.loginId}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.historyRemove}
                        data-testid="account-history-remove"
                        title="删除该历史账号"
                        aria-label={`删除历史账号 ${account.loginId}`}
                        onClick={() => void handleRemoveSavedAccount(account)}
                      >
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                        </svg>
                      </button>
                    </li>
                  ))}
                  <li className={styles.historyFooter}>
                    <span className={styles.historyCount}>{savedAccounts.length} 个历史账号</span>
                    <button
                      type="button"
                      className={isClearHistoryConfirming ? styles.historyClearConfirm : styles.historyClear}
                      data-testid="account-history-clear"
                      onClick={() => void handleClearSavedAccounts()}
                    >
                      {isClearHistoryConfirming ? '确认清空？' : '清空'}
                    </button>
                  </li>
                </ul>
              )}
            </div>

            {mode === 'password' && (
              <>
                <label className={styles.fieldLabel} htmlFor="password">
                  密码
                </label>
                <div className={styles.inputWrap}>
                  <input
                    id="password"
                    type="password"
                    className={styles.input}
                    value={password}
                    onChange={(event) => {
                      // 用户手输密码：作废在途回填，之后改账号也不再视为「自动回填」而清空
                      setPassword(event.target.value);
                      passwordFillSeqRef.current += 1;
                      isPasswordAutoFilledRef.current = false;
                      updatePasswordPending(false);
                    }}
                    placeholder="登录密码（留空默认 123456）"
                    autoComplete="current-password"
                  />
                </div>
              </>
            )}

            {mode === 'sms' && (
              <>
                <label className={styles.fieldLabel} htmlFor="sms-code">
                  短信验证码
                </label>
                <div className={styles.codeRow}>
                  <div className={styles.inputWrap}>
                    <input
                      id="sms-code"
                      className={styles.input}
                      value={smsCode}
                      onChange={(event) => setSmsCode(event.target.value)}
                      placeholder="6 位短信验证码"
                      maxLength={6}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                    />
                  </div>
                  <button
                    type="button"
                    className={styles.outlineButton}
                    onClick={() => void handleSendSms()}
                    disabled={countdown > 0 || isSendingSms}
                  >
                    {countdown > 0 ? `${Math.ceil(countdown / 60)}分${countdown % 60}秒` : isSendingSms ? '发送中…' : '发送验证码'}
                  </button>
                </div>
                {smsHint && <p className={styles.hint}>{smsHint}</p>}
              </>
            )}

            {errorMsg && <p className={styles.error} role="alert">{errorMsg}</p>}

            <button type="submit" className={styles.primaryButton} disabled={isSubmitting || isPasswordPending}>
              {isPasswordPending ? '填充密码…' : isSubmitting ? '登录中…' : '登录'}
            </button>

            <div className={styles.formFooter}>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  data-testid="remember-password"
                  checked={isRememberPassword}
                  onChange={(event) => toggleRememberPassword(event.target.checked)}
                />
                记住密码
              </label>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  data-testid="auto-login-checkbox"
                  checked={isAutoLogin}
                  disabled={!isRememberPassword}
                  onChange={(event) => toggleAutoLogin(event.target.checked)}
                />
                自动登录
              </label>
            </div>

            {mode === 'sms' && (
              <div className={styles.footerLinkRow}>
                <button type="button" className={styles.linkButton} onClick={handleBackToPassword}>
                  重新登录
                </button>
              </div>
            )}
          </form>
        )}
        </div>
        </div>
      </main>
    </div>
  );
}
