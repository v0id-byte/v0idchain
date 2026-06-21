// 节点 HTTP API 的类型与取数辅助。
export const NULL_ADDRESS = '0x' + '0'.repeat(64);

export interface Tx {
  from: string;
  to: string;
  amount: number;
  fee: number; // 手续费（gas）：发送方在 amount 之外额外支付，归打包矿工
  nonce: number;
  timestamp: number;
  memo: string;
  burn?: number; // 销毁进虚空的 $V0ID（链上消息用；普通转账省略=0）
  signature: string;
  txid: string;
}

/** 链上消息（amount 0 + burn>0 + memo 正文） */
export interface ChainMessage {
  txid: string;
  from: string;
  to: string;
  text: string;
  burn: number;
  timestamp: number;
  height: number;
}

export interface Messages {
  address: string;
  received: ChainMessage[];
  sent: ChainMessage[];
}

/** 昵称注册表（名字↔地址） */
export interface NameRegistry {
  nameToOwner: Record<string, string>;
  addressToName: Record<string, string>;
}

/** 新成员事件：本次会话首见的对等节点 / 首次上链的地址 */
export interface Newcomer {
  kind: 'peer' | 'address';
  address: string;
  at: number;
  listen?: string;
  height?: number;
}

export interface Block {
  index: number;
  timestamp: number;
  prevHash: string;
  transactions: Tx[];
  merkleRoot: string;
  difficulty: number;
  nonce: number;
  miner: string;
  hash: string;
}

export interface Listing {
  id: string;
  title: string;
  price: number;
  seller: string;
  timestamp: number;
  delisted: boolean;
  sold: boolean;
  soldBy?: string;
  mine: boolean;
}

export interface Info {
  address: string;
  symbol: string;
  height: number;
  blocks: number;
  balance: number;
  mempool: number;
  difficulty: number;
  minFee?: number; // 最低手续费（gas）
  messageBurn?: number; // 发消息默认销毁额
  burned?: number; // 🔥 全网已烧进虚空的 $V0ID 总额
  peers: number;
  peerList: { url?: string; address?: string }[];
  newcomers?: number; // 本次会话发现的新成员数
  syncing?: boolean;
}

export async function getJSON<T>(base: string, path: string): Promise<T> {
  const res = await fetch(base + path);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as any);
    throw new Error(data.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function postJSON<T>(base: string, path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}) as any);
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export const isCoinbase = (tx: Tx) => tx.from === NULL_ADDRESS;

// ---- 区块浏览器：客户端检索（数据都在已拉取的 /chain 里）----
export interface TxRef {
  tx: Tx;
  blockIndex: number;
}

/** 某地址的余额 + 进出历史（含 coinbase 收入） */
export function addressHistory(chain: Block[], address: string): { balance: number; history: TxRef[] } {
  let balance = 0;
  const history: TxRef[] = [];
  for (const b of chain) {
    for (const tx of b.transactions) {
      if (tx.to === address) balance += tx.amount;
      if (tx.from === address) balance -= tx.amount + tx.fee + (tx.burn ?? 0); // 发送方还要扣手续费与销毁额
      if (tx.to === address || tx.from === address) history.push({ tx, blockIndex: b.index });
    }
  }
  return { balance, history: history.reverse() };
}

export function findTx(chain: Block[], txid: string): TxRef | null {
  for (const b of chain) {
    const tx = b.transactions.find((t) => t.txid === txid);
    if (tx) return { tx, blockIndex: b.index };
  }
  return null;
}

export function findBlock(chain: Block[], query: string): Block | null {
  if (/^\d+$/.test(query)) return chain.find((b) => b.index === Number(query)) ?? null;
  return chain.find((b) => b.hash === query || b.hash.startsWith(query)) ?? null;
}

export type SearchResult =
  | { kind: 'address'; address: string; balance: number; history: TxRef[] }
  | { kind: 'tx'; ref: TxRef }
  | { kind: 'block'; block: Block }
  | { kind: 'none' };

/** 自动判别查询类型：0x地址 / 64hex-txid / 区块#或hash */
export function search(chain: Block[], raw: string): SearchResult {
  const q = raw.trim();
  if (!q) return { kind: 'none' };
  if (/^0x[0-9a-f]{64}$/i.test(q)) {
    const { balance, history } = addressHistory(chain, q.toLowerCase());
    return { kind: 'address', address: q.toLowerCase(), balance, history };
  }
  if (/^[0-9a-f]{64}$/i.test(q)) {
    const ref = findTx(chain, q.toLowerCase());
    if (ref) return { kind: 'tx', ref };
  }
  const block = findBlock(chain, q.toLowerCase());
  if (block) return { kind: 'block', block };
  return { kind: 'none' };
}
