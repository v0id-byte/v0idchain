// 链上抢红包：共识级托管 + 条件支付。本文件只放“纯函数”——memo 解析、派发公式、入参校验、只读视图。
// 真正的状态机（锁定/派发/退款 在余额与池上的变更）在 blockchain.ts，且 computeState 与 validateChain
// 共用同一套 applyTx，保证矿工与校验方算出完全一致的派发额（否则会分叉）。
//
// 三种操作（建在普通交易 + memo 之上，旧节点不认 → 软/硬分叉）：
//   发红包 RED   ：转给托管地址（to==RED_ESCROW_ADDRESS）amount=总额，memo `RED|<份数>|<r|e>`。
//                  共识开一个以该交易 txid 为 id 的池。**注意 to=托管而非自转**：旧节点会把它当普通转账
//                  锁进托管（余额效果与新节点一致）→ 不“静默分叉”；分叉只在 CLAIM/REFUND（amount=0，旧节点直接拒）处发生。
//   抢红包 CLAIM ：amount=0，memo `CLAIM|<红包id>`。共识校验后按公式派一份、池相应减少。
//                  拼手气随机源 = 该 CLAIM 被打包进的“区块 hash”（抢的人事先无法预测/操纵 → 防刷大额）。
//   退款   REFUND：amount=0，memo `REFUND|<红包id>`。仅发起人、且过 RED_EXPIRY 块后，取回剩余。
import type { Block } from './block.js';
import { sha256Hex } from './crypto.js';
import { RED_PREFIX, CLAIM_PREFIX, REFUND_PREFIX, MAX_RED_COUNT, RED_ESCROW_ADDRESS } from './config.js';

export type RedMode = 'r' | 'e'; // 拼手气 / 均分

export interface RedMeta {
  count: number;
  mode: RedMode;
}

/** 解析 RED|<份数>|<r|e>；非法返回 null。不校验金额（金额在 blockchain 层结合余额判）。 */
export function parseRedCreate(memo: string): RedMeta | null {
  if (!memo.startsWith(RED_PREFIX)) return null;
  const rest = memo.slice(RED_PREFIX.length);
  const sep = rest.indexOf('|');
  if (sep < 0) return null;
  const count = Number(rest.slice(0, sep));
  const mode = rest.slice(sep + 1);
  if (!Number.isInteger(count) || count < 1 || count > MAX_RED_COUNT) return null;
  if (mode !== 'r' && mode !== 'e') return null;
  return { count, mode };
}

/** CLAIM|<id> → id（id 须像 64-hex txid）；否则 null */
export function parseClaimId(memo: string): string | null {
  if (!memo.startsWith(CLAIM_PREFIX)) return null;
  const id = memo.slice(CLAIM_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(id) ? id : null;
}

/** REFUND|<id> → id；否则 null */
export function parseRefundId(memo: string): string | null {
  if (!memo.startsWith(REFUND_PREFIX)) return null;
  const id = memo.slice(REFUND_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(id) ? id : null;
}

/** 是否“amount=0 也合法”的红包操作（CLAIM/REFUND）——verifyTransaction 据此放行零额交易 */
export function isZeroAmountOp(memo: string): boolean {
  return memo.startsWith(CLAIM_PREFIX) || memo.startsWith(REFUND_PREFIX);
}

/** 拼手气随机源：把区块 hash 与该 CLAIM 的 txid 一起哈希 → 确定性、各节点一致、抢的人事先不可预测。 */
export function redSeed(blockHash: string, claimTxid: string): string {
  return sha256Hex(blockHash + claimTxid);
}

/**
 * 计算一次领取的金额（整数，共识关键 —— 各节点必须算出同一结果）。
 * - 最后一份（remainingCount==1）直接拿走剩余，保证全部派完。
 * - 均分 'e'：floor(剩余/剩余份数)。
 * - 拼手气 'r'：微信式“二倍均值”——上界 = min(⌊2×剩余/剩余份数⌋, 剩余-(剩余份数-1))，
 *   share = 1 + (seed mod 上界)。保证 1 ≤ share ≤ 上界，且给后面每份留 ≥1。全程整数（杜绝浮点撕裂共识）。
 * 不变量：只要发红包时 总额 ≥ 份数，则始终 剩余 ≥ 剩余份数，上界 ≥ 1，归纳成立。
 */
export function computeShare(remaining: number, remainingCount: number, mode: RedMode, seedHex: string): number {
  if (remainingCount <= 1) return remaining;
  if (mode === 'e') return Math.floor(remaining / remainingCount);
  const maxShare = remaining - (remainingCount - 1);
  const upper = Math.max(1, Math.min(Math.floor((2 * remaining) / remainingCount), maxShare));
  const seed = parseInt(seedHex.slice(0, 12), 16); // 48-bit，足够 mod 上界
  return 1 + (seed % upper);
}

/** 校验“发红包”入参；返回 memo 或错误（供 node 层调用，amount 取 total） */
export function makeRedPacket(total: number, count: number, mode: RedMode = 'r'): { ok: boolean; memo?: string; total?: number; error?: string } {
  if (!Number.isInteger(total) || total < 1) return { ok: false, error: '红包总额必须是正整数' };
  if (!Number.isInteger(count) || count < 1 || count > MAX_RED_COUNT) return { ok: false, error: `份数需 1~${MAX_RED_COUNT}` };
  if (total < count) return { ok: false, error: `总额需 ≥ 份数（每份至少 1）：${total} < ${count}` };
  if (mode !== 'r' && mode !== 'e') return { ok: false, error: '模式只能是 r(拼手气)/e(均分)' };
  return { ok: true, memo: `${RED_PREFIX}${count}|${mode}`, total };
}

// ---- 只读视图：扫链还原红包列表（给 CLI/仪表盘；与共识同源 computeShare，结果一致） ----
export interface RedPacketView {
  id: string;
  creator: string;
  total: number;
  count: number;
  mode: RedMode;
  remaining: number;
  remainingCount: number;
  createHeight: number;
  claims: { who: string; amount: number; height: number }[];
  refunded: boolean;
  done: boolean; // 抢完或已退款
}

/**
 * 扫整条链还原所有红包及其领取记录（只读展示用）。派发用与共识相同的 computeShare(区块 hash) →
 * 展示额与链上实际入账一致。注意：这是“展示重放”，共识权威仍是 blockchain.ts 的 applyTx。
 */
export function parseRedPackets(chain: Block[]): RedPacketView[] {
  const pools = new Map<string, RedPacketView>();
  for (const b of chain) {
    for (const tx of b.transactions) {
      const m = tx.memo;
      if (!m) continue;
      // 发红包 = 转给托管地址 + RED| memo（旧节点也会把它当普通转账锁进托管 → 不静默分叉）
      const red = tx.to === RED_ESCROW_ADDRESS ? parseRedCreate(m) : null;
      if (red && tx.amount >= red.count) {
        pools.set(tx.txid, {
          id: tx.txid, creator: tx.from, total: tx.amount, count: red.count, mode: red.mode,
          remaining: tx.amount, remainingCount: red.count, createHeight: b.index,
          claims: [], refunded: false, done: false,
        });
        continue;
      }
      const claimId = parseClaimId(m);
      if (claimId) {
        const p = pools.get(claimId);
        if (p && !p.done && p.remainingCount > 0 && tx.from !== p.creator && !p.claims.some((c) => c.who === tx.from)) {
          const share = computeShare(p.remaining, p.remainingCount, p.mode, redSeed(b.hash, tx.txid));
          p.claims.push({ who: tx.from, amount: share, height: b.index });
          p.remaining -= share;
          p.remainingCount -= 1;
          if (p.remainingCount === 0) p.done = true;
        }
        continue;
      }
      const refundId = parseRefundId(m);
      if (refundId) {
        const p = pools.get(refundId);
        if (p && !p.done && tx.from === p.creator && p.remaining > 0) {
          p.refunded = true;
          p.remaining = 0;
          p.remainingCount = 0;
          p.done = true;
        }
      }
    }
  }
  return [...pools.values()].sort((a, b) => b.createHeight - a.createHeight);
}
