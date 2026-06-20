// 区块：结构、哈希、PoW 挖矿。
import { sha256Hex, leadingZeroBits } from './crypto.js';
import type { Transaction } from './transaction.js';

export interface Block {
  index: number;
  timestamp: number;
  prevHash: string;
  transactions: Transaction[];
  merkleRoot: string; // 交易 Merkle 根（区块头据此承诺整组交易）
  difficulty: number; // 该块要求的前导 0 比特数（自适应）
  nonce: number; // PoW 随机数
  miner: string; // 出块矿工地址（便于展示）
  hash: string;
}

/** 区块哈希：覆盖头部所有字段。交易通过 merkleRoot 间接承诺（再由 txid 绑定内容）。 */
export function calcBlockHash(b: Omit<Block, 'hash'>): string {
  return sha256Hex(
    JSON.stringify([
      b.index,
      b.timestamp,
      b.prevHash,
      b.merkleRoot,
      b.difficulty,
      b.nonce,
      b.miner,
    ]),
  );
}

/** 是否满足难度：hash 的前导 0 比特数 ≥ difficulty */
export function meetsDifficulty(hash: string, difficulty: number): boolean {
  return leadingZeroBits(hash) >= difficulty;
}

const BATCH = 20_000; // 每批枚举多少个 nonce，之后让出事件循环

/**
 * PoW：分片异步枚举 nonce，直到 hash 满足该块的 difficulty。
 * 每挖 BATCH 个 nonce 就 `setImmediate` 让出一次事件循环 —— 这样即使难度高、单块要算几秒，
 * 节点也能在批次间隙处理 P2P 消息（收到别人的新块时 shouldStop 触发，放弃这块陈旧的活）。
 */
export async function mineBlock(
  template: Omit<Block, 'hash' | 'nonce'>,
  shouldStop?: () => boolean,
): Promise<Block | null> {
  let nonce = 0;
  for (;;) {
    const end = nonce + BATCH;
    for (; nonce < end; nonce++) {
      const candidate = { ...template, nonce };
      const hash = calcBlockHash(candidate);
      if (meetsDifficulty(hash, template.difficulty)) return { ...candidate, hash };
    }
    if (shouldStop?.()) return null; // 链变了（来了新块）→ 放弃，去挖新的链顶
    await new Promise((r) => setImmediate(r)); // 让出事件循环，处理 P2P
  }
}
