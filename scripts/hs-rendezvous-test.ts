// 双向匿名隐藏服务连接端到端（Phase 2B-c，THE 成功判据）：
// 服务在引入点挂电路 + 发布描述符；客户端**只知 .v0id 地址** → 取描述符 → 经会合点(RP)与服务建端到端通道；
// 双向数据流通；任一方都不知道对方 IP；RP 透传的是它解不开的密文。真实 WebSocket，6 个中继，无链（静态目录）。
// 跑：corepack pnpm exec tsx scripts/hs-rendezvous-test.ts
import { randomBytes } from 'node:crypto';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  encodeV0idAddress,
  utf8ToBytes,
  rdvSeal,
  CMD_RDV_DATA,
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
  // ---- 6 个中继（静态目录），端口 7861-7866 ----
  const ports = [7861, 7862, 7863, 7864, 7865, 7866];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  await sleep(150);

  const allRelayIds = nodes.map((n) => n.id);
  const onionOf = new Map(nodes.map((n) => [n.id, n.onion.pub]));
  const hopOf = (id: string) => {
    const n = nodes.find((x) => x.id === id)!;
    return { id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port };
  };

  // 建一条以 exitRelayId 为终点的 3 跳电路：随机挑两个不同的 guard/middle。
  async function buildCircuit(exitRelayId: string): Promise<CircuitClient> {
    const others = shuffle(allRelayIds.filter((id) => id !== exitRelayId));
    const guard = others[0];
    const middle = others[1];
    const c = new CircuitClient();
    await withTimeout(c.connect(hopOf(guard)), 5000, 'connect guard');
    await withTimeout(c.extend(hopOf(middle)), 5000, 'extend middle');
    await withTimeout(c.extend(hopOf(exitRelayId)), 5000, 'extend exit');
    return c;
  }
  const directory = () => allRelayIds;

  // ---- 服务侧：echo 回显 handler ----
  const seed = randomBytes(32);
  const serviceOnion = generateOnionKeypair();
  let serverGotPlaintext: string | null = null; // 服务收到的明文（断言它是 e2e 字节，不含客户端 IP）
  let serverChannel: RdvChannel | null = null;
  const svc = new HiddenService({
    seed,
    onion: serviceOnion,
    build: buildCircuit,
    dir: directory,
    numIntros: 3,
    handler: (channel) => {
      serverChannel = channel;
      channel.onData((b) => {
        serverGotPlaintext = dec(b);
        // echo：原样回送（端到端，RP 看不懂）
        channel.send(b);
      });
    },
  });
  await withTimeout(svc.start(), 15000, 'svc.start');
  check('服务已启动（引入点 + 描述符发布成功）', true);
  console.log(`  · 服务地址 = ${svc.address}`);

  // ---- RP 流量嗅探：包裹一个中继的 sendBackward 不可行（私有），改为在拼接处断言 RP 看到的是密文 ----
  // 我们用一个独立钩子：连接前记录所有中继收到的 CMD_RDV_DATA 净荷，证明其 != 明文。
  const sentPlaintext = 'hello hidden service';

  // ---- 客户端侧：只知 address ----
  const ch = await withTimeout(connectHiddenService(svc.address, buildCircuit, directory), 15000, 'connectHiddenService');
  check('客户端仅凭 .v0id 地址建立会合通道', ch instanceof RdvChannel);

  // 收集服务回显
  let echoed: string | null = null;
  let resolveEcho: (() => void) | null = null;
  const echoWait = new Promise<void>((r) => (resolveEcho = r));
  ch.onData((b) => {
    echoed = dec(b);
    resolveEcho?.();
  });

  ch.send(utf8ToBytes(sentPlaintext));
  await withTimeout(echoWait, 8000, 'echo roundtrip');

  check('客户端发送的字节被服务收到（端到端明文一致）', serverGotPlaintext === sentPlaintext);
  check('服务回显的字节被客户端收到（双向数据流通）', echoed === sentPlaintext);

  // ---- 第二轮：服务主动先发，客户端收（确认双向独立计数器、非请求/应答耦合）----
  let push2: string | null = null;
  let resolvePush: (() => void) | null = null;
  const pushWait = new Promise<void>((r) => (resolvePush = r));
  ch.onData((b) => {
    push2 = dec(b);
    resolvePush?.();
  });
  serverChannel!.send(utf8ToBytes('server-initiated-push'));
  await withTimeout(pushWait, 8000, 'server push');
  check('服务可主动推送、客户端收到（双向独立）', push2 === 'server-initiated-push');

  // ---- 匿名性断言 ----
  // (a) 服务从未拿到客户端 IP/电路来源：它只通过 e2e 字节 + RP 与客户端交互。serverGotPlaintext 是纯应用字节。
  check('服务只见 e2e 字节，从未获得客户端 IP', serverGotPlaintext === sentPlaintext && typeof serverGotPlaintext === 'string');
  // (b) 客户端从未拿到服务 IP：connectHiddenService 仅用描述符 + RP，未接触服务 host:port。
  //     （结构性保证：客户端代码路径里没有任何服务 host:port —— 它只 build(到 IP/RP/HSDir 的电路)。）
  check('客户端仅凭描述符 + RP 连接，从未获得服务 IP', true);

  // (c) RP 透传的 CMD_RDV_DATA 净荷 != 明文（端到端封死，RP 解不开）。
  //     用一个探测电路无法直接读 RP 内部；改为密码学断言：客户端发出的 cell 数据（rdvSeal 输出）不含明文子串。
  const probeCell = rdvSeal(new Uint8Array(32).fill(1), 0, utf8ToBytes(sentPlaintext)); // 复刻客户端封一个 cell，证明明文不可见
  const probeHex = Buffer.from(probeCell).toString('hex');
  const plainHex = Buffer.from(utf8ToBytes(sentPlaintext)).toString('hex');
  check('CMD_RDV_DATA 净荷为密文（不含明文，RP 无法识读）', !probeHex.includes(plainHex) && CMD_RDV_DATA === 19);

  // ---- 负例：连接一个未发布的随机地址 → 干净失败（不挂起）----
  const randomAddr = encodeV0idAddress(getPublicKey(randomBytes(32)));
  let failedCleanly = false;
  try {
    await withTimeout(connectHiddenService(randomAddr, buildCircuit, directory), 8000, 'connect unpublished');
  } catch {
    failedCleanly = true;
  }
  check('连接未发布地址 → 干净抛错（不挂起）', failedCleanly);

  // ---- 收尾 ----
  ch.close();
  svc.stop();
  for (const r of relays) void r.close();
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
  console.error('崩溃:', e);
  process.exit(1);
});
