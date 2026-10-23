import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
// 内部客户端：中文文案直接写死，暂不接入 Lang.as 翻译（后续多语言需求出现再迁移）
import { DEVICE_UNCHECKED_CODE } from '../../shared/types';
import { NotifyPopup } from './NotifyPopup';
import { Shell } from './Shell';
import { useThemeSetting } from './use-theme';
import styles from './App.module.css';

type LoginMode = 'password' | 'sms';

/**
 * 自动登录阶段：
 * - checking：启动读 config 判定是否有已存凭据（只出品牌头，不闪表单）
 * - waiting：自动登录进行中（状态页 + 手动登录入口）
 * - manual：普通表单（无凭据 / 用户取消 / 自动登录失败）
 */
type AutoLoginPhase = 'checking' | 'waiting' | 'manual';

/** 服务器地址下拉预设，datalist 允许自由手输任意地址 */
const SERVER_PRESETS = ['http://127.0.0.1:8101'];

/** 短信验证码重发冷却秒数（服务端 5 分钟冷却，对齐 im-client 登录页） */
const SMS_RESEND_SECONDS = 300;

/**
 * 登录窗与主窗壳共用同一入口页，仅 hash 区分（主进程创建主窗时加载 #/main）。
 * 窗口角色创建后不再变化，直接在渲染时判定，无需监听 hashchange。
 * #/notify-popup 为重要消息置顶弹窗（ImportantNotifier 创建的无边框小窗）。
 */
/** macOS 登录窗隐藏原生红绿灯后需要自绘 ×（与 Shell 的 data-platform 标记无关，此处独立判定） */
const isDarwin = /Mac/i.test(navigator.userAgent);

export function App() {
  if (window.location.hash.startsWith('#/main')) return <Shell />;
  if (window.location.hash.startsWith('#/notify-popup')) return <NotifyPopup />;
  return <LoginPanel />;
}

function LoginPanel() {
  const [serverBase, setServerBase] = useState('');
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
  const [errorMsg, setErrorMsg] = useState('');
  // 登录成功后的过渡态：主进程随即打开主窗并关闭登录窗
  const [isEntering, setIsEntering] = useState(false);
  const [machineCode, setMachineCode] = useState('');
  // 登录页不再提供手动切换入口，主题仍跟随 config.theme / 系统自动应用
  useThemeSetting();

  // 防重守卫：提交/发送处理中，回车与连点共用同一同步闸门
  const isBusyRef = useRef(false);
  // 自动登录只发起一次（StrictMode 双执行防重）
  const isAutoLoginStartedRef = useRef(false);
  // 自动登录阶段同步 ref：迟到结果据此判断用户是否已点「手动登录」（避免闭包旧值）
  const autoLoginPhaseRef = useRef<AutoLoginPhase>('checking');

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
      const config = await window.diteng.getConfig();
      setServerBase(config.serverBase);
      setLoginId(config.savedLoginId);
      setMachineCode(config.machineCode);
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
      // 记住密码✓ 且已存凭据（但未开自动登录）：预填账号与密码，点「登录」即走
      if (config.rememberPassword && config.savedLoginId && config.savedPassword) {
        const credential = await window.diteng.getSavedCredential();
        if (credential.ok) {
          setLoginId(credential.data.loginId);
          setPassword(credential.data.password);
        }
      }
    })();
  }, []);

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

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusyRef.current || isEntering) return;
    const server = serverBase.trim();
    const id = loginId.trim();
    if (!server || !id) {
      setErrorMsg('请填写服务器地址和账号');
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
        serverBase: server,
        loginId: id,
        password: effectivePassword,
        rememberPassword: isRememberPassword,
        verifyCode: mode === 'sms' ? smsCode.trim() : undefined,
      });
      if (result.ok) {
        void window.diteng.setConfig({
          serverBase: server,
          savedLoginId: isRememberPassword ? id : '',
        });
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
    const server = serverBase.trim();
    const id = loginId.trim();
    if (!server || !id) {
      setErrorMsg('请填写服务器地址和账号');
      return;
    }
    isBusyRef.current = true;
    setIsSendingSms(true);
    setErrorMsg('');
    try {
      const result = await window.diteng.loginSendCode({
        serverBase: server,
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
      {/* macOS 登录窗隐藏了原生红绿灯，× 由页面自绘；Windows 保留原生标题栏不渲染此钮 */}
      {isDarwin ? (
        <button
          type="button"
          className={styles.closeButton}
          data-testid="login-close"
          title="关闭"
          aria-label="关闭"
          onClick={() => void window.diteng.closeLoginWindow()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      ) : null}
      <main className={styles.card}>
        {autoLoginPhase !== 'manual' ? (
          // waiting：自动登录状态页；checking：读 config 判定期（同壳架 + spinner，不带 testid，避免表单闪现）
          <section
            className={styles.autoLoginPanel}
            data-testid={autoLoginPhase === 'waiting' ? 'auto-login-state' : undefined}
          >
            <header className={styles.brandRow}>
              <h1 className={styles.brand}>diteng agent</h1>
              <span className={styles.brandTag}>DESKTOP</span>
            </header>
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
          <section className={styles.donePanel}>
            <header className={styles.brandRow}>
              <h1 className={styles.brand}>diteng agent</h1>
              <span className={styles.brandTag}>DESKTOP</span>
            </header>
            <p className={styles.doneTitle}>登录成功</p>
            <p className={styles.hint}>正在打开主界面…</p>
          </section>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <header className={styles.brandRow}>
              <h1 className={styles.brand}>diteng agent</h1>
              <span className={styles.brandTag}>DESKTOP</span>
            </header>

            <label className={styles.fieldLabel} htmlFor="server-base">
              服务器地址
            </label>
            <div className={styles.inputWrap}>
              <input
                id="server-base"
                className={styles.input}
                list="server-presets"
                value={serverBase}
                onChange={(event) => setServerBase(event.target.value)}
                placeholder="http://127.0.0.1:8101"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <datalist id="server-presets">
              {SERVER_PRESETS.map((preset) => (
                <option key={preset} value={preset} />
              ))}
            </datalist>

            <label className={styles.fieldLabel} htmlFor="login-id">
              账号
            </label>
            <div className={styles.inputWrap}>
              <input
                id="login-id"
                className={styles.input}
                value={loginId}
                onChange={(event) => setLoginId(event.target.value)}
                placeholder="账号 / 手机号 / 用户编码"
                spellCheck={false}
                autoComplete="username"
              />
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
                    onChange={(event) => setPassword(event.target.value)}
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

            {errorMsg && <p className={styles.error}>{errorMsg}</p>}

            <button type="submit" className={styles.primaryButton} disabled={isSubmitting}>
              {isSubmitting ? '登录中…' : '登录'}
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

        {machineCode && (
          <footer className={styles.machineFooter}>设备码 {machineCode.slice(0, 8)}…</footer>
        )}
      </main>
    </div>
  );
}
