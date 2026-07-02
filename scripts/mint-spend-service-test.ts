// 铸币厂在线核销服务端到端（Phase A.2，THE「第三方匿名在线核销」判据）：真实 WebSocket、6 中继、铸币厂作 .v0id 隐藏服务。
// 证明——第三方付费站点仅凭铸币厂 `.v0id` 地址、经洋葱电路匿名把访客券提交核销（铸币厂不知站点 IP）：
//   ① 有效券 → ok + owed 记账；② **同一张券给第二个站点核销 → 被拒(spent) = 跨服务方双花在真网络上归零**（A.2 核心）；
//   ③ 伪券 → invalid；④ 连未发布的铸币厂地址 → 干净失败。放行只多一次链下洋葱往返，不碰链。
// 跑：corepack pnpm exec tsx scripts/mint-spend-service-test.ts
import { randomBytes } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet, getPublicKey, publicKeyToAddress, generateOnionKeypair, encodeV0idAddress } from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient, type HopSpec } from '../packages/node/src/relay/client.js';
import type { HsDeps } from '../packages/node/src/relay/hsbridge.js';
import { MintDaemon } from '../packages/node/src/mint/mintd.js';
import { issueToken } from '../packages/node/src/mint/token.js';
import { serveMintSpendService, spendViaMint } from '../packages/node/src/mint/spend-service.js';

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

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'v0id-spend-svc-'));
  // ---- 6 中继（静态目录，端口 7831-7836）----
  const ports = [7831, 7832, 7833, 7834, 7835, 7836];
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

  // ---- 铸币厂守护 + 在线核销服务（作 .v0id 隐藏服务）----
  const mint = Wallet.generate();
  const d = new MintDaemon({ dataDir: join(tmp, 'mintd'), mintWallet: mint });
  const svc = await withTimeout(serveMintSpendService({ daemon: d, deps: hsDeps }), 15000, 'serveMintSpendService');
  check('铸币厂在线核销服务已作 .v0id 隐藏服务启动', !!svc.address);
  console.log(`  · 铸币厂核销地址 = ${svc.address}`);

  const A = Wallet.generate().address; // 第三方站点 A
  const B = Wallet.generate().address; // 第三方站点 B
  const v5 = issueToken(5, mint.privateKey);

  // ---- ① 站点 A 匿名在线核销 v5 ----
  const r1 = await withTimeout(spendViaMint(svc.address, hsDeps, [v5], A), 20000, 'A spend');
  check('① 站点 A 经洋葱核销有效券 → ok，gross=5', r1.ok && r1.gross === 5);
  check('① owed[A] = 5（铸币厂已记账，待日后 settle）', d.owedTo(A) === 5);

  // ---- ② 核心：同一张券给站点 B → 被全局已花集拒（跨服务方双花在真网络归零）----
  const r2 = await withTimeout(spendViaMint(svc.address, hsDeps, [v5], B), 20000, 'B spend');
  check('② 同券给站点 B 核销 → 被拒(spent) = 跨服务方双花归零', !r2.ok && r2.code === 'spent');
  check('② owed[B] 仍为 0（B 未白服务）', d.owedTo(B) === 0);

  // ---- ③ 伪券（别的钱包签）→ invalid ----
  const forged = issueToken(5, Wallet.generate().privateKey);
  const r3 = await withTimeout(spendViaMint(svc.address, hsDeps, [forged], A), 20000, 'forged spend');
  check('③ 伪券核销 → 被拒(invalid)', !r3.ok && r3.code === 'invalid');

  // ---- 另一张有效券给 A，owed 累加 ----
  const v3 = issueToken(3, mint.privateKey);
  const r4 = await withTimeout(spendViaMint(svc.address, hsDeps, [v3], A), 20000, 'A spend v3');
  check('站点 A 再核销 v3 → ok', r4.ok && r4.gross === 3);
  check('owed[A] 累加 = 8', d.owedTo(A) === 8);
  check('服务端成功核销计数 = 2（仅两次有效，双花/伪券不计）', svc.getSpendCount() === 2);

  // ---- ④ 连未发布的随机铸币厂地址 → 干净失败 ----
  const randomAddr = encodeV0idAddress(getPublicKey(randomBytes(32)));
  let failedCleanly = false;
  try {
    await withTimeout(spendViaMint(randomAddr, hsDeps, [issueToken(1, mint.privateKey)], A), 12000, 'connect unpublished');
  } catch {
    failedCleanly = true;
  }
  check('④ 连未发布的铸币厂地址 → 干净抛错（不挂起）', failedCleanly);

  // ---- 收尾 ----
  svc.stop();
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
