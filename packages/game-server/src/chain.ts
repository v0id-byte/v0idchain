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
let chainInflight: Promise<Block[]> | null = null;
const CHAIN_TTL_MS = 2000; // 链缓存 2s，挡住整链反复拉取（出块 8s 一个，2s 足够新鲜）

/** 真正去节点拉整链；并发调用共享同一次请求，避免缓存过期瞬间多个请求同时打节点、各自传一遍整条链（274MB@100k）。 */
function fetchChain(): Promise<Block[]> {
  if (!chainInflight) {
    chainInflight = nodeGet<Block[]>('/chain')
      .then((chain) => {
        chainCache = { at: Date.now(), chain };
        return chain;
      })
      .finally(() => {
        chainInflight = null;
      });
  }
  return chainInflight;
}

export async function getChain(): Promise<Block[]> {
  if (chainCache) {
    if (Date.now() - chainCache.at < CHAIN_TTL_MS) return chainCache.chain;
    // 陈旧：先把旧值给这次调用（不阻塞），后台刷新一次；刷新失败就留到下次调用再试，不影响这次响应。
    void fetchChain().catch(() => {});
    return chainCache.chain;
  }
  return fetchChain(); // 冷启动，没有缓存可用，只能等这一次
}

export function getInfo(): Promise<unknown> {
  return nodeGet('/info');
}

/** 当前链高（= 区块数 - 1）。供 /health 用：只回数字，不泄露任何内部地址/密钥。走链缓存，廉价。 */
export async function height(): Promise<number> {
  return (await getChain()).length - 1;
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
export async function snapshot(): Promise<Blockchain> {
  const bc = new Blockchain();
  bc.chain = await getChain();
  return bc;
}

/** 某地址的下一个 nonce（= 链上已发交易数）。客户端构造交易前取它。走节点 /nonce 直答，不必拉整条链本地重算。 */
export async function getNonce(address: string): Promise<number> {
  const r = await nodeGet<{ nonce: number }>(`/nonce?address=${encodeURIComponent(address)}`);
  return r.nonce;
}

/** nonce+balance 一次取（同一次节点侧 computeState，两值保证来自同一链高）。需要两者都要时用这个，别分别调 getNonce+getBalance。 */
export async function getAccount(address: string): Promise<{ nonce: number; balance: number }> {
  return nodeGet<{ nonce: number; balance: number }>(`/account?address=${encodeURIComponent(address)}`);
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
