// 质押身份（Phase 3B）：纯资金锁仓反女巫，无罚没、无仲裁者。本文件只放“纯函数”——memo 解析、
// 入参类型、只读视图。真正的状态机在 blockchain.ts，computeState 与 validateChain 共用同一套
// applyTx，保证矿工与校验方算出完全一致的结果。与质押 staking.ts / 红包 redpacket.ts 同款分工。
//
// 两种操作（建在普通交易 + memo 之上，旧节点不认 → 软分叉，边界同质押 STAKE/UNSTAKE）：
//   认领 IDCLAIM ：转给托管地址（to==IDENTITY_ESCROW_ADDRESS）amount=押金，memo `IDCLAIM|<pseudonym>`。
//                  **注意 to=托管而非自转**：旧节点会把它当普通转账锁进托管（余额效果与新节点一致）→
//                  不“静默分叉”；分叉只在 IDRELEASE（amount=0，旧节点直接拒）处发生。
//   解锁 IDRELEASE：amount=0，memo `IDRELEASE|<claimTxid>`。仅质押人、且过 IDENTITY_LOCK_BLOCKS 锁定期后，
//                  取回**全部**本金（本机制无罚没）。解锁后该假名立刻可被任何人重新认领——押金必须
//                  “持续持有”才算拥有身份，不是一次性入场费，这是唯一的反女巫成本来源。
//
// ⚠️ 与 names.ts 的耦合：复用其 isValidName/RESERVED_NAMES（1~20 位字符集 + 保留名规则），避免用户
// 学两套昵称规则。这意味着以后修改 names.ts 的字符集/保留名会**同时是两个功能的软分叉**，改动前须知悉。
import type { Block } from './block.js';
import { isCoinbase } from './transaction.js';
import { isValidName, RESERVED_NAMES } from './names.js';
import {
  IDCLAIM_PREFIX,
  IDRELEASE_PREFIX,
  IDENTITY_ESCROW_ADDRESS,
  IDENTITY_ACTIVATION_HEIGHT,
  IDENTITY_STAKE_MIN,
  IDENTITY_LOCK_BLOCKS,
} from './config.js';

const TXID_RE = /^[0-9a-f]{64}$/; // 引用一笔认领交易的 txid

/** 解析 IDCLAIM|<pseudonym>；非法返回 null。不校验金额（金额在 blockchain 层结合 IDENTITY_STAKE_MIN 判）。 */
export function parseIdentityClaim(memo: string): { pseudonym: string } | null {
  if (!memo.startsWith(IDCLAIM_PREFIX)) return null;
  const p = memo.slice(IDCLAIM_PREFIX.length).trim().toLowerCase();
  return isValidName(p) ? { pseudonym: p } : null; // 复用 names.ts 的字符集 + 保留名规则
}

/** IDRELEASE|<claimTxid> → claimTxid（须像 64-hex txid）；否则 null */
export function parseIdentityRelease(memo: string): string | null {
  if (!memo.startsWith(IDRELEASE_PREFIX)) return null;
  const id = memo.slice(IDRELEASE_PREFIX.length);
  return TXID_RE.test(id) ? id : null;
}

/** 是否“amount=0 也合法”的身份操作（IDRELEASE）——verifyTransaction 据此放行零额交易（同质押 isZeroAmountStakeOp）。 */
export function isZeroAmountIdentityOp(memo: string): boolean {
  return memo.startsWith(IDRELEASE_PREFIX);
}

/** 一份身份质押（共识状态的一部分；也是 computeIdentityState 的视图元素）。无 slashed 字段——本机制无罚没。 */
export interface IdentityStake {
  staker: string; // 质押人地址
  pseudonym: string; // 认领的假名
  amount: number; // 押金本金（恒定，无罚没扣减）
  lockedUntil: number; // 锁定到此高度（含）；IDRELEASE 须 atHeight >= lockedUntil
  createdHeight: number; // 认领高度
  released: boolean; // 是否已解锁取回押金（防重复解锁）
}

/** 校验入参并生成 memo。 */
export function makeIdentityClaim(pseudonym: string): { ok: boolean; memo?: string; error?: string } {
  const p = pseudonym.trim().toLowerCase();
  if (RESERVED_NAMES.has(p)) return { ok: false, error: `“${p}” 是保留名，禁止认领` };
  if (!isValidName(p)) return { ok: false, error: '假名需 1~20 位 小写字母/数字/_/-，且不以 0x 开头' };
  return { ok: true, memo: `${IDCLAIM_PREFIX}${p}` };
}

/**
 * 扫整条链还原所有身份质押（只读视图：给 CLI/仪表盘展示）。这是“展示/过滤重放”，**与共识同源**——
 * 逻辑必须与 blockchain.ts applyTx 的 IDCLAIM/IDRELEASE 分支一致，共识权威仍是 applyTx。
 * 纯函数（只依赖链）→ reorg 安全；同块内按交易数组顺序，确定性。
 *
 * 语义：**押金即身份**——一个 pseudonym 的当前持有者 = 其最新一笔“仍处于活跃质押状态”（未 released）
 * 的 IDCLAIM 认领人；一旦该质押被 IDRELEASE 解锁，pseudonym 立刻变为可被任何人重新认领。
 */
export function computeIdentityState(chain: Block[]): {
  claims: Map<string, IdentityStake>; // id（IDCLAIM 交易 txid）→ 质押
  pseudonymToClaimId: Map<string, string>; // 假名 → 当前活跃 claimId（release 后从此表移除）
} {
  const claims = new Map<string, IdentityStake>();
  const pseudonymToClaimId = new Map<string, string>();
  for (const b of chain) {
    if (b.index < IDENTITY_ACTIVATION_HEIGHT) continue;
    for (const tx of b.transactions) {
      // coinbase（矿工出块奖励）的 to/amount 矿工可自由设置、memo 也不受 verifyTransaction 约束
      // （coinbase 校验只看 fee===0/burn===0/amount>0，不查 memo）——恶意矿工可以绕过 createCoinbase
      // 这个辅助函数，手写一笔 to=IDENTITY_ESCROW_ADDRESS、memo=IDCLAIM|<name> 的 coinbase，把出块奖励
      // 凑够 IDENTITY_STAKE_MIN。真正的共识 computeState 在处理 coinbase 时直接 continue、从不进
      // applyTx，永远不会创建对应的 identityClaims 记录；这里的只读展示层若不排除 coinbase，会把这
      // 笔交易误记成一条合法认领，让 UI/API 显示该假名“已被占用”，即便链上共识状态里根本没有此记录
      // （真实用户之后仍能成功认领，只是中间会有一段误导性的展示）。
      if (isCoinbase(tx)) continue;
      const m = tx.memo;
      if (!m) continue;
      // 认领 = 转给托管地址 + IDCLAIM| memo（旧节点也会把它当普通转账锁进托管 → 不静默分叉）
      if (tx.to === IDENTITY_ESCROW_ADDRESS) {
        const meta = parseIdentityClaim(m);
        if (meta && tx.amount >= IDENTITY_STAKE_MIN && !pseudonymToClaimId.has(meta.pseudonym)) {
          claims.set(tx.txid, {
            staker: tx.from,
            pseudonym: meta.pseudonym,
            amount: tx.amount,
            lockedUntil: b.index + IDENTITY_LOCK_BLOCKS,
            createdHeight: b.index,
            released: false,
          });
          pseudonymToClaimId.set(meta.pseudonym, tx.txid);
        }
        continue;
      }
      const releaseId = parseIdentityRelease(m);
      if (releaseId) {
        const c = claims.get(releaseId);
        if (c && !c.released && tx.from === c.staker && b.index >= c.lockedUntil) {
          c.released = true;
          if (pseudonymToClaimId.get(c.pseudonym) === releaseId) pseudonymToClaimId.delete(c.pseudonym);
        }
      }
    }
  }
  return { claims, pseudonymToClaimId };
}

/** 假名 → 当前持有者地址（无活跃质押则 undefined）。给 CLI/API 解析用。 */
export function resolveIdentityOwner(
  state: ReturnType<typeof computeIdentityState>,
  pseudonym: string,
): string | undefined {
  const id = state.pseudonymToClaimId.get(pseudonym.trim().toLowerCase());
  return id ? state.claims.get(id)?.staker : undefined;
}
