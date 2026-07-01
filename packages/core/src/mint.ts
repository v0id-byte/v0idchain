// 央行电子现金铸币厂（Phase A）：链上「余额公开的金库」——充值进托管、兑现从托管出、抽成回国库。
// 本文件只放“纯函数”——memo 解析、兑现拆分（共识关键的整数运算）、入参校验、只读视图。
// 真正的状态机（充值锁定 / 兑现付款+抽成 在余额上的变更）在 blockchain.ts，且 computeState 与 validateChain
// 共用同一套 applyTx，保证矿工与校验方算出完全一致的结果（否则会分叉）。与红包/质押同款分工。
//
// 两种操作（建在普通交易 + memo 之上，旧节点不认 → 软分叉，边界同红包 CLAIM/REFUND、质押 UNSTAKE/SLASH）：
//   充值 DEPOSIT：转给托管地址（to==MINT_ESCROW_ADDRESS）amount=充值额，memo `MINT|DEPOSIT`。
//                 **注意 to=托管而非自转**：旧节点会把它当普通转账锁进托管（余额效果与新节点一致）→ 不“静默分叉”；
//                 分叉只在 REDEEM（amount=0，旧节点直接拒）处发生。链上储备 = 该托管地址余额 = 累计充值 − 累计兑现。
//   兑现 REDEEM ：amount=0，memo `REDEEM|<面额>`，收款=tx.to（服务方）。仅 MINT_ADDRESS 签发；从托管付
//                 「面额 − 抽成」给服务方、抽成移交国库（→ reward-epoch 养中继）。链侧强制「面额 ≤ 储备」→ 偿付能力可验证。
import type { Block } from './block.js';
import {
  MINT_DEPOSIT_PREFIX,
  MINT_ESCROW_ADDRESS,
  MINT_ADDRESS,
  MINT_ACTIVATION_HEIGHT,
  MINT_FEE_BPS,
  REDEEM_PREFIX,
} from './config.js';

/** 解析 REDEEM|<面额>；非法返回 null。面额须规范十进制正整数（拒前导零/符号/科学计数 → 跨实现可复现 + 黄金向量稳定）。 */
export function parseRedeem(memo: string): { gross: number } | null {
  if (!memo.startsWith(REDEEM_PREFIX)) return null;
  const rest = memo.slice(REDEEM_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(rest)) return null;
  const gross = Number(rest);
  if (!Number.isSafeInteger(gross)) return null; // 防超大数丢精度
  return { gross };
}

/** 是否合法「充值」备注（转给托管地址时用）。精确匹配：不带任何关联数据（利于匿名，用户身份取 tx.from 即可）。 */
export function isMintDeposit(memo: string): boolean {
  return memo === MINT_DEPOSIT_PREFIX;
}

/**
 * 兑现拆分（共识关键 · 全整数，杜绝浮点撕裂共识）：
 * 抽成 fee = floor(面额 × MINT_FEE_BPS / 10000) 移交国库；服务方实得 net = 面额 − 抽成。
 * 不变量：net + fee === gross（供给守恒）；因 MINT_FEE_BPS < 10000 恒有 0 ≤ fee ≤ gross、net ≥ 0。
 * 用 BigInt 做中间乘除：对大额 gross，`gross × MINT_FEE_BPS` 可能越过 MAX_SAFE_INTEGER 而先舍入，
 * 直接浮点乘会算错抽成（跨节点还可能不一致）。BigInt 除法向零截断 = 正数下的 floor，结果必为安全整数（fee ≤ gross）。
 */
export function redeemSplit(gross: number): { net: number; fee: number } {
  const fee = Number((BigInt(gross) * BigInt(MINT_FEE_BPS)) / 10_000n);
  return { net: gross - fee, fee };
}

/** 是否“amount=0 也合法”的铸币操作（REDEEM）——verifyTransaction 据此放行零额交易（同红包 isZeroAmountOp）。 */
export function isZeroAmountMintOp(memo: string): boolean {
  return memo.startsWith(REDEEM_PREFIX);
}

// ---- 只读视图：扫链还原铸币厂储备与累计流量（给 CLI/仪表盘/守护进程的 GET /mint/reserve；与共识同源） ----
export interface MintView {
  reserve: number; // 当前储备（= 托管地址余额 = 累计充值 − 累计兑现面额）
  deposited: number; // 累计充值面额
  redeemed: number; // 累计兑现面额（gross）
  feesToTreasury: number; // 累计回流国库的抽成
  deposits: number; // 充值笔数
  redemptions: number; // 兑现笔数
}

/**
 * 扫整条链还原铸币厂状态（只读展示用）。仅统计激活高度（含）之后的操作——与 applyTx 的门控一致，
 * 故 reserve 与链上托管余额 balances.get(MINT_ESCROW_ADDRESS) 一致。纯函数（只依赖链）→ reorg 安全。
 * 注意：这是“展示重放”，共识权威仍是 blockchain.ts 的 applyTx；只做聚合、不重复校验授权/储备（校验在 applyTx/redOpError）。
 */
export function computeMintState(chain: Block[]): MintView {
  const v: MintView = { reserve: 0, deposited: 0, redeemed: 0, feesToTreasury: 0, deposits: 0, redemptions: 0 };
  for (const b of chain) {
    if (b.index < MINT_ACTIVATION_HEIGHT) continue;
    for (const tx of b.transactions) {
      const m = tx.memo;
      if (!m) continue;
      if (tx.to === MINT_ESCROW_ADDRESS && isMintDeposit(m) && tx.amount > 0) {
        v.reserve += tx.amount;
        v.deposited += tx.amount;
        v.deposits += 1;
        continue;
      }
      const r = tx.amount === 0 && tx.from === MINT_ADDRESS ? parseRedeem(m) : null;
      if (r && r.gross <= v.reserve) {
        const { fee } = redeemSplit(r.gross);
        v.reserve -= r.gross;
        v.redeemed += r.gross;
        v.feesToTreasury += fee;
        v.redemptions += 1;
      }
    }
  }
  return v;
}
