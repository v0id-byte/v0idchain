// Stage 1 概念证明（docs/WEBRTC-MESH-DESIGN.md §7）：
// 两个 enableRtc 节点经「只做信令中继」的种子互相发现 → WebRTC DataChannel 打洞直连 →
// 杀掉种子后，A 挖出的新块仍能经 RTC 点对点到达 B（证明数据不依赖种子中转）。
// 三节点同进程：种子用 enableRtc:false + relaySignaling:true（无 node-datachannel 句柄 → 停它不会
// 触发全局 cleanup 而误伤 A/B 的连接）。
import { rmSync } from 'node:fs';
import { V0idNode } from '../packages/node/src/index.js';

const DIR = '/tmp/v0id-rtc-proto';
rmSync(DIR, { recursive: true, force: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 20_000, step = 200): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  ok ? pass++ : fail++;
};

console.log('— 起「只做信令中继」的种子（enableRtc:false, relaySignaling:true）并挖几块 —');
const seed = new V0idNode({ dataDir: `${DIR}/seed`, p2pPort: 6401, enableRtc: false, relaySignaling: true });
seed.start();
for (let i = 0; i < 3; i++) await seed.mineOnce();
const H = seed.bc.height;
console.log(`  种子链高 = ${H}`);

console.log('\n— A、B 连种子（WS），启用 WebRTC —');
const a = new V0idNode({ dataDir: `${DIR}/a`, p2pPort: 6402, peers: ['ws://127.0.0.1:6401'], enableRtc: true });
const b = new V0idNode({ dataDir: `${DIR}/b`, p2pPort: 6403, peers: ['ws://127.0.0.1:6401'], enableRtc: true });
a.start();
b.start();

check('A 经种子 WS 追平链高', await waitFor(() => a.bc.height === H));
check('B 经种子 WS 追平链高', await waitFor(() => b.bc.height === H));

console.log('\n— A↔B 经种子 1-hop 信令建立 WebRTC DataChannel 直连 —');
const rtcUp = await waitFor(() => a.p2p.rtcPeerCount() > 0 && b.p2p.rtcPeerCount() > 0);
check('A↔B 建立 WebRTC DataChannel（双方 rtcPeerCount>0）', rtcUp);
console.log(
  `  A: peers=${a.p2p.peerCount()} rtc=${a.p2p.rtcPeerCount()} kinds=[${a.p2p.peerKinds()}] | B: peers=${b.p2p.peerCount()} rtc=${b.p2p.rtcPeerCount()} kinds=[${b.p2p.peerKinds()}]`,
);
check('A 同时保有 WS(种子) + RTC(B) 两条连接', a.p2p.peerKinds().includes('ws') && a.p2p.peerKinds().includes('rtc'));

console.log('\n— 杀掉种子：A、B 只剩彼此的 RTC 连接 —');
seed.p2p.stop();
await sleep(1500);
check('种子下线后 A 仍有对端（RTC→B）', a.p2p.peerCount() >= 1 && a.p2p.rtcPeerCount() >= 1);
check('种子下线后 B 仍有对端（RTC→A）', b.p2p.peerCount() >= 1 && b.p2p.rtcPeerCount() >= 1);

console.log('\n— A 出新块 → B 必须经 WebRTC（无种子中转）收到，证明数据点对点流动 —');
const blk = await a.mineOnce();
check('A 挖出新块到 H+1', !!blk && a.bc.height === H + 1);
const got = await waitFor(() => b.bc.height === H + 1, 12_000);
check('B 经 WebRTC 收到 A 的新块（种子已下线）', got);
check('B 链顶 hash == A 链顶 hash', b.bc.latest.hash === a.bc.latest.hash);

a.p2p.stop();
b.p2p.stop();
await sleep(400);

// ── 场景 B：整链 QUERY_ALL 经 RTC 分片同步（验证 §3.5 CHUNK_RTC / [V4]）──
// 中继 R 只做信令、不服务链（serveChain:false）→ 新节点 Q 无法经 WS 从 R 同步，
// 只能经 RTC 从生产者 P 拉取 16 块的链（>CHUNK_RTC=12 → 必然分片 + 重组）。
console.log('\n— 场景 B：新节点经 WebRTC 分片同步整链（>12 块，CHUNK_RTC）—');
const relay = new V0idNode({ dataDir: `${DIR}/relay`, p2pPort: 6411, enableRtc: false, relaySignaling: true, serveChain: false });
relay.start();
const p = new V0idNode({ dataDir: `${DIR}/p`, p2pPort: 6412, peers: ['ws://127.0.0.1:6411'], enableRtc: true });
p.start();
await waitFor(() => p.p2p.peerCount() >= 1);
for (let i = 0; i < 15; i++) await p.mineOnce(); // P 链高 15（链长 16 > CHUNK_RTC=12 → 2 片）
const HP = p.bc.height;
console.log(`  生产者 P 链高 = ${HP}（链长 ${HP + 1}，> CHUNK_RTC=12）`);

// 对照组 Q2：连同一个纯中继、但**不开 RTC** → 既无 WS 整链服务、又无 RTC → 永远停在创世。
// 这确定性地证明：中继不经 WS 提供链；因此 Q 能追平只可能是经 RTC。
const q2 = new V0idNode({ dataDir: `${DIR}/q2`, p2pPort: 6414, peers: ['ws://127.0.0.1:6411'], enableRtc: false });
q2.start();
const q = new V0idNode({ dataDir: `${DIR}/q`, p2pPort: 6413, peers: ['ws://127.0.0.1:6411'], enableRtc: true });
q.start();
await waitFor(() => q.p2p.peerCount() >= 1 && q2.p2p.peerCount() >= 1);

const qRtc = await waitFor(() => q.p2p.rtcPeerCount() > 0 && p.p2p.rtcPeerCount() > 0);
check('P↔Q 建立 WebRTC DataChannel', qRtc);
const qSynced = await waitFor(() => q.bc.height === HP, 15_000);
check('Q 经 WebRTC 分片同步追平整链（CHUNK_RTC 重组）', qSynced);
check('Q 链顶 hash == P 链顶 hash', q.bc.latest.hash === p.bc.latest.hash);
check('对照组 Q2（无 RTC）经纯中继仍停在创世 → 证明追平来自 RTC 而非 WS', q2.bc.height === 0);

console.log(`\n${fail === 0 ? '🎉 Stage 1 WebRTC 原型全部通过' : '⚠ 有失败项'}  (pass=${pass} fail=${fail})`);
relay.p2p.stop();
p.p2p.stop(); // 触发 node-datachannel 全局 cleanup，让进程能退出
q.p2p.stop();
q2.p2p.stop();
await sleep(300);
process.exit(fail === 0 ? 0 : 1);
