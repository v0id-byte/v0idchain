// 实验 2：伪造一条「压低难度、靠长度凑数」的 fork，想反超诚实链 —— 被「最大累计工作量」规则拒。
// 选链不看链长，看 chainWork = Σ 2^difficulty：长度不值钱，工作量才值钱。
//
// 跑：corepack pnpm tsx scripts/labs/02-cheap-long-fork.ts
import { Blockchain, Wallet, NULL_ADDRESS } from '../../packages/core/src/index.js';

// —— 诚实链：4 个难度 16 的真块 ——
const honest = new Blockchain();
const bob = Wallet.generate();
for (let i = 0; i < 4; i++) await honest.mine(bob.address);

// —— 攻击者的「廉价长 fork」：把难度压到 1，狂塞 30 个空块凑长度（共享同一创世）——
const cheap: any[] = JSON.parse(JSON.stringify(new Blockchain().chain));
for (let i = 1; i <= 30; i++) {
  cheap.push({
    index: i, timestamp: Date.now(), prevHash: '0'.repeat(64),
    transactions: [], merkleRoot: '0', difficulty: 1, nonce: 0, miner: NULL_ADDRESS, hash: '0',
  });
}

console.log('选链规则 = 最大累计工作量（chainWork = Σ 2^difficulty），不是最长链：\n');
console.log(`  诚实链   长度 ${honest.chain.length} 块、难度 16  → chainWork = ${Blockchain.chainWork(honest.chain)}`);
console.log(`  廉价fork 长度 ${cheap.length} 块、难度 1   → chainWork = ${Blockchain.chainWork(cheap)}`);

const r = honest.replaceChain(cheap);
console.log(`\n  把廉价长 fork 喂给诚实节点：replaced = ${r.replaced}（false = 拒绝，不采纳）`);
console.log(`  诚实节点链高仍是 ${honest.height} —— 长 fork 工作量更小，被无声拒绝（不是报错，是“你不够格”）。\n`);

// 直观对比：短而高难 > 长而低难
const shortHi = Blockchain.chainWork([{ difficulty: 20 }, { difficulty: 20 }] as any); // 2 × 2^20
const longLo = Blockchain.chainWork(Array.from({ length: 20 }, () => ({ difficulty: 8 })) as any); // 20 × 2^8
console.log(`  对比：2 个难度20的块 chainWork=${shortHi} > 20 个难度8的块 chainWork=${longLo}`);
console.log(`  → 这正是比特币的正确选链法：靠“凑长度”反超是廉价的，靠累计工作量反超才是真实代价。`);
