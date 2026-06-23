// 游戏服务器 HTTP 客户端。读链走只读代理；写动作在本地签名后经 /api/tx 广播；faucet 走 /api/faucet。
import type { Transaction } from '@v0idchain/core/browser';
import type { Pet, Catch } from '@v0idchain/core/browser';

const BASE = (import.meta.env.VITE_GAME_API as string | undefined) || 'http://127.0.0.1:8790';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `GET ${path} → ${r.status}`);
  return j as T;
}
async function send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `${method} ${path} → ${r.status}`);
  return j as T;
}

export interface ChainInfo {
  symbol: string;
  height: number;
  difficulty: number;
  minFee: number;
}
export interface TxStatus {
  txid: string;
  status: 'confirmed' | 'pending' | 'unknown';
  height?: number;
}
export interface FaucetResult {
  ok: boolean;
  txid?: string;
  amount?: number;
  error?: string;
}

export const api = {
  info: () => get<ChainInfo>('/api/info'),
  balance: (address: string) => get<{ address: string; balance: number }>(`/api/balance?address=${address}`),
  nonce: (address: string) => get<{ address: string; nonce: number }>(`/api/nonce?address=${address}`),
  pets: (address: string) => get<Pet[]>(`/api/pets?address=${address}`),
  fish: (address: string) => get<Catch[]>(`/api/fish?address=${address}`),
  names: () => get<{ addressToName: Record<string, string> }>('/api/names'),
  rooms: () => get<{ address: string; name?: string }[]>('/api/rooms'),
  txStatus: (txid: string) => get<TxStatus>(`/api/tx?txid=${txid}`),
  faucet: (address: string) => send<FaucetResult>('POST', '/api/faucet', { address }),
  submitTx: (tx: Transaction) => send<{ ok: boolean; txid: string }>('POST', '/api/tx', { tx }),
  getRoom: (address: string) =>
    get<{ layout: string | null; hash?: string; chainHash?: string | null }>(`/api/room?address=${address}`),
  putRoom: (address: string, layout: string, versionTx?: string) =>
    send<{ layout: string; hash: string }>('PUT', '/api/room', { address, layout, versionTx }),
};

/** 轮询一笔交易直到确认（或超时）。给“处理中 → 已到账”的体验。 */
export async function waitConfirmed(txid: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await api.txStatus(txid).catch(() => null);
    if (s?.status === 'confirmed') return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
