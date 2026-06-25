// v0id 浏览器“核心能力”无头验证（GUI 在无显示环境跑不了，这才是真正的成功判据）。
//
// 它证明 Electron webview 将要走的那条完整路径——SOCKS5 → rendezvous → 隐藏服务——独立于 GUI 成立：
//   起 6 个进程内 RelayNode → serveHiddenService 把会合连接桥到一个本机小 HTTP 服务 → 起 SocksProxy（带 HS deps）
//   → 真实 `curl --socks5-hostname 127.0.0.1:<port> http://<addr>.v0id/`（主机名透传=远程 DNS，正是 webview 用 socks5:// 的等价行为）
//   → 断言取回隐藏服务的 body。
// 这本质上与 scripts/hs-socks-test.ts 同形——这是对的，因为它就是浏览器的核心能力。
//
// 跑：cd clients/desktop && corepack pnpm exec tsx scripts/browser-core-test.mjs
//   （用仓库工具链的 tsx 直接执行 TS 源；本文件从 clients/desktop/scripts 上溯三级 import 仓库的 packages/*。）
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
} from '../../../packages/core/src/index.js';
import { RelayNode } from '../../../packages/node/src/relay/relaynode.js';
import { SocksProxy } from '../../../packages/node/src/relay/socks.js';
import { makeHsDeps, serveHiddenService } from '../../../packages/node/src/relay/hsbridge.js';

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);
// 经 SOCKS5 跑一条真实 curl，取回 body（失败/超时 → 空串）。.v0id 用 --socks5-hostname（主机名透传，不本地 DNS）。
// 这正是 Electron 用 proxyRules:'socks5://…' 让 Chromium 做远程 DNS 的命令行等价物。
const curlViaSocks = (socksPort, url) =>
  withTimeout(
    new Promise((res) =>
      exec(`curl -s --max-time 20 --socks5-hostname 127.0.0.1:${socksPort} ${url}`, (_e, so) => res(so || '')),
    ),
    25000,
    'curl',
  );

async function main() {
  const HTTP_PORT = 7998;
  const SOCKS_PORT = 7995;
  const BODY = 'Hello from a .v0id hidden service (browser-core)\n';

  // ---- 隐藏服务背后的真实 HTTP 服务 ----
  let sawRequest = false;
  const http = createServer((_req, res) => {
    sawRequest = true;
    res.end(BODY);
  });
  await new Promise((r) => http.listen(HTTP_PORT, '127.0.0.1', () => r()));

  // ---- 6 个中继（静态目录，端口 7981-7986）----
  const ports = [7981, 7982, 7983, 7984, 7985, 7986];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const resolveMap = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve = (id) => resolveMap.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  await sleep(150);

  // 链上目录快照（node.relays() 的形状）。makeHsDeps 据此造 buildCircuit + directory。
  const descriptors = nodes.map((n) => ({
    address: n.id,
    onionPubHex: bytesToHex(n.onion.pub),
    host: n.host,
    port: n.port,
    bandwidth: 'm',
    stakeTxid: '0',
  }));
  const deps = makeHsDeps(() => descriptors);

  // ---- 托管隐藏服务：进来的会合连接 → 转发到本机 HTTP 服务 ----
  const dataDir = mkdtempSync(join(tmpdir(), 'v0id-browser-core-'));
  const { address, stop } = await withTimeout(
    serveHiddenService({ dataDir, target: { host: '127.0.0.1', port: HTTP_PORT }, deps, numIntros: 3 }),
    20000,
    'serveHiddenService',
  );
  check('隐藏服务已托管（引入点 + 描述符发布成功）', typeof address === 'string' && address.endsWith('.v0id'));
  console.log(`  · 隐藏服务地址 = ${address}`);

  // ---- 本地 SOCKS5 前端（带 HS deps，故 .v0id 走 rendezvous）——这就是守护进程给 webview 用的那个 ----
  const pickHops = () => {
    const pool = [...descriptors];
    const chosen = [];
    for (let i = 0; i < 3; i++) chosen.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return chosen.map((d) => ({ id: d.address, onionPub: hexToBytes(d.onionPubHex), host: d.host, port: d.port }));
  };
  const socks = new SocksProxy(pickHops, SOCKS_PORT, '127.0.0.1', deps);
  await sleep(200);

  // ---- 正例：真实 curl 经 SOCKS5 + rendezvous 取回隐藏服务 HTTP body（= webview 将走的路径）----
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
