/**
 * 一键反馈：打开/前置微信、企业微信。
 *
 * 只负责「启动或前置应用」，不选择会话、不模拟粘贴——复制与提示由渲染层完成。
 * 参数全部是固定常量（Bundle ID / 协议 / 常见安装路径），不拼接用户输入。
 * macOS 优先 `open -b <bundleId>`（不依赖安装路径，兼容改名与自定义安装），失败回退
 * /Applications 下的常见 .app 包；Windows 优先协议唤醒（应用已运行时还能直接前置窗口），
 * 失败回退常见安装目录下的 exe。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { shell } from 'electron';
import type { ApiFailure, FeedbackChatApp } from '../shared/types';

/** 应用展示名（日志与失败文案共用） */
const APP_LABELS: Record<FeedbackChatApp, string> = {
  wechat: '微信',
  wecom: '企业微信',
};

/** macOS Bundle ID：微信 / 企业微信（WXWork） */
const MAC_BUNDLE_IDS: Record<FeedbackChatApp, string> = {
  wechat: 'com.tencent.xinWeChat',
  wecom: 'com.tencent.WeWorkMac',
};

/** macOS 常见安装路径（Bundle ID 打开失败时兜底） */
const MAC_APP_PATHS: Record<FeedbackChatApp, string[]> = {
  wechat: ['/Applications/WeChat.app', '/Applications/微信.app'],
  wecom: ['/Applications/WXWork.app', '/Applications/企业微信.app'],
};

/** Windows 协议：微信 / 企业微信 */
const WINDOWS_PROTOCOLS: Record<FeedbackChatApp, string> = {
  wechat: 'weixin://',
  wecom: 'wxwork://',
};

/** Windows 常见安装相对路径（拼接在 ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA 下） */
const WINDOWS_INSTALL_PATHS: Record<FeedbackChatApp, string[]> = {
  wechat: ['Tencent\\Weixin\\Weixin.exe', 'Tencent\\WeChat\\WeChat.exe'],
  wecom: ['Tencent\\WXWork\\WXWork.exe', 'WXWork\\WXWork.exe'],
};

/** 本地失败结果：与主进程 invalid 约定一致（code -1 + 中文文案） */
function invalid(message: string): ApiFailure {
  return { ok: false, code: -1, message };
}

/** 未找到应用时的统一失败文案 */
function missingAppFailure(app: FeedbackChatApp): ApiFailure {
  return invalid(`未找到${APP_LABELS[app]}，请先安装后重试`);
}

/** execFile 回调 API 转 Promise：成功 resolve，失败 reject 原始错误 */
function execOpen(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', args, { timeout: 5000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** macOS：优先 Bundle ID 启动，失败回退常见 .app 包路径 */
async function openOnMac(app: FeedbackChatApp): Promise<ApiFailure | null> {
  const label = APP_LABELS[app];
  const bundleId = MAC_BUNDLE_IDS[app];
  try {
    await execOpen(['-b', bundleId]);
    console.log(`[feedback] 已按 Bundle ID 启动${label}：${bundleId}`);
    return null;
  } catch (error) {
    console.warn(`[feedback] 按 Bundle ID 启动${label}失败，回退安装路径：`, error);
  }
  for (const appPath of MAC_APP_PATHS[app]) {
    if (!existsSync(appPath)) continue;
    try {
      await execOpen([appPath]);
      console.log(`[feedback] 已按安装路径启动${label}：${appPath}`);
      return null;
    } catch (error) {
      console.warn(`[feedback] 按安装路径启动${label}失败：${appPath}`, error);
    }
  }
  console.warn(`[feedback] 启动${label}失败：Bundle ID ${bundleId} 与常见安装路径均不可用`);
  return missingAppFailure(app);
}

/** 展开 Windows 常见安装目录下的 exe 绝对路径（目录不存在时跳过） */
function windowsInstallCandidates(app: FeedbackChatApp): string[] {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  const candidates: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    for (const relativePath of WINDOWS_INSTALL_PATHS[app]) candidates.push(join(root, relativePath));
  }
  return candidates;
}

/** Windows：优先协议唤醒，失败回退常见安装路径的 exe（openPath 返回空串表示成功） */
async function openOnWindows(app: FeedbackChatApp): Promise<ApiFailure | null> {
  const label = APP_LABELS[app];
  const protocol = WINDOWS_PROTOCOLS[app];
  try {
    await shell.openExternal(protocol);
    console.log(`[feedback] 已按协议启动${label}：${protocol}`);
    return null;
  } catch (error) {
    console.warn(`[feedback] 按协议启动${label}失败，回退安装路径：`, error);
  }
  for (const exePath of windowsInstallCandidates(app)) {
    if (!existsSync(exePath)) continue;
    const openError = await shell.openPath(exePath);
    if (!openError) {
      console.log(`[feedback] 已按安装路径启动${label}：${exePath}`);
      return null;
    }
    console.warn(`[feedback] 按安装路径启动${label}失败：${exePath}，${openError}`);
  }
  console.warn(`[feedback] 启动${label}失败：协议 ${protocol} 与常见安装路径均不可用`);
  return missingAppFailure(app);
}

/**
 * 打开/前置微信或企业微信；成功返回 null，失败返回中文 ApiFailure。
 * 成功只表示已发起启动/前置，不保证应用已登录或聊天窗口已打开。
 */
export async function openFeedbackChatApp(app: FeedbackChatApp): Promise<ApiFailure | null> {
  if (process.platform === 'darwin') return openOnMac(app);
  if (process.platform === 'win32') return openOnWindows(app);
  console.warn(`[feedback] 当前系统不支持启动${APP_LABELS[app]}：${process.platform}`);
  return invalid('当前系统暂不支持启动微信/企业微信');
}
