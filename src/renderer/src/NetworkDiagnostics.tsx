import { useEffect, useRef, useState } from 'react';
import { NETWORK_GRADE_LABELS } from '../../shared/types';
import type { NetworkDiagnosticsState, NetworkDiagnosticsTargetStat } from '../../shared/types';
import { CheckIcon, CopyIcon } from './theme-icons';
import styles from './NetworkDiagnostics.module.css';

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
    target.completed === 0 ? '等待检测' : `成功 ${target.success}/${target.total}`,
    target.medianMs === null ? null : `中位 ${target.medianMs} ms`,
    target.jitterMs === null ? null : `抖动 ±${target.jitterMs} ms`,
    target.documentMs === null || target.documentBytes === null ? null : `文档 ${target.documentMs} ms / ${kilobytes(target.documentBytes)}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

/** 复制结果时的网络检测纯文本汇总（与页面展示同源） */
function diagnosticsText(state: NetworkDiagnosticsState): string {
  const lines = state.targets.map(target =>
    `${target.label}（${hostOf(target.url)}）：${targetSummary(target)}${target.skipped ? '' : ` · ${NETWORK_GRADE_LABELS[target.grade]}`}`);
  const phases = state.phases
    ? `链路分解：DNS ${phaseMs(state.phases.dnsMs)} · TCP ${phaseMs(state.phases.tcpMs)} · TLS ${state.phases.tlsMs === null ? '—' : phaseMs(state.phases.tlsMs)}${state.phases.error ? `（${state.phases.error}）` : ''}`
    : '';
  return ['网络检测' + (state.overall ? `：${state.overall.summary}（${state.overall.advice}）` : ''), phases, ...lines]
    .filter(Boolean).join('\n');
}

/**
 * 设置页「网络检测」分类内容：外网基线 + 前端站点 + 后端接口 + AI 站点并发探测，
 * 逐探针展示进度；结论评级取前端/后端较差者，链路分解定位慢在哪一段。
 * 主进程保留最近状态（页面切走再切回不丢结果），进度与结果统一经推流刷新。
 */
export function NetworkDiagnostics() {
  const [diagnostics, setDiagnostics] = useState<NetworkDiagnosticsState | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const isCopyingRef = useRef(false);

  useEffect(() => {
    let isActive = true;
    void window.diteng.getNetworkDiagnostics().then(state => { if (isActive) setDiagnostics(state); }).catch(() => {});
    const unsubscribe = window.diteng.onNetworkDiagnosticsChanged(state => { if (isActive) setDiagnostics(state); });
    return () => { isActive = false; unsubscribe(); };
  }, []);

  const isRunning = diagnostics?.status === 'running' || isStarting;

  async function start() {
    if (isRunning) return;
    setIsStarting(true);
    try {
      // 失败（已在检测中）也无妨：进度与结果统一经 onNetworkDiagnosticsChanged 推流
      await window.diteng.startNetworkDiagnostics();
    } finally {
      setIsStarting(false);
    }
  }

  async function copyResult() {
    if (isCopyingRef.current || !diagnostics) return;
    isCopyingRef.current = true;
    setCopyError('');
    try { await navigator.clipboard.writeText(diagnosticsText(diagnostics)); setCopied(true); }
    catch { setCopyError('复制失败，请重试或手动选择内容复制'); }
    finally { isCopyingRef.current = false; }
  }

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return <div className={styles.wrap} data-testid="network-diagnostics-page" aria-label="网络检测">
    <div className={styles.actions}>
      <button type="button" data-testid="network-diagnostics-copy" disabled={!diagnostics || diagnostics.status !== 'done'} onClick={() => void copyResult()}>
        {copied ? <CheckIcon /> : <CopyIcon />}<span>{copied ? '已复制' : '复制结果'}</span>
      </button>
    </div>
    {copyError && <p className={styles.error} role="alert">{copyError}</p>}
    <span className={styles.srOnly} role="status">{copied ? '已复制到剪贴板' : ''}</span>
    <div className={styles.diag} data-testid="network-diagnostics">
      <div className={styles.diagHeader}>
        <span className={styles.diagProgress} role="status" data-testid="network-diagnostics-progress">
          {diagnostics?.status === 'running'
            ? `检测中 ${diagnostics.completedProbes}/${diagnostics.totalProbes}…`
            : diagnostics?.status === 'done' && diagnostics.overall ? diagnostics.overall.summary : '评估当前网络与服务器连接的稳定性（约 10 秒）'}
        </span>
        <button type="button" className={styles.diagStart} data-testid="network-diagnostics-start" disabled={isRunning} onClick={() => void start()}>
          {isRunning ? '检测中…' : diagnostics?.status === 'done' ? '重新检测' : '开始检测'}
        </button>
      </div>
      {diagnostics?.status === 'done' && diagnostics.overall && <p className={styles.diagVerdict}>
        <span className={styles.diagBadge} data-grade={diagnostics.overall.grade}>{NETWORK_GRADE_LABELS[diagnostics.overall.grade]}</span>
        {diagnostics.overall.advice}
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
    </div>
  </div>;
}
