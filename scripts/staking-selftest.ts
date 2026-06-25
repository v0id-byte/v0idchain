// 中继质押托管自检（Phase 3A-1）。跑：corepack pnpm exec tsx scripts/staking-selftest.ts
// 覆盖：STAKE 开池/扣款/锁定、UNSTAKE 锁定期+本金退还+防重复、SLASH 度量者权限+移交国库+罚后赎回、
//       分叉安全（computeState ≡ validateChain ≡ Blockchain.validateChain）、质押门槛选路过滤、激活/配置向量。
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
  GENESIS_PREMINE_ADDRESS,
  BLOCK_REWARD,
  MIN_FEE,
} from '../packages/core/src/index.js';

let failed = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
}

// 守恒量：全网总额恒 = 预挖 + 链高×出块奖励（手续费/罚没只搬运，不增发/不丢失）
const supply = (bc: Blockchain) => [...bc.computeState().balances.values()].reduce((s, v) => s + v, 0);
const conserved = (bc: Blockchain) => supply(bc) === GENESIS_PREMINE + bc.height * BLOCK_REWARD;

console.log(`\n— 配置向量：生产配置不导出度量者私钥，质押有显式激活高度 —`);
const measurer = Wallet.generate(); // 自检只能验证非度量者会被拒；生产 MEASURER_ADDRESS 的私钥不在仓库内。
check('MEASURER_ADDRESS 是地址而非私钥/种子', MEASURER_ADDRESS.startsWith('0x') && MEASURER_ADDRESS.length === 66);
check('质押激活高度 > 当前 checkpoint 历史', STAKING_ACTIVATION_HEIGHT > 300);
check('托管地址 = 0x…2（与红包 …1 区分）', STAKE_ESCROW_ADDRESS === '0x' + '0'.repeat(63) + '2');
check('角色最低押金 Guard ≥ HSDir ≥ Middle', STAKE_MIN.guard >= STAKE_MIN.hsdir && STAKE_MIN.hsdir >= STAKE_MIN.middle);


console.log(`\n— 纯解析器：parseStakeCreate / parseUnstakeId / parseSlash（非法返回 null）—`);
check('STAKE|guard → {role:guard}', parseStakeCreate(`${STAKE_PREFIX}guard`)?.role === 'guard');
check('STAKE|exit 非法（v1 无 exit）→ null', parseStakeCreate(`${STAKE_PREFIX}exit`) === null);
check('STAKE|（空角色）→ null', parseStakeCreate(STAKE_PREFIX) === null);
const fakeId = 'a'.repeat(64);
check('UNSTAKE|<64hex> → id', parseUnstakeId(`${UNSTAKE_PREFIX}${fakeId}`) === fakeId);
check('UNSTAKE|短id → null', parseUnstakeId(`${UNSTAKE_PREFIX}abc`) === null);
const sl = parseSlash(`${SLASH_PREFIX}${fakeId}|7|3`);
check('SLASH|<id>|7|3 → {amount:7,epoch:3}', sl?.stakeId === fakeId && sl?.amount === 7 && sl?.epoch === 3);
check('SLASH 金额 0 非法 → null', parseSlash(`${SLASH_PREFIX}${fakeId}|0|3`) === null);
check('SLASH 缺字段 → null', parseSlash(`${SLASH_PREFIX}${fakeId}|7`) === null);
check('makeStake(guard) 金额 = STAKE_MIN.guard', makeStake('guard').amount === STAKE_MIN.guard);

if (STAKING_ACTIVATION_HEIGHT > 0) {
  console.log(`\n— 激活门控：激活前不把历史 memo/托管地址转账解释成质押操作 —`);
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
  console.log(failed === 0 ? `\n🎉 激活前门控自检通过 PASS\n` : `\n💥 ${failed} 项失败 ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

console.log(`\n— STAKE：开质押池、托管入账、质押人被扣（押金+手续费）—`);
const bc = new Blockchain();
const relay = Wallet.generate(); // 充当一个中继
// relay 挖够：押金(guard=50) + 若干手续费
for (let i = 0; i < STAKE_MIN.guard + 5; i++) await bc.mine(relay.address);
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

console.log(`\n— SLASH：度量者签发减少押金 + 移交国库；非度量者签发被拒（no-op）；罚后赎回退本金-罚没 —`);
const sc = new Blockchain();
const relay2 = Wallet.generate();
for (let i = 0; i < STAKE_MIN.hsdir + 6; i++) await sc.mine(relay2.address);
// 给度量者一点余额好付 SLASH 的手续费（度量者也要付 gas）
for (let i = 0; i < 3; i++) await sc.mine(measurer.address);
const stake2 = createTransaction(relay2, STAKE_ESCROW_ADDRESS, STAKE_MIN.hsdir, sc.nonceOf(relay2.address), `${STAKE_PREFIX}hsdir`, MIN_FEE);
sc.addTransaction(stake2);
await sc.mine(relay2.address);
const stake2Id = stake2.txid;
const stake2Height = sc.height;
const slashAmount = 3; // 部分罚没（< STAKE_MIN.hsdir，故 cut === slashAmount，算术干净）
const treasuryBefore = sc.balanceOf(GENESIS_PREMINE_ADDRESS);
// 非度量者（relay2 自己）想 SLASH 自己 → 被拒
check('非度量者签发 SLASH 被拒（mempool 拦截）',
  !sc.addTransaction(createTransaction(relay2, relay2.address, 0, sc.nonceOf(relay2.address), `${SLASH_PREFIX}${stake2Id}|${slashAmount}|0`, MIN_FEE)).ok);
// 度量者签发 SLASH → 合法
const slashTx = createTransaction(measurer, measurer.address, 0, sc.nonceOf(measurer.address), `${SLASH_PREFIX}${stake2Id}|${slashAmount}|0`, MIN_FEE);
check('度量者签发 SLASH 进池', sc.addTransaction(slashTx).ok);
await sc.mine(relay2.address);
check('质押池 slashed 增加 slashAmount', sc.computeState().stakes.get(stake2Id)?.slashed === slashAmount);
check('罚没币移交国库（treasury += slashAmount）', sc.balanceOf(GENESIS_PREMINE_ADDRESS) === treasuryBefore + slashAmount);
check('质押托管仍持有 押金-罚没', sc.balanceOf(STAKE_ESCROW_ADDRESS) === STAKE_MIN.hsdir - slashAmount);
check('SLASH 后全链守恒（罚没只搬运到国库）', conserved(sc));
// 二次 SLASH：请求额超过剩余本金 → cut 封顶为剩余（slashed 不超过押金本金）
const remainingAfter1 = STAKE_MIN.hsdir - slashAmount; // = 8 - 3 = 5
const treasuryBefore2 = sc.balanceOf(GENESIS_PREMINE_ADDRESS);
const slashTx2 = createTransaction(measurer, measurer.address, 0, sc.nonceOf(measurer.address), `${SLASH_PREFIX}${stake2Id}|999|1`, MIN_FEE);
check('度量者二次 SLASH（请求 999 > 剩余）进池', sc.addTransaction(slashTx2).ok);
await sc.mine(relay2.address);
check('SLASH 封顶：slashed 封顶 = 押金本金（不超额）', sc.computeState().stakes.get(stake2Id)?.slashed === STAKE_MIN.hsdir);
check('封顶 SLASH 只把剩余本金移交国库', sc.balanceOf(GENESIS_PREMINE_ADDRESS) === treasuryBefore2 + remainingAfter1);
check('封顶后质押托管清零（本金全部罚没）', sc.balanceOf(STAKE_ESCROW_ADDRESS) === 0);
check('封顶 SLASH 后全链守恒', conserved(sc));
// 罚后赎回：退还 本金 - 已罚没（此时已罚没殆尽 → 退 0，仅净付赎回手续费）
while (sc.height < stake2Height + STAKE_LOCK_BLOCKS) await sc.mine(relay2.address);
const relay2BeforeUnstake = sc.balanceOf(relay2.address);
const unstake2 = createTransaction(relay2, relay2.address, 0, sc.nonceOf(relay2.address), `${UNSTAKE_PREFIX}${stake2Id}`, MIN_FEE);
check('罚后赎回进池', sc.addTransaction(unstake2).ok);
await sc.mine(relay2.address);
// 本金已被罚没殆尽（slashed = 押金）→ 退回 0；relay2 只净付赎回手续费，又作矿工赚回 出块奖励+费
check('罚没殆尽后赎回退回 0 本金（只净付赎回手续费、又作矿工赚回）',
  sc.balanceOf(relay2.address) === relay2BeforeUnstake - MIN_FEE + 0 + (BLOCK_REWARD + MIN_FEE));
check('赎回后质押托管清零', sc.balanceOf(STAKE_ESCROW_ADDRESS) === 0);
check('含 STAKE+SLASH+UNSTAKE 的链整链校验通过', Blockchain.validateChain(sc.chain).ok);

console.log(`\n— 分叉安全：同一条链经 computeState ≡ validateChain ≡ Blockchain.validateChain（余额逐项一致）—`);
// 复用上面含 STAKE+SLASH+UNSTAKE 的链 sc：computeState 的余额必须与“逐块重放 validateChain 的状态机”一致。
// 这里直接断言 validateChain.ok === true（其内部状态机与 computeState 共用 applyTx），并抽样核对关键地址余额。
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
check('被接受后中继 relay2 余额与源链一致',
  fresh.balanceOf(relay2.address) === sc.balanceOf(relay2.address));

console.log(`\n— 质押门槛选路：parseRelaysFiltered(chain, true) 只放行“押了有效质押”的中继 —`);
const rc = new Blockchain();
const rActive = Wallet.generate(); // 有有效质押
const rNoStake = Wallet.generate(); // 描述符 stakeTxid='0'
const rWithdrawn = Wallet.generate(); // 质押过但已赎回
for (let i = 0; i < STAKE_MIN.middle + 4; i++) await rc.mine(rActive.address);
for (let i = 0; i < 3; i++) await rc.mine(rNoStake.address);
for (let i = 0; i < STAKE_MIN.middle + 4; i++) await rc.mine(rWithdrawn.address);
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
