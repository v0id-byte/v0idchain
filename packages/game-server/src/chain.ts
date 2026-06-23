// 链访问层：游戏服务器对上游 v0idChain 节点的只读代理 + 广播已签名交易。
// 游戏服务器持 @v0idchain/core，故能用最新链重建 Blockchain 复用 nonceOf/balanceOf —— 无需给节点加新 API。
import { Block, Blockchain, Transaction } from '@v0idchain/core';
import { NODE_URL, NODE_TOKEN } from './config.js';

async function nodeGet<T>(path: string): Promise<T> {
  const r = await fetch(NODE_URL + path);
  if (!r.ok) throw new Error(`节点 GET ${path} → ${r.status}`);
  return (await r.json()) as T;
}

let chainCache: { at: number; chain: Block[] } | null = null;
const CHAIN_TTL_MS = 2000; // 链缓存 2s，挡住整链反复拉取（出块 8s 一个，2s 足够新鲜）

export async function getChain(force = false): Promise<Block[]> {
  if (!force && chainCache && Date.now() - chainCache.at < CHAIN_TTL_MS) return chainCache.chain;
  const chain = await nodeGet<Block[]>('/chain');
  chainCache = { at: Date.now(), chain };
  return chain;
}

export function getInfo(): Promise<unknown> {
  return nodeGet('/info');
}
export function getNames(): Promise<unknown> {
  return nodeGet('/names');
}
export function getMarket(): Promise<unknown> {
  return nodeGet('/market');
}
export async function getBalance(address: string): Promise<number> {
  const r = await nodeGet<{ balance: number }>(`/balance?address=${encodeURIComponent(address)}`);
  return r.balance;
}
export function getTxStatus(txid: string): Promise<unknown> {
  return nodeGet(`/tx?txid=${encodeURIComponent(txid)}`);
}

/** 用最新链重建 Blockchain（只读：nonceOf/balanceOf/petsOf 等都只依赖 chain 数组）。 */
export async function snapshot(force = false): Promise<Blockchain> {
  const bc = new Blockchain();
  bc.chain = await getChain(force);
  return bc;
}

/** 某地址的下一个 nonce（= 链上已发交易数）。客户端构造交易前取它。 */
export async function getNonce(address: string): Promise<number> {
  return (await snapshot(true)).nonceOf(address);
}

/** 某地址链上最新的房间版本 hash（memo `ROOM|<hash>` 自转,后者覆盖前者）。供串门校验用。 */
export async function latestRoomHash(address: string): Promise<string | null> {
  const bc = await snapshot();
  let hash: string | null = null;
  for (const b of bc.chain) {
    for (const tx of b.transactions) {
      if (tx.from === address && tx.to === address && typeof tx.memo === 'string' && tx.memo.startsWith('ROOM|')) {
        hash = tx.memo.slice('ROOM|'.length);
      }
    }
  }
  return hash;
}

/** 广播一笔“客户端/央行已签名”的交易到节点（写接口，带 Bearer token）。节点只校验+广播，不代签。 */
export async function submitSigned(tx: Transaction): Promise<{ ok: boolean; txid?: string; error?: string }> {
  const r = await fetch(NODE_URL + '/tx/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${NODE_TOKEN}` },
    body: JSON.stringify({ tx }),
  });
  const body = (await r.json().catch(() => ({}))) as { txid?: string; error?: string };
  if (!r.ok) return { ok: false, error: body.error ?? `节点返回 ${r.status}` };
  return { ok: true, txid: body.txid };
}
