// .v0id 隐藏服务 ↔ SOCKS5 端到端（Phase 2B-d 的成功判据）：真实 curl --socks5-hostname → 本地 SOCKS5 →
// rendezvous → 一个本机托管的隐藏服务背后的真实 HTTP 服务。证明“普通 curl 一条 .v0id 地址就能打到隐藏服务”。
// 与 socks-demo-test 同形，但目标是 .v0id 地址（curl 用 --socks5-hostname 把主机名透传为 ATYP=domain，不本地 DNS）。
// 跑：corepack pnpm exec tsx scripts/hs-socks-test.ts
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  encodeV0idAddress,
  bytesToHex,
  hexToBytes,
  type RelayDescriptor,
} from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { SocksProxy } from '../packages/node/src/relay/socks.js';
import { makeHsDeps, serveHiddenService } from '../packages/node/src/relay/hsbridge.js';

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
// 经 SOCKS5 跑一条真实 curl，取回 body（失败/超时 → 空串）。.v0id 必须用 --socks5-hostname（主机名透传，不本地 DNS）。
const curlViaSocks = (socksPort: number, url: string) =>
  withTimeout(
    new Promise<string>((res) =>
      exec(`curl -s --max-time 20 --socks5-hostname 127.0.0.1:${socksPort} ${url}`, (_e, so) => res(so || '')),
    ),
    25000,
    'curl',
  );

async function main() {
  const HTTP_PORT = 7898;
  const SOCKS_PORT = 7895;
  const BODY = 'Hello from a .v0id hidden service\n';

  // ---- 隐藏服务背后的真实 HTTP 服务 ----
  let sawRequest = false;
  const http = createServer((_req, res) => {
    sawRequest = true;
    res.end(BODY);
  });
  await new Promise<void>((r) => http.listen(HTTP_PORT, '127.0.0.1', () => r()));

  // ---- 6 个中继（静态目录，端口 7881-7886），造 RelayDescriptor[] 喂 makeHsDeps ----
  const ports = [7881, 7882, 7883, 7884, 7885, 7886];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const resolveMap = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => resolveMap.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  await sleep(150);

  // 链上目录快照（这正是 node.relays() 的形状）。makeHsDeps 据此造 buildCircuit + directory。
  const descriptors: RelayDescriptor[] = nodes.map((n) => ({
    address: n.id,
    onionPubHex: bytesToHex(n.onion.pub),
    host: n.host,
    port: n.port,
    bandwidth: 'm',
    stakeTxid: '0',
  }));
  const deps = makeHsDeps(() => descriptors);

  // ---- 托管隐藏服务：进来的会合连接 → 转发到本机 HTTP 服务 ----
  const dataDir = mkdtempSync(join(tmpdir(), 'v0id-hs-'));
  const { address, stop } = await withTimeout(
    serveHiddenService({ dataDir, target: { host: '127.0.0.1', port: HTTP_PORT }, deps, numIntros: 3 }),
    20000,
    'serveHiddenService',
  );
  check('隐藏服务已托管（引入点 + 描述符发布成功）', typeof address === 'string' && address.endsWith('.v0id'));
  console.log(`  · 隐藏服务地址 = ${address}`);

  // ---- 本地 SOCKS5 前端（带 HS deps，故 .v0id 走 rendezvous）----
  // pickHops 仅用于普通出口路径；本测不走它，但 SocksProxy 构造需要——给个合法 3 跳即可。
  const pickHops = () => {
    const pool = [...descriptors];
    const chosen = [] as RelayDescriptor[];
    for (let i = 0; i < 3; i++) chosen.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return chosen.map((d) => ({ id: d.address, onionPub: hexToBytes(d.onionPubHex), host: d.host, port: d.port }));
  };
  const socks = new SocksProxy(pickHops, SOCKS_PORT, '127.0.0.1', deps);
  await sleep(200);

  // ---- 正例：真实 curl 经 SOCKS5 + rendezvous 取回隐藏服务的 HTTP body ----
  const out = await curlViaSocks(SOCKS_PORT, `http://${address}/`);
  check('curl --socks5-hostname 经 rendezvous 取回隐藏服务 HTTP body', out === BODY);
  check('隐藏服务背后的 HTTP 服务确实被访问到', sawRequest === true);

  // ---- 负例：连一个合法格式但未发布的随机 .v0id → curl 干净失败（SOCKS 回拒，不挂起）----
  const randomAddr = encodeV0idAddress(getPublicKey(randomBytes(32)));
  const t0 = Date.now();
  const neg = await curlViaSocks(SOCKS_PORT, `http://${randomAddr}/`);
  const negMs = Date.now() - t0;
  check('连未发布的随机 .v0id → curl 得空（SOCKS 失败，非挂起）', neg === '');
  check('负例在超时上限内返回（未卡死整 20s）', negMs < 19000);

  // ---- 收尾 ----
  stop();
  socks.close();
  for (const r of relays) void r.close();
  http.close();
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () =>
    process.exit(failures === 0 ? 0 : 1),
  );
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
