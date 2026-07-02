// 第三方在线核销付费站点端到端（Phase A.2 Slice 2b，THE 判据）：真实 WebSocket、6 中继、铸币厂作 .v0id 核销服务。
// 证明——付费站点用**在线核销** VoucherVerifier(≠operator==mint 的本地受理)：放行前把访客券经洋葱提交给铸币厂核销：
//   ① curl 全链:客户端券钱包→SOCKS→付费站点→**站点在线核销**→HTTP 200;铸币厂记 owed[站点收款地址]。
//   ② 第二个第三方站点(不同收款地址)独立收款;③ **同一张券给两个站点→第二个被铸币厂拒(spent)=跨服务方双花归零**;
//   ④ 面额不足 / ⑤ 伪券 → 站点**本地预检**即拒(不劳铸币厂、不烧券:核销计数不变)。
// 跑：corepack pnpm exec tsx scripts/paywall-online-e2e.ts
import { randomBytes } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet, getPublicKey, publicKeyToAddress, generateOnionKeypair } from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient, type HopSpec } from '../packages/node/src/relay/client.js';
import { serveHiddenService, type HsDeps } from '../packages/node/src/relay/hsbridge.js';
import { connectHiddenService } from '../packages/node/src/relay/hsclient.js';
import { runPaywallClient } from '../packages/node/src/relay/paywall.js';
import { SocksProxy, type HopPicker } from '../packages/node/src/relay/socks.js';
import { VoucherWallet } from '../packages/node/src/relay/voucher-wallet.js';
import { MintDaemon } from '../packages/node/src/mint/mintd.js';
import { issueToken, type MintToken } from '../packages/node/src/mint/token.js';
import { serveMintSpendService, makeOnlineVerifier } from '../packages/node/src/mint/spend-service.js';

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
/** 付款失败(PAYERR)→返回 code；成功→'ok'。 */
async function payVerdict(addr: string, deps: HsDeps, vouchers: MintToken[]): Promise<string> {
  const { channel } = await withTimeout(connectHiddenService(addr, deps.buildCircuit, deps.directory), 20000, 'connect ' + addr.slice(0, 8));
  try {
    await withTimeout(runPaywallClient(channel, vouchers), 20000, 'pay'); // 站点在线核销=站点再连铸币厂,故给足时间
    return 'ok';
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const hit = m.match(/付费被拒\((\w+)/);
    return hit ? hit[1] : 'err';
  } finally {
    channel.close();
  }
}
/** 手写 SOCKS5 CONNECT + HTTP/1.0 GET，等期望正文到齐。返回 { rep, body }。 */
function socksHttpGet(port: number, domain: string, httpReq: string, expect: string): Promise<{ rep: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1');
    let stage: 'greet' | 'reply' | 'body' = 'greet';
    let buf = Buffer.alloc(0);
    let rep: number | null = null;
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ rep: rep ?? -1, body: Buffer.concat(chunks).toString('utf8') });
    };
    sock.on('error', reject);
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
    sock.on('data', (d) => {
      if (stage === 'body') {
        chunks.push(d);
        if (Buffer.concat(chunks).toString('utf8').includes(expect)) finish();
        return;
      }
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return void (sock.destroy(), reject(new Error('SOCKS 协商失败')));
        buf = buf.subarray(2);
        const dom = Buffer.from(domain, 'utf8');
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, dom.length]), dom, Buffer.from([0, 80])]));
        stage = 'reply';
      }
      if (stage === 'reply') {
        if (buf.length < 10) return;
        rep = buf[1];
        buf = buf.subarray(10);
        if (rep !== 0) return void (sock.destroy(), finish());
        if (buf.length) chunks.push(buf);
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
  const tmp = mkdtempSync(join(tmpdir(), 'v0id-paywall-online-'));
  // ---- 6 中继（端口 7851-7856）----
  const ports = [7851, 7852, 7853, 7854, 7855, 7856];
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
  const hsDeps: HsDeps = { buildCircuit, directory: () => allRelayIds };
  const pickHops: HopPicker = () => {
    const s = shuffle(allRelayIds);
    return [hopOf(s[0]), hopOf(s[1]), hopOf(s[2])];
  };

  // ---- HTTP 后端（两个站点共用一个落地）----
  const BACKEND = 7857;
  const backend = httpServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('PAID-CONTENT-OK');
  });
  await new Promise<void>((r) => backend.listen(BACKEND, '127.0.0.1', r));

  // ---- 铸币厂 + 在线核销服务（.v0id）----
  const mint = Wallet.generate();
  const d = new MintDaemon({ dataDir: join(tmp, 'mintd'), mintWallet: mint });
  const mintSvc = await withTimeout(serveMintSpendService({ daemon: d, deps: hsDeps }), 15000, 'serveMintSpendService');
  console.log(`  · 铸币厂核销服务 = ${mintSvc.address}`);

  const PRICE = 5;
  const P1 = Wallet.generate().address; // 第三方站点1 收款地址
  const P2 = Wallet.generate().address; // 第三方站点2 收款地址
  // 两个第三方付费站点：都用**在线核销** verifier（验签对 mint.address；核销走 mintSvc.address）
  const site1 = await withTimeout(
    serveHiddenService({ dataDir: join(tmp, 'site1'), target: { host: '127.0.0.1', port: BACKEND }, deps: hsDeps, price: PRICE, verifier: makeOnlineVerifier(mintSvc.address, hsDeps, P1, mint.address) }),
    15000,
    'site1',
  );
  const site2 = await withTimeout(
    serveHiddenService({ dataDir: join(tmp, 'site2'), target: { host: '127.0.0.1', port: BACKEND }, deps: hsDeps, price: PRICE, verifier: makeOnlineVerifier(mintSvc.address, hsDeps, P2, mint.address) }),
    15000,
    'site2',
  );
  check('两个第三方在线付费站点已启动', !!site1.address && !!site2.address);
  console.log(`  · 站点1 = ${site1.address}  站点2 = ${site2.address}  价 ${PRICE}`);

  // ================= ① curl 全链：券钱包 → SOCKS → 站点1(在线核销) → HTTP 200 =================
  const v1 = issueToken(PRICE, mint.privateKey);
  const walletFile = join(tmp, 'wallet.json');
  writeFileSync(walletFile, JSON.stringify([v1], null, 2), { mode: 0o600 });
  const socks = new SocksProxy(pickHops, 7858, '127.0.0.1', hsDeps, undefined, undefined, undefined, undefined, new VoucherWallet(walletFile, mint.address).source());
  await sleep(50);
  const httpReq = `GET / HTTP/1.0\r\nHost: ${site1.address}\r\nConnection: close\r\n\r\n`;
  const r1 = await withTimeout(socksHttpGet(7858, site1.address, httpReq, 'PAID-CONTENT-OK'), 25000, 'curl online site');
  check('① curl 经在线核销付费站点 → SOCKS 成功(0x00)', r1.rep === 0x00);
  check('① 拿到后端 HTTP 200 正文（在线核销放行）', r1.body.includes('200') && r1.body.includes('PAID-CONTENT-OK'));
  check('① 铸币厂记 owed[站点1] = 5（站点经核销得记账，日后 settle 得款）', d.owedTo(P1) === PRICE);
  check('① 铸币厂成功核销计数 = 1', mintSvc.getSpendCount() === 1);

  // ================= ② 第二个第三方站点独立收款 =================
  const v2 = issueToken(PRICE, mint.privateKey);
  check('② 站点2 在线核销 v2 → 放行', (await payVerdict(site2.address, hsDeps, [v2])) === 'ok');
  check('② 铸币厂记 owed[站点2] = 5', d.owedTo(P2) === PRICE);
  check('② 核销计数 = 2', mintSvc.getSpendCount() === 2);

  // ================= ③ 跨服务方双花：同一张 v2 再给站点1 → 被铸币厂拒(spent) =================
  check('③ 同券 v2 给站点1 → 被拒(spent) = 跨服务方双花在真网络归零', (await payVerdict(site1.address, hsDeps, [v2])) === 'spent');
  check('③ owed[站点1] 未变（仍 5，未因双花多记）', d.owedTo(P1) === PRICE);
  check('③ 核销计数未增（铸币厂拒绝，不记账）', mintSvc.getSpendCount() === 2);

  // ================= ④ 面额不足 → 站点本地预检即拒（不劳铸币厂、不烧券）=================
  const vSmall = issueToken(3, mint.privateKey); // 3 < 5
  check('④ 面额不足 → 被拒(insufficient)', (await payVerdict(site1.address, hsDeps, [vSmall])) === 'insufficient');
  check('④ 核销计数未增（本地预检拦下，不发起洋葱核销 → 不烧券）', mintSvc.getSpendCount() === 2);

  // ================= ⑤ 伪券 → 站点本地预检即拒 =================
  const forged = issueToken(PRICE, Wallet.generate().privateKey);
  check('⑤ 伪券 → 被拒(invalid)', (await payVerdict(site1.address, hsDeps, [forged])) === 'invalid');
  check('⑤ 核销计数未增（验签本地即挂，不劳铸币厂）', mintSvc.getSpendCount() === 2);

  // ---- 收尾 ----
  socks.close();
  site1.stop();
  site2.stop();
  mintSvc.stop();
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
