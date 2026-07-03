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
  NULL_ADDRESS,
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

  console.log(`\n— 核心回归：两笔 pending IDCLAIM 抢同一假名，输家必须被清出 mempool，不卡住其后续 nonce 队列 —`);
  {
    const rc = activatedClone();
    // 挂上和 node.ts 同款的回调，验证 revalidateMempool 真的会把被清理交易的 txid 上报出来——
    // 这是 V0idNode 能同步清理自己 seenTx 去重缓存、避免静默吞掉外部客户端重新广播的前提。
    const droppedTxids: string[] = [];
    rc.onMempoolDropped = (ids) => droppedTxids.push(...ids);
    const racerA = Wallet.generate(); // 出价更高，赢家
    const racerB = Wallet.generate(); // 出价更低，输家
    await fund(rc, racerA.address, IDENTITY_STAKE_MIN + 20);
    await fund(rc, racerB.address, IDENTITY_STAKE_MIN + 20);
    // 两笔都基于同一份「假名尚未被占用」的已确认状态构造，互不知晓对方也在 mempool 里排队。
    const claimA = createTransaction(
      racerA, IDENTITY_ESCROW_ADDRESS, IDENTITY_STAKE_MIN, rc.nonceOf(racerA.address), `${IDCLAIM_PREFIX}alice`, MIN_FEE + 5,
    ); // fee 更高 → selectMempoolTxs 按 fee 降序扫描时必定先轮到它，稳赢
    const claimB = createTransaction(
      racerB, IDENTITY_ESCROW_ADDRESS, IDENTITY_STAKE_MIN, rc.nonceOf(racerB.address), `${IDCLAIM_PREFIX}alice`, MIN_FEE,
    );
    check('两笔认领都成功进 mempool（提交时都基于同一份未占用状态，互不知情）', rc.addTransaction(claimA).ok && rc.addTransaction(claimB).ok);
    // racerB 紧跟着排一笔后续交易（nonce+1）：若 claimB 卡在 mempool 里不被清理，这笔会永远选不中。
    const followUp = createTransaction(racerB, racerA.address, 1, rc.nonceOf(racerB.address) + 1, '', MIN_FEE);
    check('racerB 的后续交易（nonce+1）也进 mempool（排在 claimB 之后）', rc.addTransaction(followUp).ok);

    const minedBlock = await rc.mine(racerA.address);
    check('出块成功', minedBlock !== null);
    const minedIds = new Set((minedBlock?.transactions ?? []).map((t) => t.txid));
    check('赢家 claimA 被打进块', minedIds.has(claimA.txid));
    check('输家 claimB 未被打进块（同一次选包内已判负）', !minedIds.has(claimB.txid));
    check(
      '输家 claimB 已被清出 mempool（核心修复：addBlock 后 revalidateMempool，不再永久卡住）',
      !rc.mempool.some((t) => t.txid === claimB.txid),
    );
    check(
      'racerB 的后续交易（nonce+1）也一并被清出（其依赖的 nonce=0 交易已判负，不再是合法排队序列）',
      !rc.mempool.some((t) => t.txid === followUp.txid),
    );
    check(
      'onMempoolDropped 回调上报了 claimB 和 followUp 的 txid（node.ts 据此同步清理 seenTx，外部客户端重新广播不会被静默吞掉）',
      droppedTxids.includes(claimB.txid) && droppedTxids.includes(followUp.txid),
    );
    check('resolveIdentityOwner("alice") 指向赢家 racerA', resolveIdentityOwner(computeIdentityState(rc.chain), 'alice') === racerA.address);
    // 关键验证：racerB 的 nonce 队列没有被永久卡死——用 nonce=0 重新构造一笔（比如认领另一个假名）应立刻可提交。
    const retryClaim = createTransaction(
      racerB, IDENTITY_ESCROW_ADDRESS, IDENTITY_STAKE_MIN, rc.nonceOf(racerB.address), `${IDCLAIM_PREFIX}bob2`, MIN_FEE,
    );
    check('racerB 用干净的 nonce 重新认领另一个假名，立刻可提交（未被之前的失败交易卡死）', rc.addTransaction(retryClaim).ok);
    await rc.mine(racerA.address);
    check('racerB 的重试认领成功上链', resolveIdentityOwner(computeIdentityState(rc.chain), 'bob2') === racerB.address);
    check('竞态回归场景全链守恒', conserved(rc));
    check('竞态回归场景整链校验通过', Blockchain.validateChain(rc.chain).ok);
  }

  console.log(`\n— 核心回归：computeIdentityState 必须跳过 coinbase，不被矿工用出块奖励“伪造”认领 —`);
  {
    const idc = activatedClone();
    const evilMiner = Wallet.generate();
    // 恶意 coinbase：createCoinbase 硬编码 memo=''，但 verifyTransaction 对 coinbase 的校验只看
    // fee===0/burn===0/amount>0，完全不查 memo——恶意矿工可以绕过官方辅助函数手写一笔发往身份托管
    // 地址、带 IDCLAIM 内容的“出块奖励”。这里直接构造一个含此交易的伪造区块喂给 computeIdentityState
    // （纯函数、只读 chain 结构，不校验 hash/PoW/merkleRoot，字段可以是占位值）。
    const evilCoinbase = {
      from: NULL_ADDRESS,
      to: IDENTITY_ESCROW_ADDRESS,
      amount: IDENTITY_STAKE_MIN,
      fee: 0,
      nonce: idc.height + 1,
      timestamp: Date.now(),
      memo: `${IDCLAIM_PREFIX}evilname`,
      signature: '',
      txid: 'f'.repeat(64),
    };
    const fakeBlock: Block = {
      index: idc.height + 1,
      timestamp: Date.now(),
      prevHash: idc.latest.hash,
      transactions: [evilCoinbase],
      merkleRoot: 'e'.repeat(64),
      difficulty: 8,
      nonce: 0,
      miner: evilMiner.address,
      hash: 'd'.repeat(64),
    };
    const idState = computeIdentityState([...idc.chain, fakeBlock]);
    check('恶意 coinbase（发往身份托管+IDCLAIM memo+amount够）不会被记成认领', !idState.pseudonymToClaimId.has('evilname'));
    check('resolveIdentityOwner("evilname") 无主（未被真实占用，与共识状态一致）', resolveIdentityOwner(idState, 'evilname') === undefined);
  }

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
