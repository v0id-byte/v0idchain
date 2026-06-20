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

/**
 * PoW：暴力枚举 nonce，直到 hash 满足该块的 difficulty。
 * shouldStop 让挖矿可被打断（例如收到了别人更新的链）。
 */
export function mineBlock(
  template: Omit<Block, 'hash' | 'nonce'>,
  shouldStop?: () => boolean,
): Block | null {
  let nonce = 0;
  for (;;) {
    if (nonce % 5000 === 0 && shouldStop?.()) return null;
    const candidate = { ...template, nonce };
    const hash = calcBlockHash(candidate);
    if (meetsDifficulty(hash, template.difficulty)) return { ...candidate, hash };
    nonce++;
  }
}
