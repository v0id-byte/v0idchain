// 实验 6：越过 checkpoint 的「深度 reorg」—— 被冻结的历史，工作量再大也改不动。
//
// ⚠️ 出厂 config.ts 的 CHECKPOINTS 在高度 100/200/300（绑定公网种子规范链）。本地秒级复现不到那么高，
//    所以这里临时往「内存里的」CHECKPOINTS 数组注入一个 #2 demo 检查点（只影响本进程，不改 config.ts）。
//    真实部署里换成 100/200/300 即可，逻辑完全一样。
//
// 跑：corepack pnpm tsx scripts/labs/06-checkpoint-reorg.ts
import { Blockchain, Wallet, CHECKPOINTS, NULL_ADDRESS } from '../../packages/core/src/index.js';

// 两条独立的链都先挖好（必须在注入 checkpoint 之前，否则 alt 自己挖到 #2 就会被拦）
const bc = new Blockchain();
const bob = Wallet.generate();
for (let i = 0; i < 3; i++) await bc.mine(bob.address); // 规范链：高度 3

const alt = new Blockchain();
const eve = Wallet.generate();
for (let i = 0; i < 3; i++) await alt.mine(eve.address); // 另一条链：不同矿工 → 不同的 #2 hash

// 注入 demo 检查点：把高度 2 冻结成规范链的 hash
CHECKPOINTS.push({ index: 2, hash: bc.chain[2].hash });
console.log(`注入 demo 检查点 #2 = ${bc.chain[2].hash.slice(0, 24)}…（真实部署是 #100/#200/#300）\n`);

// (A) 整链校验：任何在高度 2 hash 不符的链，直接判非法（冻结历史）
console.log(`  (A) 校验“#2 hash 不符”的另一条链：${Blockchain.validateChain(alt.chain).error}`);

// (B) replaceChain 深度 reorg 防线：一条「工作量更大、但回滚到 checkpoint 之前」的 fork 被拒。
//     伪造一个超高难度块抬高工作量 → 越过“最大工作量”门 → 真正撞到 checkpoint 防线。
const deepFork: any[] = JSON.parse(JSON.stringify(new Blockchain().chain)); // 只有创世
deepFork.push({
  index: 1, timestamp: Date.now(), prevHash: deepFork[0].hash,
  transactions: [], merkleRoot: '0', difficulty: 60, nonce: 0, miner: NULL_ADDRESS, hash: '0',
});
console.log(`\n  深 fork 长度 ${deepFork.length}（回滚到 #2 之前），工作量 ${Blockchain.chainWork(deepFork)} > 规范链 ${Blockchain.chainWork(bc.chain)}`);
const r = bc.replaceChain(deepFork);
console.log(`  (B) replaceChain：replaced = ${r.replaced}，error = ${r.error}`);
console.log(`\n  → 检查点把已确认历史「钉死」：即便攻击者真凑出更大累计工作量，也改不动 checkpoint 之前的旧账。`);
console.log(`     这是低算力 PoW 链对抗深度 reorg / ≥51% 的标准缓冲（同 Bitcoin Core 早期）——代价是引入一个`);
console.log(`     需要全网一致、手动更新的「中心化信任根」（见 LABS.md 的“摩擦点=教学点”）。`);
