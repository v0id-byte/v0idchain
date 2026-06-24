// 区块：结构、哈希、PoW 挖矿。
import { sha256Hex, leadingZeroBits } from './crypto.js';
import type { Transaction } from './transaction.js';

export interface Block {
  index: number;
  timestamp: number;
  prevHash: string;
  transactions: Transaction[];
  merkleRoot: string; // 交易 Merkle 根（区块头据此承诺整组交易）
  difficulty: number; // v1=前导 0 bit；v2=BTC compact target(nBits)
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

const TWO_256 = 1n << 256n;

export function isCompactDifficulty(difficulty: number): boolean {
  return Number.isInteger(difficulty) && difficulty > 255;
}

export function targetFromBitDifficulty(difficulty: number): bigint {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) return -1n;
  if (difficulty === 256) return 0n;
  return (1n << BigInt(256 - difficulty)) - 1n;
}

export function targetFromCompact(compact: number): bigint | null {
  if (!Number.isInteger(compact) || compact <= 0 || compact > 0xffffffff) return null;
  const size = compact >>> 24;
  const word = compact & 0x007fffff;
  if (word === 0 || (compact & 0x00800000) !== 0) return null;
  if (size <= 3) return BigInt(word >>> (8 * (3 - size)));
  return BigInt(word) << (8n * BigInt(size - 3));
}

export function compactFromTarget(target: bigint): number {
  if (target < 0n) throw new Error('negative PoW target');
  if (target === 0n) return 0x01000000;
  let hex = target.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let size = hex.length / 2;
  let compact: number;
  if (size <= 3) {
    compact = Number(target << (8n * BigInt(3 - size)));
  } else {
    compact = Number(target >> (8n * BigInt(size - 3)));
  }
  if (compact & 0x00800000) {
    compact >>= 8;
    size += 1;
  }
  return (size << 24) | (compact & 0x007fffff);
}

export function targetFromStoredDifficulty(difficulty: number): bigint | null {
  return isCompactDifficulty(difficulty) ? targetFromCompact(difficulty) : targetFromBitDifficulty(difficulty);
}

export function workForDifficulty(difficulty: number): bigint {
  if (!isCompactDifficulty(difficulty)) {
    return Number.isInteger(difficulty) && difficulty >= 0 && difficulty <= 255 ? 1n << BigInt(difficulty) : 0n;
  }
  const target = targetFromCompact(difficulty);
  if (target === null) return 0n;
  return ((TWO_256 - target - 1n) / (target + 1n)) + 1n;
}

export function approxDifficultyBits(difficulty: number): number {
  if (!isCompactDifficulty(difficulty)) return difficulty;
  const target = targetFromCompact(difficulty);
  if (target === null || target <= 0n) return 256;
  return Math.max(0, 256 - target.toString(2).length);
}

/** 是否满足难度：v1 检查前导 0 bit；v2 检查 hash 数值不大于 compact target */
export function meetsDifficulty(hash: string, difficulty: number): boolean {
  if (isCompactDifficulty(difficulty)) {
    const target = targetFromCompact(difficulty);
    if (target === null) return false;
    return BigInt(`0x${hash}`) <= target;
  }
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
