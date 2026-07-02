// 客户端付费墙端到端（Phase A.1，THE「curl 付费站点」判据）：真实 WebSocket、6 中继、真实 SOCKS5 前端 + 真实 HTTP 后端。
// 证明——把券钱包(--vouchers)接进 SOCKS 后，一句 `curl --socks5-hostname <本地SOCKS> <地址>.v0id` 就能**自动预付并连通**付费站点：
//   ① 有券 → 付费墙放行 → 拿到后端 HTTP 200 正文；该券**从钱包文件消费**、被服务方 acceptor 核销；
//   ② 余额不足 → SOCKS 干净拒绝(0x05)、钱包不动；
//   ③ 付款被拒（券已被别处花过）→ SOCKS 拒绝，且**券仍留在钱包**（commit-only-on-success 不变量：只有收到 PAYOK 才扣券）。
// 这里不 shell-out 真 curl（省一个外部依赖 + 更确定），而是手写 SOCKS5 CONNECT + HTTP/1.0 —— 与 curl --socks5-hostname 同一条协议路径。
// 跑：corepack pnpm exec tsx scripts/paywall-curl-e2e.ts
import { randomBytes } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { rmSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet, getPublicKey, publicKeyToAddress, generateOnionKeypair } from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient, type HopSpec } from '../packages/node/src/relay/client.js';
import { serveHiddenService, type HsDeps } from '../packages/node/src/relay/hsbridge.js';
import { VoucherAcceptor } from '../packages/node/src/relay/paywall.js';
import { SocksProxy, type HopPicker } from '../packages/node/src/relay/socks.js';
import { VoucherWallet } from '../packages/node/src/relay/voucher-wallet.js';
import { issueToken, type MintToken } from '../packages/node/src/mint/token.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const serialsIn = (file: string): Set<string> =>
  new Set((JSON.parse(readFileSync(file, 'utf8')) as MintToken[]).map((t) => t.serial));

/**
 * 手写 SOCKS5 客户端：no-auth 握手 → CONNECT <domain>:<port> → 成功则发 httpReq、收正文。
 * 返回 { rep, body }：rep=SOCKS 应答码（0x00 成功 / 0x05 被拒），body=隧道里读回的 HTTP 响应文本。
 * @param expectBody 期望正文子串：收到它才判定完成（否则**只到响应头就返回会漏掉后到 TCP 分片里的正文** → 断言偶发翻车）；未命中则等 close 兜底。
 */
function socksHttpGet(socksPort: number, domain: string, port: number, httpReq: string, expectBody?: string): Promise<{ rep: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(socksPort, '127.0.0.1');
    let stage: 'greet' | 'reply' | 'body' = 'greet';
    let buf = Buffer.alloc(0);
    let rep: number | null = null;
    let settled = false;
    const bodyChunks: Buffer[] = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ rep: rep ?? -1, body: Buffer.concat(bodyChunks).toString('utf8') });
    };
    sock.on('error', reject);
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0]))); // VER=5, 1 method, no-auth
    sock.on('data', (d) => {
      if (stage === 'body') {
        bodyChunks.push(d);
        // 等**正文**真正到齐（而非仅响应头终止符）：命中期望正文即可判定；否则靠 close 兜底（backend 用 Connection: close）。
        if (expectBody && Buffer.concat(bodyChunks).toString('utf8').includes(expectBody)) finish();
        return;
      }
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return void (sock.destroy(), reject(new Error('SOCKS 协商失败')));
        buf = buf.subarray(2);
        const dom = Buffer.from(domain, 'utf8');
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, dom.length]), dom, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
        stage = 'reply';
      }
      if (stage === 'reply') {
        if (buf.length < 10) return; // reply() 固定 10 字节
        rep = buf[1];
        buf = buf.subarray(10);
        if (rep !== 0) return void (sock.destroy(), finish()); // 被拒：不发 HTTP，直接返回
        if (buf.length) bodyChunks.push(buf); // 极少数：应答同包里已带隧道字节
        stage = 'body';
        sock.write(Buffer.from(httpReq, 'utf8'));
      }
    });
    sock.on('close', () => {
      if (rep !== null) finish();
    });
  });
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'v0id-paywall-curl-'));
  // ---- 6 中继（静态目录，端口 7811-7816）----
  const ports = [7811, 7812, 7813, 7814, 7815, 7816];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  await sleep(150);
  const allRelayIds = nodes.map((n) => n.id);
  const hopOf = (id: string): HopSpec => {
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
  const hsDeps: HsDeps = { buildCircuit, directory };
  const pickHops: HopPicker = () => {
    const s = shuffle(allRelayIds); // .v0id 走 hsDeps，不用它；仅满足 SocksProxy 构造签名
    return [hopOf(s[0]), hopOf(s[1]), hopOf(s[2])];
  };

  // ---- 真实 HTTP 后端（隐藏服务背后的落地）----
  const BACKEND_PORT = 7825;
  const backend = httpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('PAID-CONTENT-OK');
  });
  await new Promise<void>((r) => backend.listen(BACKEND_PORT, '127.0.0.1', r));

  // ---- 铸币厂 + 付费 HS（price=5，acceptor 对 mint 地址验签）----
  const mint = Wallet.generate();
  const PRICE = 5;
  const acceptor = new VoucherAcceptor(mint.address);
  const paid = await withTimeout(
    serveHiddenService({ dataDir: join(tmp, 'hs'), target: { host: '127.0.0.1', port: BACKEND_PORT }, deps: hsDeps, price: PRICE, verifier: acceptor }),
    15000,
    'serveHiddenService',
  );
  check('付费 HS 已启动', !!paid.address);
  console.log(`  · 付费站点 = ${paid.address}  价 ${PRICE} $V0ID/连接  → 后端 127.0.0.1:${BACKEND_PORT}`);
  const HTTP_REQ = `GET / HTTP/1.0\r\nHost: ${paid.address}\r\nConnection: close\r\n\r\n`;

  // ================= ① 有券 → 付费访问成功 + 券被消费 =================
  const vGood = issueToken(PRICE, mint.privateKey);
  const goodFile = join(tmp, 'wallet-good.json');
  writeFileSync(goodFile, JSON.stringify([vGood], null, 2), { mode: 0o600 });
  const socksGood = new SocksProxy(pickHops, 7820, '127.0.0.1', hsDeps, undefined, undefined, undefined, undefined, new VoucherWallet(goodFile, mint.address).source());
  await sleep(50);
  const r1 = await withTimeout(socksHttpGet(7820, paid.address, 80, HTTP_REQ, 'PAID-CONTENT-OK'), 25000, 'curl 付费站点');
  check('① 付费墙放行 → SOCKS 成功(0x00)', r1.rep === 0x00);
  check('① 拿到后端 HTTP 200 正文（PAID-CONTENT-OK）', r1.body.includes('200') && r1.body.includes('PAID-CONTENT-OK'));
  check('① 服务方 acceptor 已核销该券序列号', acceptor.spentSerials.has(vGood.serial));
  await sleep(100); // 等 commit 落盘（放行后异步 await sel.commit()）
  check('① 券已从钱包文件消费（钱包清空）', serialsIn(goodFile).size === 0 && !serialsIn(goodFile).has(vGood.serial));

  // ================= ② 余额不足 → 干净拒绝，钱包不动 =================
  const emptyFile = join(tmp, 'wallet-empty.json');
  writeFileSync(emptyFile, JSON.stringify([], null, 2), { mode: 0o600 });
  const socksEmpty = new SocksProxy(pickHops, 7821, '127.0.0.1', hsDeps, undefined, undefined, undefined, undefined, new VoucherWallet(emptyFile, mint.address).source());
  await sleep(50);
  const r2 = await withTimeout(socksHttpGet(7821, paid.address, 80, HTTP_REQ), 25000, 'curl 空钱包');
  check('② 余额不足 → SOCKS 拒绝(0x05)', r2.rep === 0x05);
  check('② 未拿到后端正文', !r2.body.includes('PAID-CONTENT-OK'));
  check('② 空钱包文件保持不变', serialsIn(emptyFile).size === 0);

  // ================= ③ 付款被拒（券已被别处花过）→ 券仍留在钱包（commit-only-on-success）=================
  const vDud = issueToken(PRICE, mint.privateKey);
  for (const s of [vDud.serial]) acceptor.spentSerials.add(s); // 预先把它标记已花 → 服务方会回 PAYERR(spent)
  const dudFile = join(tmp, 'wallet-dud.json');
  writeFileSync(dudFile, JSON.stringify([vDud], null, 2), { mode: 0o600 });
  const socksDud = new SocksProxy(pickHops, 7822, '127.0.0.1', hsDeps, undefined, undefined, undefined, undefined, new VoucherWallet(dudFile, mint.address).source());
  await sleep(50);
  const r3 = await withTimeout(socksHttpGet(7822, paid.address, 80, HTTP_REQ), 25000, 'curl 已花券');
  check('③ 付款被拒 → SOCKS 拒绝(0x05)', r3.rep === 0x05);
  await sleep(100);
  check('③ 关键不变量：付款失败 → 券仍留在钱包（未 commit）', serialsIn(dudFile).has(vDud.serial));

  // ================= ④ 并发预留（P1 回归：并发连接不重复选同一张券）=================
  const oneFile = join(tmp, 'wallet-one.json');
  writeFileSync(oneFile, JSON.stringify([issueToken(PRICE, mint.privateKey)], null, 2), { mode: 0o600 });
  const w = new VoucherWallet(oneFile, mint.address);
  const [a, b] = await Promise.allSettled([w.select(PRICE), w.select(PRICE)]); // 仅一张券、两个并发 select
  check('④ 并发下仅一次 select 成功（另一因该券已被预留而余额不足）', (a.status === 'fulfilled') !== (b.status === 'fulfilled'));
  const okSel = a.status === 'fulfilled' ? a.value : b.status === 'fulfilled' ? b.value : null;
  check('④ 成功的一方拿到那张券', okSel?.vouchers.length === 1);
  await okSel?.rollback(); // 释放预留（未付款）
  const again = await w.select(PRICE);
  check('④ rollback 释放预留后该券可再被选（未落盘删除）', again.vouchers.length === 1);
  await again.rollback();

  // ---- 收尾 ----
  socksGood.close();
  socksEmpty.close();
  socksDud.close();
  paid.stop();
  backend.close();
  for (const r of relays) void r.close();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
