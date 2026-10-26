import { gt, lt, valid } from 'semver';
import type { AppUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/types';

export interface UpdatePolicy { version: string; minimumVersion: string; }

/** 同一份发布元数据同时决定可更新版本与最低版本，拒绝无效或矛盾的策略。 */
export function parseUpdatePolicy(input: unknown): UpdatePolicy {
  const policy = input as { version?: unknown; minimumVersion?: unknown } | null;
  if (typeof policy?.version !== 'string' || !valid(policy.version)
    || typeof policy.minimumVersion !== 'string' || !valid(policy.minimumVersion)
    || gt(policy.minimumVersion, policy.version)) throw new Error('更新源的版本或最低版本配置无效');
  return { version: policy.version, minimumVersion: policy.minimumVersion };
}

interface UpdateHooks {
  currentVersion: string;
  disabledReason: string;
  updater: Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'allowDowngrade' | 'allowPrerelease' | 'on' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'>;
  readPreferences(): { autoCheckUpdates: boolean; autoDownloadUpdates: boolean };
  readPolicy(): unknown;
  savePolicy(policy: UpdatePolicy): void;
  onChanged(state: UpdateState): void;
  prepareInstall(): Promise<boolean>;
  checkIntervalMs?: number;
  checkTimeoutMs?: number;
}

/** 托盘、设置与启动检查共用状态和同步闸门；下载后只在明确确认时安装。 */
export class UpdateService {
  private state: UpdateState;
  private operation: Promise<UpdateState> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialCheck: Promise<UpdateState> | null = null;
  private isInstalling = false;

  constructor(private readonly hooks: UpdateHooks) {
    this.state = { status: hooks.disabledReason ? 'disabled' : 'idle', currentVersion: hooks.currentVersion,
      latestVersion: '', minimumVersion: '', isRequired: false, progress: 0, checkedAt: null,
      error: hooks.disabledReason, isManual: false };
    if (!valid(hooks.currentVersion)) throw new Error('当前客户端版本号无效');
    try {
      const policy = hooks.disabledReason ? null : hooks.readPolicy();
      if (policy) this.applyPolicy(parseUpdatePolicy(policy));
    } catch (error) { console.warn('[update] 无法读取已缓存的版本策略', error); }
    hooks.updater.autoDownload = false;
    hooks.updater.autoInstallOnAppQuit = false;
    hooks.updater.allowDowngrade = false;
    hooks.updater.allowPrerelease = false;
    hooks.updater.on('error', () => {
      // 检查/下载由各自的 Promise 处理；安装错误仅由事件报告。
      if (this.isInstalling) {
        this.isInstalling = false;
        this.change({ status: 'error', error: '更新安装失败，请重试或使用新版安装包' });
      }
    });
    hooks.updater.on('download-progress', info => {
      if (this.state.status === 'downloading' && Number.isFinite(info.percent)) {
        this.change({ progress: Math.max(0, Math.min(100, info.percent)) });
      }
    });
  }

  getState(): UpdateState { return { ...this.state }; }

  start(): void {
    if (this.hooks.disabledReason || this.timer) return;
    if (this.hooks.readPreferences().autoCheckUpdates) this.initialCheck = this.check();
    this.timer = setInterval(() => {
      if (this.hooks.readPreferences().autoCheckUpdates) void this.check();
    }, this.hooks.checkIntervalMs ?? 6 * 60 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async isCompatible(): Promise<boolean> {
    await this.initialCheck;
    return !this.state.isRequired;
  }

  check(isManual = false): Promise<UpdateState> {
    if (isManual) this.change({ isManual: true });
    if (this.hooks.disabledReason) return Promise.resolve(this.getState());
    if (this.operation) return this.operation;
    if (['downloading', 'downloaded', 'installing'].includes(this.state.status)) return Promise.resolve(this.getState());
    this.change({ status: 'checking', error: '', isManual });
    this.operation = this.performCheck().finally(() => { this.operation = null; });
    return this.operation;
  }

  private async performCheck(): Promise<UpdateState> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let isDownload = false;
    try {
      const result = await Promise.race([
        this.hooks.updater.checkForUpdates(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('检查更新超时')), this.hooks.checkTimeoutMs ?? 20_000);
        }),
      ]);
      if (!result) throw new Error('无法读取更新源');
      const policy = parseUpdatePolicy(result.updateInfo);
      // 不允许较旧的发布源清除本机已经获知的强制更新要求。
      if (!this.state.minimumVersion || !lt(policy.minimumVersion, this.state.minimumVersion)) {
        this.applyPolicy(policy);
        this.hooks.savePolicy(policy);
      }
      if (this.state.minimumVersion && lt(policy.version, this.state.minimumVersion)) throw new Error('更新源的版本低于已知最低版本');
      const isNewer = gt(policy.version, this.hooks.currentVersion);
      if (isNewer && !result.isUpdateAvailable) {
        this.change({ status: 'error', error: '新版本不适用于当前系统，请检查操作系统版本要求', checkedAt: Date.now() });
        return this.getState();
      }
      this.change({ status: isNewer ? 'available' : 'latest', checkedAt: Date.now(), progress: 0 });
      isDownload = isNewer && this.hooks.readPreferences().autoDownloadUpdates;
    } catch (error) {
      console.warn('[update] 检查失败', error);
      this.change({ status: 'error', error: '检查更新失败，请检查网络或稍后重试' });
    } finally { if (timeout) clearTimeout(timeout); }
    // 认证只等待策略检查；后台下载不能阻塞仍受支持的客户端登录。
    if (isDownload) setImmediate(() => { void this.download(); });
    return this.getState();
  }

  download(): Promise<UpdateState> {
    if (this.operation) return this.operation;
    if (this.state.status !== 'available') return Promise.resolve(this.getState());
    this.operation = this.performDownload().finally(() => { this.operation = null; });
    return this.operation;
  }

  private async performDownload(): Promise<UpdateState> {
    this.change({ status: 'downloading', progress: 0, error: '' });
    try {
      const files = await this.hooks.updater.downloadUpdate();
      if (!files.length) throw new Error('没有可安装的更新文件');
      this.change({ status: 'downloaded', progress: 100 });
    } catch (error) {
      console.warn('[update] 下载失败', error);
      this.change({ status: 'error', error: '更新下载失败，请重新检查更新后重试' });
    }
    return this.getState();
  }

  async install(): Promise<UpdateState> {
    if (this.isInstalling || this.state.status !== 'downloaded') return this.getState();
    this.isInstalling = true;
    try {
      if (!(await this.hooks.prepareInstall())) return this.getState();
      this.change({ status: 'installing', error: '' });
      this.hooks.updater.quitAndInstall(false, true);
    } catch (error) {
      console.warn('[update] 安装失败', error);
      this.change({ status: 'error', error: '更新安装失败，请重试或使用新版安装包' });
    } finally { if (this.getState().status !== 'installing') this.isInstalling = false; }
    return this.getState();
  }

  private applyPolicy(policy: UpdatePolicy): void {
    Object.assign(this.state, { latestVersion: policy.version, minimumVersion: policy.minimumVersion,
      isRequired: lt(this.hooks.currentVersion, policy.minimumVersion) });
  }

  private change(patch: Partial<UpdateState>): void {
    Object.assign(this.state, patch);
    this.hooks.onChanged(this.getState());
  }
}
