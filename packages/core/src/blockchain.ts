// 区块链：创世、校验、余额/nonce 状态、mempool、自适应难度、最长链共识。
import {
  Block,
  calcBlockHash,
  compactFromTarget,
  meetsDifficulty,
  mineBlock,
  targetFromBitDifficulty,
  targetFromStoredDifficulty,
  workForDifficulty,
} from './block.js';
import {
  Transaction,
  isCoinbase,
  verifyTransaction,
  createCoinbase,
  createGenesisTx,
} from './transaction.js';
import {
  BLOCK_REWARD,
  MIN_FEE,
  minFeeFor,
  MAX_BLOCK_TXS,
  NULL_ADDRESS,
  GENESIS_TIMESTAMP,
  GENESIS_PREMINE_ADDRESS,
  GENESIS_DIFFICULTY,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  TARGET_BLOCK_TIME_MS,
  RETARGET_INTERVAL,
  POW_V2_HEIGHT,
  POW_V2_RETARGET_INTERVAL,
  POW_V2_MAX_ADJUST_FACTOR,
  MAX_MEMPOOL,
  MAX_FUTURE_DRIFT_MS,
  CHECKPOINTS,
  RED_ESCROW_ADDRESS,
  RED_PREFIX,
  CLAIM_PREFIX,
  REFUND_PREFIX,
  RED_EXPIRY,
  STAKE_ESCROW_ADDRESS,
  STAKING_ACTIVATION_HEIGHT,
  STAKE_PREFIX,
  UNSTAKE_PREFIX,
  SLASH_PREFIX,
  STAKE_MIN,
  STAKE_LOCK_BLOCKS,
  MEASURER_ADDRESS,
  MINT_ESCROW_ADDRESS,
  MINT_ACTIVATION_HEIGHT,
  MINT_DEPOSIT_PREFIX,
  REDEEM_PREFIX,
  MINT_ADDRESS,
  SYSTEM_ADDRESSES,
  MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
  minMessageBurnFor,
  IDENTITY_ESCROW_ADDRESS,
  IDCLAIM_PREFIX,
  IDRELEASE_PREFIX,
  IDENTITY_STAKE_MIN,
  IDENTITY_LOCK_BLOCKS,
  IDENTITY_ACTIVATION_HEIGHT,
} from './config.js';
import { isValidAddress, merkleRoot } from './crypto.js';
import { parseRedCreate, parseClaimId, parseRefundId, computeShare, redSeed, type RedMode } from './redpacket.js';
import { parseStakeCreate, parseUnstakeId, parseSlash, computeStakeMin, type StakePool } from './staking.js';
import { parseRedeem, redeemSplit, isMintDeposit } from './mint.js';
import { isRealMessage } from './messages.js';
import { parseIdentityClaim, parseIdentityRelease, type IdentityStake } from './identity.js';

/** 创世区块：不做 PoW，参数全固定 → 所有节点算出同一个 hash。 */
export function genesisBlock(): Block {
  const tx = createGenesisTx(GENESIS_PREMINE_ADDRESS);
  const template: Omit<Block, 'hash'> = {
    index: 0,
    timestamp: GENESIS_TIMESTAMP,
    prevHash: '0'.repeat(64),
    transactions: [tx],
    merkleRoot: merkleRoot([tx.txid]),
    difficulty: GENESIS_DIFFICULTY,
    nonce: 0,
    miner: NULL_ADDRESS,
  };
  return { ...template, hash: calcBlockHash(template) };
}

/**
 * v1 自适应难度：纯函数，从链历史确定性地算出 index 处区块应满足的前导 0 bit 数。
 * 保留给 POW_V2_HEIGHT 之前的历史链校验。
 */
function expectedDifficultyV1(chain: Block[], index: number): number {
  if (index === 0) return GENESIS_DIFFICULTY;
  const prev = chain[index - 1];
  // 非重定向点，或窗口会触及“时间戳是固定古值”的创世块 → 沿用上一块难度
  if (index % RETARGET_INTERVAL !== 0 || index - RETARGET_INTERVAL < 1) return prev.difficulty;

  const windowStart = chain[index - RETARGET_INTERVAL];
  // 窗口 = prev 与 windowStart 之间的实际耗时，跨越 RETARGET_INTERVAL-1 个出块间隔
  // （避开比特币那个 2015/2016 的 off-by-one，让重定向精确对齐目标）。
  const actual = prev.timestamp - windowStart.timestamp;
  const expected = (RETARGET_INTERVAL - 1) * TARGET_BLOCK_TIME_MS;
  // 每差一倍调 1 bit（log2），钳制单次 ±2；太快→加难度，太慢→减难度
  const delta = actual <= 0 ? 2 : Math.max(-2, Math.min(2, Math.round(Math.log2(expected / actual))));
  return Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, prev.difficulty + delta));
}

const POW_V2_TIMESPAN_MS = POW_V2_RETARGET_INTERVAL * TARGET_BLOCK_TIME_MS;
const POW_LIMIT_TARGET = targetFromBitDifficulty(MIN_DIFFICULTY);
const MIN_POW_TARGET = targetFromBitDifficulty(MAX_DIFFICULTY);

/**
 * v2 BTC 风格难度：difficulty 字段承载 compact target(nBits)。
 * 非重定向点沿用上一块；重定向点按实际耗时比例调整 target，并按 BTC 风格限制单次最多 4 倍。
 */
function expectedDifficultyV2(chain: Block[], index: number): number {
  const prev = chain[index - 1];
  const prevTarget = targetFromStoredDifficulty(prev.difficulty) ?? POW_LIMIT_TARGET;
  if (index === POW_V2_HEIGHT) return compactFromTarget(prevTarget);
  if (index % POW_V2_RETARGET_INTERVAL !== 0 || index - POW_V2_RETARGET_INTERVAL < 1) return prev.difficulty;

  const windowStart = chain[index - POW_V2_RETARGET_INTERVAL];
  let actual = prev.timestamp - windowStart.timestamp;
  const minActual = Math.floor(POW_V2_TIMESPAN_MS / POW_V2_MAX_ADJUST_FACTOR);
  const maxActual = POW_V2_TIMESPAN_MS * POW_V2_MAX_ADJUST_FACTOR;
  if (actual < minActual) actual = minActual;
  if (actual > maxActual) actual = maxActual;

  let nextTarget = (prevTarget * BigInt(actual)) / BigInt(POW_V2_TIMESPAN_MS);
  if (nextTarget > POW_LIMIT_TARGET) nextTarget = POW_LIMIT_TARGET;
  if (nextTarget < MIN_POW_TARGET) nextTarget = MIN_POW_TARGET;
  return compactFromTarget(nextTarget);
}

/**
 * 自适应难度：POW_V2_HEIGHT 前用 v1 bit 难度；激活后用 BTC 风格 compact target。
 */
export function expectedDifficulty(chain: Block[], index: number): number {
  if (index < POW_V2_HEIGHT) return expectedDifficultyV1(chain, index);
  return expectedDifficultyV2(chain, index);
}

/**
 * 链是否与某个 checkpoint 冲突：达到该高度却 hash 不符则返回冲突的 checkpoint，否则 null。
 * 链尚未到达某 checkpoint 高度（仍在同步）时不算冲突。
 */
export function violatesCheckpoint(
  chain: Block[],
  checkpoints: { index: number; hash: string }[] = CHECKPOINTS,
): { index: number; hash: string } | null {
  for (const cp of checkpoints) {
    if (chain.length > cp.index && chain[cp.index].hash !== cp.hash) return cp;
  }
  return null;
}

/** 一个开着的红包池（共识状态的一部分）。claimants 用 Set 做 O(1) 去重。 */
export interface RedPool {
  creator: string;
  total: number;
  count: number;
  mode: RedMode;
  remaining: number; // 剩余金额
  remainingCount: number; // 剩余份数（= 校验“还能不能抢/退”的权威字段；选包阶段也能精确跟踪）
  createHeight: number;
  claimants: Set<string>; // 已抢地址（防重复领）
  refunded: boolean;
}

export interface ChainState {
  balances: Map<string, number>;
  nonces: Map<string, number>;
  pools: Map<string, RedPool>; // 红包池：id（创建交易 txid）→ 池
  stakes: Map<string, StakePool>; // 质押池：id（STAKE 交易 txid）→ 池（Phase 3A-1）
  // 铸币厂储备（Phase A）：**仅**统计激活高度后的 `MINT|DEPOSIT` 减去兑现面额。
  // 刻意与「托管地址原始余额」区分——激活前误入 …3 托管的普通转账不计入可兑现储备（否则会被当成无对应券的储备被兑走，
  // 且与公开视图 computeMintState 不一致）。兑现校验 gross ≤ mintReserve 即以此为准 → 链上储备 ≡ computeMintState。
  mintReserve: number;
  identityClaims: Map<string, IdentityStake>; // 身份质押池：id（IDCLAIM 交易 txid）→ 质押（Phase 3B，无罚没）
  identityByPseudonym: Map<string, string>; // 假名 → 当前活跃 claimId（IDRELEASE 后移除，假名重新可认领）
}

export interface ChainJSON {
  chain: Block[];
  mempool: Transaction[];
}

/**
 * 把一笔非 coinbase 交易分类，并校验“红包操作”的合法性（结合当前 pools）。
 * 返回 null = 合法（红包操作）或非红包（NORMAL，余额/nonce 由调用方另判）；返回字符串 = 非法原因。
 * atHeight = 该交易所在区块高度（REFUND 过期判定用）。**只看 remainingCount/refunded（选包阶段也能精确跟踪），
 * 不看 remaining 金额** —— 保证选包与整链校验对“能否抢/退”得出完全一致的结论。
 */
function redOpError(
  tx: Transaction,
  pools: Map<string, RedPool>,
  stakes: Map<string, StakePool>,
  mintReserve: number,
  identityClaims: Map<string, IdentityStake>,
  identityByPseudonym: Map<string, string>,
  atHeight: number,
  blockDifficulty = GENESIS_DIFFICULTY,
): string | null {
  const m = tx.memo;
  const stakingActive = atHeight >= STAKING_ACTIVATION_HEIGHT;
  if (!stakingActive && (m.startsWith(UNSTAKE_PREFIX) || m.startsWith(SLASH_PREFIX))) {
    return `质押尚未激活（激活高度 ${STAKING_ACTIVATION_HEIGHT}）`;
  }
  const mintActive = atHeight >= MINT_ACTIVATION_HEIGHT;
  // 只拦「amount=0 的兑现新边界」；激活前带 REDEEM| 前缀但 amount>0 的普通转账仍按历史普通交易处理（不 retroactive 破坏旧 memo）。
  if (!mintActive && m.startsWith(REDEEM_PREFIX) && tx.amount === 0) {
    return `铸币厂尚未激活（激活高度 ${MINT_ACTIVATION_HEIGHT}）`;
  }
  const identityActive = atHeight >= IDENTITY_ACTIVATION_HEIGHT;
  // 只拦「amount=0 且 burn=0 的解锁新边界」——这正是真实 IDRELEASE 的形态（见下方 275 行强制 burn=0）。
  // 关键：必须同时要求 burn===0，否则会误伤「amount=0 + burn>0 的普通链上消息，正文恰好以 IDRELEASE| 开头」——
  // 那种消息在本 PR 之前旧节点是合法接受的（verifyTransaction 里 burn>0 即非空操作，照收），若这里无条件按
  // amount=0 拒绝，validateChain 重放历史块时就会把这条老消息判非法 → loadChain/replaceChain 拒绝整条链
  // （retroactive 分叉）。加 burn===0 后：真实解锁（amount=0+burn=0）仍被拦（与旧节点一致地拒空操作），
  // 而 IDRELEASE| 开头的历史消息（burn>0）照常放行，两端节点行为一致、不分叉。
  if (!identityActive && m.startsWith(IDRELEASE_PREFIX) && tx.amount === 0 && (tx.burn ?? 0) === 0) {
    return `身份质押尚未激活（激活高度 ${IDENTITY_ACTIVATION_HEIGHT}）`;
  }
  // ---- 铸币厂操作（DEPOSIT/REDEEM）：与质押 STAKE/SLASH 同款合法性校验 ----
  if (mintActive && m.startsWith(REDEEM_PREFIX)) {
    if ((tx.burn ?? 0) > 0) return '铸币兑现不能附带销毁';
    if (tx.amount !== 0) return '兑现金额须为 0';
    if (tx.from !== MINT_ADDRESS) return '只有铸币厂能兑现';
    const r = parseRedeem(m);
    if (!r) return '兑现格式无效';
    if (SYSTEM_ADDRESSES.has(tx.to)) return '兑现收款不能是系统/托管地址';
    // 偿付：兑现面额 ≤ 铸币储备（= 激活后充值 − 已兑现，不含激活前误入托管的普通转账）。
    if (r.gross > mintReserve) return `兑现超出铸币厂储备（偿付不足：需 ${r.gross}，储备 ${mintReserve}）`;
    return null;
  }
  // 充值 = 转给铸币厂托管地址（旧节点也当普通转账锁进托管 → 不静默分叉）。发往托管地址的交易**必须**是合法充值。
  if (mintActive && tx.to === MINT_ESCROW_ADDRESS) {
    if ((tx.burn ?? 0) > 0) return '铸币充值不能附带销毁';
    if (!isMintDeposit(m)) return '发往铸币厂托管地址的交易必须是合法充值（MINT|DEPOSIT）';
    if (tx.amount < 1) return '充值额须 ≥ 1';
    return null;
  }
  // ---- 质押操作（STAKE/UNSTAKE/SLASH）：与红包 RED/CLAIM/REFUND 同款合法性校验 ----
  if (stakingActive && m.startsWith(UNSTAKE_PREFIX)) {
    if ((tx.burn ?? 0) > 0) return '质押交易不能附带销毁';
    if (tx.amount !== 0) return '赎回金额须为 0';
    const id = parseUnstakeId(m);
    if (!id) return '赎回格式无效';
    const p = stakes.get(id);
    if (!p) return '质押不存在';
    if (tx.from !== p.staker) return '只有质押人能赎回';
    if (p.withdrawn) return '该质押已赎回';
    if (atHeight < p.lockedUntil) return `质押锁定中（需到第 ${p.lockedUntil} 块）`;
    return null;
  }
  if (stakingActive && m.startsWith(SLASH_PREFIX)) {
    if ((tx.burn ?? 0) > 0) return '质押交易不能附带销毁';
    if (tx.amount !== 0) return '罚没金额须为 0';
    if (tx.from !== MEASURER_ADDRESS) return '只有度量者能罚没';
    const s = parseSlash(m);
    if (!s) return '罚没格式无效';
    const p = stakes.get(s.stakeId);
    if (!p) return '质押不存在';
    if (p.withdrawn) return '该质押已赎回，无法罚没';
    if (p.amount - p.slashed <= 0) return '该质押已被罚没殆尽';
    return null;
  }
  // 质押 = 转给托管地址（旧节点也当普通转账锁进托管 → 不静默分叉）。发往托管地址的交易**必须**是合法质押。
  if (stakingActive && tx.to === STAKE_ESCROW_ADDRESS) {
    if ((tx.burn ?? 0) > 0) return '质押交易不能附带销毁';
    const meta = parseStakeCreate(m);
    if (!meta) return '发往质押托管地址的交易必须是合法质押（STAKE|guard或middle或hsdir）';
    const minStake = computeStakeMin(meta.role, blockDifficulty);
    if (tx.amount < minStake) return `质押额须 ≥ 该角色最低押金 ${minStake}（当前难度动态值）`;
    return null;
  }
  // ---- 身份质押操作（IDCLAIM/IDRELEASE）：纯资金锁仓反女巫，无罚没、无仲裁者，与质押 STAKE/UNSTAKE 同款 ----
  if (identityActive && m.startsWith(IDRELEASE_PREFIX)) {
    if ((tx.burn ?? 0) > 0) return '身份操作不能附带销毁';
    if (tx.amount !== 0) return '解锁金额须为 0';
    const id = parseIdentityRelease(m);
    if (!id) return '解锁格式无效';
    const c = identityClaims.get(id);
    if (!c) return '身份质押不存在';
    if (tx.from !== c.staker) return '只有质押人能解锁';
    if (c.released) return '该身份质押已解锁';
    if (atHeight < c.lockedUntil) return `身份质押锁定中（需到第 ${c.lockedUntil} 块）`;
    return null;
  }
  // 认领 = 转给身份托管地址（旧节点也当普通转账锁进托管 → 不静默分叉）。发往托管地址的交易**必须**是合法认领。
  if (identityActive && tx.to === IDENTITY_ESCROW_ADDRESS) {
    if ((tx.burn ?? 0) > 0) return '身份操作不能附带销毁';
    const meta = parseIdentityClaim(m);
    if (!meta) return '发往身份托管地址的交易必须是合法认领（IDCLAIM|<pseudonym>）';
    if (tx.amount < IDENTITY_STAKE_MIN) return `身份押金须 ≥ 最低押金 ${IDENTITY_STAKE_MIN}`;
    if (identityByPseudonym.has(meta.pseudonym)) return `假名“${meta.pseudonym}”已被认领中`;
    return null;
  }
  // ---- 红包操作（RED/CLAIM/REFUND）----
  if (m.startsWith(CLAIM_PREFIX)) {
    if ((tx.burn ?? 0) > 0) return '红包交易不能附带销毁';
    if (tx.amount !== 0) return '领取金额须为 0';
    const id = parseClaimId(m);
    if (!id) return '领取格式无效';
    const p = pools.get(id);
    if (!p) return '红包不存在';
    if (p.refunded || p.remainingCount <= 0) return '红包已抢完或已退款';
    if (tx.from === p.creator) return '不能抢自己发的红包';
    if (p.claimants.has(tx.from)) return '你已经抢过这个红包了';
    return null;
  }
  if (m.startsWith(REFUND_PREFIX)) {
    if ((tx.burn ?? 0) > 0) return '红包交易不能附带销毁';
    if (tx.amount !== 0) return '退款金额须为 0';
    const id = parseRefundId(m);
    if (!id) return '退款格式无效';
    const p = pools.get(id);
    if (!p) return '红包不存在';
    if (tx.from !== p.creator) return '只有发起人能退款';
    if (p.refunded || p.remainingCount <= 0) return '红包无剩余可退';
    if (atHeight - p.createHeight <= RED_EXPIRY) return `红包未过期（需创建后满 ${RED_EXPIRY} 块）`;
    return null;
  }
  // 发红包 = 转给托管地址（旧节点也当普通转账锁进托管 → 不静默分叉）。发往托管地址的交易**必须**是合法红包。
  if (tx.to === RED_ESCROW_ADDRESS) {
    if ((tx.burn ?? 0) > 0) return '红包交易不能附带销毁';
    const meta = parseRedCreate(m);
    if (!meta) return '发往红包托管地址的交易必须是合法红包（RED|份数|r或e）';
    if (tx.amount < meta.count) return '红包总额须 ≥ 份数（每份至少 1）';
    return null;
  }
  // ---- 消息防刷底线：收紧校验，不引入新状态机，故放最后（真消息不命中前面任何托管/前缀分支）----
  if (atHeight >= MIN_MESSAGE_BURN_ACTIVATION_HEIGHT && isRealMessage({ ...tx, atHeight })) {
    const memoLen = [...tx.memo].length; // Unicode 码点，同 MAX_MEMO 口径
    const required = minMessageBurnFor(memoLen);
    if ((tx.burn ?? 0) < required) return `消息销毁额过低（需 ≥ ${required}，当前 ${tx.burn ?? 0}）`;
  }
  return null; // NORMAL
}

/**
 * 把一笔**已校验合法**的非 coinbase 交易应用到状态（余额/nonce/红包池）。
 * computeState 与 validateChain **共用此函数** → 矿工与校验方算出完全一致的派发额（杜绝分叉）。
 * blockHash 用于拼手气随机源（CLAIM）；atHeight 用于记录红包创建高度。
 */
function applyTx(tx: Transaction, st: ChainState, blockHash: string, atHeight: number, blockDifficulty = GENESIS_DIFFICULTY): void {
  const credit = (a: string, amt: number) => st.balances.set(a, (st.balances.get(a) ?? 0) + amt);
  const bump = () => st.nonces.set(tx.from, (st.nonces.get(tx.from) ?? 0) + 1);
  const m = tx.memo;
  // 发红包：转给托管地址 → 锁总额、开池。余额效果 = 普通转账到托管（旧节点也如此），额外开池。
  if (tx.to === RED_ESCROW_ADDRESS && m.startsWith(RED_PREFIX)) {
    const meta = parseRedCreate(m);
    if (meta && tx.amount >= meta.count) {
      credit(tx.from, -(tx.amount + tx.fee));
      credit(RED_ESCROW_ADDRESS, tx.amount);
      st.pools.set(tx.txid, {
        creator: tx.from, total: tx.amount, count: meta.count, mode: meta.mode,
        remaining: tx.amount, remainingCount: meta.count, createHeight: atHeight, claimants: new Set(), refunded: false,
      });
      bump();
      return;
    }
    // 发往托管的非法 RED → 合法链上不会发生（validateChain/redOpError 已拦）；稳妥起见落到 NORMAL
  }
  // 抢红包：从托管派一份给抢的人（拼手气随机额由 blockHash 决定）
  if (m.startsWith(CLAIM_PREFIX) && tx.amount === 0) {
    const id = parseClaimId(m);
    const p = id ? st.pools.get(id) : undefined;
    if (p) {
      const share = computeShare(p.remaining, p.remainingCount, p.mode, redSeed(blockHash, tx.txid));
      credit(tx.from, share - tx.fee); // 收到 share、付出 fee
      credit(RED_ESCROW_ADDRESS, -share);
      p.remaining -= share;
      p.remainingCount -= 1;
      p.claimants.add(tx.from);
      bump();
      return;
    }
  }
  // 退款：发起人取回剩余
  if (m.startsWith(REFUND_PREFIX) && tx.amount === 0) {
    const id = parseRefundId(m);
    const p = id ? st.pools.get(id) : undefined;
    if (p) {
      const amt = p.remaining;
      credit(tx.from, amt - tx.fee);
      credit(RED_ESCROW_ADDRESS, -amt);
      p.remaining = 0;
      p.remainingCount = 0;
      p.refunded = true;
      bump();
      return;
    }
  }
  // ---- 质押托管（Phase 3A-1）：STAKE/UNSTAKE/SLASH，与红包 RED/CLAIM/REFUND 同款，共识权威在此 ----
  // 质押：转给托管地址 → 锁押金、开质押池。余额效果 = 普通转账到托管（旧节点也如此），额外开池。
  if (atHeight >= STAKING_ACTIVATION_HEIGHT && tx.to === STAKE_ESCROW_ADDRESS && m.startsWith(STAKE_PREFIX)) {
    const meta = parseStakeCreate(m);
    if (meta && tx.amount >= computeStakeMin(meta.role, blockDifficulty)) {
      credit(tx.from, -(tx.amount + tx.fee));
      credit(STAKE_ESCROW_ADDRESS, tx.amount);
      st.stakes.set(tx.txid, {
        staker: tx.from, role: meta.role, amount: tx.amount,
        lockedUntil: atHeight + STAKE_LOCK_BLOCKS, createdHeight: atHeight, slashed: 0, withdrawn: false,
      });
      bump();
      return;
    }
    // 发往托管的非法 STAKE → 合法链上不会发生（validateChain/redOpError 已拦）；稳妥起见落到 NORMAL
  }
  // 赎回：质押人取回本金 - 已罚没（已被 redOpError 校验过锁定期/归属/未赎回）
  if (atHeight >= STAKING_ACTIVATION_HEIGHT && m.startsWith(UNSTAKE_PREFIX) && tx.amount === 0) {
    const id = parseUnstakeId(m);
    const p = id ? st.stakes.get(id) : undefined;
    if (p && !p.withdrawn) {
      const principal = p.amount - p.slashed; // 退回本金扣除累计罚没
      credit(tx.from, principal - tx.fee);
      credit(STAKE_ESCROW_ADDRESS, -principal);
      p.withdrawn = true;
      bump();
      return;
    }
  }
  // 罚没：度量者把失职押金从托管移交国库（GENESIS_PREMINE_ADDRESS）；已被 redOpError 校验过度量者权限/池存在
  if (atHeight >= STAKING_ACTIVATION_HEIGHT && m.startsWith(SLASH_PREFIX) && tx.amount === 0 && tx.from === MEASURER_ADDRESS) {
    const s = parseSlash(m);
    const p = s ? st.stakes.get(s.stakeId) : undefined;
    if (s && p && !p.withdrawn) {
      const remaining = p.amount - p.slashed;
      const cut = Math.min(s.amount, Math.max(0, remaining)); // 至多罚没剩余本金
      p.slashed += cut;
      credit(STAKE_ESCROW_ADDRESS, -cut);
      credit(GENESIS_PREMINE_ADDRESS, cut); // 罚没币移交国库（而非烧毁），便于审计与再分配
      credit(tx.from, -tx.fee); // 度量者付打包手续费
      bump();
      return;
    }
  }
  // ---- 身份质押（Phase 3B）：IDCLAIM/IDRELEASE，与质押 STAKE/UNSTAKE 同款，共识权威在此，无罚没 ----
  // 认领：转给身份托管地址 → 锁押金、记录质押。余额效果 = 普通转账到托管（旧节点也如此），额外记录。
  if (atHeight >= IDENTITY_ACTIVATION_HEIGHT && tx.to === IDENTITY_ESCROW_ADDRESS && m.startsWith(IDCLAIM_PREFIX)) {
    const meta = parseIdentityClaim(m);
    if (meta && tx.amount >= IDENTITY_STAKE_MIN && !st.identityByPseudonym.has(meta.pseudonym)) {
      credit(tx.from, -(tx.amount + tx.fee));
      credit(IDENTITY_ESCROW_ADDRESS, tx.amount);
      st.identityClaims.set(tx.txid, {
        staker: tx.from, pseudonym: meta.pseudonym, amount: tx.amount,
        lockedUntil: atHeight + IDENTITY_LOCK_BLOCKS, createdHeight: atHeight, released: false,
      });
      st.identityByPseudonym.set(meta.pseudonym, tx.txid);
      bump();
      return;
    }
    // 发往托管的非法 IDCLAIM → 合法链上不会发生（validateChain/redOpError 已拦）；稳妥起见落到 NORMAL
  }
  // 解锁：质押人取回全部本金（无罚没扣减）；已被 redOpError 校验过锁定期/归属/未解锁
  if (atHeight >= IDENTITY_ACTIVATION_HEIGHT && m.startsWith(IDRELEASE_PREFIX) && tx.amount === 0) {
    const id = parseIdentityRelease(m);
    const c = id ? st.identityClaims.get(id) : undefined;
    if (c && !c.released) {
      credit(tx.from, c.amount - tx.fee); // 全额退回（无罚没）
      credit(IDENTITY_ESCROW_ADDRESS, -c.amount);
      c.released = true;
      if (st.identityByPseudonym.get(c.pseudonym) === id) st.identityByPseudonym.delete(c.pseudonym);
      bump();
      return;
    }
  }
  // ---- 铸币厂充值（Phase A）：转给托管地址 → 锁额、记储备。余额效果 = 普通转账到托管（旧节点也如此），额外累加 mintReserve。
  //      **单列此分支（而非落 NORMAL）**：只有激活后的合法 MINT|DEPOSIT 才计入可兑现储备，排除激活前误入托管的普通转账。
  if (atHeight >= MINT_ACTIVATION_HEIGHT && tx.to === MINT_ESCROW_ADDRESS && isMintDeposit(m)) {
    credit(tx.from, -(tx.amount + tx.fee));
    credit(MINT_ESCROW_ADDRESS, tx.amount);
    st.mintReserve += tx.amount;
    bump();
    return;
  }
  // ---- 铸币厂兑现（Phase A）：从托管付「面额−抽成」给服务方、抽成移交国库；已被 redOpError 校验过授权/储备/收款 ----
  if (atHeight >= MINT_ACTIVATION_HEIGHT && m.startsWith(REDEEM_PREFIX) && tx.amount === 0 && tx.from === MINT_ADDRESS) {
    const r = parseRedeem(m);
    if (r) {
      const { net, fee } = redeemSplit(r.gross);
      credit(MINT_ESCROW_ADDRESS, -r.gross); // 从储备扣面额
      credit(tx.to, net); // 服务方（=收款）实得 面额−抽成
      credit(GENESIS_PREMINE_ADDRESS, fee); // 抽成回流国库（→ reward-epoch 养中继）
      credit(tx.from, -tx.fee); // 铸币厂付打包手续费
      st.mintReserve -= r.gross; // 储备减少（与 computeMintState 一致）
      bump();
      return;
    }
  }
  // 普通交易（转账/消息/昵称/集市）
  const burn = tx.burn ?? 0;
  credit(tx.from, -(tx.amount + tx.fee + burn));
  credit(tx.to, tx.amount);
  if (burn > 0) credit(NULL_ADDRESS, burn);
  bump();
}

/**
 * 选包阶段的“应用”：与 applyTx 一致地推进 nonce/红包池的**校验字段**（remainingCount/claimants/refunded），
 * 但 CLAIM 的派发额依赖尚不存在的区块 hash，故只“占位扣 fee、占一份”，不结算 share。
 * 这不影响所选块能否通过 validateChain（合法性只看 remainingCount/claimants/refunded，派发额永远在范围内）。
 */
function applySelect(tx: Transaction, st: ChainState, atHeight: number, blockDifficulty = GENESIS_DIFFICULTY): void {
  const credit = (a: string, amt: number) => st.balances.set(a, (st.balances.get(a) ?? 0) + amt);
  const bump = () => st.nonces.set(tx.from, (st.nonces.get(tx.from) ?? 0) + 1);
  const m = tx.memo;
  if (tx.to === RED_ESCROW_ADDRESS && m.startsWith(RED_PREFIX)) {
    const meta = parseRedCreate(m);
    if (meta && tx.amount >= meta.count) {
      credit(tx.from, -(tx.amount + tx.fee));
      credit(RED_ESCROW_ADDRESS, tx.amount);
      st.pools.set(tx.txid, {
        creator: tx.from, total: tx.amount, count: meta.count, mode: meta.mode,
        remaining: tx.amount, remainingCount: meta.count, createHeight: atHeight, claimants: new Set(), refunded: false,
      });
      bump();
      return;
    }
  }
  if (m.startsWith(CLAIM_PREFIX) && tx.amount === 0) {
    const id = parseClaimId(m);
    const p = id ? st.pools.get(id) : undefined;
    if (p) {
      credit(tx.from, -tx.fee); // share 未知，仅扣 fee；占一份
      p.remainingCount -= 1;
      p.claimants.add(tx.from);
      bump();
      return;
    }
  }
  if (m.startsWith(REFUND_PREFIX) && tx.amount === 0) {
    const id = parseRefundId(m);
    const p = id ? st.pools.get(id) : undefined;
    if (p) {
      credit(tx.from, p.remaining - tx.fee);
      credit(RED_ESCROW_ADDRESS, -p.remaining);
      p.remaining = 0;
      p.remainingCount = 0;
      p.refunded = true;
      bump();
      return;
    }
  }
  // 质押操作在选包阶段与 applyTx 完全一致（无区块 hash 依赖 → 可原样推进，杜绝选包/校验分歧）
  if (atHeight >= STAKING_ACTIVATION_HEIGHT && tx.to === STAKE_ESCROW_ADDRESS && m.startsWith(STAKE_PREFIX)) {
    const meta = parseStakeCreate(m);
    if (meta && tx.amount >= computeStakeMin(meta.role, blockDifficulty)) {
      credit(tx.from, -(tx.amount + tx.fee));
      credit(STAKE_ESCROW_ADDRESS, tx.amount);
      st.stakes.set(tx.txid, {
        staker: tx.from, role: meta.role, amount: tx.amount,
        lockedUntil: atHeight + STAKE_LOCK_BLOCKS, createdHeight: atHeight, slashed: 0, withdrawn: false,
      });
      bump();
      return;
    }
  }
  if (atHeight >= STAKING_ACTIVATION_HEIGHT && m.startsWith(UNSTAKE_PREFIX) && tx.amount === 0) {
    const id = parseUnstakeId(m);
    const p = id ? st.stakes.get(id) : undefined;
    if (p && !p.withdrawn) {
      const principal = p.amount - p.slashed;
      credit(tx.from, principal - tx.fee);
      credit(STAKE_ESCROW_ADDRESS, -principal);
      p.withdrawn = true;
      bump();
      return;
    }
  }
  if (atHeight >= STAKING_ACTIVATION_HEIGHT && m.startsWith(SLASH_PREFIX) && tx.amount === 0 && tx.from === MEASURER_ADDRESS) {
    const s = parseSlash(m);
    const p = s ? st.stakes.get(s.stakeId) : undefined;
    if (s && p && !p.withdrawn) {
      const remaining = p.amount - p.slashed;
      const cut = Math.min(s.amount, Math.max(0, remaining));
      p.slashed += cut;
      credit(STAKE_ESCROW_ADDRESS, -cut);
      credit(GENESIS_PREMINE_ADDRESS, cut);
      credit(tx.from, -tx.fee);
      bump();
      return;
    }
  }
  // 身份质押在选包阶段与 applyTx 完全一致（无区块 hash 依赖 → 可原样推进，杜绝选包/校验分歧）
  if (atHeight >= IDENTITY_ACTIVATION_HEIGHT && tx.to === IDENTITY_ESCROW_ADDRESS && m.startsWith(IDCLAIM_PREFIX)) {
    const meta = parseIdentityClaim(m);
    if (meta && tx.amount >= IDENTITY_STAKE_MIN && !st.identityByPseudonym.has(meta.pseudonym)) {
      credit(tx.from, -(tx.amount + tx.fee));
      credit(IDENTITY_ESCROW_ADDRESS, tx.amount);
      st.identityClaims.set(tx.txid, {
        staker: tx.from, pseudonym: meta.pseudonym, amount: tx.amount,
        lockedUntil: atHeight + IDENTITY_LOCK_BLOCKS, createdHeight: atHeight, released: false,
      });
      st.identityByPseudonym.set(meta.pseudonym, tx.txid);
      bump();
      return;
    }
  }
  if (atHeight >= IDENTITY_ACTIVATION_HEIGHT && m.startsWith(IDRELEASE_PREFIX) && tx.amount === 0) {
    const id = parseIdentityRelease(m);
    const c = id ? st.identityClaims.get(id) : undefined;
    if (c && !c.released) {
      credit(tx.from, c.amount - tx.fee);
      credit(IDENTITY_ESCROW_ADDRESS, -c.amount);
      c.released = true;
      if (st.identityByPseudonym.get(c.pseudonym) === id) st.identityByPseudonym.delete(c.pseudonym);
      bump();
      return;
    }
  }
  // 铸币充值/兑现在选包阶段与 applyTx 完全一致（无区块 hash 依赖 → 可原样推进，杜绝选包/校验分歧）
  if (atHeight >= MINT_ACTIVATION_HEIGHT && tx.to === MINT_ESCROW_ADDRESS && isMintDeposit(m)) {
    credit(tx.from, -(tx.amount + tx.fee));
    credit(MINT_ESCROW_ADDRESS, tx.amount);
    st.mintReserve += tx.amount;
    bump();
    return;
  }
  if (atHeight >= MINT_ACTIVATION_HEIGHT && m.startsWith(REDEEM_PREFIX) && tx.amount === 0 && tx.from === MINT_ADDRESS) {
    const r = parseRedeem(m);
    if (r) {
      const { net, fee } = redeemSplit(r.gross);
      credit(MINT_ESCROW_ADDRESS, -r.gross);
      credit(tx.to, net);
      credit(GENESIS_PREMINE_ADDRESS, fee);
      credit(tx.from, -tx.fee);
      st.mintReserve -= r.gross;
      bump();
      return;
    }
  }
  const burn = tx.burn ?? 0;
  credit(tx.from, -(tx.amount + tx.fee + burn));
  credit(tx.to, tx.amount);
  if (burn > 0) credit(NULL_ADDRESS, burn);
  bump();
}

export class Blockchain {
  chain: Block[];
  mempool: Transaction[] = [];
  /**
   * revalidateMempool 剔除交易时的回调（可选，供上层如 V0idNode 挂载）：同步清理调用方自己的
   * P2P 去重缓存（如 seenTx），避免被剔除交易的 txid 仍被当作“已处理过”而静默吞掉外部客户端的
   * 重新提交。用回调而非返回值/共享字段：revalidateMempool 可能在挖矿（PoW 异步计算期间）与
   * P2P 收块两条路径交错触发，共享字段会被后触发的一次覆盖、丢失前一次的清理信息；回调在
   * revalidateMempool 内部同步调用，不依赖调用方“事后”读取的时机，没有这个竞态风险。
   */
  onMempoolDropped?: (txids: string[]) => void;

  constructor() {
    this.chain = [genesisBlock()];
  }

  get latest(): Block {
    return this.chain[this.chain.length - 1];
  }

  /** 链高（创世为 0） */
  get height(): number {
    return this.chain.length - 1;
  }

  /** 下一块要求的难度（供展示用） */
  tipDifficulty(): number {
    return expectedDifficulty(this.chain, this.height + 1);
  }

  // ---- 状态：重放整条链，得到余额表 / nonce 表 / 红包池（假定链已合法；校验在 validateChain）----
  computeState(chain: Block[] = this.chain): ChainState {
    const st: ChainState = { balances: new Map(), nonces: new Map(), pools: new Map(), stakes: new Map(), mintReserve: 0, identityClaims: new Map(), identityByPseudonym: new Map() };
    for (const block of chain) {
      for (const tx of block.transactions) {
        if (isCoinbase(tx)) {
          st.balances.set(tx.to, (st.balances.get(tx.to) ?? 0) + tx.amount); // 矿工/预挖收款
          continue;
        }
        applyTx(tx, st, block.hash, block.index, block.difficulty); // 与 validateChain 同一套状态机
      }
    }
    return st;
  }

  balanceOf(address: string): number {
    return this.computeState().balances.get(address) ?? 0;
  }

  /** 某地址已上链的交易数 = 下一笔交易应使用的 nonce */
  nonceOf(address: string): number {
    return this.computeState().nonces.get(address) ?? 0;
  }

  // ---- mempool：待打包交易池 ----
  /** 收一笔交易进池。会校验签名、nonce 顺序、（含池内待发）余额。 */
  addTransaction(tx: Transaction): { ok: boolean; error?: string } {
    if (isCoinbase(tx)) return { ok: false, error: 'coinbase 不能进入交易池' };
    if (this.mempool.length >= MAX_MEMPOOL) return { ok: false, error: '交易池已满' };
    // 先单独判金额/销毁额/手续费，给出明确报错（否则非整数/费太低会被 verifyTransaction 笼统当成“签名无效”，误导用户）
    const burn = tx.burn ?? 0;
    const isZeroOp =
      typeof tx.memo === 'string' &&
      (tx.memo.startsWith(CLAIM_PREFIX) ||
        tx.memo.startsWith(REFUND_PREFIX) ||
        tx.memo.startsWith(UNSTAKE_PREFIX) ||
        tx.memo.startsWith(SLASH_PREFIX) ||
        tx.memo.startsWith(REDEEM_PREFIX) ||
        tx.memo.startsWith(IDRELEASE_PREFIX));
    if (!Number.isInteger(tx.amount) || tx.amount < 0) return { ok: false, error: '金额必须是非负整数' };
    if (!Number.isInteger(burn) || burn < 0) return { ok: false, error: '销毁额必须是非负整数' };
    if (tx.amount === 0 && burn === 0 && !isZeroOp) return { ok: false, error: '空交易：转账须金额>0，消息须销毁额>0' };
    const minRequired = minFeeFor(tx.amount);
    if (!Number.isInteger(tx.fee) || tx.fee < minRequired) return { ok: false, error: `手续费至少 ${minRequired} gas` };
    if (!verifyTransaction(tx)) return { ok: false, error: '签名无效或备注超长' };
    if (!isValidAddress(tx.to) || tx.to === NULL_ADDRESS) {
      return { ok: false, error: '收款地址格式无效' }; // 防止打钱给畸形/空地址导致永久销毁
    }
    // 发往红包托管地址只允许合法红包（RED）；其它一律拒（防误把钱锁死）。redOpError 下方统一判。
    if (this.mempool.some((t) => t.txid === tx.txid)) return { ok: false, error: '交易已在池中' };

    const r = this.admitAgainstState(tx, this.computeState());
    if (!r.ok) return r;
    this.mempool.push(tx);
    return { ok: true };
  }

  /**
   * addTransaction 里“依赖链上状态”的那部分校验（红包/质押/铸币/身份合法性 + nonce 顺序 + 余额），
   * 抽成独立方法只为了让 revalidateMempool 能**复用同一份 computeState() 快照**给 mempool 里的每一笔
   * 旧交易判断，而不是像原先那样每笔都各自重新 computeState() 一遍（见 revalidateMempool 的性能注释）。
   * `state` 由调用方传入（正常提交路径传新鲜的 this.computeState()；批量重验路径传共享的那一份）。
   */
  private admitAgainstState(tx: Transaction, state: ChainState): { ok: boolean; error?: string } {
    const { balances, nonces, pools, stakes, mintReserve, identityClaims, identityByPseudonym } = state;
    const burn = tx.burn ?? 0;
    // 红包/质押/铸币/身份操作合法性：池存在/未抢完/未重复领/已过期、质押锁定期/度量者权限、铸币储备、
    // 身份假名是否已被占用等（按 height+1 估算，与 selectMempoolTxs 的口径一致）
    const redErr = redOpError(tx, pools, stakes, mintReserve, identityClaims, identityByPseudonym, this.height + 1, this.tipDifficulty());
    if (redErr) return { ok: false, error: redErr };
    // pending 仍按“当前已在 this.mempool 里的同地址交易”统计——revalidateMempool 会在循环中逐步重建
    // this.mempool，这个统计口径天然随重建进度演进，语义与原先逐笔重新 addTransaction 完全一致。
    const pending = this.mempool.filter((t) => t.from === tx.from);
    const expectedNonce = (nonces.get(tx.from) ?? 0) + pending.length;
    if (tx.nonce !== expectedNonce) {
      return { ok: false, error: `nonce 错误：期望 ${expectedNonce}，收到 ${tx.nonce}` };
    }
    // 占用额 = 金额 + 手续费 + 销毁额（含池中本地址其它待发交易），都要先扣住，避免连环超支
    const pendingOut = pending.reduce((s, t) => s + t.amount + t.fee + (t.burn ?? 0), 0);
    const need = tx.amount + tx.fee + burn;
    const available = (balances.get(tx.from) ?? 0) - pendingOut;
    if (need > available) {
      const extra = burn > 0 ? `手续费 ${tx.fee} + 销毁 ${burn}` : `手续费 ${tx.fee}`;
      return { ok: false, error: `余额不足：可用 ${available}，需要 ${need}（含${extra}）` };
    }
    return { ok: true };
  }

  /**
   * 从 mempool 挑出能干净应用到当前链顶的交易（保证打出的块必然合法）。
   * 手续费市场：按 fee 从高到低排序（txid 兜底决定性）；多趟扫描，让先入的低 nonce 交易解锁
   * 同一发送方的后续 nonce；最多挑 MAX_BLOCK_TXS 笔 —— 拥堵时给得多的先上链。
   */
  private selectMempoolTxs(): Transaction[] {
    const st = this.computeState(); // {balances, nonces, pools}（pools 含真实剩余，本块将打到 height+1）
    const atHeight = this.height + 1;
    const queue: (Transaction | undefined)[] = [...this.mempool].sort(
      (a, b) => b.fee - a.fee || (a.txid < b.txid ? -1 : 1),
    );
    const selected: Transaction[] = [];
    let progressed = true;
    while (progressed && selected.length < MAX_BLOCK_TXS) {
      progressed = false;
      for (let i = 0; i < queue.length && selected.length < MAX_BLOCK_TXS; i++) {
        const tx = queue[i];
        if (!tx) continue;
        const expected = st.nonces.get(tx.from) ?? 0;
        const cost = tx.amount + tx.fee + (tx.burn ?? 0); // 发送方实付（RED=总额+费；CLAIM/REFUND=费）
        // 同 validateChain 的接纳条件：nonce 对、红包操作合法、余额够付、自洽签名 → 必能通过整链校验
        if (
          tx.nonce === expected &&
          !redOpError(tx, st.pools, st.stakes, st.mintReserve, st.identityClaims, st.identityByPseudonym, atHeight, this.tipDifficulty()) &&
          cost <= (st.balances.get(tx.from) ?? 0) &&
          verifyTransaction(tx)
        ) {
          selected.push(tx);
          applySelect(tx, st, atHeight, this.tipDifficulty()); // 推进 nonce/池校验字段（CLAIM 仅占位、不结算 share）
          queue[i] = undefined;
          progressed = true;
        }
      }
    }
    return selected;
  }

  // ---- 挖矿 ----
  /** 打包 coinbase + mempool 交易，按自适应难度做 PoW，成功则上链。返回新块或 null（被打断）。 */
  async mine(minerAddress: string, shouldStop?: () => boolean): Promise<Block | null> {
    const index = this.height + 1;
    const picked = this.selectMempoolTxs();
    const fees = picked.reduce((s, t) => s + t.fee, 0); // 本块手续费总额，并入 coinbase 归矿工
    const transactions = [createCoinbase(minerAddress, index, fees), ...picked];
    // 时间戳不能早于链顶（校验要求单调不减）
    const timestamp = Math.max(Date.now(), this.latest.timestamp);
    const template: Omit<Block, 'hash' | 'nonce'> = {
      index,
      timestamp,
      prevHash: this.latest.hash,
      transactions,
      merkleRoot: merkleRoot(transactions.map((t) => t.txid)),
      difficulty: expectedDifficulty(this.chain, index),
      miner: minerAddress,
    };
    const block = await mineBlock(template, shouldStop);
    if (!block) return null;
    return this.addBlock(block).ok ? block : null;
  }

  // ---- 上链 / 共识 ----
  /**
   * 追加一个区块（必须是当前链顶的下一块，且整体合法）。
   * dropMined 之后再 revalidateMempool：不是所有“未被打进这块”的 mempool 交易都只是在排队——像
   * IDCLAIM 认领假名这类有“排他性”的操作，一旦被抢先打进链，队列里同名的另一笔就**永久**不再合法
   * （不像红包/质押那样，落选只是暂时的、下一块还有机会）。若不清掉，selectMempoolTxs 会一直跳过它、
   * 卡住该地址后续所有交易的 nonce 序列，直到手动清 mempool。revalidateMempool 本就在 replaceChain
   * （reorg）用于同样目的，这里复用同一套机制覆盖“正常出块”路径。
   */
  addBlock(block: Block): { ok: boolean; error?: string } {
    if (block.index !== this.height + 1) return { ok: false, error: '区块高度不连续' };
    if (block.prevHash !== this.latest.hash) return { ok: false, error: 'prevHash 不匹配' };
    const v = Blockchain.validateChain([...this.chain, block]);
    if (!v.ok) return { ok: false, error: v.error };
    this.chain.push(block);
    this.dropMined(block);
    this.revalidateMempool();
    return { ok: true };
  }

  /**
   * 一条链的累计 PoW 工作量：v1 为 Σ 2^difficulty；v2 为 BTC 风格 target proof。
   * 各链共享同一创世，创世项在比较中抵消，故是否计入不影响结果。
   */
  static chainWork(chain: Block[]): bigint {
    let work = 0n;
    for (const b of chain) work += workForDifficulty(b.difficulty);
    return work;
  }

  /**
   * 最大工作量规则（非“最长链”）：只接受**累计 PoW 工作量严格更大**的合法链。
   * 这堵死了“压低难度→多挖几块凑长度”的廉价 fork —— 长度不值钱，工作量才值钱：
   * 一条靠时间戳操纵把难度压到地板、再狂出低难块凑长度的链，总工作量低于诚实链，会被拒。
   */
  replaceChain(incoming: Block[]): { ok: boolean; replaced: boolean; error?: string } {
    if (Blockchain.chainWork(incoming) <= Blockchain.chainWork(this.chain)) {
      return { ok: true, replaced: false };
    }
    // 深度 reorg 防线：本链已越过的 checkpoint 不容被回滚——incoming 必须也达到这些高度。
    // （validateChain 另保证 incoming 在它达到的 checkpoint 高度上 hash 吻合。）
    for (const cp of CHECKPOINTS) {
      if (this.height >= cp.index && incoming.length <= cp.index) {
        return { ok: false, replaced: false, error: `拒绝越过 checkpoint #${cp.index} 的 reorg` };
      }
    }
    const v = Blockchain.validateChain(incoming);
    if (!v.ok) return { ok: false, replaced: false, error: v.error };
    this.chain = incoming;
    this.revalidateMempool();
    return { ok: true, replaced: true };
  }

  private dropMined(block: Block): void {
    const mined = new Set(block.transactions.map((t) => t.txid));
    this.mempool = this.mempool.filter((t) => !mined.has(t.txid));
  }

  /**
   * 用最新已确认状态重新过滤 mempool：剔除因新区块而不再合法的交易（如两笔互斥的 IDCLAIM 抢同一
   * 假名，一笔上链后另一笔永久失效，见 addBlock 的调用点注释）。
   *
   * ⚠️ 性能要点：只调用**一次** computeState()（重放整条链）供本轮所有旧 mempool 交易共用，而非
   * 像之前那样对每笔交易各自调用一次 addTransaction（后者内部每次都重新 computeState）——mempool
   * 上限 5000、每块只能打包 50 笔，若每次出块都对剩余的成千上万笔各重放一次全链，链一长就会让每次
   * 出块/收块都变得极慢（O(mempool × chainLength)）。签名/格式自洽性不必重查：mempool 里已存的交易
   * 在最初 addTransaction 时已经过完整校验，这些字段不会因为新区块而改变；只有依赖链上状态的部分
   * （redOpError/nonce/余额，即 admitAgainstState）需要用新状态重新判一遍。
   */
  private revalidateMempool(): void {
    const old = this.mempool;
    this.mempool = [];
    const state = this.computeState(); // 只算一次，供本轮所有旧交易共用
    const dropped: string[] = [];
    for (const tx of old) {
      if (this.admitAgainstState(tx, state).ok) this.mempool.push(tx);
      else dropped.push(tx.txid);
    }
    if (dropped.length > 0) this.onMempoolDropped?.(dropped);
  }

  // ---- 整链校验（共识的唯一权威）----
  static validateChain(chain: Block[]): { ok: boolean; error?: string } {
    if (chain.length === 0) return { ok: false, error: '空链' };
    // 创世块必须与本地规范创世一致：既比对 .hash 字段（chain[1].prevHash 据此链接），
    // 又用内容重算 hash（绝不信任 wire 上的 .hash）。配合下方“每笔交易 txid===内容哈希”
    // 与 merkleRoot 校验，创世内容被完全锁定 —— 攻击者既改不了预挖归属，也无法凭空增发。
    const g = genesisBlock();
    if (chain[0].hash !== g.hash || calcBlockHash(chain[0]) !== g.hash) {
      return { ok: false, error: '创世块不一致' };
    }
    // checkpoint：达到某硬编码高度的区块 hash 必须吻合（冻结历史，挡深度 reorg）
    const badCp = violatesCheckpoint(chain);
    if (badCp) return { ok: false, error: `#${badCp.index} 与 checkpoint 不一致` };

    // 状态机：余额/nonce/红包池。与 computeState 共用 applyTx，确保各节点一致。
    const st: ChainState = { balances: new Map(), nonces: new Map(), pools: new Map(), stakes: new Map(), mintReserve: 0, identityClaims: new Map(), identityByPseudonym: new Map() };

    for (let i = 0; i < chain.length; i++) {
      const b = chain[i];
      const isGenesis = i === 0;

      if (!isGenesis) {
        const prev = chain[i - 1];
        if (b.index !== prev.index + 1) return { ok: false, error: `#${i} 高度不连续` };
        if (b.prevHash !== prev.hash) return { ok: false, error: `#${i} prevHash 不匹配` };
        if (b.timestamp < prev.timestamp) return { ok: false, error: `#${i} 时间戳倒退` };
        // 唯一一处“与本地时钟相关”的上下文校验：拒绝远超本地时间的未来时间戳。
        // 否则矿工可把时间戳调到 1 小时后拉长重定向窗口、把难度压到地板（时间戳操纵）。
        if (b.timestamp > Date.now() + MAX_FUTURE_DRIFT_MS) {
          return { ok: false, error: `#${i} 时间戳来自未来` };
        }
        // merkleRoot 必须等于交易集重算结果（区块头据此承诺整组交易）
        if (b.merkleRoot !== merkleRoot(b.transactions.map((t) => t.txid))) {
          return { ok: false, error: `#${i} merkleRoot 不匹配` };
        }
        // 难度必须等于由历史确定性算出的期望值（杜绝矿工私自降难度）
        if (b.difficulty !== expectedDifficulty(chain, i)) {
          return { ok: false, error: `#${i} 难度不符（期望 ${expectedDifficulty(chain, i)}）` };
        }
        if (calcBlockHash(b) !== b.hash) return { ok: false, error: `#${i} 区块 hash 被篡改` };
        if (!meetsDifficulty(b.hash, b.difficulty)) return { ok: false, error: `#${i} 未满足 PoW 难度` };

        const cb = b.transactions[0];
        if (!cb || !isCoinbase(cb)) return { ok: false, error: `#${i} 缺少 coinbase` };
        if (cb.to !== b.miner) return { ok: false, error: `#${i} coinbase 收款与矿工不符` };
        // coinbase 金额 = 出块奖励 + 本块所有普通交易的手续费之和；多一分少一分都判非法 → 杜绝矿工凭空多发
        const blockFees = b.transactions.slice(1).reduce((s, t) => s + t.fee, 0);
        if (cb.amount !== BLOCK_REWARD + blockFees) {
          return { ok: false, error: `#${i} 区块奖励金额错误（应为 出块奖励 ${BLOCK_REWARD} + 手续费 ${blockFees}）` };
        }
        if (b.transactions.slice(1).some(isCoinbase)) return { ok: false, error: `#${i} 多个 coinbase` };
      }

      for (let j = 0; j < b.transactions.length; j++) {
        const tx = b.transactions[j];
        if (isCoinbase(tx)) {
          if (!isGenesis && j !== 0) return { ok: false, error: `#${i} coinbase 不在首位` };
          // coinbase/创世也必须校验 txid===内容哈希，把金额/收款方绑定到 txid，
          // 从而经由 merkleRoot→区块 hash 被 PoW 真正锚定，杜绝凭空增发。
          if (!verifyTransaction(tx)) return { ok: false, error: `#${i} coinbase txid 与内容不符` };
          st.balances.set(tx.to, (st.balances.get(tx.to) ?? 0) + tx.amount);
          continue;
        }
        if (!verifyTransaction(tx)) return { ok: false, error: `#${i} 交易签名无效或手续费过低` };
        const expected = st.nonces.get(tx.from) ?? 0;
        if (tx.nonce !== expected) {
          return { ok: false, error: `#${i} nonce 错误（${tx.from.slice(0, 10)}… 期望 ${expected}）` };
        }
        // 普通交易不得打到空地址（销毁应走 burn 字段）；发往托管地址的合法性交给 redOpError 判
        if (tx.to === NULL_ADDRESS) return { ok: false, error: `#${i} 收款为空地址非法` };
        // 红包操作合法性（池存在/未抢完/未重复领/发起人退款且已过期…）；非红包返回 null
        const redErr = redOpError(tx, st.pools, st.stakes, st.mintReserve, st.identityClaims, st.identityByPseudonym, b.index, b.difficulty);
        if (redErr) return { ok: false, error: `#${i} 红包/质押/铸币：${redErr}` };
        // 余额够付：发送方实付 = 金额 + 手续费 + 销毁额（RED=总额+费；CLAIM/REFUND=费；收到的 share 由 applyTx 入账）
        const cost = tx.amount + tx.fee + (tx.burn ?? 0);
        if (cost > (st.balances.get(tx.from) ?? 0)) {
          return { ok: false, error: `#${i} 余额不足（双花/超额，含手续费与销毁额）` };
        }
        applyTx(tx, st, b.hash, b.index, b.difficulty); // 与 computeState 同一套：扣款/派发/退款/开池 一致
      }
    }
    return { ok: true };
  }

  // ---- 序列化 ----
  toJSON(): ChainJSON {
    return { chain: this.chain, mempool: this.mempool };
  }

  static fromJSON(data: ChainJSON): Blockchain {
    const bc = new Blockchain();
    bc.chain = data.chain;
    bc.mempool = data.mempool ?? [];
    return bc;
  }
}
