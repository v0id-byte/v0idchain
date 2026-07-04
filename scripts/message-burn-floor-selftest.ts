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
  isProtocolMemo,
  UNSTAKE_PREFIX,
  MESSAGE_BURN,
  MESSAGE_BURN_PER_CHAR_UNIT,
  MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
  MAX_MEMO,
  FISH_PREFIX,
  PET_PREFIX,
  PETX_PREFIX,
  PETBREED_PREFIX,
  PET_BREED_COST,
  LAND_PREFIX,
  IDCLAIM_PREFIX,
  IDRELEASE_PREFIX,
  STAKE_PREFIX,
  STAKE_ESCROW_ADDRESS,
  STAKING_ACTIVATION_HEIGHT,
  RED_PREFIX,
  RED_ESCROW_ADDRESS,
  IDENTITY_ESCROW_ADDRESS,
  IDENTITY_ACTIVATION_HEIGHT,
  IDENTITY_STAKE_MIN,
  GENESIS_PREMINE,
  BLOCK_REWARD,
  MIN_FEE,
  minFeeFor,
  isMemoSpamCandidate,
  buildNameMemo,
  buildListMemo,
  DEL_PREFIX,
  buildRelayMemo,
  ROOM_PREFIX,
  MINE_MAT_PREFIX,
  makeMineMaterial,
  mineMaterialBurn,
  transactionPayloadHash,
  sign,
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

  console.log(`\n— 向后兼容：isProtocolMemo 仍接受裸字符串（历史签名），不抛异常、缺语境时保守判 false —`);
  check(
    'isProtocolMemo(裸字符串 "UNSTAKE|..." )：① id 引用类纯 startsWith，与旧版一致返回 true',
    isProtocolMemo(`${UNSTAKE_PREFIX}${'a'.repeat(64)}`) === true,
  );
  check(
    'isProtocolMemo(裸字符串 "STAKE|guard")：② 需 to===托管地址语境，字符串模式缺语境 → 保守返回 false（不误豁免）',
    isProtocolMemo('STAKE|guard') === false,
  );
  check(
    'isProtocolMemo(裸字符串 普通正文)：非协议前缀 → false（且不抛异常）',
    isProtocolMemo('hello world') === false,
  );

  console.log(`\n— isRealMessage 分类：真正合法的协议层操作不算真消息（精确 payload + 达标烧币值 + from/to/amount 语境）—`);
  const selfAddr = '0x' + '1'.repeat(64);
  const otherAddr = '0x' + '2'.repeat(64);
  check(
    'PET| 精确孵化 memo（自转、无后缀）不算真消息',
    !isRealMessage({ amount: 0, burn: 1, memo: PET_PREFIX, from: selfAddr, to: selfAddr }),
  );
  check(
    'PET| 但 burn=0（旧漏洞⑪：parsePets 要求 burn>0 才算真孵化，burn=0 只是自转带 memo）算真消息',
    isRealMessage({ amount: 0, burn: 0, memo: PET_PREFIX, from: selfAddr, to: selfAddr }),
  );
  check(
    'FISH| 精确铸渔获 memo（自转、无后缀）不算真消息',
    !isRealMessage({ amount: 0, burn: 1, memo: FISH_PREFIX, from: selfAddr, to: selfAddr }),
  );
  check(
    'FISH| 但 burn=0（parseFish 同样要求 burn>0 才算真铸渔获）算真消息',
    isRealMessage({ amount: 0, burn: 0, memo: FISH_PREFIX, from: selfAddr, to: selfAddr }),
  );
  check(
    'PETBREED|<64hex>|<64hex>（自转）且 burn=PET_BREED_COST 不算真消息',
    !isRealMessage({ amount: 0, burn: PET_BREED_COST, memo: `${PETBREED_PREFIX}${fakeId}|${fakeId}`, from: selfAddr, to: selfAddr }),
  );
  check(
    'PETX|<64hex>（转移给别人 + amount>0）不算真消息',
    !isRealMessage({ amount: 1, burn: 1, memo: `${PETX_PREFIX}${fakeId}`, from: selfAddr, to: otherAddr }),
  );
  check(
    'LAND|<n>（自转）不算真消息',
    !isRealMessage({ amount: 0, burn: 999, memo: `${LAND_PREFIX}0`, from: selfAddr, to: selfAddr }),
  );
  check(
    'LAND|<n> 但 burn=0（旧漏洞⑫：parseFarm 的 selfBurn 门槛要求 burn>0，地价恒为正）算真消息',
    isRealMessage({ amount: 0, burn: 0, memo: `${LAND_PREFIX}0`, from: selfAddr, to: selfAddr }),
  );
  check(
    'STAKE| 真发往质押托管地址 + 已过激活高度 不算真消息',
    !isRealMessage({ amount: 0, burn: 1, memo: `${STAKE_PREFIX}guard`, from: selfAddr, to: STAKE_ESCROW_ADDRESS, atHeight: STAKING_ACTIVATION_HEIGHT }),
  );
  check(
    'RED| 真发往红包托管地址 + amount 达标（count=10，真实转账给第三方）不算真消息' +
      '（本就落在 isMemoSpamCandidate 候选范围外，amount 达标与否不影响这条——见下方旧漏洞⑧才是新增校验点）',
    !isRealMessage({ amount: 10, burn: 1, memo: `${RED_PREFIX}10|r`, from: selfAddr, to: RED_ESCROW_ADDRESS, atHeight: 1 }),
  );
  check(
    'RED| 但 amount 不足 count（旧漏洞⑧：amount=0 时 consensus 不当真红包接受，只是普通烧币到托管，' +
      '此时若仍判定为协议层会免费绕开消息门槛）算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: `${RED_PREFIX}10|r`, from: selfAddr, to: RED_ESCROW_ADDRESS, atHeight: 1 }),
  );
  check(
    'IDCLAIM| 真发往身份托管地址 + 已过激活高度 + amount 达标（真实转账给第三方）不算真消息' +
      '（本就落在 isMemoSpamCandidate 候选范围外——见下方旧漏洞⑨才是新增校验点）',
    !isRealMessage({
      amount: IDENTITY_STAKE_MIN, burn: 1, memo: `${IDCLAIM_PREFIX}alice`,
      from: selfAddr, to: IDENTITY_ESCROW_ADDRESS, atHeight: IDENTITY_ACTIVATION_HEIGHT,
    }),
  );
  check(
    'IDCLAIM| 但 amount 不足 IDENTITY_STAKE_MIN（旧漏洞⑨：amount=0 时 consensus 不当真认领接受，只是普通烧币到托管）算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: `${IDCLAIM_PREFIX}alice`, from: selfAddr, to: IDENTITY_ESCROW_ADDRESS, atHeight: IDENTITY_ACTIVATION_HEIGHT }),
  );
  check(
    'IDRELEASE| 前缀不算真消息（id 引用类，consensus 不看 to，共识层已保护）',
    !isRealMessage({ amount: 0, burn: 1, memo: `${IDRELEASE_PREFIX}${fakeId}`, from: selfAddr, to: otherAddr }),
  );
  check('普通正文才算真消息', isRealMessage({ amount: 0, burn: 5, memo: 'hello there', from: selfAddr, to: otherAddr }));

  console.log(`\n— 核心回归：套壳攻击必须算真消息、受烧币下限约束 —`);
  check(
    'FISH| 后面接垃圾内容（非精确匹配）算真消息（旧漏洞①：曾被 startsWith 误放行）',
    isRealMessage({ amount: 0, burn: 1, memo: `${FISH_PREFIX}${'x'.repeat(300)}`, from: selfAddr, to: selfAddr }),
  );
  check(
    'PET| 后面接垃圾内容（非精确匹配）算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: `${PET_PREFIX}${'x'.repeat(300)}`, from: selfAddr, to: selfAddr }),
  );
  check(
    'PETBREED| 格式合法但 burn 不等于 PET_BREED_COST 时算真消息（套壳想蹭排除但没付真实协议成本）',
    isRealMessage({ amount: 0, burn: 1, memo: `${PETBREED_PREFIX}${fakeId}|${fakeId}`, from: selfAddr, to: selfAddr }),
  );
  check(
    'PET| payload 精确但 from!==to（非自转）算真消息（旧漏洞②：曾不查 from/to 语境）',
    isRealMessage({ amount: 0, burn: 1, memo: PET_PREFIX, from: selfAddr, to: otherAddr }),
  );
  check(
    'LAND|<n> 但 from!==to（非自转）算真消息——真实买地要求自转烧币',
    isRealMessage({ amount: 0, burn: 999, memo: `${LAND_PREFIX}0`, from: selfAddr, to: otherAddr }),
  );
  check(
    'STAKE|guard 但 to 不是质押托管地址算真消息（旧漏洞③：曾只看前缀不看 to，consensus 也不会把它当质押）',
    isRealMessage({ amount: 0, burn: 1, memo: `${STAKE_PREFIX}guard`, from: selfAddr, to: otherAddr, atHeight: STAKING_ACTIVATION_HEIGHT }),
  );
  check(
    'RED|10|r 但 to 不是红包托管地址算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: `${RED_PREFIX}10|r`, from: selfAddr, to: otherAddr, atHeight: 1 }),
  );
  check(
    'IDCLAIM|alice 但 to 不是身份托管地址算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: `${IDCLAIM_PREFIX}alice`, from: selfAddr, to: otherAddr, atHeight: IDENTITY_ACTIVATION_HEIGHT }),
  );
  check(
    'PETX|<64hex> 但 amount=0（没真转账）算真消息——真实送崽要求转 1 币',
    isRealMessage({ amount: 0, burn: 1, memo: `${PETX_PREFIX}${fakeId}`, from: selfAddr, to: otherAddr }),
  );

  console.log(`\n— 核心回归②：LAND 超长数字 payload 必须算真消息（旧漏洞④：数字类字段未限位数）—`);
  check(
    'LAND|<9位数字>（自转、位数上限内）不算真消息',
    !isRealMessage({ amount: 0, burn: 999, memo: `${LAND_PREFIX}${'9'.repeat(9)}`, from: selfAddr, to: selfAddr }),
  );
  check(
    'LAND|<500位数字>（自转、远超位数上限，套壳夹带垃圾）算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: `${LAND_PREFIX}${'1'.repeat(500)}`, from: selfAddr, to: selfAddr }),
  );

  console.log(`\n— 核心回归③：IDENTITY_ACTIVATION_HEIGHT(45000) 晚于 MIN_MESSAGE_BURN_ACTIVATION_HEIGHT(40000)，`);
  console.log(`   窗口期内（消息门槛已激活、身份质押尚未激活）IDCLAIM 不能豁免（旧漏洞⑤）—`);
  check(
    `身份激活高度确实晚于消息防刷激活高度（存在窗口期，前提条件）`,
    IDENTITY_ACTIVATION_HEIGHT > MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
  );
  const windowHeight = MIN_MESSAGE_BURN_ACTIVATION_HEIGHT + 1; // 落在 (40000, 45000) 窗口内
  check(
    'IDCLAIM|alice 发往身份托管地址,但 atHeight 落在窗口期内（身份尚未激活）算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: `${IDCLAIM_PREFIX}alice`, from: selfAddr, to: IDENTITY_ESCROW_ADDRESS, atHeight: windowHeight }),
  );
  check(
    '同一笔 IDCLAIM，即便 atHeight 已达身份激活高度仍算真消息（amount=0 恒不足 IDENTITY_STAKE_MIN，' +
      '不像旧版那样单靠高度跨过激活点就豁免——现在还需 amount 达标，而达标的 amount>0 又天然不落入' +
      'isMemoSpamCandidate 候选范围，故这条分支在 isRealMessage 的可达路径里恒定判真消息）',
    isRealMessage({
      amount: 0, burn: 1, memo: `${IDCLAIM_PREFIX}alice`,
      from: selfAddr, to: IDENTITY_ESCROW_ADDRESS, atHeight: IDENTITY_ACTIVATION_HEIGHT,
    }),
  );
  check(
    'STAKE|guard 发往质押托管地址,但 atHeight 落在质押激活高度之前算真消息（同一逻辑的 STAKE 版本）',
    isRealMessage({ amount: 0, burn: 1, memo: `${STAKE_PREFIX}guard`, from: selfAddr, to: STAKE_ESCROW_ADDRESS, atHeight: STAKING_ACTIVATION_HEIGHT - 1 }),
  );

  console.log(`\n— 核心回归④：isMemoSpamCandidate 不再要求 amount===0，「自转夹带」必须受消息门槛约束（旧漏洞⑥）—`);
  check(
    'isMemoSpamCandidate：自转 + amount>0 + 非空 memo + burn=0 也算候选（旧版 isMessageTx 会漏掉）',
    isMemoSpamCandidate({ from: selfAddr, to: selfAddr, memo: 'x'.repeat(300) }),
  );
  check(
    'isMemoSpamCandidate：转给别人（非自转）不算候选——转账带备注是合法场景，不受消息门槛约束',
    !isMemoSpamCandidate({ from: selfAddr, to: otherAddr, memo: 'x'.repeat(300) }),
  );
  check(
    'isMemoSpamCandidate：自转但 memo 为空不算候选（普通无备注自转）',
    !isMemoSpamCandidate({ from: selfAddr, to: selfAddr, memo: '' }),
  );
  check(
    '「自转 1 币 + 512 码点垃圾 memo + burn=0」（旧漏洞⑥：不满足 isMessageTx 的 amount=0 形态）现在算真消息',
    isRealMessage({ amount: 1, burn: 0, memo: 'x'.repeat(512), from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    '同一形态但转给别人（真实转账+备注）不算真消息，不受门槛约束',
    !isRealMessage({ amount: 1, burn: 0, memo: 'x'.repeat(512), from: selfAddr, to: otherAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );

  console.log(`\n— 核心回归⑤：NAME/MKT/RELAY（自转、burn 恒为 0）扩大范围后仍需被正确排除，不被误伤 —`);
  check(
    'NAME|alice（自转、burn=0、合法昵称）不算真消息',
    !isRealMessage({ amount: 0, burn: 0, memo: buildNameMemo('alice'), from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'NAME| 但 burn>0（不是真实抢注形态）算真消息',
    isRealMessage({ amount: 0, burn: 1, memo: buildNameMemo('alice'), from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'MKT|<价格>|<标题>（自转、burn=0、合法上架)不算真消息',
    !isRealMessage({ amount: 0, burn: 0, memo: buildListMemo(100, '复习笔记'), from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'MKT| 但标题超 MAX_TITLE(100) 算真消息（伪装上架夹带长文）',
    isRealMessage({ amount: 0, burn: 1, memo: buildListMemo(100, 'x'.repeat(200)), from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'RELAY|...（自转、burn=0、合法描述符）不算真消息',
    !isRealMessage({
      amount: 0, burn: 0, memo: buildRelayMemo('a'.repeat(64), '10.0.0.1', 6001),
      from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
    }),
  );
  check(
    'RELAY| 但 burn>0（不是真实发布形态）算真消息',
    isRealMessage({
      amount: 0, burn: 1, memo: buildRelayMemo('a'.repeat(64), '10.0.0.1', 6001),
      from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
    }),
  );
  check(
    'DEL|<64hex>（自转、burn=0，V0idNode.marketDelist() 的真实形态）不算真消息',
    !isRealMessage({ amount: 1, burn: 0, memo: `${DEL_PREFIX}${fakeId}`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'DEL| 但 burn>0（不是真实撤单形态）算真消息',
    isRealMessage({ amount: 1, burn: 1, memo: `${DEL_PREFIX}${fakeId}`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'ROOM|<64hex>（自转、burn=0，game-web publishRoom() 的真实形态）不算真消息',
    !isRealMessage({ amount: 1, burn: 0, memo: `${ROOM_PREFIX}${fakeId}`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'ROOM| 但 burn>0（不是真实发布形态）算真消息',
    isRealMessage({ amount: 1, burn: 1, memo: `${ROOM_PREFIX}${fakeId}`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'ROOM| 但 payload 不是 64-hex（伪装发布夹带长文）算真消息',
    isRealMessage({ amount: 1, burn: 1, memo: `${ROOM_PREFIX}${'x'.repeat(200)}`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );

  console.log(`\n— 核心回归⑦：数字/字符串字段填充攻击——Number()/trim() 归一化把填充值判成合法小值，`);
  console.log(`   必须核对规范形式（无前导零/空白），否则可撑满 512 码点仍被判非真消息（旧漏洞⑩）—`);
  check(
    'NAME|<506 空格>x（trim 后归一成合法昵称 x）算真消息——不该被当协议层豁免',
    isRealMessage({ amount: 0, burn: 1, memo: `NAME|${' '.repeat(506)}x`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'MKT|<前导零填充的价格>|x（Number() 归一成 1）算真消息——价格字段须是规范十进制形式',
    isRealMessage({ amount: 0, burn: 1, memo: `MKT|${'0'.repeat(505)}1|x`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'MKT|1|x（规范形式，无填充）合法上架仍不算真消息（对照组，确认没有误伤正常上架）',
    !isRealMessage({ amount: 0, burn: 0, memo: buildListMemo(1, 'x'), from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  const paddedMineCount = `${MINE_MAT_PREFIX}copper|${'0'.repeat(495)}1`; // 495 零 + 1 位数字 = 496 位，凑够 512 码点
  check(
    'MINE|MAT|copper|<前导零填充的数量>（parseMineMemo 归一成 1）算真消息——数量字段须是规范十进制形式',
    isRealMessage({
      amount: 0, burn: mineMaterialBurn('copper', 1), memo: paddedMineCount,
      from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
    }),
  );
  check(
    'MINE|MAT|copper|1（规范形式，无填充）合法材料铸造仍不算真消息（对照组）',
    !isRealMessage({
      amount: 0, burn: mineMaterialBurn('copper', 1), memo: makeMineMaterial('copper', 1).memo!,
      from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT,
    }),
  );
  const paddedRelayPort = `RELAY|${'a'.repeat(64)}|10.0.0.1:${'0'.repeat(429)}6001|m|0`; // 端口前导零填充撑到 512 码点
  check(
    'RELAY|...:<前导零填充的端口>|...（Number() 归一成合法端口）算真消息——端口字段须是规范十进制形式',
    isRealMessage({ amount: 0, burn: 1, memo: paddedRelayPort, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );

  console.log(`\n— 核心回归⑥：IDRELEASE 拒绝条件依赖 amount，未激活+amount≠0 这个组合不能豁免（旧漏洞⑦）—`);
  check(
    'IDRELEASE|<64hex> 已激活 + amount=0（真实解锁形态）不算真消息',
    !isRealMessage({ amount: 0, burn: 0, memo: `${IDRELEASE_PREFIX}${fakeId}`, from: selfAddr, to: selfAddr, atHeight: IDENTITY_ACTIVATION_HEIGHT }),
  );
  check(
    'IDRELEASE|<64hex> 未激活 + amount=0：redOpError 会直接拒绝这笔交易（consensus 层面早已挡住），' +
      '但 isProtocolMemo 仍应保守地判定为真消息（协议未激活时它就不该被当协议操作豁免）',
    isRealMessage({ amount: 0, burn: 1, memo: `${IDRELEASE_PREFIX}${fakeId}`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'IDRELEASE|<64hex> 未激活 + amount=1（旧漏洞⑦核心场景：redOpError 的未激活门控只拦 amount=0，' +
      'amount≠0 会被漏判成普通转账接受）现在正确算真消息，受消息门槛约束',
    isRealMessage({ amount: 1, burn: 0, memo: `${IDRELEASE_PREFIX}${'x'.repeat(500)}`, from: selfAddr, to: selfAddr, atHeight: MIN_MESSAGE_BURN_ACTIVATION_HEIGHT }),
  );
  check(
    'IDRELEASE|<64hex> 已激活但 amount≠0（不是真实解锁形态，会被 redOpError 拒绝）算真消息',
    isRealMessage({ amount: 1, burn: 0, memo: `${IDRELEASE_PREFIX}${fakeId}`, from: selfAddr, to: selfAddr, atHeight: IDENTITY_ACTIVATION_HEIGHT }),
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

  console.log(`\n— 端到端：真实 addTransaction 路径下，NAME 抢注不受影响、「自转夹带」套壳被真实拒绝 —`);
  const carol2 = Wallet.generate();
  await fund(bc, carol2.address, 100);
  const nameTx = createTransaction(carol2, carol2.address, 1, bc.nonceOf(carol2.address), buildNameMemo('carol2'), MIN_FEE);
  check('NAME| 真实抢注（自转 1 币 + burn=0）激活后依然被接受，不需要额外销毁费', bc.addTransaction(nameTx).ok);
  await bc.mine(carol2.address);
  const smuggleMemo = 'y'.repeat(512);
  // createTransaction/createMessage 都不支持「amount>0 且 burn>0」这种组合（前者不接受 burn 参数，
  // 后者 amount 固定 0），故这里直接用底层 payload+签名手动构造，模拟“有人手写了这样一笔交易”。
  const selfMemoTx = (amount: number, burn: number, nonce: number, memo = smuggleMemo) => {
    const base = { from: carol2.address, to: carol2.address, amount, fee: MIN_FEE, nonce, timestamp: Date.now(), memo, burn };
    const txid = transactionPayloadHash(base);
    return { ...base, signature: sign(txid, carol2.privateKey), txid };
  };
  const smuggleTx = selfMemoTx(1, 0, bc.nonceOf(carol2.address));
  check(
    '自转 1 币 + 512 码点垃圾 memo + burn=0（旧漏洞⑥）真实提交时被拒绝',
    !bc.addTransaction(smuggleTx).ok,
  );
  const smuggleRequired = minMessageBurnFor(512);
  const smuggleFixed = selfMemoTx(1, smuggleRequired, bc.nonceOf(carol2.address));
  check(
    '同一条自转夹带，真的烧够 minMessageBurnFor(512) 后被接受（付出了和真消息一样的成本，套利空间消失）',
    bc.addTransaction(smuggleFixed).ok,
  );
  await bc.mine(carol2.address);
  check('NAME/套壳场景后全链守恒', conserved(bc));

  console.log(`\n— 端到端：DEL 撤单不受影响、IDRELEASE「未激活+amount≠0」套壳被真实拒绝 —`);
  const delTx = createTransaction(carol2, carol2.address, 1, bc.nonceOf(carol2.address), `${DEL_PREFIX}${fakeId}`, MIN_FEE);
  check('DEL| 真实撤单（自转 1 币 + burn=0）激活后依然被接受，不需要额外销毁费', bc.addTransaction(delTx).ok);
  await bc.mine(carol2.address);
  // IDRELEASE 尚未到 IDENTITY_ACTIVATION_HEIGHT（本链当前链高远低于它），amount≠0 套壳按旧漏洞⑦
  // 本该被误判成协议操作豁免；现在必须受消息门槛约束。
  const idreleaseSmuggleTx = selfMemoTx(1, 0, bc.nonceOf(carol2.address), `${IDRELEASE_PREFIX}${'z'.repeat(500)}`);
  check(
    'IDRELEASE| 未激活 + amount=1 + burn=0 套壳（旧漏洞⑦）真实提交时被拒绝',
    !bc.addTransaction(idreleaseSmuggleTx).ok,
  );
  await bc.mine(carol2.address);
  check('DEL/IDRELEASE 套壳场景后全链守恒', conserved(bc));

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
