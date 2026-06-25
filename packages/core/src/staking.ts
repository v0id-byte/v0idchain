// 中继质押托管（Phase 3A-1）：共识级押金 + 失职罚没。本文件只放“纯函数”——memo 解析、入参类型、只读视图。
// 真正的状态机（押金锁定/赎回/罚没 在余额与质押池上的变更）在 blockchain.ts，且 computeState 与 validateChain
// 共用同一套 applyTx，保证矿工与校验方算出完全一致的结果（否则会分叉）。与红包 redpacket.ts 同款分工。
//
// 三种操作（建在普通交易 + memo 之上，旧节点不认 → 软分叉，边界同红包 CLAIM/REFUND）：
//   质押 STAKE   ：转给托管地址（to==STAKE_ESCROW_ADDRESS）amount=押金，memo `STAKE|<role>`。共识开一个以该交易 txid
//                  为 id 的质押池。**注意 to=托管而非自转**：旧节点会把它当普通转账锁进托管（余额效果与新节点一致）→
//                  不“静默分叉”；分叉只在 UNSTAKE/SLASH（amount=0，旧节点直接拒）处发生。
//   赎回 UNSTAKE ：amount=0，memo `UNSTAKE|<stakeTxid>`。仅质押人、且过 STAKE_LOCK_BLOCKS 锁定期后，取回本金-已罚没。
//   罚没 SLASH   ：amount=0，memo `SLASH|<stakeId>|<金额>|<epoch>`。仅 MEASURER_ADDRESS 签发，把失职押金移交国库。
import type { Block } from './block.js';
import {
  STAKE_PREFIX,
  UNSTAKE_PREFIX,
  SLASH_PREFIX,
  STAKE_ESCROW_ADDRESS,
  STAKING_ACTIVATION_HEIGHT,
  STAKE_MIN,
  STAKE_LOCK_BLOCKS,
  MEASURER_ADDRESS,
} from './config.js';

/** 中继角色：guard 入口 / middle 中间 / hsdir 隐藏服务目录。v1 无 exit。 */
export type StakeRole = 'guard' | 'middle' | 'hsdir';

const ROLES: ReadonlySet<string> = new Set<StakeRole>(['guard', 'middle', 'hsdir']);
const TXID_RE = /^[0-9a-f]{64}$/; // 引用一笔质押交易的 txid

/** 解析 STAKE|<role>；非法返回 null。不校验金额（金额在 blockchain 层结合余额与 STAKE_MIN 判）。 */
export function parseStakeCreate(memo: string): { role: StakeRole } | null {
  if (!memo.startsWith(STAKE_PREFIX)) return null;
  const role = memo.slice(STAKE_PREFIX.length);
  return ROLES.has(role) ? { role: role as StakeRole } : null;
}

/** UNSTAKE|<stakeTxid> → stakeTxid（须像 64-hex txid）；否则 null */
export function parseUnstakeId(memo: string): string | null {
  if (!memo.startsWith(UNSTAKE_PREFIX)) return null;
  const id = memo.slice(UNSTAKE_PREFIX.length);
  return TXID_RE.test(id) ? id : null;
}

/** SLASH|<stakeId>|<金额>|<epoch> → {stakeId, amount, epoch}；任一字段非法返回 null。 */
export function parseSlash(memo: string): { stakeId: string; amount: number; epoch: number } | null {
  if (!memo.startsWith(SLASH_PREFIX)) return null;
  const parts = memo.slice(SLASH_PREFIX.length).split('|');
  if (parts.length !== 3) return null;
  const [stakeId, amountStr, epochStr] = parts;
  if (!TXID_RE.test(stakeId)) return null;
  // 规范十进制形：拒 1e3/0x10/前导零/正负号/空白等非规范写法（跨实现可复现 + 黄金向量稳定）
  if (!/^[1-9][0-9]*$/.test(amountStr)) return null; // 罚没额：正整数
  if (!/^(0|[1-9][0-9]*)$/.test(epochStr)) return null; // 周期号：非负整数
  const amount = Number(amountStr);
  const epoch = Number(epochStr);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(epoch)) return null; // 防超大数丢精度
  return { stakeId, amount, epoch };
}

/** 是否“amount=0 也合法”的质押操作（UNSTAKE/SLASH）——verifyTransaction 据此放行零额交易（同红包 isZeroAmountOp）。 */
export function isZeroAmountStakeOp(memo: string): boolean {
  return memo.startsWith(UNSTAKE_PREFIX) || memo.startsWith(SLASH_PREFIX);
}

/** 一个质押池（共识状态的一部分；也是 computeStakeState 的视图元素）。 */
export interface StakePool {
  staker: string; // 质押人地址（= 中继链上身份）
  role: StakeRole; // 质押的角色
  amount: number; // 押金本金
  lockedUntil: number; // 锁定到此高度（含）；UNSTAKE 须 atHeight >= lockedUntil
  createdHeight: number; // 质押创建高度
  slashed: number; // 累计已罚没额（赎回时从本金扣除）
  withdrawn: boolean; // 是否已赎回（防重复赎回）
}

/** 校验“质押”入参；返回 memo 或错误（供 node 层调用，amount 取 STAKE_MIN[role]）。 */
export function makeStake(role: StakeRole): { ok: boolean; memo?: string; amount?: number; error?: string } {
  if (!ROLES.has(role)) return { ok: false, error: '角色只能是 guard/middle/hsdir' };
  return { ok: true, memo: `${STAKE_PREFIX}${role}`, amount: STAKE_MIN[role] };
}

/**
 * 扫整条链还原所有质押池（只读视图：给 relays.ts 选路过滤、CLI/仪表盘展示）。
 * 这是“展示/过滤重放”，**与共识同源**——逻辑必须与 blockchain.ts applyTx 的 STAKE/UNSTAKE/SLASH 分支一致，
 * 共识权威仍是 applyTx。纯函数（只依赖链）→ reorg 安全；同块内按交易数组顺序，确定性。
 */
export function computeStakeState(chain: Block[]): Map<string, StakePool> {
  const stakes = new Map<string, StakePool>();
  for (const b of chain) {
    if (b.index < STAKING_ACTIVATION_HEIGHT) continue;
    for (const tx of b.transactions) {
      const m = tx.memo;
      if (!m) continue;
      // 质押 = 转给托管地址 + STAKE| memo（旧节点也会把它当普通转账锁进托管 → 不静默分叉）
      if (tx.to === STAKE_ESCROW_ADDRESS) {
        const meta = parseStakeCreate(m);
        if (meta && tx.amount >= STAKE_MIN[meta.role]) {
          stakes.set(tx.txid, {
            staker: tx.from,
            role: meta.role,
            amount: tx.amount,
            lockedUntil: b.index + STAKE_LOCK_BLOCKS,
            createdHeight: b.index,
            slashed: 0,
            withdrawn: false,
          });
        }
        continue;
      }
      const unstakeId = parseUnstakeId(m);
      if (unstakeId) {
        const p = stakes.get(unstakeId);
        if (p && !p.withdrawn && tx.from === p.staker && b.index >= p.lockedUntil) {
          p.withdrawn = true;
        }
        continue;
      }
      const slash = parseSlash(m);
      if (slash) {
        const p = stakes.get(slash.stakeId);
        if (p && !p.withdrawn && tx.from === MEASURER_ADDRESS) {
          const remaining = p.amount - p.slashed;
          p.slashed += Math.min(slash.amount, Math.max(0, remaining));
        }
      }
    }
  }
  return stakes;
}
