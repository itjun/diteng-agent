import { useEffect, useState } from 'react';
import type { MqttState } from '../../shared/types';

/** 先订阅后读取，避免初始快照覆盖读取期间的新连接状态。 */
export function useMessageState() {
  const [state, setState] = useState<MqttState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let isDisposed = false;
    let hasUpdate = false;
    const unsubscribe = window.diteng.onMqttChanged((next) => {
      hasUpdate = true;
      setState(next);
      setError('');
    });
    void window.diteng.getMqttState().then((next) => {
      if (!isDisposed && !hasUpdate) setState(next);
    }).catch(() => { if (!isDisposed && !hasUpdate) setError('无法读取消息状态'); });
    return () => { isDisposed = true; unsubscribe(); };
  }, []);
  return { state, error };
}

export function messageConnectionLabel(state: MqttState | null): string {
  if (!state) return '正在读取消息状态';
  switch (state.connectionStatus) {
    case 'connected': return '实时接收已连接';
    case 'connecting': return '正在连接消息服务';
    case 'reconnecting': return '连接中断，正在重连';
    case 'unavailable': return '实时接收不可用，定时同步中';
    default: return '消息服务尚未连接';
  }
}
