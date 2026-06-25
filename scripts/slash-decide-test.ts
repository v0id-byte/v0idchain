// 罚没决策 + 交易成形自检（Phase 3A-4）：纯函数 decideSlashes + SLASH 交易成形 + 链侧拒非度量者。
//   ① 仅连续掉线 ≥ SLASH_AFTER_EPOCHS 才罚；偶发/未达阈值不罚。
//   ② 罚没额 = floor(SLASH_FRACTION × 剩余本金)；已赎回/已罚没殆尽/剩余太小不产出。
//   ③ updateOfflineHistory 滚动：在线清零、掉线累加、赎回移除。
//   ④ 成形的 SLASH 交易：memo == `SLASH|<stakeId>|<amount>|<epoch>`、from == MEASURER_ADDRESS、parseSlash 能解回。
//   ⑤ 链上接受属部署期（需 MEASURER_ADDRESS 私钥，不在仓库）：本地只能验「非度量者签发的 SLASH 被共识拒」。
// 跑：corepack pnpm exec tsx scripts/slash-decide-test.ts
import {
  Blockchain,
  Wallet,
  createTransaction,
  parseSlash,
  computeStakeState,
  SLASH_PREFIX,
  SLASH_AFTER_EPOCHS,
  SLASH_FRACTION,
  STAKE_PREFIX,
  STAKE_ESCROW_ADDRESS,
  STAKE_MIN,
  MEASURER_ADDRESS,
  MIN_FEE,
  STAKING_ACTIVATION_HEIGHT,
  type StakePool,
  type StakeRole,
} from '../packages/core/src/index.js';
import { decideSlashes, updateOfflineHistory, type OfflineHistory } from '../packages/node/src/relay/measurer.js';
import { forgeTo, forgeAppendBlock } from './forge-chain.js';

let failed = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
};

let idc = 0;
function pool(staker: string, opts: Partial<StakePool> = {}): [string, StakePool] {
  const id = `slashtest${idc++}`.padEnd(64, '0');
  return [
    id,
    {
      staker,
      role: (opts.role ?? 'guard') as StakeRole,
      amount: opts.amount ?? 100,
      lockedUntil: 0,
      createdHeight: 0,
      slashed: opts.slashed ?? 0,
      withdrawn: opts.withdrawn ?? false,
    },
  ];
}

console.log(`\n— ① 仅连续掉线 ≥ SLASH_AFTER_EPOCHS(${SLASH_AFTER_EPOCHS}) 才罚 —`);
{
  const a = '0x' + 'a'.repeat(64);
  const [idA, pA] = pool(a, { amount: 100 });
  const stakes = new Map<string, StakePool>([[idA, pA]]);
  for (let off = 0; off < SLASH_AFTER_EPOCHS; off++) {
    const decisions = decideSlashes({ [idA]: off }, stakes);
    check(`连续掉线 ${off}(<${SLASH_AFTER_EPOCHS}) → 不罚`, decisions.length === 0);
  }
  const atThreshold = decideSlashes({ [idA]: SLASH_AFTER_EPOCHS }, stakes);
  check(`连续掉线 ${SLASH_AFTER_EPOCHS}(=阈值) → 罚 1 笔`, atThreshold.length === 1 && atThreshold[0].stakeId === idA);
  const over = decideSlashes({ [idA]: SLASH_AFTER_EPOCHS + 5 }, stakes);
  check(`连续掉线 ${SLASH_AFTER_EPOCHS + 5}(>阈值) → 仍罚`, over.length === 1);
}

console.log(`\n— ② 罚没额 = floor(SLASH_FRACTION(${SLASH_FRACTION}) × 剩余本金)；边界不产出 —`);
{
  const a = '0x' + 'b'.repeat(64);
  // 本金 100、已罚 0 → 剩余 100 → floor(0.1×100)=10
  const [id1, p1] = pool(a, { amount: 100, slashed: 0 });
  // 本金 100、已罚 30 → 剩余 70 → floor(0.1×70)=7
  const [id2, p2] = pool(a, { amount: 100, slashed: 30 });
  // 本金 5、剩余 5 → floor(0.1×5)=0 → 不产出（剩余太小）
  const [id3, p3] = pool(a, { amount: 5, slashed: 0 });
  // 已赎回 → 不产出
  const [id4, p4] = pool(a, { amount: 100, withdrawn: true });
  // 已罚没殆尽（剩余 0）→ 不产出
  const [id5, p5] = pool(a, { amount: 100, slashed: 100 });
  const stakes = new Map<string, StakePool>([[id1, p1], [id2, p2], [id3, p3], [id4, p4], [id5, p5]]);
  const hist: OfflineHistory = { [id1]: SLASH_AFTER_EPOCHS, [id2]: SLASH_AFTER_EPOCHS, [id3]: SLASH_AFTER_EPOCHS, [id4]: SLASH_AFTER_EPOCHS, [id5]: SLASH_AFTER_EPOCHS };
  const ds = decideSlashes(hist, stakes);
  const by = new Map(ds.map((d) => [d.stakeId, d]));
  check('剩余 100 → 罚 floor(0.1×100)=10', by.get(id1)?.amount === 10);
  check('剩余 70（已罚 30）→ 罚 floor(0.1×70)=7', by.get(id2)?.amount === 7);
  check('剩余 5 → floor(0.1×5)=0 → 不产出空 SLASH', !by.has(id3));
  check('已赎回质押 → 不产出', !by.has(id4));
  check('已罚没殆尽（剩余 0）→ 不产出', !by.has(id5));
  check('decideSlashes 不修改入参 stakes（纯函数）', p1.slashed === 0 && p2.slashed === 30);
  check('SLASH_FRACTION 保守 ∈ (0,1)', SLASH_FRACTION > 0 && SLASH_FRACTION < 1);
}

console.log(`\n— ③ updateOfflineHistory 滚动：在线清零 / 掉线累加 / 赎回移除 —`);
{
  const x = '0x' + 'c'.repeat(64);
  const [idOnline, pOnline] = pool(x);
  const [idOffline, pOffline] = pool(x);
  const [idWd, pWd] = pool(x, { withdrawn: true });
  const stakes = new Map<string, StakePool>([[idOnline, pOnline], [idOffline, pOffline], [idWd, pWd]]);
  const prev: OfflineHistory = { [idOnline]: 2, [idOffline]: 2, [idWd]: 9 };
  const next = updateOfflineHistory(prev, new Set([idOnline]), stakes);
  check('本 epoch 在线 → 计数清零', next[idOnline] === 0);
  check('本 epoch 掉线 → 计数累加（2→3）', next[idOffline] === 3);
  check('已赎回质押 → 从历史移除（不再追踪）', !(idWd in next));
  // 新质押首次掉线：prev 无记录 → 累加为 1
  const [idNew, pNew] = pool(x);
  stakes.set(idNew, pNew);
  const next2 = updateOfflineHistory({}, new Set(), stakes);
  check('新质押首次掉线 → 计数从 0 累加为 1', next2[idNew] === 1);
}

console.log(`\n— ④ SLASH 交易成形：memo / from / parseSlash 解回 —`);
{
  // 成形等同 CLI slash-epoch --send 的做法：度量者钱包对自转 0 币 + SLASH| memo 签名。
  // 这里用一个临时钱包代签来验「成形格式」；真链上接受需 from===MEASURER_ADDRESS（见 ⑤ 与部署说明）。
  const stakeId = 'f'.repeat(64);
  const amount = 10;
  const epoch = 4;
  const memo = `${SLASH_PREFIX}${stakeId}|${amount}|${epoch}`;
  const signer = Wallet.generate();
  const tx = createTransaction(signer, signer.address, 0, 0, memo, MIN_FEE);
  check('SLASH 交易 amount == 0（零额操作）', tx.amount === 0);
  check('SLASH 交易 memo == `SLASH|<stakeId>|<amount>|<epoch>`', tx.memo === memo);
  check('SLASH 交易 from == 签名者地址（成形时 = 度量者钱包；链接受要求 ===MEASURER_ADDRESS）', tx.from === signer.address);
  const parsed = parseSlash(tx.memo);
  check('parseSlash 能从成形 memo 解回 {stakeId, amount, epoch}', parsed?.stakeId === stakeId && parsed?.amount === amount && parsed?.epoch === epoch);
  check('MEASURER_ADDRESS 是地址而非私钥（其私钥不在仓库，链上 SLASH 接受属部署期）', MEASURER_ADDRESS.startsWith('0x') && MEASURER_ADDRESS.length === 66);
}

// 段 ⑤ 需要 forge 到激活高度（异步）→ 用一个 async IIFE 收尾（前面 ①~④ 都是同步纯函数断言）。
(async () => {
  console.log(`\n— ⑤ 链侧拒「非度量者签发的 SLASH」（复用已合入共识；本地无 MEASURER 私钥，无法落地成功 SLASH）—`);
  // 把链推到激活高度之上，真正进入质押分支（forge 追加区块到 ≥ STAKING_ACTIVATION_HEIGHT，便宜，不做 16000 次真 PoW）。
  const { bc, relay, stakeId } = await buildActivatedChainWithStake();
  // 非度量者（中继自己）签 SLASH → mempool 校验应拒（redOpError: '只有度量者能罚没'）。
  const badSlash = createTransaction(relay, relay.address, 0, bc.nonceOf(relay.address), `${SLASH_PREFIX}${stakeId}|5|0`, MIN_FEE);
  const res = bc.addTransaction(badSlash);
  check('非度量者签发的 SLASH 被共识拒（addTransaction.ok === false）', res.ok === false);
  check('拒绝原因点明「只有度量者能罚没」', String(res.error).includes('度量者'));
  // 质押池仍完好（未被非度量者动到）。
  check('被拒后质押池 slashed 仍为 0（非度量者罚没无效）', computeStakeState(bc.chain).get(stakeId)?.slashed === 0);
  // 正向佐证：parseSlash 对该 memo 是合法的（即「被拒」纯因签发人非度量者，而非格式问题）。
  check('该 SLASH memo 本身格式合法（被拒因签发人，非格式）', parseSlash(`${SLASH_PREFIX}${stakeId}|5|0`) !== null);
  // 整链（含 forge 高度 + 真 STAKE 块）一次性 validateChain 必过（forge 出来的链对共识合法）。
  check('含 forge 高度 + STAKE 的整链 validateChain 通过', Blockchain.validateChain(bc.chain).ok);

  console.log(failed === 0 ? `\n🎉 全部通过 ALL PASS\n` : `\n💥 ${failed} 项失败 ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});

// ---- 辅助：便宜地把链 forge 到 ≥ STAKING_ACTIVATION_HEIGHT 并落一笔真 STAKE（forge 追加块，不做 16000 次真 PoW）----
async function buildActivatedChainWithStake(): Promise<{ bc: Blockchain; relay: Wallet; stakeId: string }> {
  const bc = new Blockchain();
  const relay = Wallet.generate();
  // forge 到激活高度（coinbase 全发给 relay，顺带攒够押金 + 手续费）。
  await forgeTo(bc, relay.address, STAKING_ACTIVATION_HEIGHT);
  if (bc.height < STAKING_ACTIVATION_HEIGHT) throw new Error('forge 未达激活高度');
  // 此时高度 ≥ 激活高度 → STAKE 进入质押分支。发一笔真 STAKE 并 forge 进下一块。
  const stakeTx = createTransaction(relay, STAKE_ESCROW_ADDRESS, STAKE_MIN.guard, bc.nonceOf(relay.address), `${STAKE_PREFIX}guard`, MIN_FEE);
  if (!bc.addTransaction(stakeTx).ok) throw new Error('forge 后 STAKE 未进 mempool（高度/余额不足？）');
  await forgeAppendBlock(bc, relay.address, [stakeTx]);
  if (!computeStakeState(bc.chain).get(stakeTx.txid)) throw new Error('STAKE 未开池（激活门控未越过？）');
  return { bc, relay, stakeId: stakeTx.txid };
}
