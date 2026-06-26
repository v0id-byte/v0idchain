// 中继质押托管自检（Phase 3A-1；3A-2/3/4 修复使其重新可达）。跑：corepack pnpm exec tsx scripts/staking-selftest.ts
// 覆盖：STAKE 开池/扣款/锁定、UNSTAKE 锁定期+本金退还+防重复、SLASH **决策/成形/非度量者被拒**、
//       分叉安全（computeState ≡ validateChain ≡ Blockchain.validateChain）、质押门槛选路过滤、激活/配置向量。
//
// ⚠️ 修复记录（3A-2/3/4）：已合入的「激活门控」提交（gate staking activation, 29aa9ba）在「激活前门控」段尾
//    加了一个早退 `process.exit`，使其**下方所有 STAKE/UNSTAKE/SLASH 状态机断言不可达**（永远跑不到、等于没测）。
//    本次修复：① 去掉那处早退（改为打印小节通过、继续往下跑）；② 因质押仅在高度 ≥ STAKING_ACTIVATION_HEIGHT
//    才激活，状态机各场景先用 forge-chain **便宜地把链推到激活高度**（不做 16000 次真 PoW），再发 STAKE/UNSTAKE；
//    ③ **SLASH 接受**需要 MEASURER_ADDRESS 的私钥（**故意不在仓库**）——本地无任何私钥能匹配该固定常量，
//    故无法在本地落地一笔被共识**接受**的 SLASH。于是把原先「度量者签发 SLASH 被接受」的断言**替换为
//    「任何本地生成的签发者（即便我们希望它是度量者）都被共识拒」**，并写明**链上 SLASH 接受属部署期**
//    （部署者持 MEASURER_ADDRESS 私钥时才成立，见 docs / measurer.ts）。SLASH 的**决策逻辑 + 交易成形**
//    另在 scripts/slash-decide-test.ts 全面覆盖。
import {
  Blockchain,
  Wallet,
  createTransaction,
  parseStakeCreate,
  parseUnstakeId,
  parseSlash,
  computeStakeState,
  parseRelaysFiltered,
  buildRelayMemo,
  makeStake,
  STAKE_ESCROW_ADDRESS,
  STAKE_PREFIX,
  UNSTAKE_PREFIX,
  SLASH_PREFIX,
  STAKE_MIN,
  STAKE_LOCK_BLOCKS,
  MEASURER_ADDRESS,
  STAKING_ACTIVATION_HEIGHT,
  GENESIS_PREMINE,
  BLOCK_REWARD,
  MIN_FEE,
  minFeeFor,
  type Block,
} from '../packages/core/src/index.js';
import { forgeTo } from './forge-chain.js';

let failed = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
}

// 守恒量：全网总额恒 = 预挖 + 链高×出块奖励（手续费/罚没只搬运，不增发/不丢失）
const supply = (bc: Blockchain) => [...bc.computeState().balances.values()].reduce((s, v) => s + v, 0);
const conserved = (bc: Blockchain) => supply(bc) === GENESIS_PREMINE + bc.height * BLOCK_REWARD;

const measurer = Wallet.generate(); // 自检只能验证非度量者会被拒；生产 MEASURER_ADDRESS 的私钥不在仓库内。
const fakeId = 'a'.repeat(64);

// ---- 一条 forge 到激活高度的「基底链」：coinbase 全发给 funder，供各状态机场景克隆复用（只 forge 一次，省时）----
// 各场景从它的深拷贝出发，再由 funder 转账给场景中继/度量者起步资金。这样把唯一一次昂贵 forge（~15s）摊给所有场景。
const funder = Wallet.generate();
let baseSnapshot: Block[] = [];

/** 从基底快照克隆一条已激活高度的链（深拷贝，互不影响）。 */
function activatedClone(): Blockchain {
  return Blockchain.fromJSON({ chain: JSON.parse(JSON.stringify(baseSnapshot)), mempool: [] });
}

/** 由 funder 给 to 转一笔起步资金并 forge 进一块（链已在激活高度，难度在地板，单块很便宜）。 */
async function fund(bc: Blockchain, to: string, amount: number): Promise<void> {
  const tx = createTransaction(funder, to, amount, bc.nonceOf(funder.address), '', minFeeFor(amount));
  if (!bc.addTransaction(tx).ok) throw new Error('fund: 转账未进 mempool（funder 余额不足？）');
  await bc.mine(funder.address); // funder 既转账又作矿工（手续费+出块奖励回流给 funder，不影响 to 收到的 amount）
}

async function main() {
  console.log(`\n— 配置向量：生产配置不导出度量者私钥，质押有显式激活高度 —`);
  check('MEASURER_ADDRESS 是地址而非私钥/种子', MEASURER_ADDRESS.startsWith('0x') && MEASURER_ADDRESS.length === 66);
  check('质押激活高度 > 当前 checkpoint 历史', STAKING_ACTIVATION_HEIGHT > 300);
  check('托管地址 = 0x…2（与红包 …1 区分）', STAKE_ESCROW_ADDRESS === '0x' + '0'.repeat(63) + '2');
  check('角色最低押金 Guard ≥ HSDir ≥ Middle', STAKE_MIN.guard >= STAKE_MIN.hsdir && STAKE_MIN.hsdir >= STAKE_MIN.middle);

  console.log(`\n— 纯解析器：parseStakeCreate / parseUnstakeId / parseSlash（非法返回 null）—`);
  check('STAKE|guard → {role:guard}', parseStakeCreate(`${STAKE_PREFIX}guard`)?.role === 'guard');
  check('STAKE|exit 非法（v1 无 exit）→ null', parseStakeCreate(`${STAKE_PREFIX}exit`) === null);
  check('STAKE|（空角色）→ null', parseStakeCreate(STAKE_PREFIX) === null);
  check('UNSTAKE|<64hex> → id', parseUnstakeId(`${UNSTAKE_PREFIX}${fakeId}`) === fakeId);
  check('UNSTAKE|短id → null', parseUnstakeId(`${UNSTAKE_PREFIX}abc`) === null);
  const sl = parseSlash(`${SLASH_PREFIX}${fakeId}|7|3`);
  check('SLASH|<id>|7|3 → {amount:7,epoch:3}', sl?.stakeId === fakeId && sl?.amount === 7 && sl?.epoch === 3);
  check('SLASH 金额 0 非法 → null', parseSlash(`${SLASH_PREFIX}${fakeId}|0|3`) === null);
  check('SLASH 缺字段 → null', parseSlash(`${SLASH_PREFIX}${fakeId}|7`) === null);
  check('makeStake(guard) 返回 ok + memo', makeStake('guard').ok === true && typeof makeStake('guard').memo === 'string');

  // ---- 激活前门控（保留；不再早退，继续往下跑状态机断言）----
  console.log(`\n— 激活门控：激活前不把历史 memo/托管地址转账解释成质押操作 —`);
  {
    const pre = new Blockchain();
    const user = Wallet.generate();
    for (let i = 0; i < 6; i++) await pre.mine(user.address);
    const ordinaryToEscrow = createTransaction(user, STAKE_ESCROW_ADDRESS, 1, pre.nonceOf(user.address), 'historical transfer', MIN_FEE);
    check('激活前普通转账到质押托管地址可按普通历史交易处理', pre.addTransaction(ordinaryToEscrow).ok);
    await pre.mine(user.address);
    check('激活前不会创建质押池', pre.computeState().stakes.size === 0);
    check('激活前 UNSTAKE 零额新边界被拒',
      !pre.addTransaction(createTransaction(user, user.address, 0, pre.nonceOf(user.address), `${UNSTAKE_PREFIX}${fakeId}`, MIN_FEE)).ok);
    check('激活前链整链校验通过', Blockchain.validateChain(pre.chain).ok);
  }

  // ---- forge 一次到激活高度（coinbase 全给 funder，攒足后续各场景的起步资金）----
  console.log(`\n— 把基底链便宜地 forge 到激活高度 ${STAKING_ACTIVATION_HEIGHT}（非真 PoW；难度自降到地板）…耐心几秒 —`);
  {
    const base = new Blockchain();
    await forgeTo(base, funder.address, STAKING_ACTIVATION_HEIGHT);
    baseSnapshot = base.chain;
    check(`基底链已达激活高度（height=${base.height} ≥ ${STAKING_ACTIVATION_HEIGHT}）`, base.height >= STAKING_ACTIVATION_HEIGHT);
    check('基底链（forge 到激活高度）整链 validateChain 通过', Blockchain.validateChain(base.chain).ok);
    check('基底链全链守恒（forge 块均带合法 coinbase）', conserved(base));
  }

  console.log(`\n— STAKE：开质押池、托管入账、质押人被扣（押金+手续费）—`);
  const bc = activatedClone();
  const relay = Wallet.generate(); // 充当一个中继
  await fund(bc, relay.address, STAKE_MIN.guard + 5); // funder 给中继起步资金（押金 + 若干手续费）
  const relayBefore = bc.balanceOf(relay.address);
  const stakeTx = createTransaction(relay, STAKE_ESCROW_ADDRESS, STAKE_MIN.guard, bc.nonceOf(relay.address), `${STAKE_PREFIX}guard`, MIN_FEE);
  check('STAKE 进池（转给质押托管地址）', bc.addTransaction(stakeTx).ok);
  await bc.mine(relay.address);
  const stakeId = stakeTx.txid;
  const stakeHeight = bc.height;
  check('质押人被扣 押金+手续费（手续费作为矿工又赚回出块奖励+费）',
    bc.balanceOf(relay.address) === relayBefore - STAKE_MIN.guard - MIN_FEE + (BLOCK_REWARD + MIN_FEE));
  check('押金锁进质押托管地址', bc.balanceOf(STAKE_ESCROW_ADDRESS) === STAKE_MIN.guard);
  const pool = bc.computeState().stakes.get(stakeId);
  check('质押池开着：staker/role/amount 正确', pool?.staker === relay.address && pool?.role === 'guard' && pool?.amount === STAKE_MIN.guard);
  check('lockedUntil = 创建高度 + STAKE_LOCK_BLOCKS', pool?.lockedUntil === stakeHeight + STAKE_LOCK_BLOCKS);
  check('STAKE 后全链守恒', conserved(bc));

  console.log(`\n— STAKE 校验：低于最低押金被拒、普通转账打到质押托管被拒 —`);
  check('质押额 < STAKE_MIN[role] 被拒',
    !bc.addTransaction(createTransaction(relay, STAKE_ESCROW_ADDRESS, STAKE_MIN.guard - 1, bc.nonceOf(relay.address), `${STAKE_PREFIX}guard`, MIN_FEE)).ok);
  check('普通转账打到质押托管地址被拒（非合法 STAKE）',
    !bc.addTransaction(createTransaction(relay, STAKE_ESCROW_ADDRESS, 10, bc.nonceOf(relay.address), 'hi', MIN_FEE)).ok);

  console.log(`\n— UNSTAKE：锁定期内被拒；过锁定期后退还本金、池标记 withdrawn；二次赎回被拒 —`);
  check('锁定期内赎回被拒',
    !bc.addTransaction(createTransaction(relay, relay.address, 0, bc.nonceOf(relay.address), `${UNSTAKE_PREFIX}${stakeId}`, MIN_FEE)).ok);
  // 挖到锁定期满（lockedUntil 高度，含）
  while (bc.height < stakeHeight + STAKE_LOCK_BLOCKS) await bc.mine(relay.address);
  const relayBeforeUnstake = bc.balanceOf(relay.address);
  const unstakeTx = createTransaction(relay, relay.address, 0, bc.nonceOf(relay.address), `${UNSTAKE_PREFIX}${stakeId}`, MIN_FEE);
  check('过锁定期后赎回进池', bc.addTransaction(unstakeTx).ok);
  await bc.mine(relay.address);
  check('退还本金（=押金，无罚没）减赎回手续费（手续费又作矿工赚回）',
    bc.balanceOf(relay.address) === relayBeforeUnstake - MIN_FEE + STAKE_MIN.guard + (BLOCK_REWARD + MIN_FEE));
  check('质押托管清零（本金已退出）', bc.balanceOf(STAKE_ESCROW_ADDRESS) === 0);
  check('质押池标记 withdrawn', bc.computeState().stakes.get(stakeId)?.withdrawn === true);
  check('二次赎回被拒（已 withdrawn）',
    !bc.addTransaction(createTransaction(relay, relay.address, 0, bc.nonceOf(relay.address), `${UNSTAKE_PREFIX}${stakeId}`, MIN_FEE)).ok);
  check('UNSTAKE 后全链守恒', conserved(bc));
  check('含 STAKE+UNSTAKE 的链整链校验通过', Blockchain.validateChain(bc.chain).ok);

  console.log(`\n— SLASH：非度量者签发被共识拒（本地无 MEASURER 私钥 → 链上 SLASH 接受属部署期）—`);
  // 修复说明：MEASURER_ADDRESS 是固定常量、其私钥**故意不在仓库**。本地任何钱包（含上面的 measurer/relay2）
  // 地址都 ≠ MEASURER_ADDRESS，故**无法**在本地落地一笔被共识接受的 SLASH。这里改测「非度量者签发被拒」，
  // 并明确：**链上 SLASH 被接受需部署者持 MEASURER_ADDRESS 私钥**（部署期）。SLASH 决策/成形见 slash-decide-test.ts。
  const sc = activatedClone();
  const relay2 = Wallet.generate();
  await fund(sc, relay2.address, STAKE_MIN.hsdir + 6); // 中继起步资金
  await fund(sc, measurer.address, 4); // 给（生成的）度量者一点余额，证明「即便有钱付 gas，地址不符仍被拒」
  const stake2 = createTransaction(relay2, STAKE_ESCROW_ADDRESS, STAKE_MIN.hsdir, sc.nonceOf(relay2.address), `${STAKE_PREFIX}hsdir`, MIN_FEE);
  check('SLASH 场景：STAKE 进池', sc.addTransaction(stake2).ok);
  await sc.mine(relay2.address);
  const stake2Id = stake2.txid;
  check('SLASH 场景质押池开着', sc.computeState().stakes.get(stake2Id)?.amount === STAKE_MIN.hsdir);
  // ① 中继自己（非度量者）签发 SLASH → 被拒
  check('非度量者(中继自己)签发 SLASH 被拒（mempool 拦截）',
    !sc.addTransaction(createTransaction(relay2, relay2.address, 0, sc.nonceOf(relay2.address), `${SLASH_PREFIX}${stake2Id}|3|0`, MIN_FEE)).ok);
  // ② 本地「度量者」钱包（地址 ≠ MEASURER_ADDRESS）签发 SLASH → 同样被拒（这正是为何本地无法落地成功 SLASH）
  const localMeasurerSlash = createTransaction(measurer, measurer.address, 0, sc.nonceOf(measurer.address), `${SLASH_PREFIX}${stake2Id}|3|0`, MIN_FEE);
  const localRes = sc.addTransaction(localMeasurerSlash);
  check('本地生成的“度量者”钱包（地址≠MEASURER_ADDRESS）签发 SLASH 也被拒', localRes.ok === false);
  check('拒绝原因点明「只有度量者能罚没」', String(localRes.error).includes('度量者'));
  check('measurer 钱包地址确实 ≠ MEASURER_ADDRESS（故本地无法签出被接受的 SLASH；接受属部署期）', measurer.address !== MEASURER_ADDRESS);
  // ③ 两次被拒后，质押池本金原封未动（没有任何 SLASH 生效）
  check('两次被拒后质押池 slashed 仍为 0（无 SLASH 生效）', sc.computeState().stakes.get(stake2Id)?.slashed === 0);
  check('被拒后质押托管仍持有全额押金', sc.balanceOf(STAKE_ESCROW_ADDRESS) === STAKE_MIN.hsdir);
  check('SLASH 场景全链守恒', conserved(sc));
  check('含 STAKE + 被拒 SLASH 的链整链校验通过', Blockchain.validateChain(sc.chain).ok);

  console.log(`\n— 分叉安全：同一条链经 computeState ≡ validateChain ≡ Blockchain.validateChain（余额逐项一致）—`);
  // 复用上面含 STAKE 的链 sc：computeState 的余额必须与“逐块重放 validateChain 的状态机”一致。
  const vc = Blockchain.validateChain(sc.chain);
  check('Blockchain.validateChain(sc.chain).ok === true', vc.ok === true);
  // 把整条链塞进一个全新 Blockchain（fromJSON），其 computeState 必须给出与 sc 完全一致的余额
  const replica = Blockchain.fromJSON({ chain: JSON.parse(JSON.stringify(sc.chain)), mempool: [] });
  const balA = sc.computeState().balances;
  const balB = replica.computeState().balances;
  let balancesIdentical = balA.size === balB.size;
  for (const [k, v] of balA) if (balB.get(k) !== v) balancesIdentical = false;
  check('computeState 余额表在重放副本上逐项一致（无分叉）', balancesIdentical);
  check('replica 整链校验也通过', Blockchain.validateChain(replica.chain).ok);
  // 端到端：把含质押的整条链当作“更长合法链”喂给一个全新节点，replaceChain 必须接受且余额一致
  const fresh = new Blockchain();
  const rep = fresh.replaceChain(JSON.parse(JSON.stringify(sc.chain)));
  check('含质押的整链经 replaceChain 被全新节点接受', rep.replaced === true);
  check('被接受后中继 relay2 余额与源链一致', fresh.balanceOf(relay2.address) === sc.balanceOf(relay2.address));

  console.log(`\n— 质押门槛选路：parseRelaysFiltered(chain, true) 只放行“押了有效质押”的中继 —`);
  const rc = activatedClone();
  const rActive = Wallet.generate(); // 有有效质押
  const rNoStake = Wallet.generate(); // 描述符 stakeTxid='0'
  const rWithdrawn = Wallet.generate(); // 质押过但已赎回
  await fund(rc, rActive.address, STAKE_MIN.middle + 8); // 押金 + 发描述符 + 手续费
  await fund(rc, rNoStake.address, 4);
  await fund(rc, rWithdrawn.address, STAKE_MIN.middle + 8);
  const okey = '1'.repeat(64);
  // rActive：先质押，拿到 stakeId，再用该 stakeId 发布描述符
  const sActive = createTransaction(rActive, STAKE_ESCROW_ADDRESS, STAKE_MIN.middle, rc.nonceOf(rActive.address), `${STAKE_PREFIX}middle`, MIN_FEE);
  rc.addTransaction(sActive);
  await rc.mine(rActive.address);
  const activeStakeId = sActive.txid;
  rc.addTransaction(createTransaction(rActive, rActive.address, 1, rc.nonceOf(rActive.address), buildRelayMemo(okey, '10.0.0.1', 6001, 'm', activeStakeId), MIN_FEE));
  // rNoStake：发布描述符，stakeTxid 默认 '0'
  rc.addTransaction(createTransaction(rNoStake, rNoStake.address, 1, rc.nonceOf(rNoStake.address), buildRelayMemo(okey, '10.0.0.2', 6002), MIN_FEE));
  // rWithdrawn：质押 → 描述符引用它 → 锁定期后赎回（描述符的 stakeTxid 仍指向已赎回的质押）
  const sWd = createTransaction(rWithdrawn, STAKE_ESCROW_ADDRESS, STAKE_MIN.middle, rc.nonceOf(rWithdrawn.address), `${STAKE_PREFIX}middle`, MIN_FEE);
  rc.addTransaction(sWd);
  await rc.mine(rActive.address);
  const wdStakeId = sWd.txid;
  const wdHeight = rc.height;
  rc.addTransaction(createTransaction(rWithdrawn, rWithdrawn.address, 1, rc.nonceOf(rWithdrawn.address), buildRelayMemo(okey, '10.0.0.3', 6003, 'm', wdStakeId), MIN_FEE));
  await rc.mine(rActive.address);
  const dirAll = parseRelaysFiltered(rc.chain, false);
  check('requireStake=false：完整目录含全部 3 个中继（向后兼容）', dirAll.size === 3);
  const dirStakedBeforeWd = parseRelaysFiltered(rc.chain, true);
  check('requireStake=true：放行有质押的 rActive', dirStakedBeforeWd.has(rActive.address));
  check('requireStake=true：排除 stakeTxid=0 的 rNoStake', !dirStakedBeforeWd.has(rNoStake.address));
  check('requireStake=true：未赎回前 rWithdrawn 暂被放行', dirStakedBeforeWd.has(rWithdrawn.address));
  // 让 rWithdrawn 赎回后，过滤应把它剔除
  while (rc.height < wdHeight + STAKE_LOCK_BLOCKS) await rc.mine(rActive.address);
  rc.addTransaction(createTransaction(rWithdrawn, rWithdrawn.address, 0, rc.nonceOf(rWithdrawn.address), `${UNSTAKE_PREFIX}${wdStakeId}`, MIN_FEE));
  await rc.mine(rActive.address);
  const dirStaked = parseRelaysFiltered(rc.chain, true);
  check('requireStake=true：赎回后排除 rWithdrawn（质押已撤）', !dirStaked.has(rWithdrawn.address));
  check('requireStake=true：rActive 仍在（质押有效）', dirStaked.has(rActive.address));
  check('质押门槛链整链校验通过', Blockchain.validateChain(rc.chain).ok);

  console.log(failed === 0 ? `\n🎉 全部通过 ALL PASS\n` : `\n💥 ${failed} 项失败 ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
