// 轮询 GET /info（经主进程 IPC，避免渲染层直接发网络请求）。
// 占位板块用它显示只读链状态（链高/对等/地址/已烧毁等）。外部 SOCKS 模式无链 → 返回 null。
import { useEffect, useState } from 'react';

export function useInfo(intervalMs = 5000) {
  const [info, setInfo] = useState(undefined); // undefined=加载中, null=不可用, object=数据

  useEffect(() => {
    if (!window.v0id || !window.v0id.info) {
      setInfo(null);
      return undefined;
    }
    let alive = true;
    const tick = async () => {
      try {
        const i = await window.v0id.info();
        if (alive) setInfo(i ?? null);
      } catch {
        if (alive) setInfo(null);
      }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);

  return info;
}
