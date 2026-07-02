// 隐藏服务引入点自愈（回归 THE bug：引入电路衰亡后服务半死）。真实 WebSocket，6 个中继，静态目录。
// 复现根因：引入电路经 CF 隧道 idle-kill / 中继重启而死，但描述符只在 24h TP 边界重发、中途不重建 →
//   描述符仍挂着死引入点，客户端 INTRODUCE 无人接 → 服务不可达（却"看着在跑"）。
// 修复：① client.ts 补 ws close/error 检测（死亡有信号）；② hsservice.ts 引入电路死亡→重建+重推描述符。
// 判据：以 numIntros=1 起服务（单引入点）→ 基线连通 → **停掉那唯一的引入中继** → 若无自愈则永久不可达；
//   本测试断言服务在数秒内把引入点重建到存活中继、并让**新客户端**照常连通。
// 跑：corepack pnpm exec tsx scripts/hs-intro-recovery-test.ts
import { randomBytes } from 'node:crypto';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  utf8ToBytes,
} from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient } from '../packages/node/src/relay/client.js';
import { HiddenService } from '../packages/node/src/relay/hsservice.js';
import { connectHiddenService, RdvChannel } from '../packages/node/src/relay/hsclient.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- 6 个中继（静态目录，端口 7871-7876）----
  const ports = [7871, 7872, 7873, 7874, 7875, 7876];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const relayById = new Map(nodes.map((n) => [n.id, new RelayNode(n.id, n.onion, resolve, n.port, n.host)]));
  await sleep(150);

  // 可变目录：停掉的中继从中剔除（模拟"中继下线"，与真实选路一致）。
  let liveIds = nodes.map((n) => n.id);
  const directory = () => liveIds;
  const hopOf = (id: string) => {
    const n = nodes.find((x) => x.id === id)!;
    return { id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port };
  };
  async function buildCircuit(exitRelayId: string): Promise<CircuitClient> {
    const others = shuffle(liveIds.filter((id) => id !== exitRelayId));
    const c = new CircuitClient();
    await withTimeout(c.connect(hopOf(others[0])), 5000, 'connect guard');
    await withTimeout(c.extend(hopOf(others[1])), 5000, 'extend middle');
    await withTimeout(c.extend(hopOf(exitRelayId)), 5000, 'extend exit');
    return c;
  }

  // ---- 服务：单引入点（numIntros=1），echo handler ----
  const seed = randomBytes(32);
  const svc = new HiddenService({
    seed,
    onion: generateOnionKeypair(),
    build: buildCircuit,
    dir: directory,
    numIntros: 1,
    handler: (channel) => channel.onData((b) => channel.send(b)),
  });
  await withTimeout(svc.start(), 15000, 'svc.start');
  const intro0 = svc.introRelayIds[0];
  check('服务已启动，单引入点已建', svc.introRelayIds.length === 1 && !!intro0);

  // ---- 基线：新客户端连通 ----
  const { channel: ch0 } = await withTimeout(connectHiddenService(svc.address, buildCircuit, directory), 15000, 'baseline connect');
  check('基线：客户端连通隐藏服务', ch0 instanceof RdvChannel);
  ch0.close();

  // ---- 杀掉那唯一的引入中继（+ 从目录剔除）→ 描述符里的引入点就此"死了" ----
  await relayById.get(intro0)!.close();
  liveIds = liveIds.filter((id) => id !== intro0);
  check('已停掉唯一引入中继（无自愈则服务永久不可达）', true);

  // ---- 断言自愈：引入电路死亡（DESTROY 反向传播 / ws close）应触发维护，把引入点重建到存活中继 ----
  let healed = false;
  for (let i = 0; i < 40; i++) {
    // 事件驱动重建为异步：轮询直到引入点变为一个**存活**中继（≠ 已停的 intro0）。
    const ids = svc.introRelayIds;
    if (ids.length === 1 && ids[0] !== intro0 && liveIds.includes(ids[0])) {
      healed = true;
      break;
    }
    await sleep(250); // 最多等 10s
  }
  check('服务自愈：引入点被重建到另一存活中继', healed);
  check('重建后的引入点不是已停的旧中继', svc.introRelayIds[0] !== intro0);

  // ---- 决定性判据：重建 + 重推描述符后，**新客户端**照常连通（端到端回显）----
  const { channel: ch1 } = await withTimeout(connectHiddenService(svc.address, buildCircuit, directory), 15000, 'post-heal connect');
  check('自愈后：新客户端仍能连通隐藏服务', ch1 instanceof RdvChannel);
  let echoed: string | null = null;
  let resolveEcho: (() => void) | null = null;
  const echoWait = new Promise<void>((r) => (resolveEcho = r));
  ch1.onData((b) => {
    echoed = dec(b);
    resolveEcho?.();
  });
  ch1.send(utf8ToBytes('post-heal-roundtrip'));
  await withTimeout(echoWait, 8000, 'post-heal echo');
  check('自愈后：端到端数据流通（回显一致）', echoed === 'post-heal-roundtrip');

  // ---- 收尾 ----
  ch1.close();
  svc.stop();
  for (const r of relayById.values()) void r.close();
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
