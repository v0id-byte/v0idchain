// 实验 3：把区块时间戳设到「远未来」，想拉长重定向窗口、把难度压到地板 —— 被 MAX_FUTURE_DRIFT_MS 拒。
// 这是「最大工作量规则」挡不住的「压难度双花」的关键防线：压难度必须伪造未来时间戳，而未来时间戳直接被拒。
//
// 跑：corepack pnpm tsx scripts/labs/03-future-timestamp.ts
import { Blockchain, Wallet, MAX_FUTURE_DRIFT_MS, NULL_ADDRESS } from '../../packages/core/src/index.js';

const honest = new Blockchain();
const bob = Wallet.generate();
for (let i = 0; i < 4; i++) await honest.mine(bob.address);

console.log(`本地时钟容忍上限 MAX_FUTURE_DRIFT_MS = ${MAX_FUTURE_DRIFT_MS}ms（${MAX_FUTURE_DRIFT_MS / 1000}s）\n`);

// (A) 直接把链顶时间戳推到 now + 2分钟 + 60秒
const fut = JSON.parse(JSON.stringify(honest.chain));
fut[fut.length - 1].timestamp = Date.now() + MAX_FUTURE_DRIFT_MS + 60_000;
console.log(`  (A) 整链校验一条“链顶时间戳来自未来”的链：${Blockchain.validateChain(fut).error}`);

// (B) 真实攻击形态：一条「更长 + 累计工作量更大」但含未来时间戳的 fork。
//     工作量门会被它越过（继承诚实前缀 + 多一个高难块），全靠未来时间戳上限挡下。
const fork: any[] = JSON.parse(JSON.stringify(honest.chain));
fork.push({
  index: fork.length,
  timestamp: Date.now() + MAX_FUTURE_DRIFT_MS + 3_600_000, // 远未来：攻击者拉长窗口压难度的代价
  prevHash: fork[fork.length - 1].hash,
  transactions: [], merkleRoot: '0', difficulty: 30, nonce: 0, miner: NULL_ADDRESS, hash: '0',
});
const victim = new Blockchain();
victim.chain = JSON.parse(JSON.stringify(honest.chain));
console.log(`\n  fork 工作量 ${Blockchain.chainWork(fork)} > 诚实链 ${Blockchain.chainWork(victim.chain)}（越过了“最大工作量”门）`);
const r = victim.replaceChain(fork);
console.log(`  (B) replaceChain：replaced = ${r.replaced}，error = ${r.error}`);
console.log(`\n  → 时间戳校验「先于」PoW，所以攻击者连伪造合法 PoW 都省了——窗口拉不长 → 难度压不下去`);
console.log(`     → 廉价块造不出来。攻击被「收敛」为真·≥51% 算力攻击（任何 PoW 链都防不住的固有上限）。`);
