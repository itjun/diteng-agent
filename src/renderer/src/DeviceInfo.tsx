import { useEffect, useRef, useState } from 'react';
import { DesktopIcon } from '@radix-ui/react-icons';
import { NETWORK_GRADE_LABELS } from '../../shared/types';
import type { DeviceInfo as DeviceInfoData, NetworkDiagnosticsState, NetworkDiagnosticsTargetStat } from '../../shared/types';
import { CheckIcon, CopyIcon, ReloadIcon } from './theme-icons';
import styles from './DeviceInfo.module.css';

function bytes(value: number): string {
  return `${(value / 1024 ** 3).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} GB`;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function kilobytes(value: number): string {
  return `${(value / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB`;
}

/** 链路分解/目标行的时间展示：null 表示该段失败 */
function phaseMs(value: number | null): string {
  return value === null ? '失败' : `${value} ms`;
}

function targetSummary(target: NetworkDiagnosticsTargetStat): string {
  if (target.skipped) return '跳过（本地服务，不计入检测）';
  const parts = [
    target.completed === 0 ? '等待中' : `成功 ${target.success}/${target.total}`,
    target.medianMs === null ? null : `中位 ${target.medianMs} ms`,
    target.jitterMs === null ? null : `抖动 ±${target.jitterMs} ms`,
    target.documentMs === null || target.documentBytes === null ? null : `文档 ${target.documentMs} ms / ${kilobytes(target.documentBytes)}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** 复制全部时的网络检测纯文本汇总（与页面展示同源） */
function diagnosticsText(state: NetworkDiagnosticsState): string {
  const lines = state.targets.map(target =>
    `${target.label}（${hostOf(target.url)}）：${targetSummary(target)}${target.skipped ? '' : ` · ${NETWORK_GRADE_LABELS[target.grade]}`}`);
  const phases = state.phases
    ? `链路分解：DNS ${phaseMs(state.phases.dnsMs)} · TCP ${phaseMs(state.phases.tcpMs)} · TLS ${state.phases.tlsMs === null ? '—' : phaseMs(state.phases.tlsMs)}${state.phases.error ? `（${state.phases.error}）` : ''}`
    : '';
  return ['网络检测' + (state.overall ? `：${state.overall.summary}（${state.overall.advice}）` : ''), phases, ...lines]
    .filter(Boolean).join('\n');
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
  // 网络检测：主进程保留最近状态，这里订阅推流（页面切回时恢复上次结果）
  const [diagnostics, setDiagnostics] = useState<NetworkDiagnosticsState | null>(null);
  const [isDiagStarting, setIsDiagStarting] = useState(false);

  useEffect(() => {
    let isActive = true;
    void window.diteng.getNetworkDiagnostics().then(state => { if (isActive) setDiagnostics(state); }).catch(() => {});
    const unsubscribe = window.diteng.onNetworkDiagnosticsChanged(state => { if (isActive) setDiagnostics(state); });
    return () => { isActive = false; unsubscribe(); };
  }, []);

  const isDiagRunning = diagnostics?.status === 'running' || isDiagStarting;

  async function startDiagnostics() {
    if (isDiagRunning) return;
    setIsDiagStarting(true);
    try {
      // 失败（已在检测中）也无妨：进度与结果统一经 onNetworkDiagnosticsChanged 推流
      await window.diteng.startNetworkDiagnostics();
    } finally {
      setIsDiagStarting(false);
    }
  }

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
    { title: '硬件与系统', rows: [
      { label: '设备型号', value: info.model || '系统未提供', isUnavailable: !info.model },
      { label: '操作系统', value: info.system },
      { label: '架构', value: info.architecture },
      { label: '处理器', value: `${info.cpu} · ${info.cpuCores} 个逻辑核心` },
      { label: '内存', value: `${bytes(info.memoryTotal)} · 空闲 ${bytes(info.memoryFree)}` },
      { label: '用户目录磁盘', value: info.storage ? `${bytes(info.storage.total)} · 可用 ${bytes(info.storage.available)}` : info.storageError, isUnavailable: !info.storage },
      ...info.displays.map((display, index) => ({ label: display.isPrimary ? '主显示器' : `显示器 ${index + 1}`, value: `${display.name} · ${display.width} × ${display.height} · ${display.scaleFactor * 100}%` })),
      { label: '客户端版本', value: info.appVersion },
    ] },
  ] : [];
  sections.push({ title: '网络', rows: [
    { label: '公网 IP', value: isIpLoading ? '正在获取…' : publicIp || ipError, isUnavailable: !publicIp },
    ...(info ? [{ label: 'DNS', value: info.dnsServers.join('\n') || '系统未提供', isUnavailable: !info.dnsServers.length }] : []),
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

  return <section className={styles.page} data-testid="device-info" aria-label="本机信息">
    <div className={styles.content}>
      <header className={styles.header}>
        <div className={styles.heading}><DesktopIcon width={28} height={28} /><h1>本机信息</h1></div>
        <div className={styles.actions}>
          <button type="button" data-testid="device-copy-all" disabled={!info || isLoading || isIpLoading}
            onClick={() => void copy('all', [
              ...sections.map(section => `${section.title}\n${section.rows.map(row => `${row.label}：${row.value}`).join('\n')}`),
              ...(diagnostics?.status === 'done' ? [diagnosticsText(diagnostics)] : []),
            ].join('\n\n'))}>
            {copied === 'all' ? <CheckIcon /> : <CopyIcon />}<span>{copied === 'all' ? '已复制' : '复制全部'}</span>
          </button>
          <button type="button" data-testid="device-refresh" disabled={isLoading || isIpLoading} onClick={() => {
            if (isRefreshingRef.current) return;
            isRefreshingRef.current = true;
            setIsLoading(true);
            setIsIpLoading(true);
            setRefreshVersion(value => value + 1);
          }}><ReloadIcon /><span>{isLoading || isIpLoading ? '刷新中…' : '刷新'}</span></button>
        </div>
      </header>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {isLoading && !info && <p className={styles.status} role="status">正在读取本机信息…</p>}
      {copyError && <p className={styles.error} role="alert">{copyError}</p>}
      <span className={styles.srOnly} role="status">{copied ? '已复制到剪贴板' : ''}</span>
      {sections.map(section => <section className={styles.section} key={section.title}>
        <h2>{section.title}</h2>
        {section.title === '网络' && <NetworkDiagnosticsCard diagnostics={diagnostics} isRunning={isDiagRunning} onStart={() => void startDiagnostics()} />}
        {section.title === '网络' && <p className={styles.note}>公网 IP 为当前网络出口地址，使用代理或 VPN 时可能不同。</p>}
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
    </div>
  </section>;
}

/**
 * 网络检测卡片：外网基线 + 前端站点 + 后端接口 + AI 站点并发探测，
 * 逐探针展示进度；结论评级取前端/后端较差者，链路分解定位慢在哪一段。
 */
function NetworkDiagnosticsCard({ diagnostics, isRunning, onStart }: {
  diagnostics: NetworkDiagnosticsState | null;
  isRunning: boolean;
  onStart: () => void;
}) {
  const overall = diagnostics?.status === 'done' ? diagnostics.overall : null;
  return <div className={styles.diag} data-testid="network-diagnostics">
    <div className={styles.diagHeader}>
      <span className={styles.diagTitle}>网络检测</span>
      <span className={styles.diagProgress} role="status" data-testid="network-diagnostics-progress">
        {diagnostics?.status === 'running'
          ? `检测中 ${diagnostics.completedProbes}/${diagnostics.totalProbes}…`
          : overall ? overall.summary : '评估当前网络与服务器连接的稳定性（约 10 秒）'}
      </span>
      <button type="button" className={styles.diagStart} data-testid="network-diagnostics-start" disabled={isRunning} onClick={onStart}>
        {isRunning ? '检测中…' : overall ? '重新检测' : '开始检测'}
      </button>
    </div>
    {overall && <p className={styles.diagVerdict}>
      <span className={styles.diagBadge} data-grade={overall.grade}>{NETWORK_GRADE_LABELS[overall.grade]}</span>
      {overall.advice}
    </p>}
    {diagnostics?.phases && <p className={styles.diagPhases}>
      链路分解：DNS {phaseMs(diagnostics.phases.dnsMs)} · TCP {phaseMs(diagnostics.phases.tcpMs)} · TLS {diagnostics.phases.tlsMs === null ? '—' : phaseMs(diagnostics.phases.tlsMs)}
      {diagnostics.phases.error && `（${diagnostics.phases.error}）`}
    </p>}
    {diagnostics && <ul className={styles.diagTargets}>
      {diagnostics.targets.map(target => <li className={styles.diagTarget} key={target.key} data-testid="network-diagnostics-target">
        <span className={styles.diagName}>{target.label}<small>{hostOf(target.url)}</small></span>
        <span className={styles.diagStats}>{targetSummary(target)}</span>
        <span className={styles.diagBadge} data-grade={target.grade}>
          {target.skipped || (diagnostics.status === 'running' && target.completed === 0) ? '—' : NETWORK_GRADE_LABELS[target.grade]}
        </span>
      </li>)}
    </ul>}
  </div>;
}
