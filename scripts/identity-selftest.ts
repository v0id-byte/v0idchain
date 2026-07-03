// 质押身份自检（Phase 3B：纯资金锁仓反女巫，无罚没、无仲裁者）。跑：corepack pnpm exec tsx scripts/identity-selftest.ts
// 覆盖：IDCLAIM 开质押/扣款、IDRELEASE 锁定期+全额退还+防重复、**解锁后假名可被别人重新认领**（核心设计决定）、
//       分叉安全（computeState ≡ validateChain ≡ replaceChain）、激活/配置向量、纯解析器（复用 names.ts 字符集）。
import {
  Blockchain,
  Wallet,
  createTransaction,
  parseIdentityClaim,
  parseIdentityRelease,
  makeIdentityClaim,
  computeIdentityState,
  resolveIdentityOwner,
  IDCLAIM_PREFIX,
  IDRELEASE_PREFIX,
  IDENTITY_ESCROW_ADDRESS,
  IDENTITY_STAKE_MIN,
  IDENTITY_LOCK_BLOCKS,
  IDENTITY_ACTIVATION_HEIGHT,
  STAKE_LOCK_BLOCKS,
  STAKE_MIN,
  RED_ESCROW_ADDRESS,
  STAKE_ESCROW_ADDRESS,
  MINT_ESCROW_ADDRESS,
  RESERVED_NAMES,
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

const supply = (bc: Blockchain) => [...bc.computeState().balances.values()].reduce((s, v) => s + v, 0);
const conserved = (bc: Blockchain) => supply(bc) === GENESIS_PREMINE + bc.height * BLOCK_REWARD;

const fakeId = 'a'.repeat(64);
const funder = Wallet.generate();
let baseSnapshot: Block[] = [];

function activatedClone(): Blockchain {
  return Blockchain.fromJSON({ chain: JSON.parse(JSON.stringify(baseSnapshot)), mempool: [] });
}

async function fund(bc: Blockchain, to: string, amount: number): Promise<void> {
  const tx = createTransaction(funder, to, amount, bc.nonceOf(funder.address), '', minFeeFor(amount));
  if (!bc.addTransaction(tx).ok) throw new Error('fund: 转账未进 mempool（funder 余额不足？）');
  await bc.mine(funder.address);
}

async function main() {
  console.log(`\n— 配置向量：无罚没、无仲裁者，锁定期显著长于中继质押，托管地址不撞 —`);
  check('身份质押激活高度 > 当前 checkpoint 历史', IDENTITY_ACTIVATION_HEIGHT > 300);
  check('托管地址 = 0x…4（与红包…1/质押…2/铸币…3 区分）', IDENTITY_ESCROW_ADDRESS === '0x' + '0'.repeat(63) + '4');
  check(
    '身份托管地址与其他三个托管地址互不相同',
    new Set([RED_ESCROW_ADDRESS, STAKE_ESCROW_ADDRESS, MINT_ESCROW_ADDRESS, IDENTITY_ESCROW_ADDRESS]).size === 4,
  );
  check(
    '身份锁定期显著长于中继质押锁定期（无罚没，锁仓时长本身是全部代价）',
    IDENTITY_LOCK_BLOCKS > STAKE_LOCK_BLOCKS,
  );
  check(
    '身份最低押金介于中继 middle 与 guard 之间',
    IDENTITY_STAKE_MIN > STAKE_MIN.middle && IDENTITY_STAKE_MIN < STAKE_MIN.guard,
  );

  console.log(`\n— 纯解析器：parseIdentityClaim / parseIdentityRelease / makeIdentityClaim（复用 names.ts 规则）—`);
  check('IDCLAIM|alice → {pseudonym:alice}', parseIdentityClaim(`${IDCLAIM_PREFIX}alice`)?.pseudonym === 'alice');
  check('IDCLAIM|Alice 归一化为小写', parseIdentityClaim(`${IDCLAIM_PREFIX}Alice`)?.pseudonym === 'alice');
  check('IDCLAIM|0xabc 非法（避免与地址混淆）→ null', parseIdentityClaim(`${IDCLAIM_PREFIX}0xabc`) === null);
  check('IDCLAIM|（空假名）→ null', parseIdentityClaim(IDCLAIM_PREFIX) === null);
  check('IDCLAIM|太长(21位) → null', parseIdentityClaim(`${IDCLAIM_PREFIX}${'a'.repeat(21)}`) === null);
  check('IDRELEASE|<64hex> → id', parseIdentityRelease(`${IDRELEASE_PREFIX}${fakeId}`) === fakeId);
  check('IDRELEASE|短id → null', parseIdentityRelease(`${IDRELEASE_PREFIX}abc`) === null);
  check('makeIdentityClaim(alice) 返回 ok + memo', makeIdentityClaim('alice').ok === true && typeof makeIdentityClaim('alice').memo === 'string');
  const reservedSample = [...RESERVED_NAMES][0];
  check(`makeIdentityClaim(保留名 "${reservedSample}") 被拒`, makeIdentityClaim(reservedSample).ok === false);

  console.log(`\n— 激活门控：激活前不把历史 memo/托管地址转账解释成身份操作 —`);
  {
    const pre = new Blockchain();
    const user = Wallet.generate();
    for (let i = 0; i < 6; i++) await pre.mine(user.address);
    const ordinaryToEscrow = createTransaction(
      user, IDENTITY_ESCROW_ADDRESS, 1, pre.nonceOf(user.address), 'historical transfer', MIN_FEE,
    );
    check('激活前普通转账到身份托管地址可按普通历史交易处理', pre.addTransaction(ordinaryToEscrow).ok);
    await pre.mine(user.address);
    check('激活前不会创建身份质押', pre.computeState().identityClaims.size === 0);
    check(
      '激活前 IDRELEASE 零额新边界被拒',
      !pre.addTransaction(createTransaction(user, user.address, 0, pre.nonceOf(user.address), `${IDRELEASE_PREFIX}${fakeId}`, MIN_FEE)).ok,
    );
    check('激活前链整链校验通过', Blockchain.validateChain(pre.chain).ok);
  }

  console.log(`\n— 把基底链便宜地 forge 到激活高度 ${IDENTITY_ACTIVATION_HEIGHT}（非真 PoW）…耐心几秒 —`);
  {
    const base = new Blockchain();
    await forgeTo(base, funder.address, IDENTITY_ACTIVATION_HEIGHT);
    baseSnapshot = base.chain;
    check(`基底链已达激活高度（height=${base.height} ≥ ${IDENTITY_ACTIVATION_HEIGHT}）`, base.height >= IDENTITY_ACTIVATION_HEIGHT);
    check('基底链整链 validateChain 通过', Blockchain.validateChain(base.chain).ok);
    check('基底链全链守恒', conserved(base));
  }

  console.log(`\n— IDCLAIM 校验：押金不足被拒、押金足够被接受、托管入账、状态正确记录 —`);
  const bc = activatedClone();
  const alice = Wallet.generate();
  await fund(bc, alice.address, IDENTITY_STAKE_MIN + 20);
  check(
    '押金 < IDENTITY_STAKE_MIN 被拒',
    !bc.addTransaction(createTransaction(alice, IDENTITY_ESCROW_ADDRESS, IDENTITY_STAKE_MIN - 1, bc.nonceOf(alice.address), `${IDCLAIM_PREFIX}alice`, MIN_FEE)).ok,
  );
  const aliceBefore = bc.balanceOf(alice.address);
  const claimTx = createTransaction(alice, IDENTITY_ESCROW_ADDRESS, IDENTITY_STAKE_MIN, bc.nonceOf(alice.address), `${IDCLAIM_PREFIX}alice`, MIN_FEE);
  check('IDCLAIM 进池（转给身份托管地址）', bc.addTransaction(claimTx).ok);
  await bc.mine(alice.address);
  const claimId = claimTx.txid;
  const claimHeight = bc.height;
  check(
    '质押人被扣 押金+手续费（手续费作为矿工又赚回出块奖励+费）',
    bc.balanceOf(alice.address) === aliceBefore - IDENTITY_STAKE_MIN - MIN_FEE + (BLOCK_REWARD + MIN_FEE),
  );
  check('押金锁进身份托管地址', bc.balanceOf(IDENTITY_ESCROW_ADDRESS) === IDENTITY_STAKE_MIN);
  const idState1 = computeIdentityState(bc.chain);
  const claim1 = idState1.claims.get(claimId);
  check('质押记录正确：staker/pseudonym/amount', claim1?.staker === alice.address && claim1?.pseudonym === 'alice' && claim1?.amount === IDENTITY_STAKE_MIN);
  check('lockedUntil = 认领高度 + IDENTITY_LOCK_BLOCKS', claim1?.lockedUntil === claimHeight + IDENTITY_LOCK_BLOCKS);
  check('resolveIdentityOwner("alice") 指向质押人', resolveIdentityOwner(idState1, 'alice') === alice.address);
  check('IDCLAIM 后全链守恒', conserved(bc));

  console.log(`\n— 同假名重复认领被拒（认领中不可二次占用）—`);
  const eve = Wallet.generate();
  await fund(bc, eve.address, IDENTITY_STAKE_MIN + 20);
  check(
    '不同地址认领同一活跃假名 "alice" 被拒',
    !bc.addTransaction(createTransaction(eve, IDENTITY_ESCROW_ADDRESS, IDENTITY_STAKE_MIN, bc.nonceOf(eve.address), `${IDCLAIM_PREFIX}alice`, MIN_FEE)).ok,
  );

  console.log(`\n— IDRELEASE：锁定期内被拒、非质押人被拒、过锁定期后全额退回、二次解锁被拒 —`);
  check(
    '锁定期内解锁被拒',
    !bc.addTransaction(createTransaction(alice, alice.address, 0, bc.nonceOf(alice.address), `${IDRELEASE_PREFIX}${claimId}`, MIN_FEE)).ok,
  );
  check(
    '非质押人（eve）解锁被拒（即便挂着 alice 的 claimId）',
    !bc.addTransaction(createTransaction(eve, eve.address, 0, bc.nonceOf(eve.address), `${IDRELEASE_PREFIX}${claimId}`, MIN_FEE)).ok,
  );
  while (bc.height < claimHeight + IDENTITY_LOCK_BLOCKS) await bc.mine(alice.address);
  const aliceBeforeRelease = bc.balanceOf(alice.address);
  const releaseTx = createTransaction(alice, alice.address, 0, bc.nonceOf(alice.address), `${IDRELEASE_PREFIX}${claimId}`, MIN_FEE);
  check('过锁定期后解锁进池', bc.addTransaction(releaseTx).ok);
  await bc.mine(alice.address);
  check(
    '全额退回本金（无罚没扣减）减解锁手续费（手续费又作矿工赚回）',
    bc.balanceOf(alice.address) === aliceBeforeRelease - MIN_FEE + IDENTITY_STAKE_MIN + (BLOCK_REWARD + MIN_FEE),
  );
  check('身份托管清零（本金已退出）', bc.balanceOf(IDENTITY_ESCROW_ADDRESS) === 0);
  const idState2 = computeIdentityState(bc.chain);
  check('质押记录标记 released', idState2.claims.get(claimId)?.released === true);
  check(
    '二次解锁被拒（已 released）',
    !bc.addTransaction(createTransaction(alice, alice.address, 0, bc.nonceOf(alice.address), `${IDRELEASE_PREFIX}${claimId}`, MIN_FEE)).ok,
  );
  check('IDRELEASE 后全链守恒（无烧毁无罚没，纯锁仓解仓）', conserved(bc));
  check('含 IDCLAIM+IDRELEASE 的链整链校验通过', Blockchain.validateChain(bc.chain).ok);

  console.log(`\n— 核心设计决定验证：解锁后假名立刻可被别人重新认领（押金须持续持有才算拥有身份）—`);
  check('解锁后 resolveIdentityOwner("alice") 无主', resolveIdentityOwner(computeIdentityState(bc.chain), 'alice') === undefined);
  const eveClaimTx = createTransaction(eve, IDENTITY_ESCROW_ADDRESS, IDENTITY_STAKE_MIN, bc.nonceOf(eve.address), `${IDCLAIM_PREFIX}alice`, MIN_FEE);
  check('eve 现在可以成功认领同一假名 "alice"（release 释放了它）', bc.addTransaction(eveClaimTx).ok);
  await bc.mine(eve.address);
  const idState3 = computeIdentityState(bc.chain);
  check('resolveIdentityOwner("alice") 现在指向 eve', resolveIdentityOwner(idState3, 'alice') === eve.address);
  check('重新认领后全链守恒', conserved(bc));
  check('含重新认领的链整链校验通过', Blockchain.validateChain(bc.chain).ok);

  console.log(`\n— 分叉安全：computeState ≡ validateChain ≡ replaceChain（余额与身份状态逐项一致）—`);
  {
    const vc = Blockchain.validateChain(bc.chain);
    check('Blockchain.validateChain(bc.chain).ok === true', vc.ok === true);
    const replica = Blockchain.fromJSON({ chain: JSON.parse(JSON.stringify(bc.chain)), mempool: [] });
    const balA = bc.computeState().balances;
    const balB = replica.computeState().balances;
    let balancesIdentical = balA.size === balB.size;
    for (const [k, v] of balA) if (balB.get(k) !== v) balancesIdentical = false;
    check('computeState 余额表在重放副本上逐项一致（无分叉）', balancesIdentical);
    const idA = bc.computeState().identityClaims;
    const idB = replica.computeState().identityClaims;
    let identityIdentical = idA.size === idB.size;
    for (const [k, v] of idA) {
      const w = idB.get(k);
      if (!w || w.staker !== v.staker || w.pseudonym !== v.pseudonym || w.amount !== v.amount || w.released !== v.released) {
        identityIdentical = false;
      }
    }
    check('identityClaims 状态在重放副本上逐项一致（无分叉）', identityIdentical);
    const fresh = new Blockchain();
    const rep = fresh.replaceChain(JSON.parse(JSON.stringify(bc.chain)));
    check('含身份质押的整链经 replaceChain 被全新节点接受', rep.replaced === true);
    check('被接受后 eve 余额与源链一致', fresh.balanceOf(eve.address) === bc.balanceOf(eve.address));
  }

  console.log(failed === 0 ? `\n🎉 全部通过 ALL PASS\n` : `\n💥 ${failed} 项失败 ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
