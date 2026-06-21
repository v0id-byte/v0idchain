// 单进程冒烟测试：挖矿出币、转账、余额、防重放、整链校验、最长链、安全回归、进阶功能。
import {
  Blockchain,
  Wallet,
  createTransaction,
  createMessage,
  verifyTransaction,
  isCoinbase,
  violatesCheckpoint,
  merkleRoot,
  expectedDifficulty,
  parseMarket,
  parseMessages,
  buildListMemo,
  BUY_PREFIX,
  DEL_PREFIX,
  TARGET_BLOCK_TIME_MS,
  RETARGET_INTERVAL,
  GENESIS_PREMINE,
  GENESIS_PREMINE_ADDRESS,
  BLOCK_REWARD,
  MIN_FEE,
  MESSAGE_BURN,
  GENESIS_DIFFICULTY,
  MAX_FUTURE_DRIFT_MS,
  MAX_MEMO,
  NULL_ADDRESS,
  SYMBOL,
} from '../packages/core/src/index.js';

let failed = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
}

const bc = new Blockchain();
const alice = Wallet.generate();
const bob = Wallet.generate();

console.log(`\n— 创世 —`);
check(`创世链合法`, Blockchain.validateChain(bc.chain).ok);
check(`预挖 ${GENESIS_PREMINE} 进“央行”地址`, bc.balanceOf(GENESIS_PREMINE_ADDRESS) === GENESIS_PREMINE);
check(`链高 = 0`, bc.height === 0);

console.log(`\n— 挖矿出币：bob 挖 2 块 —`);
await bc.mine(bob.address);
await bc.mine(bob.address);
check(`链高 = 2`, bc.height === 2);
check(`bob 余额 = 2×奖励 = ${2 * BLOCK_REWARD}`, bc.balanceOf(bob.address) === 2 * BLOCK_REWARD);

console.log(`\n— bob → alice 转 1（用挖来的币，付手续费 ${MIN_FEE}）—`);
const t1 = createTransaction(bob, alice.address, 1, bc.nonceOf(bob.address)); // 默认手续费 = MIN_FEE
check(`交易进池`, bc.addTransaction(t1).ok);
await bc.mine(bob.address); // bob 打包：拿 出块奖励 + 这笔的手续费
check(`alice 余额 = 1（实收金额，不含费）`, bc.balanceOf(alice.address) === 1);
// bob：2(初始) - 1(给alice) - 1(手续费) + (出块奖励 + 手续费) = 2（手续费付给自己又作为矿工赚回）
check(`bob 余额 = 2`, bc.balanceOf(bob.address) === 2 - 1 - MIN_FEE + (BLOCK_REWARD + MIN_FEE));
check(`交易池已清空`, bc.mempool.length === 0);

console.log(`\n— 防重放：重复广播同一笔已花交易 —`);
check(`重复交易被拒（nonce 错）`, !bc.addTransaction(t1).ok);

console.log(`\n— 余额不足应被拒 —`);
check(`超额交易被拒`, !bc.addTransaction(createTransaction(alice, bob.address, 999999, bc.nonceOf(alice.address))).ok);

console.log(`\n— 篡改区块应使整链校验失败 —`);
const tampered = JSON.parse(JSON.stringify(bc.chain));
tampered[1].transactions[0].amount = 999999; // 改掉一个 coinbase 金额
check(`篡改链被识破`, !Blockchain.validateChain(tampered).ok);

console.log(`\n— 最长链：较短链不替换，较长合法链替换 —`);
check(`短链不替换`, bc.replaceChain(new Blockchain().chain).replaced === false);
const other = new Blockchain();
other.chain = JSON.parse(JSON.stringify(bc.chain));
await other.mine(alice.address); // 比 bc 多一块
check(`长链可替换`, new Blockchain().replaceChain(other.chain).ok);

console.log(`\n— 安全回归：审查发现的攻击必须被拒 —`);
// 攻击1（曾经的 CRITICAL）：保留 canonical 创世 hash，偷改预挖收款方
const forgePremine = JSON.parse(JSON.stringify(new Blockchain().chain));
forgePremine[0].transactions[0].to = alice.address; // 想把预挖偷给 alice
check('偷改预挖收款方的伪造创世被拒', !Blockchain.validateChain(forgePremine).ok);

// 攻击2：往创世里塞一笔无签名的 NULL_ADDRESS 交易，凭空增发
const forgeMint = JSON.parse(JSON.stringify(new Blockchain().chain));
forgeMint[0].transactions.push({
  from: NULL_ADDRESS, to: alice.address, amount: 1_000_000, nonce: 0, timestamp: 1, memo: '', signature: '', txid: 'bogus',
});
check('凭空增发的伪造创世被拒', !Blockchain.validateChain(forgeMint).ok);

// 攻击3（端到端）：在一条更长的链上篡改创世预挖，replaceChain 必须拒绝
const legit = new Blockchain();
await legit.mine(bob.address);
const forgedLonger = JSON.parse(JSON.stringify(legit.chain));
forgedLonger[0].transactions[0].to = alice.address;
const victim = new Blockchain();
check('replaceChain 拒绝“更长但创世被篡改”的链', !victim.replaceChain(forgedLonger).replaced);
check('被攻击节点余额未被污染（alice 仍为 0）', victim.balanceOf(alice.address) === 0);

// 金额必须是正整数
check('小数金额交易被拒', !verifyTransaction(createTransaction(bob, alice.address, 0.1, 0)));
check('零/负金额交易被拒', !verifyTransaction(createTransaction(bob, alice.address, 0, 0)));

// 打款到畸形 / 空地址必须被拒
const freshBc = new Blockchain();
await freshBc.mine(bob.address); // 给 bob 一点余额好通过前置校验
check('打款到畸形地址被拒', !freshBc.addTransaction(createTransaction(bob, '0xZZZ', 10, freshBc.nonceOf(bob.address))).ok);
check('打款到空地址(销毁)被拒', !freshBc.addTransaction(createTransaction(bob, NULL_ADDRESS, 10, freshBc.nonceOf(bob.address))).ok);

console.log(`\n— 进阶功能：交易备注 memo —`);
const memoBc = new Blockchain();
await memoBc.mine(bob.address);
await memoBc.mine(bob.address); // bob 拿到 2（够付 1 转账 + 1 手续费）
const tm = createTransaction(bob, alice.address, 1, memoBc.nonceOf(bob.address), '午饭钱 🍜');
check('带 memo 的交易进池', memoBc.addTransaction(tm).ok);
await memoBc.mine(bob.address);
check('memo 正确上链且可查', memoBc.latest.transactions.find((t) => t.txid === tm.txid)?.memo === '午饭钱 🍜');
check('超长 memo 被拒', !verifyTransaction(createTransaction(bob, alice.address, 10, 0, 'x'.repeat(MAX_MEMO + 1))));
check('emoji memo 按码点计数（128 个 emoji 通过）', verifyTransaction(createTransaction(bob, alice.address, 10, 0, '😀'.repeat(MAX_MEMO))));

console.log(`\n— 进阶功能：Merkle 根 —`);
const mkBc = new Blockchain();
await mkBc.mine(bob.address);
await mkBc.mine(bob.address); // bob 拿到 2（够付 1 转账 + 1 手续费）
mkBc.addTransaction(createTransaction(bob, alice.address, 1, mkBc.nonceOf(bob.address)));
await mkBc.mine(bob.address);
check('正常链 merkleRoot 校验通过', Blockchain.validateChain(mkBc.chain).ok);
const tamperMk = JSON.parse(JSON.stringify(mkBc.chain));
tamperMk[3].merkleRoot = merkleRoot(['fake']); // 篡改最新块（含转账）的 merkleRoot
check('篡改 merkleRoot 被拒', !Blockchain.validateChain(tamperMk).ok);

console.log(`\n— 进阶功能：自适应难度 —`);
const diffBc = new Blockchain();
for (let i = 0; i < 3; i++) await diffBc.mine(bob.address);
check('创世难度 = GENESIS_DIFFICULTY', diffBc.chain[0].difficulty === GENESIS_DIFFICULTY);
check('正常链难度校验通过', Blockchain.validateChain(diffBc.chain).ok);
const tamperDiff = JSON.parse(JSON.stringify(diffBc.chain));
tamperDiff[1].difficulty = 1; // 矿工私自把难度降到 1
check('私自篡改难度被拒', !Blockchain.validateChain(tamperDiff).ok);
// 重定向数学（喂合成历史，快且确定）：出块过快→加难度，过慢→减难度
const idx = RETARGET_INTERVAL * 2;
const fast = Array.from({ length: idx + 1 }, (_, i) => ({ timestamp: i * 100, difficulty: GENESIS_DIFFICULTY }));
const slow = Array.from({ length: idx + 1 }, (_, i) => ({ timestamp: i * TARGET_BLOCK_TIME_MS * 4, difficulty: GENESIS_DIFFICULTY }));
check('出块过快 → 难度上调', expectedDifficulty(fast as any, idx) > GENESIS_DIFFICULTY);
check('出块过慢 → 难度下调', expectedDifficulty(slow as any, idx) < GENESIS_DIFFICULTY);

console.log(`\n— 共识：最大工作量规则（防低难度长 fork）+ 未来时间戳上限 —`);
const honestW = new Blockchain();
for (let i = 0; i < 3; i++) await honestW.mine(bob.address); // 4 块 × 难度16
check('chainWork 随链增长而增大', Blockchain.chainWork(honestW.chain) > Blockchain.chainWork(new Blockchain().chain));
// 工作量按 2^difficulty 计：一条“短但高难度”的链工作量应大于“长但低难度”的链 —— 长度不值钱，工作量才值钱
const wHiShort = Blockchain.chainWork([{ difficulty: 20 }, { difficulty: 20 }] as any); // 2×2^20
const wLoLong = Blockchain.chainWork(Array.from({ length: 20 }, () => ({ difficulty: 8 })) as any); // 20×2^8
check('chainWork：短高难链 > 长低难链', wHiShort > wLoLong);
// replaceChain 用工作量门控：更长但总工作量更小的低难度 fork 不被接受（旧“最长链”规则会误判其更优）
const cheapLong: any[] = JSON.parse(JSON.stringify(new Blockchain().chain));
for (let i = 1; i < 12; i++) {
  cheapLong.push({ index: i, timestamp: Date.now(), prevHash: '0'.repeat(64), transactions: [], merkleRoot: '0', difficulty: 1, nonce: 0, miner: NULL_ADDRESS, hash: '0' });
}
check('最大工作量规则：低难度长 fork 不替换诚实短链', honestW.replaceChain(cheapLong as any).replaced === false);
// 未来时间戳上限：把链顶时间戳调到远超本地时钟 → 必须被拒（封死“调时钟拉长窗口压难度”）
const futureChain = JSON.parse(JSON.stringify(honestW.chain));
futureChain[futureChain.length - 1].timestamp = Date.now() + MAX_FUTURE_DRIFT_MS + 60_000;
const futRes = Blockchain.validateChain(futureChain);
check('未来时间戳的块被拒（防时间戳操纵压难度）', !futRes.ok && (futRes.error ?? '').includes('未来'));
// 真实攻击形态：一条**更长且累计工作量更大**、但含未来时间戳的 fork（压难度双花的实际链形）
// 必须被 replaceChain 拒。这里时间戳上限才是关键防线——工作量门会被这条更高工作量的链越过，
// 全靠 validateChain 的未来时间戳校验挡下（时间戳校验先于 PoW，故无需伪造合法 PoW）。
const attackFork: any[] = JSON.parse(JSON.stringify(honestW.chain));
attackFork.push({
  index: attackFork.length,
  timestamp: Date.now() + MAX_FUTURE_DRIFT_MS + 3_600_000, // 远未来（攻击者拉长窗口压难度的代价）
  prevHash: attackFork[attackFork.length - 1].hash,
  transactions: [],
  merkleRoot: '0',
  difficulty: 30, // 抬高累计工作量，确保越过“最大工作量”门、真正走到 validateChain
  nonce: 0,
  miner: NULL_ADDRESS,
  hash: '0',
});
const attackVictim = new Blockchain();
attackVictim.chain = JSON.parse(JSON.stringify(honestW.chain));
const attackRes = attackVictim.replaceChain(attackFork as any);
check(
  '更长+更高工作量但含未来时间戳的 fork 被 replaceChain 拒（时间戳上限挡住压难度双花）',
  attackRes.replaced === false && (attackRes.error ?? '').includes('未来'),
);

console.log(`\n— 共识：checkpoint（冻结历史，挡深度 reorg / 抬高 ≥51% 成本）—`);
check('匹配的 checkpoint：不报冲突', violatesCheckpoint(honestW.chain, [{ index: 2, hash: honestW.chain[2].hash }]) === null);
check('被篡改的 checkpoint 高度：检出冲突', violatesCheckpoint(honestW.chain, [{ index: 2, hash: '0'.repeat(64) }])?.index === 2);
check('链未到 checkpoint 高度：不报冲突（仍在同步）', violatesCheckpoint(honestW.chain, [{ index: 999, hash: '0'.repeat(64) }]) === null);
check('默认空 CHECKPOINTS：不影响正常链校验', Blockchain.validateChain(honestW.chain).ok);

console.log(`\n— gas/手续费：归矿工、计入余额、最低费、防篡改、高者优先 —`);
const g = new Blockchain();
await g.mine(alice.address);
await g.mine(alice.address); // alice 2
const carol = Wallet.generate();
const gtx = createTransaction(alice, bob.address, 1, g.nonceOf(alice.address), '', MIN_FEE);
check('带手续费交易进池', g.addTransaction(gtx).ok);
await g.mine(carol.address); // carol 打包这笔（手续费应归 carol，而非创世/任何第三方）
check('收款方实收 = 金额（不含手续费）', g.balanceOf(bob.address) === 1);
check('发送方实扣 = 金额 + 手续费', g.balanceOf(alice.address) === 2 - 1 - MIN_FEE);
check(`矿工实得 = 出块奖励 + 手续费 = ${BLOCK_REWARD + MIN_FEE}`, g.balanceOf(carol.address) === BLOCK_REWARD + MIN_FEE);
const supply = (b: Blockchain) => [...b.computeState().balances.values()].reduce((s, v) => s + v, 0);
check('全链守恒：总额 = 预挖 + 链高×出块奖励（手续费只搬运、不增发）', supply(g) === GENESIS_PREMINE + g.height * BLOCK_REWARD);
// 最低手续费：零手续费交易必须被拒（verifyTransaction 与 mempool 两道都拦）
const zeroFee = createTransaction(alice, bob.address, 1, 0, '', 0);
check('零手续费交易：verifyTransaction 拒绝', !verifyTransaction(zeroFee));
check('零手续费交易：mempool 拒绝', !new Blockchain().addTransaction(zeroFee).ok);
// 防篡改：偷改手续费（不重签）→ txid 不再匹配内容 → 校验失败
check('偷改手续费 → txid 校验失败', !verifyTransaction({ ...gtx, fee: gtx.fee + 5 }));
// coinbase 自身不得带手续费
const cbFee = JSON.parse(JSON.stringify(g.chain));
cbFee[1].transactions[0].fee = 3;
check('coinbase 带非零手续费的链被拒', !Blockchain.validateChain(cbFee).ok);
// 矿工虚报 coinbase 金额（凭空多印）→ 校验失败（金额必须 = 出块奖励 + 实际手续费）
const inflate = JSON.parse(JSON.stringify(g.chain));
inflate[1].transactions[0].amount = 999;
check('矿工虚报 coinbase 金额（偷印）被拒', !Blockchain.validateChain(inflate).ok);
// 手续费市场：同一块内，高手续费交易排在低手续费之前（高者优先打包）
const fm = new Blockchain();
await fm.mine(alice.address);
await fm.mine(alice.address); // alice 2（付 低费交易 1+1）
const carol2 = Wallet.generate();
for (let i = 0; i < 3; i++) await fm.mine(carol2.address); // carol2 3（付 高费交易 1+2）
fm.addTransaction(createTransaction(alice, bob.address, 1, fm.nonceOf(alice.address), 'low', 1)); // 低费先进池
fm.addTransaction(createTransaction(carol2, bob.address, 1, fm.nonceOf(carol2.address), 'high', 2)); // 高费后进池
await fm.mine(bob.address);
const packed = fm.latest.transactions.filter((t) => !isCoinbase(t));
check('高手续费交易被排在低手续费之前（高者优先）', packed[0]?.memo === 'high' && packed[1]?.memo === 'low');

console.log(`\n— 集市：上架 → 购买 → 撤单（每次操作付 ${MIN_FEE} 手续费）—`);
const mk = new Blockchain();
for (let i = 0; i < 4; i++) await mk.mine(alice.address); // alice 挖到 4（够付多次上架/撤单的自转 + 手续费）
mk.addTransaction(createTransaction(alice, alice.address, 1, mk.nonceOf(alice.address), buildListMemo(1, '复习笔记')));
await mk.mine(bob.address); // bob 打包上架（拿 出块奖励 + 手续费）
let listings = parseMarket(mk.chain);
check('集市解析出 1 件在售', listings.length === 1 && listings[0].price === 1 && listings[0].title === '复习笔记' && !listings[0].sold);
const lid = listings[0].id;
mk.addTransaction(createTransaction(bob, alice.address, 1, mk.nonceOf(bob.address), `${BUY_PREFIX}${lid}`));
await mk.mine(bob.address);
listings = parseMarket(mk.chain);
check('购买后标记已售 + 买家正确', listings[0].sold && listings[0].soldBy === bob.address);
// alice：挖矿 4 - 上架手续费 1 + 售货 1 = 4（自转本金回到自己，只净付手续费）
check('卖家 alice 余额 = 4', mk.balanceOf(alice.address) === 4);
// 第二件：上架后撤单
mk.addTransaction(createTransaction(alice, alice.address, 1, mk.nonceOf(alice.address), buildListMemo(5, '废品')));
await mk.mine(bob.address);
const l2 = parseMarket(mk.chain).find((l) => l.title === '废品')!;
mk.addTransaction(createTransaction(alice, alice.address, 1, mk.nonceOf(alice.address), `${DEL_PREFIX}${l2.id}`));
await mk.mine(bob.address);
check('撤单后标记下架', parseMarket(mk.chain).find((l) => l.id === l2.id)?.delisted === true);
// 第三件：bob 冒充卖家撤单（非本人）→ 应无效
mk.addTransaction(createTransaction(alice, alice.address, 1, mk.nonceOf(alice.address), buildListMemo(8, '橡皮')));
await mk.mine(bob.address);
const l3 = parseMarket(mk.chain).find((l) => l.title === '橡皮')!;
mk.addTransaction(createTransaction(bob, bob.address, 1, mk.nonceOf(bob.address), `${DEL_PREFIX}${l3.id}`));
await mk.mine(bob.address);
check('非卖家撤单无效（商品仍在售）', parseMarket(mk.chain).find((l) => l.id === l3.id)?.delisted === false);

console.log(`\n— 链上消息：发消息（不转币、烧 ${MESSAGE_BURN} 进虚空、付手续费）→ 收件箱 —`);
const msgBc = new Blockchain();
for (let i = 0; i < (MESSAGE_BURN + MIN_FEE); i++) await msgBc.mine(bob.address); // bob 挖够付 销毁+手续费
const bobBefore = msgBc.balanceOf(bob.address);
const carolMiner = Wallet.generate();
const dm = createMessage(bob, alice.address, '在链上给你留个话 👋', msgBc.nonceOf(bob.address));
check('消息默认 amount=0 / burn=MESSAGE_BURN', dm.amount === 0 && dm.burn === MESSAGE_BURN);
check('消息交易自洽（签名/txid 合法）', verifyTransaction(dm));
check('消息进池', msgBc.addTransaction(dm).ok);
await msgBc.mine(carolMiner.address); // 由 carol 打包，手续费归 carol，便于核账
const parsed = parseMessages(msgBc.chain);
check('收件箱解析出该消息（收件人/正文/销毁额正确）',
  parsed.length === 1 && parsed[0].to === alice.address && parsed[0].from === bob.address &&
  parsed[0].text === '在链上给你留个话 👋' && parsed[0].burn === MESSAGE_BURN);
check('收件人未收到任何币（消息不转账）', msgBc.balanceOf(alice.address) === 0);
check('发件人实扣 = 销毁额 + 手续费', msgBc.balanceOf(bob.address) === bobBefore - MESSAGE_BURN - MIN_FEE);
check('打包矿工实得 = 出块奖励 + 手续费', msgBc.balanceOf(carolMiner.address) === BLOCK_REWARD + MIN_FEE);
check(`销毁额进虚空地址（🔥 已烧毁 = ${MESSAGE_BURN}）`, msgBc.balanceOf(NULL_ADDRESS) === MESSAGE_BURN);
check('含消息的链整链校验通过', Blockchain.validateChain(msgBc.chain).ok);
const supplyMsg = [...msgBc.computeState().balances.values()].reduce((s, v) => s + v, 0);
check('全链守恒不变（销毁额记入虚空地址，总账不丢）', supplyMsg === GENESIS_PREMINE + msgBc.height * BLOCK_REWARD);
// 防篡改：偷改销毁额（不重签）→ txid 不再匹配内容 → 校验失败
check('偷改消息销毁额 → txid 校验失败', !verifyTransaction({ ...dm, burn: dm.burn! + 100 }));
// 空操作：burn=0 的“消息”（既不转账也不销毁）必须被拒
check('burn=0 的空消息被拒', !verifyTransaction(createMessage(bob, alice.address, 'x', 0, 0, MIN_FEE)));
// 向后兼容：普通转账的 txid 不受 burn 影响（burn=0/缺省 不进 hash）→ 创世/历史哈希不变
const plain = createTransaction(bob, alice.address, 1, 0, 'hi', MIN_FEE);
check('转账显式补 burn=0 不改变 txid（哈希向后兼容，创世/checkpoint 不变）',
  ({ ...plain, burn: 0 }).txid === plain.txid && verifyTransaction({ ...plain, burn: 0 }));

console.log(`\n余额总览：`);
console.log(`  央行预挖 ${bc.balanceOf(GENESIS_PREMINE_ADDRESS)} ${SYMBOL}`);
console.log(`  alice    ${bc.balanceOf(alice.address)} ${SYMBOL}`);
console.log(`  bob      ${bc.balanceOf(bob.address)} ${SYMBOL}`);

console.log(failed === 0 ? `\n🎉 全部通过\n` : `\n💥 ${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
