// 交易：转账（带手续费/gas）、coinbase（出块奖励 + 手续费归集）、创世预挖。
import { sha256Hex, sign, verify, addressToPublicKeyHex } from './crypto.js';
import {
  NULL_ADDRESS,
  BLOCK_REWARD,
  GENESIS_PREMINE,
  GENESIS_TIMESTAMP,
  MAX_MEMO,
  MIN_FEE,
  minFeeFor,
  MESSAGE_BURN,
  CLAIM_PREFIX,
  REFUND_PREFIX,
} from './config.js';
import type { Wallet } from './wallet.js';

export interface Transaction {
  from: string; // 发送方地址（= 公钥）；coinbase / 创世为 NULL_ADDRESS
  to: string; // 接收方地址
  amount: number; // 转账金额（收款方实收 = 此金额）；链上消息为 0
  fee: number; // 手续费（gas）：发送方在 amount 之外额外支付，归打包矿工；普通交易 ≥ MIN_FEE，coinbase/创世恒 0
  nonce: number; // 发送方自增计数，防重放（同一笔签名交易不能被重复广播扣款）
  timestamp: number;
  memo: string; // 备注（可空串）/ 消息正文，随 payload 一起签名、计入 txid
  burn?: number; // 销毁进虚空（NULL_ADDRESS）的 $V0ID：链上消息用；普通转账/coinbase 省略(=0)。仅 >0 时计入 txid → 老交易哈希不变
  signature: string; // ed25519 签名 hex；coinbase / 创世为空串
  txid: string; // = sha256(规范化 payload)
}

type TxPayload = Pick<Transaction, 'from' | 'to' | 'amount' | 'fee' | 'nonce' | 'timestamp' | 'memo' | 'burn'>;

/**
 * 参与签名 / txid 计算的规范化字段（顺序固定，保证各节点算出一致的 hash）。fee 一并计入 → 篡改手续费即破坏 txid。
 * burn **仅在 >0 时追加**到末尾：这样所有历史交易（无 burn 字段的转账/coinbase/创世）算出的哈希与升级前**逐字节一致**，
 * 创世 hash 与既有 checkpoint 全部不变 —— 既不重置链，又把销毁额牢牢绑进新消息交易的 txid（篡改销毁额即破 txid）。
 */
function payloadHash(t: TxPayload): string {
  const fields: unknown[] = [t.from, t.to, t.amount, t.fee, t.nonce, t.timestamp, t.memo];
  if ((t.burn ?? 0) > 0) fields.push(t.burn);
  return sha256Hex(JSON.stringify(fields));
}

/** 普通转账：由钱包签名。fee 省略时自动按比例计算（minFeeFor(amount)），给多了打包更优先。 */
export function createTransaction(
  wallet: Wallet,
  to: string,
  amount: number,
  nonce: number,
  memo = '',
  fee?: number,
): Transaction {
  const actualFee = fee ?? minFeeFor(amount);
  const base: TxPayload = { from: wallet.address, to, amount, fee: actualFee, nonce, timestamp: Date.now(), memo };
  const txid = payloadHash(base);
  return { ...base, signature: sign(txid, wallet.privateKey), txid };
}

/**
 * 链上消息：由钱包签名。amount 恒 0（不转币），burn = 烧进虚空的 $V0ID（默认 MESSAGE_BURN），memo = 消息正文。
 * 另付 fee（gas，默认 MIN_FEE）给打包矿工。to = 收件人地址（实收 0 币，只是消息的投递目标）。
 */
export function createMessage(
  wallet: Wallet,
  to: string,
  text: string,
  nonce: number,
  burn = MESSAGE_BURN,
  fee = MIN_FEE,
): Transaction {
  const base: TxPayload = { from: wallet.address, to, amount: 0, fee, nonce, timestamp: Date.now(), memo: text, burn };
  const txid = payloadHash(base);
  return { ...base, signature: sign(txid, wallet.privateKey), txid };
}

/** coinbase：每个区块第一笔，矿工收入 = 出块奖励 + 本块手续费总额（fees），无签名、自身不付费 */
export function createCoinbase(minerAddress: string, blockIndex: number, fees = 0): Transaction {
  // nonce 用 blockIndex，保证不同高度的 coinbase txid 不同
  const base: TxPayload = {
    from: NULL_ADDRESS,
    to: minerAddress,
    amount: BLOCK_REWARD + fees,
    fee: 0,
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
    fee: 0,
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
  const burn = t.burn ?? 0;
  // 金额与销毁额必须是非负整数且在安全范围内：浮点数会让各节点按不同交易顺序累积舍入误差，
  // 进而对“余额是否够付”得出不同结论 —— 那会直接撕裂共识。
  if (!Number.isInteger(t.amount) || t.amount < 0 || t.amount > Number.MAX_SAFE_INTEGER) return false;
  if (!Number.isInteger(burn) || burn < 0 || burn > Number.MAX_SAFE_INTEGER) return false;
  // 空操作交易（既不转账 amount=0 又不销毁 burn=0）一律拒：转账须 amount>0，消息须 burn>0。
  // 例外：红包的 CLAIM/REFUND 是 amount=0（领/退由共识从托管池支付，不在本交易里转币）。
  const zeroOk = typeof t.memo === 'string' && (t.memo.startsWith(CLAIM_PREFIX) || t.memo.startsWith(REFUND_PREFIX));
  if (t.amount === 0 && burn === 0 && !zeroOk) return false;
  // 手续费同样必须是整数且在安全范围内（同样的浮点累积误差会撕裂共识）。此处只判范围，最低值按类型在下方判。
  if (!Number.isInteger(t.fee) || t.fee < 0 || t.fee > Number.MAX_SAFE_INTEGER) return false;
  // 备注 / 消息正文须为串且不超长。按 Unicode 码点计数（与“字符”一致，避免 emoji 被当成 2 个）；
  // 先用码元长度做廉价上界，挡住超长串再展开，避免恶意巨串撑爆内存。
  if (typeof t.memo !== 'string' || t.memo.length > MAX_MEMO * 2 || [...t.memo].length > MAX_MEMO) {
    return false;
  }
  if (payloadHash(t) !== t.txid) return false; // txid 必须等于内容哈希（含 fee/burn），篡改金额/手续费/销毁额即被识破
  // coinbase / 创世：无签名，金额>0，且自身既不付手续费也不销毁（fee 与 burn 必须为 0）
  if (isCoinbase(t)) return t.fee === 0 && burn === 0 && t.amount > 0;
  if (t.fee < minFeeFor(t.amount)) return false; // 普通交易：强制比例+保底手续费
  return verify(t.signature, t.txid, addressToPublicKeyHex(t.from));
}
