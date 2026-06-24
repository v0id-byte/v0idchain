// TCP 流经 3 跳洋葱电路（真实 WebSocket + 真实 TCP）。证明“出口 CONNECT + 双向字节流”可用。
// 跑：corepack pnpm exec tsx scripts/relay-stream-test.ts
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { getPublicKey, publicKeyToAddress, generateOnionKeypair, utf8ToBytes } from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
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
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);

async function main() {
  // 本地 TCP echo 服务（= 出口要连的“目标”）
  const ECHO_PORT = 7799;
  const echo = createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise<void>((r) => echo.listen(ECHO_PORT, '127.0.0.1', () => r()));

  // 3 中继
  const ports = [7741, 7742, 7743];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  // 出口策略：只允许连本地 echo 服务（默认 deny-all，这里显式放行）
  relays[2].setExitPolicy((host, port) => host === '127.0.0.1' && port === ECHO_PORT);
  await new Promise((r) => setTimeout(r, 150));

  const hops: HopSpec[] = nodes.map((n) => ({ id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port }));

  // 建路 + 开流
  const client = new CircuitClient();
  await withTimeout(client.connect(hops[0]), 5000, 'connect');
  await withTimeout(client.extend(hops[1]), 5000, 'extend1');
  await withTimeout(client.extend(hops[2]), 5000, 'extend2');
  let recv: number[] = [];
  let expected = 0;
  let resolveRecv: (() => void) | null = null;
  client.onData((b) => {
    for (const v of b) recv.push(v);
    if (resolveRecv && recv.length >= expected) resolveRecv();
  });
  const connected = await withTimeout(client.beginStream('127.0.0.1', ECHO_PORT), 5000, 'beginStream');
  check('出口 CONNECT 到 echo 成功', connected === true);

  // 小数据回显
  const msg = utf8ToBytes('hello stream over a 3-hop onion circuit');
  recv = [];
  expected = msg.length;
  const w1 = new Promise<void>((r) => (resolveRecv = r));
  client.write(msg);
  await withTimeout(w1, 5000, 'echo small');
  check('小数据经电路回显正确', dec(Uint8Array.from(recv)) === dec(msg));

  // 大数据（2000B → 多 cell 分片 + 出口侧重分片）
  const big = new Uint8Array(2000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  recv = [];
  expected = big.length;
  const w2 = new Promise<void>((r) => (resolveRecv = r));
  client.write(big);
  await withTimeout(w2, 5000, 'echo large');
  check('大数据(2000B 多片)回显完整且有序', recv.length === big.length && recv.every((v, i) => v === big[i]));

  // 出口策略：拒绝未授权目标
  const c2 = new CircuitClient();
  await withTimeout(c2.connect(hops[0]), 5000, 'c2 connect');
  await withTimeout(c2.extend(hops[1]), 5000, 'c2 extend1');
  await withTimeout(c2.extend(hops[2]), 5000, 'c2 extend2');
  const denied = await withTimeout(c2.beginStream('127.0.0.1', 9999), 5000, 'denied');
  check('出口策略拒绝未授权目标(返回未连通)', denied === false);

  client.endStream();
  client.close();
  c2.close();
  for (const r of relays) void r.close(); // 不 await：出口 TCP/出站连接交给 process.exit 收尾，避免 echo.close 等待挂起
  echo.close();
  // 经 pipe 输出会块缓冲，process.exit 可能截断 → 显式 flush 末行再退出。
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
