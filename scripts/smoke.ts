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
  parseNames,
  makeNameClaim,
  buildNameMemo,
  encryptMemo,
  decryptMemo,
  isEncryptedMemo,
  makeRedPacket,
  parseRedPackets,
  computeShare,
  redSeed,
  RED_ESCROW_ADDRESS,
  RED_EXPIRY,
  parsePets,
  petsOf,
  petGene,
  petTraits,
  makePetTransfer,
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

console.log(`\n— 端到端加密私信（x25519 ECDH + XChaCha20-Poly1305）+ MAX_MEMO 512 —`);
const secret = '只有你能看到的悄悄话：周五老地方见 🤫';
const enc = encryptMemo(secret, bob.address, alice.privateKey); // alice → bob
check('密文带 ENC| 前缀且不含明文', isEncryptedMemo(enc) && !enc.includes('悄悄话'));
check('收件人 bob 能解（自己私钥 + 发件人地址）', decryptMemo(enc, alice.address, bob.privateKey) === secret);
check('发件人 alice 也能解自己发的（ECDH 对称）', decryptMemo(enc, bob.address, alice.privateKey) === secret);
const carol2e = Wallet.generate();
check('第三方无法解密（返回 null）', decryptMemo(enc, alice.address, carol2e.privateKey) === null);
check('密文被篡改 → 认证失败返回 null', decryptMemo(enc.slice(0, -2) + (enc.endsWith('00') ? '11' : '00'), alice.address, bob.privateKey) === null);
check('512 码点 memo 合法（MAX_MEMO 已抬到 512）', verifyTransaction(createTransaction(bob, alice.address, 1, 0, 'x'.repeat(512))));
check('513 码点 memo 仍被拒', !verifyTransaction(createTransaction(bob, alice.address, 1, 0, 'x'.repeat(513))));
// 加密私信整条上链 + 解析 + 解密（密文 >128 码点，顺带验证 512 上限放行）
const encBc = new Blockchain();
for (let i = 0; i < 8; i++) await encBc.mine(alice.address);
const encMsg = createMessage(alice, bob.address, encryptMemo('链上加密第一条 🔐', bob.address, alice.privateKey), encBc.nonceOf(alice.address));
check('加密消息交易自洽（签名/txid/memo长度）', verifyTransaction(encMsg));
encBc.addTransaction(encMsg);
await encBc.mine(alice.address);
const pm = parseMessages(encBc.chain)[0];
check('加密私信上链且密文不可读', isEncryptedMemo(pm.text) && !pm.text.includes('加密第一条'));
check('收件人从链上密文解出明文', decryptMemo(pm.text, pm.from, bob.privateKey) === '链上加密第一条 🔐');

console.log(`\n— 链上昵称：全网唯一抢注（先到先得）+ 改名 + 自转约束 —`);
const nm = new Blockchain();
for (let i = 0; i < 6; i++) await nm.mine(alice.address); // alice 攒够多次自转的手续费
for (let i = 0; i < 3; i++) await nm.mine(bob.address);
// alice 抢注 'alice'（自转 1 + memo NAME|alice）
nm.addTransaction(createTransaction(alice, alice.address, 1, nm.nonceOf(alice.address), buildNameMemo('alice')));
await nm.mine(bob.address);
let reg = parseNames(nm.chain);
check('alice 抢到 @alice', reg.nameToOwner.get('alice') === alice.address && reg.addressToName.get(alice.address) === 'alice');
// bob 想抢同名 'alice' → 先到先得，无效
nm.addTransaction(createTransaction(bob, bob.address, 1, nm.nonceOf(bob.address), buildNameMemo('alice')));
await nm.mine(alice.address);
reg = parseNames(nm.chain);
check('bob 抢同名 @alice 无效（先到先得仍归 alice）', reg.nameToOwner.get('alice') === alice.address);
// bob 抢自己的 'bob'
nm.addTransaction(createTransaction(bob, bob.address, 1, nm.nonceOf(bob.address), buildNameMemo('bob')));
await nm.mine(alice.address);
reg = parseNames(nm.chain);
check('bob 抢到 @bob', reg.nameToOwner.get('bob') === bob.address && reg.addressToName.get(bob.address) === 'bob');
// alice 改名 'queen'（显示名跟新；旧名 alice 仍永久属于 alice）
nm.addTransaction(createTransaction(alice, alice.address, 1, nm.nonceOf(alice.address), buildNameMemo('queen')));
await nm.mine(bob.address);
reg = parseNames(nm.chain);
check('alice 改名后显示名=queen，旧名 alice 仍归 alice', reg.addressToName.get(alice.address) === 'queen' && reg.nameToOwner.get('alice') === alice.address && reg.nameToOwner.get('queen') === alice.address);
// 非自转 + NAME memo 不算抢注（alice 付给 bob 带 NAME|hacker 不应注册）
nm.addTransaction(createTransaction(alice, bob.address, 1, nm.nonceOf(alice.address), buildNameMemo('hacker')));
await nm.mine(bob.address);
check('非自转的 NAME memo 不注册（必须自转）', parseNames(nm.chain).nameToOwner.has('hacker') === false);
// 名字校验：大写/空格自动规范化为小写；超长 / 0x 开头 / 非法字符被拒
check('大写自动规范化为小写（Alice → NAME|alice）', makeNameClaim('  Alice ').memo === buildNameMemo('alice'));
check('非法昵称被拒（超 20 位）', !makeNameClaim('a'.repeat(21)).ok);
check('非法昵称被拒（0x 开头）', !makeNameClaim('0xabc').ok);
check('非法昵称被拒（含空格/非法字符）', !makeNameClaim('a b').ok);
check('合法昵称通过（小写字母/数字/_/-）', makeNameClaim('cool_name-1').ok);
// —— review 修复回归 ——
for (let i = 0; i < 8; i++) await nm.mine(alice.address); // 给 alice 补额度
// 读端规范化：链上 NAME|MixedCase（大写）应解析为 mixedcase（写端 makeNameClaim 也小写 → 写读一致，不再白付费）
nm.addTransaction(createTransaction(alice, alice.address, 1, nm.nonceOf(alice.address), 'NAME|MixedCase'));
await nm.mine(bob.address);
check('读端规范化：链上 NAME|MixedCase 解析为 @mixedcase', parseNames(nm.chain).nameToOwner.get('mixedcase') === alice.address);
// 保留名：makeNameClaim 拒绝 + 链上 NAME|treasury 自转被解析端忽略（防冒充央行/官方）
check('保留名 treasury 抢注被拒（makeNameClaim）', !makeNameClaim('treasury').ok);
nm.addTransaction(createTransaction(alice, alice.address, 1, nm.nonceOf(alice.address), 'NAME|treasury'));
await nm.mine(bob.address);
check('链上 NAME|treasury 自转不被注册（保留名防冒充）', parseNames(nm.chain).nameToOwner.has('treasury') === false);
// 自发消息（amount0+burn）携 NAME memo 不算抢注（抢注须自转、非消息）
nm.addTransaction(createMessage(alice, alice.address, 'NAME|ghost', nm.nonceOf(alice.address)));
await nm.mine(bob.address);
check('自发消息携 NAME memo 不注册（须自转非消息）', parseNames(nm.chain).nameToOwner.has('ghost') === false);

console.log(`\n— 链上抢红包：发→抢(拼手气)→分配守恒→防重复/越权→过期退款 —`);
const rp = new Blockchain();
const C = Wallet.generate();
const D = Wallet.generate();
for (let i = 0; i < 11; i++) await rp.mine(alice.address); // alice 攒够 发红包(10)+手续费
for (let i = 0; i < 2; i++) await rp.mine(bob.address);
for (let i = 0; i < 2; i++) await rp.mine(C.address);
for (let i = 0; i < 2; i++) await rp.mine(D.address);
const aBefore = rp.balanceOf(alice.address);
check('makeRedPacket 合法', makeRedPacket(10, 3, 'r').ok);
check('makeRedPacket 总额<份数被拒', !makeRedPacket(2, 3, 'r').ok);
const redTx = createTransaction(alice, RED_ESCROW_ADDRESS, 10, rp.nonceOf(alice.address), makeRedPacket(10, 3, 'r').memo!, 1);
check('发红包进池（转给托管地址）', rp.addTransaction(redTx).ok);
await rp.mine(bob.address);
const redId = redTx.txid;
check('发起人被扣 总额+手续费', rp.balanceOf(alice.address) === aBefore - 10 - 1);
check('总额锁进托管地址', rp.balanceOf(RED_ESCROW_ADDRESS) === 10);
check('红包池开着：剩余 10 / 3 份', rp.computeState().pools.get(redId)?.remaining === 10 && rp.computeState().pools.get(redId)?.remainingCount === 3);
check('发起人不能抢自己的红包', !rp.addTransaction(createTransaction(alice, alice.address, 0, rp.nonceOf(alice.address), 'CLAIM|' + redId, 1)).ok);
check('领取金额必须为 0', !rp.addTransaction(createTransaction(bob, bob.address, 5, rp.nonceOf(bob.address), 'CLAIM|' + redId, 1)).ok);
check('链上发红包 总额<份数 被拒', !rp.addTransaction(createTransaction(alice, RED_ESCROW_ADDRESS, 2, rp.nonceOf(alice.address), 'RED|3|r', 1)).ok);
check('普通转账打到托管地址被拒（非红包）', !rp.addTransaction(createTransaction(alice, RED_ESCROW_ADDRESS, 1, rp.nonceOf(alice.address), 'hi', 1)).ok);
// bob 抢
const bBefore = rp.balanceOf(bob.address);
const claimB = createTransaction(bob, bob.address, 0, rp.nonceOf(bob.address), 'CLAIM|' + redId, 1);
check('bob 抢红包进池', rp.addTransaction(claimB).ok);
await rp.mine(C.address);
const shareB = computeShare(10, 3, 'r', redSeed(rp.latest.hash, claimB.txid));
check('bob 收到拼手气份额（=确定性公式值，≥1）', shareB >= 1 && rp.balanceOf(bob.address) === bBefore - 1 + shareB);
check('bob 不能重复抢', !rp.addTransaction(createTransaction(bob, bob.address, 0, rp.nonceOf(bob.address), 'CLAIM|' + redId, 1)).ok);
// C 抢
const cBefore = rp.balanceOf(C.address);
const claimC = createTransaction(C, C.address, 0, rp.nonceOf(C.address), 'CLAIM|' + redId, 1);
rp.addTransaction(claimC);
await rp.mine(D.address);
const shareC = computeShare(10 - shareB, 2, 'r', redSeed(rp.latest.hash, claimC.txid));
check('C 收到份额', rp.balanceOf(C.address) === cBefore - 1 + shareC);
// D 抢（第三＝最后一份，拿走剩余）
const dBefore = rp.balanceOf(D.address);
const claimD = createTransaction(D, D.address, 0, rp.nonceOf(D.address), 'CLAIM|' + redId, 1);
rp.addTransaction(claimD);
await rp.mine(bob.address);
const shareD = 10 - shareB - shareC;
check('D（最后一份）拿走剩余', rp.balanceOf(D.address) === dBefore - 1 + shareD);
check('三份相加 == 总额（全部派完）', shareB + shareC + shareD === 10);
check('红包抢完：剩余 0 份、托管清零', rp.computeState().pools.get(redId)?.remainingCount === 0 && rp.balanceOf(RED_ESCROW_ADDRESS) === 0);
check('抢完后再抢被拒', !rp.addTransaction(createTransaction(C, C.address, 0, rp.nonceOf(C.address), 'CLAIM|' + redId, 1)).ok);
const rpSupply = [...rp.computeState().balances.values()].reduce((s, v) => s + v, 0);
check('全链守恒（含托管/虚空）== 预挖 + 链高×奖励', rpSupply === GENESIS_PREMINE + rp.height * BLOCK_REWARD);
check('含红包的链整链校验通过', Blockchain.validateChain(rp.chain).ok);
const view = parseRedPackets(rp.chain).find((v) => v.id === redId)!;
check('只读视图与共识一致（3 领取/已完成/份额和=总额）', view.claims.length === 3 && view.done && view.claims.reduce((s, c) => s + c.amount, 0) === 10);

console.log(`\n— 红包过期退款（未过期拒、过期退回发起人）—`);
const rf = new Blockchain();
for (let i = 0; i < 8; i++) await rf.mine(alice.address); // alice 攒够 发红包(6)+手续费
for (let i = 0; i < 2; i++) await rf.mine(bob.address);
const refundRed = createTransaction(alice, RED_ESCROW_ADDRESS, 6, rf.nonceOf(alice.address), makeRedPacket(6, 3, 'r').memo!, 1);
rf.addTransaction(refundRed);
await rf.mine(bob.address);
const rid = refundRed.txid;
const aBal2 = rf.balanceOf(alice.address);
check('未过期退款被拒', !rf.addTransaction(createTransaction(alice, alice.address, 0, rf.nonceOf(alice.address), 'REFUND|' + rid, 1)).ok);
const claimRf = createTransaction(bob, bob.address, 0, rf.nonceOf(bob.address), 'CLAIM|' + rid, 1);
check('bob 抢一份进池', rf.addTransaction(claimRf).ok);
await rf.mine(bob.address);
const sB = computeShare(6, 3, 'r', redSeed(rf.latest.hash, claimRf.txid));
for (let i = 0; i < RED_EXPIRY + 1; i++) await rf.mine(bob.address); // 挖过期
const refundTx = createTransaction(alice, alice.address, 0, rf.nonceOf(alice.address), 'REFUND|' + rid, 1);
check('过期后退款进池', rf.addTransaction(refundTx).ok);
await rf.mine(bob.address);
check('发起人取回剩余（6 - 已领 - 退款费）', rf.balanceOf(alice.address) === aBal2 - 1 + (6 - sB));
check('退款后该红包托管清零', rf.computeState().pools.get(rid)?.remaining === 0);
check('退款后再抢被拒', !rf.addTransaction(createTransaction(C, C.address, 0, rf.nonceOf(C.address), 'CLAIM|' + rid, 1)).ok);
check('退款链整链校验通过', Blockchain.validateChain(rf.chain).ok);

console.log(`\n— 崽（PET NFT）：孵化(确定性基因) → 送崽(归属流转) → 越权拒绝 → 守恒 —`);
const pet = new Blockchain();
for (let i = 0; i < 9; i++) await pet.mine(alice.address); // alice 攒够 孵化(burn3+费1) + 送崽(1+费1) + 越权尝试(1+费1)
// 孵化 = 自转 + 烧 burn 当孵化费 + memo `PET|`（这里用小额 burn=3 让测试快；真实客户端默认烧 PET_HATCH_COST）
const hatch = createMessage(alice, alice.address, 'PET|', pet.nonceOf(alice.address), 3, 1);
check('孵化交易自洽（签名/txid 合法）', verifyTransaction(hatch));
check('孵化进池', pet.addTransaction(hatch).ok);
await pet.mine(bob.address);
let pets = parsePets(pet.chain);
check('解析出 1 只崽，归属 = 孵化者 alice', pets.length === 1 && pets[0].owner === alice.address && pets[0].minter === alice.address);
const petId = pets[0].id;
const gene = pets[0].gene;
check('基因 = hash(主人 + 孵化txid)（确定性、可复算）', gene === petGene(alice.address, petId));
check('同一基因外观特征处处一致（PRD 6.5：任意客户端同基因同外观）', JSON.stringify(petTraits(gene)) === JSON.stringify(petTraits(gene)));
check('不同孵化交易 → 不同基因（唯一）', petGene(alice.address, petId) !== petGene(alice.address, 'de'.repeat(32)));
check('换个主人地址 → 基因不同（地址并入，防撞）', petGene(alice.address, petId) !== petGene(bob.address, petId));
// 送崽：alice → bob（转 1 币 + memo PETX|崽id）
const give = createTransaction(alice, bob.address, 1, pet.nonceOf(alice.address), makePetTransfer(petId).memo!);
check('送崽交易进池', pet.addTransaction(give).ok);
await pet.mine(bob.address);
pets = parsePets(pet.chain);
check('送崽后归属转移给 bob', pets[0].owner === bob.address);
check('基因不随转手改变（还是同一只崽）', pets[0].gene === gene && pets[0].minter === alice.address);
check('petsOf(bob) 含该崽、petsOf(alice) 不再含', petsOf(pet.chain, bob.address).some((p) => p.id === petId) && !petsOf(pet.chain, alice.address).some((p) => p.id === petId));
// 越权转移：alice 已不是主人，再发 PETX 把崽转给别人 → 无效
pet.addTransaction(createTransaction(alice, carol.address, 1, pet.nonceOf(alice.address), makePetTransfer(petId).memo!));
await pet.mine(bob.address);
check('非当前主人的转移无效（崽仍归 bob）', parsePets(pet.chain).find((p) => p.id === petId)?.owner === bob.address);
// 守恒：孵化费烧进虚空，总账不丢
const petSupply = [...pet.computeState().balances.values()].reduce((s, v) => s + v, 0);
check('含崽的链全链守恒（孵化烧币记入虚空，总额 = 预挖 + 链高×奖励）', petSupply === GENESIS_PREMINE + pet.height * BLOCK_REWARD);
check('含崽的链整链校验通过', Blockchain.validateChain(pet.chain).ok);

console.log(`\n余额总览：`);
console.log(`  央行预挖 ${bc.balanceOf(GENESIS_PREMINE_ADDRESS)} ${SYMBOL}`);
console.log(`  alice    ${bc.balanceOf(alice.address)} ${SYMBOL}`);
console.log(`  bob      ${bc.balanceOf(bob.address)} ${SYMBOL}`);

console.log(failed === 0 ? `\n🎉 全部通过\n` : `\n💥 ${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
