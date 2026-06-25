// 订阅主进程的 v0id:status 推送，聚合成一个 React 状态对象。
// 守护阶段、SOCKS 就绪、链高/对等、日志行——多处 UI（侧栏脚、浏览器状态行）共用。
import { useEffect, useState } from 'react';

const PHASE_TEXT = {
  starting: '守护进程启动中…',
  'socks-ready': 'SOCKS 已就绪 · 可访问 .v0id',
  'daemon-exited': '守护进程已退出',
  error: '出错',
};

export function useStatus() {
  const [status, setStatus] = useState({
    phase: 'starting',
    phaseText: PHASE_TEXT.starting,
    socksReady: false,
    socksPort: null,
    external: false,
    chain: null, // { height, peers, syncing }
    error: null,
    log: [], // 最近若干行守护日志
  });

  useEffect(() => {
    // 防御：理论上 preload 一定注入了 window.v0id；万一没有（纯浏览器预览）也不崩。
    if (!window.v0id || !window.v0id.onStatus) return undefined;
    const off = window.v0id.onStatus((patch) => {
      setStatus((prev) => {
        const next = { ...prev };
        if (patch.phase) {
          next.phase = patch.phase;
          next.phaseText =
            patch.phase === 'error' && patch.error
              ? patch.error
              : patch.statusText || PHASE_TEXT[patch.phase] || patch.phase;
          next.socksReady = patch.phase === 'socks-ready';
          if (patch.phase === 'error') next.error = patch.error || '未知错误';
          else next.error = null;
        }
        if (patch.socksPort != null) next.socksPort = patch.socksPort;
        if (patch.external != null) next.external = patch.external;
        if (patch.error && !patch.phase) next.error = patch.error;
        if (patch.chain) next.chain = patch.chain;
        if (patch.logLine) {
          next.log = [...prev.log, patch.logLine];
          if (next.log.length > 300) next.log = next.log.slice(-300);
        }
        return next;
      });
    });
    return off;
  }, []);

  return status;
}
