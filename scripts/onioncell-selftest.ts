// 定长洋葱 cell 三跳内存自检（无网络）：证明洋葱路由真的成立——
// 客户端套 3 层 → 每个中继只剥自己一层、只知“转发/投递”、看不懂内层 → 出口还原明文；中间篡改被端到端 MAC 抓住。
// 跑：corepack pnpm exec tsx scripts/onioncell-selftest.ts
import {
  CELL_BODY_LEN,
  CMD_DATA,
  CMD_EXTEND,
  nonceFromCounter,
  applyLayer,
  packCellBody,
  unpackCellBody,
  wrapForward,
  unwrapBackward,
} from '../packages/core/src/onioncell.js';
import { sha256Hex, bytesToHex, utf8ToBytes } from '../packages/core/src/crypto.js';
import type { CircuitKeys } from '../packages/core/src/onion.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
}
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const fill = (x: number) => new Uint8Array(32).fill(x);
// 3 跳确定性密钥（hop0=guard, hop1=middle, hop2=exit）；4 把/跳互不相同
const mk = (base: number): CircuitKeys => ({
  encForward: fill(base),
  encBackward: fill(base + 1),
  macForward: fill(base + 2),
  macBackward: fill(base + 3),
});
const hops = [mk(0x10), mk(0x40), mk(0x70)];
const allLen512 = (...bs: Uint8Array[]) => bs.every((b) => b.length === CELL_BODY_LEN);

// ---- 1. 前向 DATA 到出口(hop2)：逐跳剥层，只有出口认领 ----
{
  const msg = utf8ToBytes('hello exit — only hop2 should read this');
  const ctr = 7;
  const n = nonceFromCounter(ctr);
  const wire = wrapForward(hops, 2, CMD_DATA, msg, ctr);

  const p0 = applyLayer(hops[0].encForward, n, wire); // hop0 剥
  check('hop0 不认领（recognized≠0 → 转发）', unpackCellBody(p0, hops[0].macForward) === null);
  const p1 = applyLayer(hops[1].encForward, n, p0); // hop1 剥
  check('hop1 不认领 → 转发', unpackCellBody(p1, hops[1].macForward) === null);
  const p2 = applyLayer(hops[2].encForward, n, p1); // hop2 剥
  const r = unpackCellBody(p2, hops[2].macForward);
  check('出口认领且明文正确', r !== null && r.cmd === CMD_DATA && dec(r.data) === dec(msg));
  check('全程 body 恒 512 字节（不泄露跳位）', allLen512(wire, p0, p1, p2));
}

// ---- 2. 前向 EXTEND 到当前终点(hop0)：建路时延伸 ----
{
  const extData = new Uint8Array(96).fill(0xab); // nextHopId32 ‖ onion32 ‖ eph32 (占位)
  const ctr = 1;
  const wire = wrapForward(hops, 0, CMD_EXTEND, extData, ctr);
  const p0 = applyLayer(hops[0].encForward, nonceFromCounter(ctr), wire);
  const r = unpackCellBody(p0, hops[0].macForward);
  check('hop0 立即认领 EXTEND', r !== null && r.cmd === CMD_EXTEND);
  check('EXTEND 数据完整', r !== null && bytesToHex(r.data) === bytesToHex(extData));
}

// ---- 3. 后向 DATA 出口(hop2)→客户端：各跳加层，客户端剥净 ----
{
  const back = utf8ToBytes('hi client, from the exit');
  const ctr = 3;
  const n = nonceFromCounter(ctr);
  let b = packCellBody(CMD_DATA, back, hops[2].macBackward);
  b = applyLayer(hops[2].encBackward, n, b); // 出口套
  b = applyLayer(hops[1].encBackward, n, b); // hop1 加
  b = applyLayer(hops[0].encBackward, n, b); // hop0 加 → 到客户端
  check('后向 body 恒 512', b.length === CELL_BODY_LEN);
  const r = unwrapBackward(hops, 2, b, ctr);
  check('客户端剥净并验 MAC，明文正确', r !== null && r.cmd === CMD_DATA && dec(r.data) === dec(back));
}

// ---- 4. 篡改检测：中间跳翻一位 → 出口 MAC 抓住、丢弃 ----
{
  const msg = utf8ToBytes('tamper me');
  const ctr = 9;
  const n = nonceFromCounter(ctr);
  const wire = wrapForward(hops, 2, CMD_DATA, msg, ctr);
  const q0 = applyLayer(hops[0].encForward, n, wire);
  const q1 = applyLayer(hops[1].encForward, n, q0);
  q1[20] ^= 0xff; // 恶意中间跳篡改
  const q2 = applyLayer(hops[2].encForward, n, q1);
  check('篡改的 cell 出口拒收（端到端完整性）', unpackCellBody(q2, hops[2].macForward) === null);
}

// ---- 5. 错误 nonce/计数器 → 解不开 ----
{
  const back = utf8ToBytes('x');
  const n = nonceFromCounter(5);
  let b = packCellBody(CMD_DATA, back, hops[2].macBackward);
  b = applyLayer(hops[2].encBackward, n, b);
  b = applyLayer(hops[1].encBackward, n, b);
  b = applyLayer(hops[0].encBackward, n, b);
  check('错误计数器 → 客户端解不开', unwrapBackward(hops, 2, b, 6) === null);
}

// ---- 6. 金标准：固定输入 → 固定 wire body（跨实现对齐用） ----
{
  const msg = utf8ToBytes('golden');
  const wire = wrapForward(hops, 2, CMD_DATA, msg, 1);
  const digest = sha256Hex(bytesToHex(wire));
  console.log('\n# wrapForward(t=2,DATA,"golden",ctr=1) sha256(body) =', digest);
  const EXPECT = '37292c4fdcbc96fe6f2238ffbedaaaec48126ce6ae9988161c2f3da42d7b1391';
  if (EXPECT !== '__FILL__') check('回归：wire body sha256', digest === EXPECT);
  else console.log('  (回归锁未填——把上面 sha256 填进 EXPECT 即生效)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
