import { useEffect, useRef, useState } from 'react';
import type { DeviceInfo as DeviceInfoData } from '../../shared/types';
import { CheckIcon, CopyIcon, ReloadIcon } from './theme-icons';
import styles from './DeviceInfo.module.css';

function bytes(value: number): string {
  return `${(value / 1024 ** 3).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} GB`;
}

export function DeviceInfo() {
  const [info, setInfo] = useState<DeviceInfoData | null>(null);
  const [error, setError] = useState('');
  const [publicIp, setPublicIp] = useState('');
  const [ipError, setIpError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isIpLoading, setIsIpLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const isRefreshingRef = useRef(true);
  const isCopyingRef = useRef(false);
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');

  useEffect(() => {
    let isActive = true;
    isRefreshingRef.current = true;
    setIsLoading(true);
    setIsIpLoading(true);
    setError('');
    setIpError('');
    setPublicIp('');
    setCopied('');
    setCopyError('');
    const local = window.diteng.getDeviceInfo().then(value => {
      if (isActive) setInfo(value);
    }).catch(() => {
      if (isActive) { setInfo(null); setError('无法读取本机信息，请刷新重试'); }
    }).finally(() => { if (isActive) setIsLoading(false); });
    const network = window.diteng.getPublicIp().then(result => {
      if (!isActive) return;
      if (result.ok) setPublicIp(result.data);
      else setIpError(result.message);
    }).catch(() => {
      if (isActive) setIpError('获取失败，请检查网络后刷新');
    }).finally(() => { if (isActive) setIsIpLoading(false); });
    void Promise.allSettled([local, network]).then(() => { if (isActive) isRefreshingRef.current = false; });
    return () => { isActive = false; };
  }, [refreshVersion]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(''), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const sections: { title: string; rows: { label: string; value: string; isUnavailable?: boolean }[] }[] = info ? [
    { title: '设备标识', rows: [
      { label: '电脑名称', value: info.hostname },
      { label: '硬件码（UUID）', value: info.hardwareId || info.hardwareError, isUnavailable: !info.hardwareId },
      { label: '设备码（CLIENTID）', value: info.clientId },
    ] },
    { title: '硬件系统', rows: [
      { label: '设备型号', value: info.model || '系统未提供', isUnavailable: !info.model },
      { label: '操作系统', value: info.system },
      { label: '系统架构', value: info.architecture },
      { label: '处理器', value: `${info.cpu} · ${info.cpuCores} 个逻辑核心` },
      { label: '内存容量', value: `${bytes(info.memoryTotal)} · 空闲 ${bytes(info.memoryFree)}` },
      { label: '磁盘空间', value: info.storage ? `${bytes(info.storage.total)} · 可用 ${bytes(info.storage.available)}` : info.storageError, isUnavailable: !info.storage },
      ...info.displays.map((display, index) => ({ label: display.isPrimary ? '主显示器' : `显示器 ${index + 1}`, value: `${display.name} · ${display.width} × ${display.height} · ${display.scaleFactor * 100}%` })),
    ] },
  ] : [];
  sections.push({ title: '网络信息', rows: [
    { label: '公网地址', value: isIpLoading ? '正在获取…' : publicIp || ipError, isUnavailable: !publicIp },
    ...(info ? [{ label: 'DNS 服务', value: info.dnsServers.join('\n') || '系统未提供', isUnavailable: !info.dnsServers.length }] : []),
    ...(info?.networks.map(network => ({ label: network.name, value: [
      ...network.addresses.map(address => `${address.family}  ${address.address}\n子网掩码  ${address.netmask}`),
      ...(network.mac ? [`MAC  ${network.mac}`] : []),
    ].join('\n') })) ?? []),
    ...(info && !info.networks.length ? [{ label: '网络接口', value: '未检测到活动的网络接口', isUnavailable: true }] : []),
  ] });

  async function copy(key: string, value: string) {
    if (isCopyingRef.current) return;
    isCopyingRef.current = true;
    setCopyError('');
    try { await navigator.clipboard.writeText(value); setCopied(key); }
    catch { setCopyError('复制失败，请重试或手动选择内容复制'); }
    finally { isCopyingRef.current = false; }
  }

  // 设置页「关于应用」分类的本机信息部分：分类标题由设置页页头提供，这里只保留操作行与信息卡片
  return <div className={styles.wrap} data-testid="device-info" aria-label="本机信息">
    <div className={styles.actions}>
      <button type="button" data-testid="device-copy-all" disabled={!info || isLoading || isIpLoading}
        onClick={() => void copy('all', sections.map(section => `${section.title}\n${section.rows.map(row => `${row.label}：${row.value}`).join('\n')}`).join('\n\n'))}>
        {copied === 'all' ? <CheckIcon /> : <CopyIcon />}<span>{copied === 'all' ? '已复制' : '复制全部'}</span>
      </button>
      <button type="button" data-testid="device-refresh" disabled={isLoading || isIpLoading} onClick={() => {
        if (isRefreshingRef.current) return;
        isRefreshingRef.current = true;
        setIsLoading(true);
        setIsIpLoading(true);
        setRefreshVersion(value => value + 1);
      }}><ReloadIcon /><span>{isLoading || isIpLoading ? '刷新中…' : '刷新数据'}</span></button>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {isLoading && !info && <p className={styles.status} role="status">正在读取本机信息…</p>}
    {copyError && <p className={styles.error} role="alert">{copyError}</p>}
    <span className={styles.srOnly} role="status">{copied ? '已复制到剪贴板' : ''}</span>
    {sections.map(section => <section className={styles.section} key={section.title}>
      <h2>{section.title}</h2>
      {section.title === '网络信息' && <p className={styles.note}>公网地址为当前网络出口地址，使用代理或 VPN 时可能不同；连接质量检测见「连接设置 · 网络检测」。</p>}
      <dl>{section.rows.map(row => {
        const key = `${section.title}-${row.label}`;
        return <div className={styles.row} key={key}>
          <dt>{row.label}</dt>
          <dd data-unavailable={row.isUnavailable || undefined} data-testid={row.label === '设备码（CLIENTID）' ? 'device-client-id' : row.label === '公网 IP' ? 'device-public-ip' : row.label === '硬件码（UUID）' ? 'device-hardware-id' : undefined}>{row.value}</dd>
          <button type="button" className={styles.copy} aria-label={`复制${row.label}`} title={copied === key ? '已复制' : `复制${row.label}`} disabled={row.isUnavailable}
            onClick={() => void copy(key, row.value)}>{copied === key ? <CheckIcon /> : <CopyIcon />}</button>
        </div>;
      })}</dl>
    </section>)}
  </div>;
}
