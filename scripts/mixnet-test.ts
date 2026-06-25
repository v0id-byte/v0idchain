// Mixnet 模式自测（Phase 2C）。验证 opt-in 的两件事：① 中继逐跳混入随机延迟（打散 input→output 时序相关），
// ② 客户端环路 cover（CMD_DROP 掩护 cell，与真数据线缆不可区分，终点静默丢）。镜像 relay-stream-test 风格：
// check + flush-exit + void r.close() 收尾 + 每步 withTimeout。
// 跑：corepack pnpm exec tsx scripts/mixnet-test.ts
//
// 反相关性诚实说明：本测试不主张“抵抗流量分析”这一强结论，只验证机制存在且按设计工作（延迟可测、cover 被丢、调度器速率达标、
// 真数据仍正确、默认关时零行为变化）。注意一个 v1 已知耦合：mixnet 开启时各跳独立随机延迟会**重排前向 cell**，而前向
// 防重放要求 n 严格增 → 被重排到后面的前向 cell 会在中继被当重放丢弃。故“真数据经 mixnet 正确”用**串行请求/应答
// （sendData，任一时刻仅 1 个前向 cell 在途）**验证（无重排）；cover 调度器速率用**未开延迟的中继**隔离验证（把“客户端
// 调度速率”这一客户端属性与“中继 mixnet 重排”解耦）。详见返回的设计说明。
import { randomBytes } from 'node:crypto';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  utf8ToBytes,
  sampleExpMs,
  nextCoverDelayMs,
  DEFAULT_MAX_DELAY_MS,
} from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver, type MixnetOpts } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient, type HopSpec } from '../packages/node/src/relay/client.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);

// 一组 3 中继 + 目录 + 出口 echo handler 计数 + drop 计数。mixnet 传 opts 即各中继开延迟；不传 = 关。
// 返回 close() 一并收尾。端口段每组不同，避免并存时撞端口。
function makeRelays(basePort: number, mixnet?: MixnetOpts) {
  const ports = [basePort, basePort + 1, basePort + 2];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const exitCalls = { n: 0 };
  const dropCount = { n: 0 };
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host, true, {}, mixnet));
  // 终点(出口)：数据报 echo + 计数。CMD_DROP 不会到这里（终点更早静默丢）→ 用来证明 cover 不被投递。
  relays[2].onExit((data, reply) => {
    exitCalls.n++;
    reply(utf8ToBytes('ECHO:' + dec(data)));
  });
  relays[2].onDrop(() => dropCount.n++); // 终点丢弃一个 CMD_DROP 掩护 cell → 计数（仅自测观察）
  const hops: HopSpec[] = nodes.map((n) => ({ id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port }));
  const close = () => {
    for (const r of relays) void r.close();
  };
  return { hops, relays, exitCalls, dropCount, close };
}

async function build3Hop(hops: HopSpec[]): Promise<CircuitClient> {
  const c = new CircuitClient();
  await withTimeout(c.connect(hops[0]), 5000, 'connect');
  await withTimeout(c.extend(hops[1]), 5000, 'extend1');
  await withTimeout(c.extend(hops[2]), 5000, 'extend2');
  return c;
}

async function main() {
  // ============ ② sampleExpMs 分布性质（纯函数，无网络）============
  {
    const mean = 50;
    const N = 4000;
    let sum = 0;
    let above = 0;
    let below = 0;
    let maxSeen = 0;
    let overMax = 0;
    const MAXCLAMP = 300;
    for (let i = 0; i < N; i++) {
      const x = sampleExpMs(mean, MAXCLAMP);
      sum += x;
      if (x > mean) above++;
      if (x < mean) below++;
      if (x > maxSeen) maxSeen = x;
      if (x > MAXCLAMP) overMax++;
    }
    const avg = sum / N;
    check(`② sampleExpMs 样本均值 ≈ 目标(±25%)：${avg.toFixed(1)} vs ${mean}`, avg > mean * 0.75 && avg < mean * 1.25);
    check('② 分布非常量：有样本 > 均值 且有样本 < 均值', above > 0 && below > 0);
    check(`② 全部样本被钳到 ≤ max(${MAXCLAMP})`, overMax === 0 && maxSeen <= MAXCLAMP);
    // 退化输入：mean≤0 → 0（mixnet 关的同步语义）；默认 max 生效。
    check('② mean=0 → 恒 0（同步退化）', sampleExpMs(0, 1000) === 0 && sampleExpMs(-5, 1000) === 0);
    check('② 默认 max 钳制存在', sampleExpMs(1e9, DEFAULT_MAX_DELAY_MS) <= DEFAULT_MAX_DELAY_MS);
  }

  // ============ nextCoverDelayMs 性质（纯函数）============
  {
    const rate = 10; // 10/s → 平均间隔 100ms
    const N = 4000;
    let sum = 0;
    let pos = 0;
    for (let i = 0; i < N; i++) {
      const d = nextCoverDelayMs(rate);
      sum += d;
      if (d > 0) pos++;
    }
    const avg = sum / N;
    check(`· nextCoverDelayMs 平均间隔 ≈ 1000/rate(±25%)：${avg.toFixed(1)} vs 100`, avg > 75 && avg < 125);
    check('· nextCoverDelayMs 恒非负且非常量', pos > N * 0.9);
    check('· rate≤0 → +∞（停调度退化）', !Number.isFinite(nextCoverDelayMs(0)) && !Number.isFinite(nextCoverDelayMs(-1)));
  }

  // ============ ① 延迟实测：mixnet 开 vs 关，串行往返计时对比 ============
  // mean=60ms/跳、3 跳、双向均延迟 → 一次 sendData 往返（前向 3 跳 + 后向 3 跳）期望 ≈ +6×60=360ms 量级（指数有方差，
  // 但远大于关时的近 0）。用清晰可分的均值 + 取多次往返取中位/均值降噪，阈值留宽避免偶发长尾误判。
  const OFF = makeRelays(7810); // mixnet 关
  const ON = makeRelays(7820, { delayMeanMs: 60, maxDelayMs: 2000 }); // mixnet 开
  await sleep(150);

  const cOff = await build3Hop(OFF.hops);
  const cOn = await build3Hop(ON.hops);

  // 预热各一发（建路已产生若干 cell；再跑稳定）。
  await withTimeout(cOff.sendData(utf8ToBytes('warm')), 5000, 'warm off');
  await withTimeout(cOn.sendData(utf8ToBytes('warm')), 8000, 'warm on');

  const timeRoundTrips = async (c: CircuitClient, k: number, budget: number) => {
    const ts: number[] = [];
    for (let i = 0; i < k; i++) {
      const t0 = Date.now();
      await withTimeout(c.sendData(utf8ToBytes('ping' + i)), budget, 'rt');
      ts.push(Date.now() - t0);
    }
    ts.sort((a, b) => a - b);
    return { median: ts[Math.floor(ts.length / 2)], avg: ts.reduce((s, v) => s + v, 0) / ts.length };
  };
  const offT = await timeRoundTrips(cOff, 5, 4000);
  const onT = await timeRoundTrips(cOn, 5, 8000);
  console.log(`  · 往返耗时 off median=${offT.median}ms avg=${offT.avg.toFixed(0)}ms | on median=${onT.median}ms avg=${onT.avg.toFixed(0)}ms`);
  check('① mixnet 关时往返很快（中位 < 100ms）', offT.median < 100);
  check('① mixnet 开时往返显著变慢（中位 > 关时 + 150ms）', onT.median > offT.median + 150);

  // ============ ⑤ 真数据经 mixnet 仍正确（串行往返，无前向重排）============
  const r1 = await withTimeout(cOn.sendData(utf8ToBytes('hello mixnet')), 8000, 'on data1');
  const r2 = await withTimeout(cOn.sendData(utf8ToBytes('second through delay')), 8000, 'on data2');
  check('⑤ mixnet 下往返数据正确(1)', dec(r1) === 'ECHO:hello mixnet');
  check('⑤ mixnet 下多次往返各自正确(2)', dec(r2) === 'ECHO:second through delay');

  // ============ ③ cover cell 被终点丢弃、不投递给出口、且不影响后续真数据 ============
  // 用 mixnet 开的电路（cover 也应在 mixnet 下工作）。一发 cover → exitCalls 不增、dropCount +1、无后向（不会卡）。
  const exitBefore = ON.exitCalls.n;
  const dropBefore = ON.dropCount.n;
  cOn.sendCover();
  await sleep(600); // 给延迟（mean 60ms/跳，3 跳）足够时间到终点被丢
  check('③ cover 未投递给出口(exitCalls 不变)', ON.exitCalls.n === exitBefore);
  check('③ cover 被终点识别并丢弃(dropCount +1)', ON.dropCount.n === dropBefore + 1);
  // 紧接一发真数据仍正确（cover 没让电路计数器/状态错位）。
  const r3 = await withTimeout(cOn.sendData(utf8ToBytes('after cover')), 8000, 'after cover data');
  check('③ cover 之后真数据仍正确(电路未失同步)', dec(r3) === 'ECHO:after cover');

  cOff.close();
  cOn.close();
  OFF.close();
  ON.close();
  await sleep(150);

  // ============ ④ cover 调度器速率：startCover(rate) 在 ~1s 内大致发出 rate 个 cover ============
  // 隔离“客户端调度速率”：用**未开 mixnet 延迟**的中继 → 前向不重排、cover 全部按序抵达终点被丢，dropCount 精确反映发出数。
  const SCHED = makeRelays(7830); // mixnet 关 → 无前向重排
  await sleep(150);
  const cSched = await build3Hop(SCHED.hops);
  const RATE = 20; // 20/s → ~1s 约 20 个（指数到达有方差，阈值给宽 [10,32]）
  const dBefore = SCHED.dropCount.n;
  cSched.startCover(RATE);
  await sleep(1000);
  cSched.stopCover();
  await sleep(250); // 让在途 cover 抵达终点计入
  const emitted = SCHED.dropCount.n - dBefore;
  console.log(`  · startCover(${RATE}/s) ~1s 内终点丢弃 cover 数 = ${emitted}（期望 ≈ ${RATE}，容差 [10,32]）`);
  check(`④ 调度器约按 rate 发 cover（${emitted} ∈ [10,32]）`, emitted >= 10 && emitted <= 32);
  // stopCover 后不再增长。
  const afterStop = SCHED.dropCount.n;
  await sleep(400);
  check('④ stopCover 后不再发 cover（计数停增）', SCHED.dropCount.n === afterStop);
  // 再次 startCover 后 close() 应自动停 cover（不泄漏定时器/不再发）。
  cSched.startCover(RATE);
  await sleep(150);
  cSched.close();
  const afterClose = SCHED.dropCount.n;
  await sleep(400);
  check('④ close() 自动停 cover（计数停增）', SCHED.dropCount.n === afterClose);
  SCHED.close();
  await sleep(150);

  // ============ ⑥ 默认关 = 零行为变化：未开 mixnet 的中继同步转发，真数据立即往返 ============
  const PLAIN = makeRelays(7840); // 不传 mixnet → 关
  await sleep(150);
  const cPlain = await build3Hop(PLAIN.hops);
  const t0 = Date.now();
  const rp = await withTimeout(cPlain.sendData(utf8ToBytes('sync forward')), 4000, 'plain data');
  const dt = Date.now() - t0;
  check('⑥ 默认(关)往返正确', dec(rp) === 'ECHO:sync forward');
  check(`⑥ 默认(关)同步转发、往返很快(<100ms)：${dt}ms`, dt < 100);
  cPlain.close();
  PLAIN.close();
  await sleep(150);

  // 经 pipe 输出会块缓冲，process.exit 可能截断 → 显式 flush 末行再退出。
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
