// 央行电子现金铸币厂自检（Phase A）。跑：corepack pnpm exec tsx scripts/mint-selftest.ts
// 覆盖：配置向量、纯解析/兑现拆分（共识关键整数运算）、激活门控、DEPOSIT 开账+储备+守恒、
//       非法充值/非授权兑现被拒、分叉安全（computeState ≡ validateChain ≡ replaceChain）、computeMintState 视图。
//
// ⚠️ 与 staking-selftest 同款边界：REDEEM **被接受**需 MINT_ADDRESS 的私钥（**故意不在仓库**，掌钥即可提走全部储备）。
//    本地任何钱包地址都 ≠ MINT_ADDRESS，故无法在本地落地一笔被共识**接受**的 REDEEM。于是这里测「非授权兑现被拒」+
//    「兑现拆分/储备/守恒的纯逻辑」，并写明**链上 REDEEM 接受属部署期**（部署者持 MINT_ADDRESS 私钥时才成立，见 MINT-PROTOCOL.md）。
import {
  Blockchain,
  Wallet,
  createTransaction,
  parseRedeem,
  isMintDeposit,
  isZeroAmountMintOp,
  redeemSplit,
  computeMintState,
  MINT_ESCROW_ADDRESS,
  MINT_ADDRESS,
  MINT_ACTIVATION_HEIGHT,
  MINT_FEE_BPS,
  MINT_DEPOSIT_PREFIX,
  REDEEM_PREFIX,
  STAKING_ACTIVATION_HEIGHT,
  SYSTEM_ADDRESSES,
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

// 守恒量：全网总额恒 = 预挖 + 链高×出块奖励（手续费/抽成只搬运，不增发/不丢失）
const supply = (bc: Blockchain) => [...bc.computeState().balances.values()].reduce((s, v) => s + v, 0);
const conserved = (bc: Blockchain) => supply(bc) === GENESIS_PREMINE + bc.height * BLOCK_REWARD;

const funder = Wallet.generate();

/** 由 funder 给 to 转一笔起步资金并 forge 进一块（funder 既转账又作矿工 → 手续费+出块奖励回流 funder，不影响 to 实收 amount）。 */
async function fund(bc: Blockchain, to: string, amount: number): Promise<void> {
  const tx = createTransaction(funder, to, amount, bc.nonceOf(funder.address), '', minFeeFor(amount));
  if (!bc.addTransaction(tx).ok) throw new Error('fund: 转账未进 mempool（funder 余额不足？）');
  await bc.mine(funder.address);
}

async function main() {
  console.log(`\n— 配置向量：托管地址/授权地址/激活高度/抽成率 —`);
  check('托管地址 = 0x…3（与红包 …1 / 质押 …2 区分）', MINT_ESCROW_ADDRESS === '0x' + '0'.repeat(63) + '3');
  check('MINT_ADDRESS 是地址而非私钥/种子', MINT_ADDRESS.startsWith('0x') && MINT_ADDRESS.length === 66);
  check('铸币激活高度 > 当前 checkpoint 历史(300)', MINT_ACTIVATION_HEIGHT > 300);
  check('铸币激活高度 ≥ 质押激活高度（后于质押上线）', MINT_ACTIVATION_HEIGHT >= STAKING_ACTIVATION_HEIGHT);
  check('抽成率在 (0, 10000) 基点内', MINT_FEE_BPS > 0 && MINT_FEE_BPS < 10_000);
  check('系统地址集合含铸币托管地址', SYSTEM_ADDRESSES.has(MINT_ESCROW_ADDRESS));

  console.log(`\n— 纯解析：parseRedeem / isMintDeposit / isZeroAmountMintOp（非法返回 null/false）—`);
  check('REDEEM|100 → {gross:100}', parseRedeem(`${REDEEM_PREFIX}100`)?.gross === 100);
  check('REDEEM|0 非法（须正整数）→ null', parseRedeem(`${REDEEM_PREFIX}0`) === null);
  check('REDEEM|01 前导零 → null', parseRedeem(`${REDEEM_PREFIX}01`) === null);
  check('REDEEM|-5 → null', parseRedeem(`${REDEEM_PREFIX}-5`) === null);
  check('REDEEM|1e3 科学计数 → null', parseRedeem(`${REDEEM_PREFIX}1e3`) === null);
  check('REDEEM|（空）→ null', parseRedeem(REDEEM_PREFIX) === null);
  check('REDEEM|abc → null', parseRedeem(`${REDEEM_PREFIX}abc`) === null);
  check('isMintDeposit(MINT|DEPOSIT) → true', isMintDeposit(MINT_DEPOSIT_PREFIX) === true);
  check('isMintDeposit(MINT|DEPOSITx) → false（精确匹配）', isMintDeposit(`${MINT_DEPOSIT_PREFIX}x`) === false);
  check('isMintDeposit(MINT|DEPOSIT|note) → false（不带关联数据）', isMintDeposit(`${MINT_DEPOSIT_PREFIX}|note`) === false);
  check('isZeroAmountMintOp(REDEEM|5) → true', isZeroAmountMintOp(`${REDEEM_PREFIX}5`) === true);
  check('isZeroAmountMintOp(MINT|DEPOSIT) → false（充值 amount>0）', isZeroAmountMintOp(MINT_DEPOSIT_PREFIX) === false);

  console.log(`\n— 兑现拆分 redeemSplit（共识关键 · 全整数，net+fee===gross、0≤fee≤gross）—`);
  {
    const s1000 = redeemSplit(1000); // MINT_FEE_BPS=500 → fee=50, net=950
    check(`redeemSplit(1000)@${MINT_FEE_BPS}bps = {net:950,fee:50}`, s1000.net === 950 && s1000.fee === 50);
    const s10 = redeemSplit(10); // floor(10*500/10000)=0 → 小额免抽成
    check('redeemSplit(10) 抽成向下取整为 0、net=10', s10.fee === 0 && s10.net === 10);
    const s1 = redeemSplit(1);
    check('redeemSplit(1) = {net:1,fee:0}', s1.net === 1 && s1.fee === 0);
    const sBig = redeemSplit(1_000_000);
    check('redeemSplit(1e6) = {net:950000,fee:50000}', sBig.net === 950_000 && sBig.fee === 50_000);
    let invariant = true;
    for (const g of [1, 7, 19, 100, 999, 12345, 999_983, 5_000_000]) {
      const { net, fee } = redeemSplit(g);
      if (net + fee !== g || fee < 0 || net < 0 || fee > g) invariant = false;
    }
    check('遍历多个面额：net+fee===gross 且 0≤fee≤gross 恒成立', invariant);
  }

  console.log(`\n— 激活门控：激活前不把 …3 托管转账/REDEEM 备注解释成铸币操作 —`);
  {
    const pre = new Blockchain();
    const user = Wallet.generate();
    for (let i = 0; i < 6; i++) await pre.mine(user.address);
    const ordinaryToEscrow = createTransaction(user, MINT_ESCROW_ADDRESS, 1, pre.nonceOf(user.address), 'historical transfer', MIN_FEE);
    check('激活前普通转账到铸币托管地址可按普通历史交易处理', pre.addTransaction(ordinaryToEscrow).ok);
    await pre.mine(user.address);
    check('激活前 computeMintState 视图储备为 0（不计激活前）', computeMintState(pre.chain).reserve === 0);
    check('激活前 REDEEM 零额新边界被拒',
      !pre.addTransaction(createTransaction(user, user.address, 0, pre.nonceOf(user.address), `${REDEEM_PREFIX}1`, MIN_FEE)).ok);
    check('激活前链整链校验通过', Blockchain.validateChain(pre.chain).ok);
  }

  console.log(`\n— 把链便宜地 forge 到铸币激活高度 ${MINT_ACTIVATION_HEIGHT}（非真 PoW；难度自降到地板）…耐心几十秒 —`);
  const bc = new Blockchain();
  await forgeTo(bc, funder.address, MINT_ACTIVATION_HEIGHT);
  check(`基底链已达激活高度（height=${bc.height} ≥ ${MINT_ACTIVATION_HEIGHT}）`, bc.height >= MINT_ACTIVATION_HEIGHT);
  check('基底链整链 validateChain 通过', Blockchain.validateChain(bc.chain).ok);
  check('基底链全链守恒', conserved(bc));

  console.log(`\n— DEPOSIT：充值锁进托管、储备增加、充值人被扣（充值额+手续费）、守恒 —`);
  const user = Wallet.generate();
  const DEP = 1000;
  await fund(bc, user.address, DEP + MIN_FEE); // 充值额 + 一笔手续费
  check('充值人起步资金到位', bc.balanceOf(user.address) === DEP + MIN_FEE);
  const depTx = createTransaction(user, MINT_ESCROW_ADDRESS, DEP, bc.nonceOf(user.address), MINT_DEPOSIT_PREFIX, MIN_FEE);
  check('DEPOSIT 进 mempool（转给铸币托管地址 + MINT|DEPOSIT）', bc.addTransaction(depTx).ok);
  await bc.mine(funder.address); // funder 作矿工，充值人净支出可干净断言
  check('充值人被扣 充值额+手续费（余额归零）', bc.balanceOf(user.address) === 0);
  check('储备（托管地址余额）= 充值额', bc.balanceOf(MINT_ESCROW_ADDRESS) === DEP);
  const mv = computeMintState(bc.chain);
  check('computeMintState：reserve/deposited=充值额、deposits=1', mv.reserve === DEP && mv.deposited === DEP && mv.deposits === 1);
  check('视图储备 ≡ 链上托管余额', mv.reserve === bc.balanceOf(MINT_ESCROW_ADDRESS));
  check('DEPOSIT 后全链守恒', conserved(bc));
  check('含 DEPOSIT 的链整链校验通过', Blockchain.validateChain(bc.chain).ok);

  console.log(`\n— 非法充值被拒：发往铸币托管地址但非 MINT|DEPOSIT —`);
  check('普通转账（错备注）打到铸币托管地址被拒',
    !bc.addTransaction(createTransaction(user, MINT_ESCROW_ADDRESS, 10, bc.nonceOf(user.address), 'hi', MIN_FEE)).ok);

  console.log(`\n— 非授权兑现被拒（本地无 MINT_ADDRESS 私钥 → 链上 REDEEM 接受属部署期）—`);
  const outsider = Wallet.generate();
  await fund(bc, outsider.address, 10); // 给它点余额付 gas，证明「即便有钱付 gas，地址不符仍被拒」
  const provider = Wallet.generate();
  // ① 局外人签发 REDEEM（收款=provider）→ 被拒（只有铸币厂能兑现）
  const badRedeem = createTransaction(outsider, provider.address, 0, bc.nonceOf(outsider.address), `${REDEEM_PREFIX}100`, MIN_FEE);
  const badRes = bc.addTransaction(badRedeem);
  check('非授权（地址≠MINT_ADDRESS）签发 REDEEM 被拒', badRes.ok === false);
  check('拒绝原因点明「只有铸币厂能兑现」', String(badRes.error).includes('铸币厂'));
  check('outsider 钱包地址确实 ≠ MINT_ADDRESS（本地无法签出被接受的 REDEEM；接受属部署期）', outsider.address !== MINT_ADDRESS);
  // ② 兑现金额非 0 → 被拒
  check('兑现 amount≠0 被拒',
    !bc.addTransaction(createTransaction(outsider, provider.address, 5, bc.nonceOf(outsider.address), `${REDEEM_PREFIX}100`, MIN_FEE)).ok);
  check('被拒后储备原封未动（无 REDEEM 生效）', bc.balanceOf(MINT_ESCROW_ADDRESS) === DEP);

  console.log(`\n— 分叉安全：含 DEPOSIT 的链经 computeState ≡ validateChain ≡ replaceChain（余额逐项一致）—`);
  const vc = Blockchain.validateChain(bc.chain);
  check('Blockchain.validateChain(bc.chain).ok === true', vc.ok === true);
  const replica = Blockchain.fromJSON({ chain: JSON.parse(JSON.stringify(bc.chain)) as Block[], mempool: [] });
  const balA = bc.computeState().balances;
  const balB = replica.computeState().balances;
  let identical = balA.size === balB.size;
  for (const [k, v] of balA) if (balB.get(k) !== v) identical = false;
  check('computeState 余额表在重放副本上逐项一致（无分叉）', identical);
  check('replica 托管储备与源链一致', replica.balanceOf(MINT_ESCROW_ADDRESS) === bc.balanceOf(MINT_ESCROW_ADDRESS));
  const fresh = new Blockchain();
  const rep = fresh.replaceChain(JSON.parse(JSON.stringify(bc.chain)) as Block[]);
  check('含 DEPOSIT 的整链经 replaceChain 被全新节点接受', rep.replaced === true);
  check('被接受后储备与源链一致', fresh.balanceOf(MINT_ESCROW_ADDRESS) === bc.balanceOf(MINT_ESCROW_ADDRESS));

  console.log(failed === 0 ? `\n🎉 全部通过 ALL PASS\n` : `\n💥 ${failed} 项失败 ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
