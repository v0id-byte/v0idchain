// 交易：转账（零手续费）、coinbase（挖矿奖励）、创世预挖。
import { sha256Hex, sign, verify, addressToPublicKeyHex } from './crypto.js';
import {
  NULL_ADDRESS,
  BLOCK_REWARD,
  GENESIS_PREMINE,
  GENESIS_TIMESTAMP,
  MAX_MEMO,
} from './config.js';
import type { Wallet } from './wallet.js';

export interface Transaction {
  from: string; // 发送方地址（= 公钥）；coinbase / 创世为 NULL_ADDRESS
  to: string; // 接收方地址
  amount: number; // 转账金额（零手续费，收到 = 发出）
  nonce: number; // 发送方自增计数，防重放（同一笔签名交易不能被重复广播扣款）
  timestamp: number;
  memo: string; // 备注（可空串），随 payload 一起签名、计入 txid
  signature: string; // ed25519 签名 hex；coinbase / 创世为空串
  txid: string; // = sha256(规范化 payload)
}

type TxPayload = Pick<Transaction, 'from' | 'to' | 'amount' | 'nonce' | 'timestamp' | 'memo'>;

/** 参与签名 / txid 计算的规范化字段（顺序固定，保证各节点算出一致的 hash） */
function payloadHash(t: TxPayload): string {
  return sha256Hex(JSON.stringify([t.from, t.to, t.amount, t.nonce, t.timestamp, t.memo]));
}

/** 普通转账：由钱包签名 */
export function createTransaction(
  wallet: Wallet,
  to: string,
  amount: number,
  nonce: number,
  memo = '',
): Transaction {
  const base: TxPayload = { from: wallet.address, to, amount, nonce, timestamp: Date.now(), memo };
  const txid = payloadHash(base);
  return { ...base, signature: sign(txid, wallet.privateKey), txid };
}

/** coinbase：每个区块第一笔，矿工奖励，无签名 */
export function createCoinbase(minerAddress: string, blockIndex: number): Transaction {
  // nonce 用 blockIndex，保证不同高度的 coinbase txid 不同
  const base: TxPayload = {
    from: NULL_ADDRESS,
    to: minerAddress,
    amount: BLOCK_REWARD,
    nonce: blockIndex,
    timestamp: Date.now(),
    memo: '',
  };
  return { ...base, signature: '', txid: payloadHash(base) };
}

/** 创世预挖交易：固定参数 → 所有节点算出完全相同的 txid 与创世 hash */
export function createGenesisTx(premineAddress: string): Transaction {
  const base: TxPayload = {
    from: NULL_ADDRESS,
    to: premineAddress,
    amount: GENESIS_PREMINE,
    nonce: 0,
    timestamp: GENESIS_TIMESTAMP,
    memo: 'v0idChain genesis',
  };
  return { ...base, signature: '', txid: payloadHash(base) };
}

export function isCoinbase(t: Transaction): boolean {
  return t.from === NULL_ADDRESS;
}

/**
 * 校验单笔交易的“自洽性”：金额、txid 是否匹配内容、签名是否有效。
 * 不含余额 / nonce 顺序检查 —— 那依赖整条链的状态，由 blockchain 层负责。
 */
export function verifyTransaction(t: Transaction): boolean {
  // 金额必须是正整数且在安全范围内：浮点数会让各节点按不同交易顺序累积舍入误差，
  // 进而对“余额是否够付”得出不同结论 —— 那会直接撕裂共识。
  if (!Number.isInteger(t.amount) || t.amount <= 0 || t.amount > Number.MAX_SAFE_INTEGER) return false;
  // 备注须为串且不超长。按 Unicode 码点计数（与“字符”一致，避免 emoji 被当成 2 个）；
  // 先用码元长度做廉价上界，挡住超长串再展开，避免恶意巨串撑爆内存。
  if (typeof t.memo !== 'string' || t.memo.length > MAX_MEMO * 2 || [...t.memo].length > MAX_MEMO) {
    return false;
  }
  if (payloadHash(t) !== t.txid) return false; // txid 必须等于内容哈希，防篡改
  if (isCoinbase(t)) return true; // coinbase / 创世无签名
  return verify(t.signature, t.txid, addressToPublicKeyHex(t.from));
}
