// 消息防刷底线自检（Phase：消息销毁额随备注长度递增）。跑：corepack pnpm exec tsx scripts/message-burn-floor-selftest.ts
// 覆盖：minMessageBurnFor 公式（边界/单调/整数）、isRealMessage 分类（真正合法的协议层操作绝不受约束，
//       含身份 IDCLAIM/IDRELEASE 交叉wiring；**套壳攻击——前缀匹配但 payload/burn 不合法——必须受约束**，
//       这是 isProtocolMemo 从纯 startsWith 收紧为「payload 格式 + 精确/达标烧币值」双重校验的核心回归测试）、
//       激活高度门控（forge-chain 便宜锻造）、mempool 与选包两条路径一致拒绝、分叉安全
//       （computeState ≡ validateChain ≡ replaceChain）、供应量守恒。
import {
  Blockchain,
  Wallet,
  createTransaction,
  createMessage,
  minMessageBurnFor,
  isRealMessage,
  MESSAGE_BURN,
  MESSAGE_BURN_PER_CHAR_UNIT,
  MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
  MAX_MEMO,
  FISH_PREFIX,
  PET_PREFIX,
  PETBREED_PREFIX,
  PET_BREED_COST,
  IDCLAIM_PREFIX,
  IDRELEASE_PREFIX,
  STAKE_PREFIX,
  RED_PREFIX,
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
  console.log(`\n— 配置向量：激活高度晚于历史 checkpoint，斜率为正 —`);
  check('消息防刷激活高度 > 当前 checkpoint 历史', MIN_MESSAGE_BURN_ACTIVATION_HEIGHT > 300);
  check('斜率为正', MESSAGE_BURN_PER_CHAR_UNIT > 0);
  check('minMessageBurnFor(0) === MESSAGE_BURN（空备注门槛不变）', minMessageBurnFor(0) === MESSAGE_BURN);

  console.log(`\n— 纯公式测试：minMessageBurnFor 边界值/单调不减/全整数 —`);
  check('1 字符门槛仍是 MESSAGE_BURN（不误伤日常寒暄）', minMessageBurnFor(1) === MESSAGE_BURN);
  check(
    `恰好一个斜率单位（${MESSAGE_BURN_PER_CHAR_UNIT} 码点）门槛 +1`,
    minMessageBurnFor(MESSAGE_BURN_PER_CHAR_UNIT) === MESSAGE_BURN + 1,
  );
  check(
    `MAX_MEMO(${MAX_MEMO}) 长消息门槛 = MESSAGE_BURN + floor(MAX_MEMO/斜率)`,
    minMessageBurnFor(MAX_MEMO) === MESSAGE_BURN + Math.floor(MAX_MEMO / MESSAGE_BURN_PER_CHAR_UNIT),
  );
  {
    const lengths = [0, 1, 19, 20, 21, 199, 200, 511, 512];
    let monotonic = true;
    let allInt = true;
    for (let i = 0; i < lengths.length; i++) {
      const v = minMessageBurnFor(lengths[i]);
      if (!Number.isInteger(v)) allInt = false;
      if (i > 0 && v < minMessageBurnFor(lengths[i - 1])) monotonic = false;
    }
    check('minMessageBurnFor 在抽样长度上单调不减', monotonic);
    check('minMessageBurnFor 在抽样长度上全整数输出（禁浮点跨节点分叉）', allInt);
  }

  console.log(`\n— isRealMessage 分类：真正合法的协议层操作不算真消息（精确 payload + 达标烧币值）—`);
  check('PET| 精确孵化 memo（无后缀）不算真消息', !isRealMessage({ amount: 0, burn: 1, memo: PET_PREFIX }));
  check('FISH| 精确铸渔获 memo（无后缀）不算真消息', !isRealMessage({ amount: 0, burn: 1, memo: FISH_PREFIX }));
  check(
    'PETBREED|<64hex>|<64hex> 且 burn=PET_BREED_COST 不算真消息',
    !isRealMessage({ amount: 0, burn: PET_BREED_COST, memo: `${PETBREED_PREFIX}${fakeId}|${fakeId}` }),
  );
  check('STAKE| 前缀（形态测试，共识层已保护）不算真消息', !isRealMessage({ amount: 0, burn: 1, memo: `${STAKE_PREFIX}guard` }));
  check('RED| 前缀（形态测试，共识层已保护）不算真消息', !isRealMessage({ amount: 0, burn: 1, memo: `${RED_PREFIX}10|r` }));
  check(
    'IDCLAIM| 前缀不算真消息（Feature A×B 交叉wiring，共识层已保护）',
    !isRealMessage({ amount: 0, burn: 1, memo: `${IDCLAIM_PREFIX}alice` }),
  );
  check(
    'IDRELEASE| 前缀不算真消息（Feature A×B 交叉wiring，共识层已保护）',
    !isRealMessage({ amount: 0, burn: 1, memo: `${IDRELEASE_PREFIX}${fakeId}` }),
  );
  check('普通正文才算真消息', isRealMessage({ amount: 0, burn: 5, memo: 'hello there' }));

  console.log(`\n— 核心回归：套壳攻击（前缀匹配但 payload 是垃圾或 burn 不达标）必须算真消息、受烧币下限约束 —`);
  check(
    'FISH| 后面接垃圾内容（非精确匹配）算真消息（旧漏洞：曾被 startsWith 误放行）',
    isRealMessage({ amount: 0, burn: 1, memo: `${FISH_PREFIX}${'x'.repeat(300)}` }),
  );
  check(
    'PET| 后面接垃圾内容（非精确匹配）算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: `${PET_PREFIX}${'x'.repeat(300)}` }),
  );
  check(
    'PETBREED| 格式合法但 burn 不等于 PET_BREED_COST 时算真消息（套壳想蹭排除但没付真实协议成本）',
    isRealMessage({ amount: 0, burn: 1, memo: `${PETBREED_PREFIX}${fakeId}|${fakeId}` }),
  );

  console.log(`\n— 激活门控：激活前旧规则放行低销毁长消息，不 retroactive 拒绝已广播交易 —`);
  {
    const pre = new Blockchain();
    const user = Wallet.generate();
    for (let i = 0; i < 6; i++) await pre.mine(user.address);
    const longMemo = 'x'.repeat(200);
    const lowBurnLongMsg = createMessage(user, user.address, longMemo, pre.nonceOf(user.address), 1, MIN_FEE);
    check('激活前：200 字长消息 burn=1 仍被接受（旧规则只要求 burn>0）', pre.addTransaction(lowBurnLongMsg).ok);
    await pre.mine(user.address);
    check('激活前链整链校验通过', Blockchain.validateChain(pre.chain).ok);
  }

  console.log(`\n— 把基底链便宜地 forge 到激活高度 ${MIN_MESSAGE_BURN_ACTIVATION_HEIGHT}（非真 PoW）…耐心几秒 —`);
  {
    const base = new Blockchain();
    await forgeTo(base, funder.address, MIN_MESSAGE_BURN_ACTIVATION_HEIGHT);
    baseSnapshot = base.chain;
    check(
      `基底链已达激活高度（height=${base.height} ≥ ${MIN_MESSAGE_BURN_ACTIVATION_HEIGHT}）`,
      base.height >= MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
    );
    check('基底链整链 validateChain 通过', Blockchain.validateChain(base.chain).ok);
    check('基底链全链守恒', conserved(base));
  }

  console.log(`\n— 场景：短消息门槛不变、长消息旧默认值被拒、长消息按新公式烧够则放行 —`);
  const bc = activatedClone();
  const alice = Wallet.generate();
  await fund(bc, alice.address, 1000);

  const shortMemo = 'hi';
  check(
    '短消息 burn=MESSAGE_BURN 被接受（门槛未涨）',
    bc.addTransaction(createMessage(alice, alice.address, shortMemo, bc.nonceOf(alice.address), MESSAGE_BURN, MIN_FEE)).ok,
  );
  await bc.mine(alice.address); // 立即挖矿，保持 nonceOf 与实际已确认状态同步（不同 tx 间不留悬空 mempool）
  check(
    '短消息 burn=MESSAGE_BURN-1 被拒（低于门槛）',
    !bc.addTransaction(createMessage(alice, alice.address, shortMemo, bc.nonceOf(alice.address), MESSAGE_BURN - 1, MIN_FEE)).ok,
  );
  const longMemo = 'y'.repeat(200);
  const longRequired = minMessageBurnFor(200);
  check(`200 字长消息门槛应 > 旧默认值（${longRequired} > ${MESSAGE_BURN}）`, longRequired > MESSAGE_BURN);
  const rejLong = bc.addTransaction(createMessage(alice, alice.address, longMemo, bc.nonceOf(alice.address), MESSAGE_BURN, MIN_FEE));
  check('激活后：200 字长消息仍用旧默认值 burn=MESSAGE_BURN 被拒（核心场景：以前合法、现在不合法）', !rejLong.ok);
  check('拒绝原因点明消息销毁额过低', String(rejLong.error).includes('消息销毁额过低'));
  check(
    '同一条长消息按新公式 minMessageBurnFor(200) 烧够则被接受',
    bc.addTransaction(createMessage(alice, alice.address, longMemo, bc.nonceOf(alice.address), longRequired, MIN_FEE)).ok,
  );
  await bc.mine(alice.address);
  check('消息场景后全链守恒', conserved(bc));
  check('含消息的链整链校验通过', Blockchain.validateChain(bc.chain).ok);

  console.log(`\n— 协议层低销毁操作不受消息防刷影响（真正合法的 memo，isProtocolMemo 精确匹配放行）—`);
  const bob = Wallet.generate();
  await fund(bc, bob.address, 100);
  // 形态同「链上消息」（amount=0+burn>0）但 memo **精确等于** FISH_PREFIX（真实铸渔获的合法形态，无后缀），
  // 且 burn=2 远低于 MESSAGE_BURN=5：若 isRealMessage 排除失效，这笔会被 Feature A 的门槛误杀。
  const fishTx = createMessage(bob, bob.address, FISH_PREFIX, bc.nonceOf(bob.address), 2, MIN_FEE);
  check('FISH| 真实协议操作（精确 memo，burn=2，远低于消息门槛）激活后依然被接受', bc.addTransaction(fishTx).ok);
  await bc.mine(bob.address);
  check('协议层操作场景后全链守恒', conserved(bc));

  console.log(`\n— mempool 与选包两条路径一致拒绝：绕过 addTransaction 直塞进 mempool 也不会被打包 —`);
  {
    const sc = activatedClone();
    const carol = Wallet.generate();
    await fund(sc, carol.address, 100);
    const badMemo = 'z'.repeat(200);
    const badTx = createMessage(carol, carol.address, badMemo, sc.nonceOf(carol.address), MESSAGE_BURN, MIN_FEE);
    check('该低销毁长消息确实会被 addTransaction 拒绝（前置条件）', !sc.addTransaction(badTx).ok);
    // 绕过 addTransaction 直接塞进公开的 mempool 数组，模拟“不知怎的溜进池子”的边缘情况。
    (sc as unknown as { mempool: unknown[] }).mempool.push(badTx);
    const before = sc.height;
    const mined = await sc.mine(carol.address);
    check('mine() 成功出块（selectMempoolTxs 应跳过坏交易而非卡死）', mined !== null);
    check('高度确实前进了一块', sc.height === before + 1);
    const included = mined!.transactions.some((t) => t.txid === badTx.txid);
    check('selectMempoolTxs 独立拒绝了该低销毁长消息（未被打进块）', !included);
    check('该块整链校验通过', Blockchain.validateChain(sc.chain).ok);
  }

  console.log(`\n— 分叉安全：computeState ≡ validateChain ≡ replaceChain（余额逐项一致）—`);
  {
    const vc = Blockchain.validateChain(bc.chain);
    check('Blockchain.validateChain(bc.chain).ok === true', vc.ok === true);
    const replica = Blockchain.fromJSON({ chain: JSON.parse(JSON.stringify(bc.chain)), mempool: [] });
    const balA = bc.computeState().balances;
    const balB = replica.computeState().balances;
    let balancesIdentical = balA.size === balB.size;
    for (const [k, v] of balA) if (balB.get(k) !== v) balancesIdentical = false;
    check('computeState 余额表在重放副本上逐项一致（无分叉）', balancesIdentical);
    const fresh = new Blockchain();
    const rep = fresh.replaceChain(JSON.parse(JSON.stringify(bc.chain)));
    check('含消息防刷交易的整链经 replaceChain 被全新节点接受', rep.replaced === true);
    check('被接受后 alice 余额与源链一致', fresh.balanceOf(alice.address) === bc.balanceOf(alice.address));
  }

  console.log(failed === 0 ? `\n🎉 全部通过 ALL PASS\n` : `\n💥 ${failed} 项失败 ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
