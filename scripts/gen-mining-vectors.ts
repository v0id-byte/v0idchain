// 生成挖矿一致性金标准向量：难度重定向 + coinbase txid。
// 跑：corepack pnpm exec tsx scripts/gen-mining-vectors.ts
// 输出粘进 clients/macos/V0idKit/Tests/V0idKitTests/MiningVectorTests.swift。
import { sha256Hex } from '../packages/core/src/crypto.js';
import { expectedDifficulty } from '../packages/core/src/blockchain.js';
import {
  NULL_ADDRESS,
  BLOCK_REWARD,
  GENESIS_DIFFICULTY,
  MIN_DIFFICULTY,
  RETARGET_INTERVAL,
  TARGET_BLOCK_TIME_MS,
} from '../packages/core/src/config.js';

console.log('# constants', { NULL_ADDRESS, BLOCK_REWARD, GENESIS_DIFFICULTY, MIN_DIFFICULTY, RETARGET_INTERVAL, TARGET_BLOCK_TIME_MS });

// ---- coinbase txid（与 createCoinbase 的 payloadHash 同：[from,to,amount,fee,nonce,timestamp,memo]，无 burn）----
function coinbaseTxid(miner: string, index: number, fees: number, ts: number): string {
  return sha256Hex(JSON.stringify([NULL_ADDRESS, miner, BLOCK_REWARD + fees, 0, index, ts, '']));
}
const miner = '0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664';
const ts = 1_700_000_000_000;
console.log('# coinbase');
for (const [index, fees] of [[1, 0], [1234, 0], [1234, 7], [99999, 250]] as const) {
  console.log(`coinbase index=${index} fees=${fees} ts=${ts} => ${coinbaseTxid(miner, index, fees, ts)}`);
}

// ---- expectedDifficulty：构造长度 16 的链，控制 chain[8] / chain[15] 时间戳，调 expectedDifficulty(chain, 16) ----
type Stub = { index: number; timestamp: number; difficulty: number };
function buildChain(baseDiff: number, ts8: number, ts15: number): Stub[] {
  const c: Stub[] = [];
  for (let i = 0; i < 16; i++) {
    let t = i * 8000; // 线性占位（只有 8 与 15 真正参与 index=16 的计算）
    if (i === 8) t = ts8;
    if (i === 15) t = ts15;
    c.push({ index: i, timestamp: t, difficulty: baseDiff });
  }
  return c;
}
const expected = (RETARGET_INTERVAL - 1) * TARGET_BLOCK_TIME_MS; // 56000
console.log('# expectedDifficulty (call index=16, prev=chain[15], windowStart=chain[8])');
const cases: { name: string; base: number; actual: number }[] = [
  { name: 'on-target', base: 20, actual: expected },          // ratio 1 → 0
  { name: '4x-fast', base: 20, actual: expected / 4 },        // log2 2 → +2
  { name: '2x-fast', base: 20, actual: expected / 2 },        // log2 1 → +1
  { name: '2x-slow', base: 20, actual: expected * 2 },        // log2 -1 → -1
  { name: '4x-slow', base: 20, actual: expected * 4 },        // log2 -2 → -2
  { name: '8x-fast-clamp', base: 20, actual: expected / 8 },  // log2 3 → clamp +2
  { name: 'floor-clamp', base: 9, actual: expected * 1000 },  // huge slow → -2 → 7 → MIN 8
  { name: 'zero-actual', base: 20, actual: 0 },               // actual<=0 → +2
];
for (const c of cases) {
  const ts8 = 1_000_000;
  const chain = buildChain(c.base, ts8, ts8 + c.actual);
  const d = expectedDifficulty(chain as any, 16);
  console.log(`diff ${c.name}: base=${c.base} actual=${c.actual} => ${d}`);
}

// 非重定向点 / 近创世 → 沿用 prev 难度
const c2 = buildChain(20, 1_000_000, 1_000_000 + 14_000);
console.log(`diff non-retarget index=15 => ${expectedDifficulty(c2 as any, 15)} (expect 20)`);
console.log(`diff near-genesis index=8 => ${expectedDifficulty(c2 as any, 8)} (expect 20)`);
console.log(`diff index=0 => ${expectedDifficulty(c2 as any, 0)} (expect ${GENESIS_DIFFICULTY})`);
