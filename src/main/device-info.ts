import { execFile } from 'node:child_process';
import { getServers } from 'node:dns';
import { readFile, statfs } from 'node:fs/promises';
import { isIP } from 'node:net';
import { cpus, freemem, hostname, machine, networkInterfaces, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app, net, screen } from 'electron';
import type { ApiCallResult, DeviceInfo } from '../shared/types';

const execute = promisify(execFile);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readHardware(): Promise<Pick<DeviceInfo, 'model' | 'hardwareId' | 'hardwareError'>> {
  try {
    let model = '';
    let hardwareId = '';
    const options = { timeout: 4000, maxBuffer: 128 * 1024, windowsHide: true };
    if (platform() === 'darwin') {
      const { stdout } = await execute('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], options);
      model = stdout.match(/"model"\s*=\s*<"([^"]+)"/i)?.[1] ?? '';
      hardwareId = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/i)?.[1] ?? '';
    } else if (platform() === 'win32') {
      const { stdout } = await execute(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_ComputerSystemProduct | Select-Object Name,UUID | ConvertTo-Json -Compress',
      ], options);
      const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>;
        model = typeof item.Name === 'string' ? item.Name.trim() : '';
        hardwareId = typeof item.UUID === 'string' ? item.UUID.trim() : '';
      }
    } else {
      const results = await Promise.allSettled([
        readFile('/sys/class/dmi/id/product_name', 'utf8'),
        readFile('/sys/class/dmi/id/product_uuid', 'utf8'),
      ]);
      model = results[0].status === 'fulfilled' ? results[0].value.trim() : '';
      hardwareId = results[1].status === 'fulfilled' ? results[1].value.trim() : '';
    }
    const isValidId = UUID_PATTERN.test(hardwareId) && !/^(0|-)+$/.test(hardwareId) && !/^(f|-)+$/i.test(hardwareId);
    return { model: model || null, hardwareId: isValidId ? hardwareId : null, hardwareError: isValidId ? '' : '系统未提供可用的硬件 UUID' };
  } catch {
    return { model: null, hardwareId: null, hardwareError: '无法读取硬件 UUID，请检查系统权限后刷新' };
  }
}

/** 仅在用户打开或刷新信息页时采集，不把设备信息发送到网络。 */
export async function getDeviceInfo(clientId: string): Promise<DeviceInfo> {
  const [hardware, storageResult] = await Promise.allSettled([
    readHardware(),
    statfs(app.getPath('home')),
  ]);
  const processors = cpus();
  const primaryId = screen.getPrimaryDisplay().id;
  return {
    hostname: hostname(),
    ...(hardware.status === 'fulfilled' ? hardware.value : { model: null, hardwareId: null, hardwareError: '无法读取硬件信息，请刷新重试' }),
    clientId,
    system: `${platform() === 'darwin' ? 'macOS' : platform() === 'win32' ? 'Windows' : 'Linux'} ${process.getSystemVersion()}`,
    architecture: machine(),
    cpu: processors[0]?.model.trim() || '系统未提供',
    cpuCores: processors.length,
    memoryTotal: totalmem(),
    memoryFree: freemem(),
    storage: storageResult.status === 'fulfilled' ? {
      total: storageResult.value.blocks * storageResult.value.bsize,
      available: storageResult.value.bavail * storageResult.value.bsize,
    } : null,
    storageError: storageResult.status === 'fulfilled' ? '' : '无法读取用户目录所在磁盘的容量',
    displays: screen.getAllDisplays().map(display => ({
      name: display.label || `显示器 ${display.id}`,
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      scaleFactor: display.scaleFactor,
      isPrimary: display.id === primaryId,
    })),
    networks: Object.entries(networkInterfaces()).flatMap(([name, entries]) => {
      const addresses = (entries ?? []).filter(entry => !entry.internal);
      if (!addresses.length) return [];
      return [{ name, mac: addresses.find(entry => entry.mac !== '00:00:00:00:00:00')?.mac ?? '',
        addresses: addresses.map(({ address, family, netmask }) => ({ address, family, netmask })) }];
    }),
    dnsServers: getServers(),
    appVersion: app.getVersion(),
  };
}

let publicIpRequest: Promise<ApiCallResult<string>> | null = null;

/** 使用 Chromium 网络栈，出口与客户端代理设置一致；不携带会话、CLIENTID 或硬件信息。 */
export function getPublicIp(): Promise<ApiCallResult<string>> {
  if (publicIpRequest) return publicIpRequest;
  publicIpRequest = (async (): Promise<ApiCallResult<string>> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await net.fetch('https://api64.ipify.org', {
        signal: controller.signal, credentials: 'omit', headers: { 'Cache-Control': 'no-cache' }, redirect: 'error',
      });
      if (!response.ok || !response.body) throw new Error('无法查询公网 IP');
      const reader = response.body.getReader();
      let value = '';
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          value += new TextDecoder().decode(chunk);
          if (value.length > 64) throw new Error('公网 IP 响应无效');
        }
      } finally { await reader.cancel(); }
      const ip = value.trim();
      if (!isIP(ip)) throw new Error('公网 IP 响应无效');
      return { ok: true, data: ip };
    } catch {
      return { ok: false, code: -1, message: '获取失败，请检查网络后刷新' };
    } finally {
      clearTimeout(timeout);
      publicIpRequest = null;
    }
  })();
  return publicIpRequest;
}
