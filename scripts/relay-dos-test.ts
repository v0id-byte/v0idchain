// 中继 DoS 加固自测（feat/onion-entry-guards）：用极小覆盖时序验证四道控制
//   ① 空闲清扫 + TTL：僵尸电路被回收，活跃电路不被误伤
//   ② EXTEND 连接超时：延伸到黑洞/拒连的下一跳不会永挂，按时拆电路、客户端 extend 被拒
//   ③ 每连接电路上限：单连接 CREATE 超过 maxPerConn → 超出者收 DESTROY 'per-conn-limit'
//   ④ 每电路 cell 限速：极小 CELL_RATE 下狂灌 → 超额被丢/洪泛销毁；正常速率不受影响
// 镜像 relay-stream-test 风格（check + flush-exit + void r.close() 收尾 + 每步 withTimeout）。
// 跑：corepack pnpm exec tsx scripts/relay-dos-test.ts
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { getPublicKey, publicKeyToAddress, generateOnionKeypair, utf8ToBytes, bytesToHex } from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver, type RelayDosOpts } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient, type HopSpec } from '../packages/node/src/relay/client.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);

// 极小覆盖时序：快 + 确定。空闲 300ms、清扫 100ms、连接超时 500ms、每连接 4 电路、cell 速率 20/s 桶 10。
const DOS: RelayDosOpts = {
  idleMs: 300,
  maxAgeMs: 60_000, // 本测试不验绝对寿命（避免与空闲清扫纠缠），留大值
  sweepMs: 100,
  connectTimeoutMs: 500,
  maxPerConn: 4,
  cellRate: 20,
  cellBurst: 10,
  floodWindowMs: 500,
  floodKill: 40,
};

// 一个裸 WebSocket 客户端，只为“开多条 CREATE 电路”测每连接上限（不需要完整 telescoping）。
// 借 CircuitClient 太重，这里直接用 ws 发 CREATE、收 DESTROY/CREATED 数。
// 注：'ws' 链在 packages/node 下而非仓库根，脚本从根跑 → 经 node 包的 node_modules 解析。
// ws/index.js 是 CJS（无静态命名导出）→ 默认导入再取 WebSocket。
import wsPkg from '../packages/node/node_modules/ws/index.js';
const WebSocket = (wsPkg as any).WebSocket ?? wsPkg;
import { ntorClientStart } from '../packages/core/src/index.js';

async function main() {
  const ports = [7751, 7752, 7753];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));

  // 黑洞下一跳：一个解析得到、但 TCP 直接 close 的端口（连上即断 → 既无 CREATED 也不会让电路建立）。
  // 用一个“接受连接后立刻 destroy socket”的 TCP 服务模拟（WebSocket 升级握手不会完成 → ws 'error'/'close'）。
  // 为触发“连接超时(HANG)”而非“连接错误”，再加一个真正不回应的黑洞端口（accept 后挂住不读不写不关）。
  const BLACKHOLE_PORT = 7760; // accept 后挂起：WebSocket 升级永不完成 → 触发 connectTimeout
  let blackholeSock: import('node:net').Socket | null = null;
  const blackhole: Server = createServer((s) => {
    blackholeSock = s; // 持有引用防 GC；不读不写不关 → 永挂
  });
  await new Promise<void>((r) => blackhole.listen(BLACKHOLE_PORT, '127.0.0.1', () => r()));
  const BLACKHOLE_ID = '0x' + 'bb'.repeat(32);

  const resolve: RelayResolver = (id) => (id === BLACKHOLE_ID ? { host: '127.0.0.1', port: BLACKHOLE_PORT } : dir.get(id));
  // 关键：allowPrivateRelayTargets 必须为 true（host=127.0.0.1 默认即 true），否则 EXTEND 到 127.0.0.1 会被私网守卫直接拒。
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host, true, DOS));
  await sleep(150);

  const hops: HopSpec[] = nodes.map((n) => ({ id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port }));

  // ============ ① 空闲清扫 + 活跃保护 ============
  // 建一条 3 跳电路（每跳各 +1 电路）。停止触碰 → 守卫(hop0)电路应在 idleMs + 一个清扫 tick 后被回收。
  const idleClient = new CircuitClient();
  await withTimeout(idleClient.connect(hops[0]), 5000, 'idle connect');
  await withTimeout(idleClient.extend(hops[1]), 5000, 'idle extend1');
  await withTimeout(idleClient.extend(hops[2]), 5000, 'idle extend2');
  check('① 建路后守卫承载 1 电路', relays[0].circuits === 1);

  // 同时建一条“持续活跃”的电路：每个清扫周期发一个 DATA（出口无 handler，但前向 cell 会刷新 lastSeen）。
  const liveClient = new CircuitClient();
  await withTimeout(liveClient.connect(hops[0]), 5000, 'live connect');
  check('① 两条电路在守卫上（idle+live）', relays[0].circuits === 2);
  // liveClient 单跳即可（连上守卫）；持续发前向 DATA 刷新 lastSeen。出口无回应不影响 lastSeen 刷新。
  let keepAlive = true;
  (async () => {
    while (keepAlive) {
      // 经 1 跳发一个 DATA cell（出口=守卫；它没 exitHandler/stream → 静默，但 lastSeen 被刷新）。
      try {
        liveClient.write(utf8ToBytes('ka'));
      } catch {
        /* 电路被销毁后 write 抛错 → 退出保活 */ break;
      }
      await sleep(80); // < idleMs，确保每个空闲窗口内都有活动
    }
  })();

  // 等 > idleMs(300) + 一个清扫 tick(100)，留足余量。
  await sleep(700);
  check('① 空闲电路被清扫（守卫电路数下降）', relays[0].circuits === 1); // idle 那条没了，live 还在
  check('① 活跃电路未被误扫（live 仍在）', relays[0].circuits >= 1);
  keepAlive = false;
  liveClient.close();
  idleClient.close();
  await sleep(250); // 让 live 也空闲掉，回到基线
  check('① 停止保活后活跃电路也最终空闲回收', relays[0].circuits === 0);

  // ============ ② EXTEND 到黑洞 → 连接超时拆电路 ============
  const baseline2 = relays[0].circuits;
  const bhClient = new CircuitClient();
  await withTimeout(bhClient.connect(hops[0]), 5000, 'bh connect');
  check('② 连上守卫后 1 电路', relays[0].circuits === baseline2 + 1);
  // EXTEND 到黑洞 relayId：守卫拨号 BLACKHOLE_PORT（accept 后永挂）→ 既无 CREATED 也无 error → connectTimeout 触发。
  let extendRejected = false;
  const t0 = Date.now();
  try {
    await withTimeout(
      bhClient.extend({ id: BLACKHOLE_ID, onionPub: generateOnionKeypair().pub, host: '127.0.0.1', port: BLACKHOLE_PORT }),
      4000,
      'bh extend',
    );
  } catch {
    extendRejected = true;
  }
  const dt = Date.now() - t0;
  check('② 延伸到黑洞被拒（extend reject，无永挂）', extendRejected === true);
  check('② 在连接超时量级内返回（< 2s，约 connectTimeoutMs=500）', dt < 2000);
  await sleep(250);
  check('② 黑洞延伸后电路被拆、回到基线', relays[0].circuits === baseline2);
  bhClient.close();
  await sleep(100);

  // ============ ③ 每连接电路上限 ============
  // 用一条裸 ws 连守卫，连发 maxPerConn+2 个 CREATE。前 maxPerConn 个回 CREATED，其后回 DESTROY 'per-conn-limit'。
  const baseline3 = relays[0].circuits;
  const ws = new WebSocket(`ws://127.0.0.1:${ports[0]}`, { maxPayload: 1 << 16 });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  let created = 0;
  let perConnLimited = 0;
  ws.on('message', (d) => {
    try {
      const m = JSON.parse(String(d));
      if (m.t === 'CREATED') created++;
      else if (m.t === 'DESTROY' && m.r === 'per-conn-limit') perConnLimited++;
    } catch {
      /* ignore */
    }
  });
  const total = (DOS.maxPerConn ?? 4) + 3; // 故意超额 3 个
  for (let i = 0; i < total; i++) {
    const st = ntorClientStart();
    ws.send(JSON.stringify({ t: 'CREATE', c: 'pc-' + i, x: bytesToHex(st.ephPublic) }));
  }
  // 等响应回齐
  await withTimeout(
    (async () => {
      while (created + perConnLimited < total) await sleep(20);
    })(),
    4000,
    'per-conn responses',
  );
  check(`③ 恰好 maxPerConn(${DOS.maxPerConn}) 个 CREATE 成功`, created === DOS.maxPerConn);
  check('③ 超出者全部收 DESTROY per-conn-limit', perConnLimited === total - (DOS.maxPerConn ?? 4));
  check('③ 守卫电路数 = 基线 + maxPerConn（超额未占用电路槽）', relays[0].circuits === baseline3 + (DOS.maxPerConn ?? 4));
  // 关连接 → 全部电路释放 + perConn 记账归零（关键：不泄漏计数）。
  ws.close();
  await sleep(200);
  check('③ 关连接后该连接电路全部回收', relays[0].circuits === baseline3);
  // 再用一条新连接 CREATE 应仍可建满 maxPerConn（证明上一连接的计数没残留污染全局/同 link 记账）。
  const ws2 = new WebSocket(`ws://127.0.0.1:${ports[0]}`, { maxPayload: 1 << 16 });
  await new Promise<void>((res, rej) => {
    ws2.once('open', () => res());
    ws2.once('error', rej);
  });
  let created2 = 0;
  ws2.on('message', (d) => {
    try {
      if (JSON.parse(String(d)).t === 'CREATED') created2++;
    } catch {
      /* ignore */
    }
  });
  for (let i = 0; i < (DOS.maxPerConn ?? 4); i++) {
    const st = ntorClientStart();
    ws2.send(JSON.stringify({ t: 'CREATE', c: 'pc2-' + i, x: bytesToHex(st.ephPublic) }));
  }
  await withTimeout(
    (async () => {
      while (created2 < (DOS.maxPerConn ?? 4)) await sleep(20);
    })(),
    4000,
    'per-conn round2',
  );
  check('③ 新连接可重新建满 maxPerConn（计数无残留）', created2 === DOS.maxPerConn);
  ws2.close();
  await sleep(200);

  // ============ ④ 每电路 cell 限速 / 洪泛销毁 ============
  // 用一条新电路狂灌前向 cell。CELL_RATE=20/s, burst=10, floodKill=40/500ms。
  // 一口气发 floodKill+突发 个 cell → 桶(10)很快耗尽、剩余被丢，丢弃数达 floodKill → 电路被 'flood' 销毁。
  const baseline4 = relays[0].circuits;
  const floodClient = new CircuitClient();
  await withTimeout(floodClient.connect(hops[0]), 5000, 'flood connect');
  check('④ 洪泛前守卫 +1 电路', relays[0].circuits === baseline4 + 1);
  // 狂灌：burst(10) + floodKill(40) + 余量 → 远超一窗口阈值，触发 flood 销毁。
  const blast = (DOS.cellBurst ?? 10) + (DOS.floodKill ?? 40) + 20;
  for (let i = 0; i < blast; i++) floodClient.write(utf8ToBytes('x')); // 每个 write 至少 1 个前向 cell
  // 电路应被销毁（守卫回到基线）。给一点时间让 cell 全部到达 + 处理。
  await withTimeout(
    (async () => {
      while (relays[0].circuits > baseline4) await sleep(20);
    })(),
    4000,
    'flood kill',
  );
  check('④ 狂灌触发洪泛销毁（电路回基线）', relays[0].circuits === baseline4);
  floodClient.close();

  // 正常速率不受影响：每 ≥60ms 发 1 个 cell（< 20/s），连发 8 个，电路全程存活、不被限速/销毁。
  const baseline5 = relays[0].circuits;
  const slowClient = new CircuitClient();
  await withTimeout(slowClient.connect(hops[0]), 5000, 'slow connect');
  for (let i = 0; i < 8; i++) {
    slowClient.write(utf8ToBytes('y'));
    await sleep(70); // 速率 ~14/s < CELL_RATE=20/s → 永不缺令牌
  }
  // 全程低速 → 既不被限速丢弃也不被洪泛销毁 → 该电路仍在（= 基线 + 1，区别于洪泛被销毁回基线）。
  check('④ 正常速率电路全程存活（不被误限速销毁）', relays[0].circuits === baseline5 + 1);
  slowClient.close();
  await sleep(150);

  // ---- 收尾 ----
  blackholeSock?.destroy();
  blackhole.close();
  for (const r of relays) void r.close(); // 不 await；出站/挂起连接交给 process.exit 收尾
  // 经 pipe 块缓冲 → 显式 flush 末行再退出。
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
