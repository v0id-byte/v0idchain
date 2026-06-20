// 单进程冒烟测试：挖矿出币、转账、余额、防重放、整链校验、最长链、安全回归、进阶功能。
import {
  Blockchain,
  Wallet,
  createTransaction,
  verifyTransaction,
  merkleRoot,
  expectedDifficulty,
  parseMarket,
  buildListMemo,
  BUY_PREFIX,
  DEL_PREFIX,
  TARGET_BLOCK_TIME_MS,
  RETARGET_INTERVAL,
  GENESIS_PREMINE,
  GENESIS_PREMINE_ADDRESS,
  BLOCK_REWARD,
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

console.log(`\n— bob → alice 转 1（用挖来的币，零手续费）—`);
const t1 = createTransaction(bob, alice.address, 1, bc.nonceOf(bob.address));
check(`交易进池`, bc.addTransaction(t1).ok);
await bc.mine(bob.address); // bob 打包，再得一份奖励
check(`alice 余额 = 1`, bc.balanceOf(alice.address) === 1);
check(`bob 余额 = 2 - 1 + 奖励 = ${2 - 1 + BLOCK_REWARD}`, bc.balanceOf(bob.address) === 2 - 1 + BLOCK_REWARD);
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
await memoBc.mine(bob.address); // bob 拿到 1 个奖励
const tm = createTransaction(bob, alice.address, 1, memoBc.nonceOf(bob.address), '午饭钱 🍜');
check('带 memo 的交易进池', memoBc.addTransaction(tm).ok);
await memoBc.mine(bob.address);
check('memo 正确上链且可查', memoBc.latest.transactions.find((t) => t.txid === tm.txid)?.memo === '午饭钱 🍜');
check('超长 memo 被拒', !verifyTransaction(createTransaction(bob, alice.address, 10, 0, 'x'.repeat(MAX_MEMO + 1))));
check('emoji memo 按码点计数（128 个 emoji 通过）', verifyTransaction(createTransaction(bob, alice.address, 10, 0, '😀'.repeat(MAX_MEMO))));

console.log(`\n— 进阶功能：Merkle 根 —`);
const mkBc = new Blockchain();
await mkBc.mine(bob.address);
mkBc.addTransaction(createTransaction(bob, alice.address, 1, mkBc.nonceOf(bob.address)));
await mkBc.mine(bob.address);
check('正常链 merkleRoot 校验通过', Blockchain.validateChain(mkBc.chain).ok);
const tamperMk = JSON.parse(JSON.stringify(mkBc.chain));
tamperMk[2].merkleRoot = merkleRoot(['fake']); // 篡改 merkleRoot
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

console.log(`\n— 集市：上架 → 购买 → 撤单 —`);
const mk = new Blockchain();
await mk.mine(alice.address); // alice 挖到 1
mk.addTransaction(createTransaction(alice, alice.address, 1, mk.nonceOf(alice.address), buildListMemo(1, '复习笔记')));
await mk.mine(bob.address); // bob 挖到 1，并打包上架
let listings = parseMarket(mk.chain);
check('集市解析出 1 件在售', listings.length === 1 && listings[0].price === 1 && listings[0].title === '复习笔记' && !listings[0].sold);
const lid = listings[0].id;
mk.addTransaction(createTransaction(bob, alice.address, 1, mk.nonceOf(bob.address), `${BUY_PREFIX}${lid}`));
await mk.mine(bob.address);
listings = parseMarket(mk.chain);
check('购买后标记已售 + 买家正确', listings[0].sold && listings[0].soldBy === bob.address);
check('卖家 alice 收到货款（1挖矿 + 1售货 = 2）', mk.balanceOf(alice.address) === 2);
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

console.log(`\n余额总览：`);
console.log(`  央行预挖 ${bc.balanceOf(GENESIS_PREMINE_ADDRESS)} ${SYMBOL}`);
console.log(`  alice    ${bc.balanceOf(alice.address)} ${SYMBOL}`);
console.log(`  bob      ${bc.balanceOf(bob.address)} ${SYMBOL}`);

console.log(failed === 0 ? `\n🎉 全部通过\n` : `\n💥 ${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
