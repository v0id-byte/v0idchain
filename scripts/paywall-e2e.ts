// 隧道内付费墙端到端（Phase A.1）：真实 WebSocket、6 中继、付费 .v0id 站点。证明——
//   ① 客户端从**已签名描述符**得知价格 → 乐观预付；② 放行(PAYOK)全程链下(验签+本地已花集)、
//   **不碰链不等出块** → 付费握手时延 << 出块时间；③ 无券/伪券/双花被拒；④ 免费站点无付费墙照常直连。
// 跑：corepack pnpm exec tsx scripts/paywall-e2e.ts
import { randomBytes } from 'node:crypto';
import {
  Wallet,
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  utf8ToBytes,
  TARGET_BLOCK_TIME_MS,
} from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient } from '../packages/node/src/relay/client.js';
import { HiddenService } from '../packages/node/src/relay/hsservice.js';
import { connectHiddenService, RdvChannel } from '../packages/node/src/relay/hsclient.js';
import { runPaywallServer, runPaywallClient, VoucherAcceptor } from '../packages/node/src/relay/paywall.js';
import { issueToken } from '../packages/node/src/mint/token.js';

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
  // ---- 6 中继（静态目录，端口 7891-7896）----
  const ports = [7891, 7892, 7893, 7894, 7895, 7896];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  await sleep(150);
  const allRelayIds = nodes.map((n) => n.id);
  const hopOf = (id: string) => {
    const n = nodes.find((x) => x.id === id)!;
    return { id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port };
  };
  async function buildCircuit(exitRelayId: string): Promise<CircuitClient> {
    const others = shuffle(allRelayIds.filter((id) => id !== exitRelayId));
    const c = new CircuitClient();
    await withTimeout(c.connect(hopOf(others[0])), 5000, 'connect guard');
    await withTimeout(c.extend(hopOf(others[1])), 5000, 'extend middle');
    await withTimeout(c.extend(hopOf(exitRelayId)), 5000, 'extend exit');
    return c;
  }
  const directory = () => allRelayIds;

  // ---- 铸币厂 + 券（本地生成 mint 钱包充当签发者；acceptor 对其地址验签）----
  const mint = Wallet.generate();
  const PRICE = 5;
  const acceptor = new VoucherAcceptor(mint.address);
  const v5 = issueToken(5, mint.privateKey); // 恰好够付
  const v3a = issueToken(3, mint.privateKey); // 3+3=6 ≥ 5 多券凑付
  const v3b = issueToken(3, mint.privateKey);
  const forged = issueToken(5, Wallet.generate().privateKey); // 别的钱包签的伪券

  // ---- 付费 HS：price=5，付费墙通过后回显 ----
  const paidSeed = randomBytes(32);
  const svc = new HiddenService({
    seed: paidSeed,
    onion: generateOnionKeypair(),
    build: buildCircuit,
    dir: directory,
    price: PRICE,
    handler: (channel) => {
      runPaywallServer(channel, PRICE, acceptor)
        .then((res) => {
          if (!res.paid) return void channel.close();
          channel.onData((b) => channel.send(b)); // 付费通过 → 回显
          if (res.leftover.length) channel.send(res.leftover);
        })
        .catch(() => channel.close());
    },
  });
  await withTimeout(svc.start(), 15000, 'paid svc.start');
  check('付费 HS 已启动', true);
  console.log(`  · 付费站点 = ${svc.address}  价 ${PRICE} $V0ID/连接`);

  // ---- 决定性：一次付费访问，测时延 + 断言链下（<< 出块时间）----
  const t0 = Date.now();
  const { channel, price } = await withTimeout(connectHiddenService(svc.address, buildCircuit, directory), 15000, 'connect paid');
  const tConnect = Date.now();
  check('客户端从已签名描述符得知价格 = 5（连接前即知价 → 乐观预付）', price === PRICE);
  await withTimeout(runPaywallClient(channel, [v5]), 12000, 'pay');
  const tPaid = Date.now();
  const paywallMs = tPaid - tConnect;

  // 回显往返
  let echoed: string | null = null;
  let resolveEcho: (() => void) | null = null;
  const echoWait = new Promise<void>((r) => (resolveEcho = r));
  channel.onData((b) => {
    echoed = dec(b);
    resolveEcho?.();
  });
  channel.send(utf8ToBytes('paid-hello'));
  await withTimeout(echoWait, 8000, 'echo');
  const tFirstByte = Date.now();

  check('付费通过后端到端字节流通（回显一致）', echoed === 'paid-hello');
  check(
    `★ 付费墙放行时延 ${paywallMs}ms 远小于出块时间 ${TARGET_BLOCK_TIME_MS}ms（放行链下、不被打包速度拖累）`,
    paywallMs < TARGET_BLOCK_TIME_MS && paywallMs < 3000,
  );
  console.log(`  · 时延：建连 ${tConnect - t0}ms · 付费握手 ${paywallMs}ms · 首字节 ${tFirstByte - t0}ms（出块目标 ${TARGET_BLOCK_TIME_MS}ms 仅作对比,访问全程未碰链）`);
  channel.close();

  // ---- 多券凑付：3+3=6 ≥ 5 → 通过 ----
  const { channel: cSum } = await withTimeout(connectHiddenService(svc.address, buildCircuit, directory), 15000, 'connect sum');
  let sumOk = true;
  try {
    await withTimeout(runPaywallClient(cSum, [v3a, v3b]), 12000, 'pay sum');
  } catch {
    sumOk = false;
  }
  check('多张小面额券凑付（3+3 ≥ 5）→ 通过', sumOk);
  cSum.close();

  // ---- 负例：无券 / 双花 / 伪券 ----
  const payFails = async (vouchers: Parameters<typeof runPaywallClient>[1], label: string): Promise<boolean> => {
    const { channel: c } = await withTimeout(connectHiddenService(svc.address, buildCircuit, directory), 15000, `connect ${label}`);
    let rejected = false;
    try {
      await withTimeout(runPaywallClient(c, vouchers), 12000, label);
    } catch {
      rejected = true;
    }
    c.close();
    return rejected;
  };
  check('无券递空 → 付费被拒（insufficient）', await payFails([], 'empty'));
  check('已花过的券再用 → 被拒（防双花：v5 上面已花）', await payFails([v5], 'double-spend'));
  check('伪券（非铸币厂签发）→ 验签失败被拒', await payFails([forged], 'forged'));

  // ---- 免费站点：无 price → 描述符无价、无付费墙、直连回显 ----
  const freeSvc = new HiddenService({
    seed: randomBytes(32),
    onion: generateOnionKeypair(),
    build: buildCircuit,
    dir: directory,
    handler: (channel) => channel.onData((b) => channel.send(b)),
  });
  await withTimeout(freeSvc.start(), 15000, 'free svc.start');
  const { channel: fc, price: fprice } = await withTimeout(connectHiddenService(freeSvc.address, buildCircuit, directory), 15000, 'connect free');
  check('免费站点描述符无 price（免费站点不受影响）', fprice === undefined);
  let freeEcho: string | null = null;
  let resolveFree: (() => void) | null = null;
  const freeWait = new Promise<void>((r) => (resolveFree = r));
  fc.onData((b) => {
    freeEcho = dec(b);
    resolveFree?.();
  });
  fc.send(utf8ToBytes('free-hello'));
  await withTimeout(freeWait, 8000, 'free echo');
  check('免费站点无付费墙、直接连通回显', freeEcho === 'free-hello');
  fc.close();

  // ---- 收尾 ----
  svc.stop();
  freeSvc.stop();
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
  console.error(e);
  process.exit(1);
});
