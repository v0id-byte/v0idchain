// v0id 浏览器「本地 demo 网络」—— 保持运行，给 GUI 手动验证用。
//
// 它在本机进程内拉起一整套 .v0id 隐藏服务网络（无真链、不挖矿、纯内存），
// 然后挂在那里不退，这样 Electron 浏览器（V0ID_SOCKS_EXTERNAL=9050 pnpm start）
// 就能把 webview 代理指到这里的 SOCKS5（:9050），输入打印出来的 xxx.v0id 地址访问到它。
//
// 与 scripts/browser-core-test.mjs 同形（6 个进程内 RelayNode + 静态目录 + serveHiddenService
// 桥到本机 HTTP + SocksProxy），区别只有两点：
//   1) 不跑 curl 断言、不 process.exit——起好后常驻，直到 Ctrl-C。
//   2) HTTP 服务返回一段友好的中文 HTML（而非测试用纯文本），并把每次进来的请求打到日志
//      （这是「请求真的经 rendezvous 到达」的可观察证据——该 HTTP 服务只有会合桥接才连得到）。
//
// 为什么用进程内静态中继而不是真链：真链有 checkpoint / 高度门槛，本地起一条够 3 中继的链很费事；
// 而隐藏服务用到的只是「目录快照 + 能 buildCircuit 的中继」，进程内 6 个就够，且零额外依赖。
//
// 跑（在 worktree 根目录）：corepack pnpm exec tsx clients/desktop/scripts/demo-network.mjs
//   端口可改：V0ID_SOCKS_PORT=9051 corepack pnpm exec tsx …（记得浏览器侧 V0ID_SOCKS_EXTERNAL 同步改）
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  bytesToHex,
  hexToBytes,
} from '../../../packages/core/src/index.js';
import { RelayNode } from '../../../packages/node/src/relay/relaynode.js';
import { SocksProxy } from '../../../packages/node/src/relay/socks.js';
import { makeHsDeps, serveHiddenService } from '../../../packages/node/src/relay/hsbridge.js';

const SOCKS_PORT = Number(process.env.V0ID_SOCKS_PORT || 9050);
const HTTP_PORT = 8799; // 隐藏服务背后的本机 HTTP 落地（仅经 rendezvous 桥接可达，外部访问不到）
const RELAY_PORTS = [7991, 7992, 7993, 7994, 7995, 7996]; // 6 个进程内中继的回环端口

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19); // HH:MM:SS，日志好读
const log = (s) => console.log(`${ts()}  ${s}`);

// 浏览器里会渲染出的那一页（合法最小 HTML，content-type text/html）。
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>.v0id 隐藏服务</title></head>
<body style="font-family:system-ui;background:#0a0a0f;color:#e8e8f0;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.6">
<h1>✅ 你正在浏览一个 .v0id 隐藏服务</h1>
<p>这页面通过 rendezvous 经 3 跳洋葱电路送达——浏览器只知道这个 .v0id 地址，不知道服务在哪台机器。</p>
</body></html>
`;

async function main() {
  // ---- 隐藏服务背后的真实 HTTP 服务（每个进来的会合通道最终落到这里）----
  // 每次收到请求就打日志——这是「请求确实经 rendezvous 到达」的硬证据（此服务不暴露给外部，只有桥接连得到）。
  const http = createServer((req, res) => {
    log(`[hs] 收到请求 ${req.method} ${req.url}  ← 一次 rendezvous 会合已送达此本机落地`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => http.listen(HTTP_PORT, '127.0.0.1', () => r()));
  log(`本机 HTTP 落地已起 127.0.0.1:${HTTP_PORT}（隐藏服务背后的真实服务）`);

  // ---- 6 个进程内中继（静态目录，无真链、无挖矿）----
  const nodes = RELAY_PORTS.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const resolveMap = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve = (id) => resolveMap.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  await sleep(150);
  log(`已起 ${relays.length} 个进程内中继（端口 ${RELAY_PORTS[0]}-${RELAY_PORTS[RELAY_PORTS.length - 1]}，静态目录）`);

  // 链上目录快照（= node.relays() 的形状）。makeHsDeps 据此造 buildCircuit + directory。
  const descriptors = nodes.map((n) => ({
    address: n.id,
    onionPubHex: bytesToHex(n.onion.pub),
    host: n.host,
    port: n.port,
    bandwidth: 'm',
    stakeTxid: '0',
  }));
  // 本机自测：中继全在 127.0.0.1 → 放行私网 host 探测（生产默认 false 会拒探私网，见 RelayReachability 的 SSRF 守卫）。
  const deps = makeHsDeps(() => descriptors, undefined, { allowPrivateHosts: true });

  // ---- 托管隐藏服务：进来的会合连接 → 桥到本机 HTTP 服务 ----
  // onError 是单个落地连接出错的可观察回调（默认会被吞），这里打到日志方便排错。
  const dataDir = mkdtempSync(join(tmpdir(), 'v0id-demo-net-'));
  const { address, stop } = await serveHiddenService({
    dataDir,
    target: { host: '127.0.0.1', port: HTTP_PORT },
    deps,
    numIntros: 3,
    onError: (e) => log(`[hs] 落地连接出错：${e?.message ?? e}`),
  });
  log(`隐藏服务已托管（引入点 + 描述符已发布到进程内 DHT）`);

  // ---- 本地 SOCKS5 前端（注入 HS deps → .v0id 走 rendezvous）——这就是浏览器要连的那个代理 ----
  const pickHops = () => {
    const pool = [...descriptors];
    const chosen = [];
    for (let i = 0; i < 3; i++) chosen.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return chosen.map((d) => ({ id: d.address, onionPub: hexToBytes(d.onionPubHex), host: d.host, port: d.port }));
  };
  const socks = new SocksProxy(pickHops, SOCKS_PORT, '127.0.0.1', deps);
  await sleep(200);
  log(`SOCKS5 代理已起 127.0.0.1:${SOCKS_PORT}（带 HS deps：.v0id 经 rendezvous）`);

  // ---- 就绪横幅 ----
  const bar = '─'.repeat(64);
  console.log(`\n${bar}`);
  console.log(`  v0id demo 网络就绪，保持本终端运行`);
  console.log(bar);
  console.log(`  要在浏览器里访问的地址：  http://${address}/`);
  console.log(`  .v0id 地址：              ${address}`);
  console.log(`  SOCKS5 端口：             ${SOCKS_PORT}`);
  console.log(bar);
  console.log(`  下一步（另开一个终端）：`);
  console.log(`    cd clients/desktop && pnpm install --ignore-workspace   # 首次装 electron`);
  console.log(`    V0ID_SOCKS_EXTERNAL=${SOCKS_PORT} pnpm start`);
  console.log(`  然后在地址栏粘贴上面的 .v0id 地址回车。`);
  console.log(`  （收到访问时，本终端会打印 “[hs] 收到请求 …” = 请求真的经 rendezvous 到了。）`);
  console.log(`  Ctrl-C 退出并清理。`);
  console.log(`${bar}\n`);

  // ---- 干净收尾（Ctrl-C）----
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log('收到退出信号，正在关闭…');
    try { stop(); } catch { /* 忽略 */ }
    try { socks.close(); } catch { /* 忽略 */ }
    for (const r of relays) { try { void r.close(); } catch { /* 忽略 */ } }
    try { http.close(); } catch { /* 忽略 */ }
    log('已清理，退出。');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // 不 process.exit：事件循环被中继的 WS server + HTTP server + SOCKS server 撑住，进程常驻。
}

main().catch((e) => {
  console.error('demo 网络启动失败:', e);
  process.exit(1);
});
