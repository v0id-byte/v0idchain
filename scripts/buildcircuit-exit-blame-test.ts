// 选路归因测试（PR #32 review 第 1 条）：建路到一个「WS 可达但实际转不动」的 exit 失败时，**不得**把无辜的
// 好 middle 判负——否则一个坏 exit 会把可达集里的好 middle 逐个剔除，最终连去好 exit 的建路也建不成。
//
// 手法：4 个真实 RelayNode（r0/r1/r2 好 + bad），先让可达缓存暖（全部 cached 可达），再 close(bad)。此时 bad 仍
// 被缓存为可达（TTL 内）→ 建路会选它当 exit、走到「middle→exit EXTEND」才失败（exit 已死，连接被拒）。
//   旧逻辑：exit EXTEND 失败即 markBad(middle)，把好 middle 误判负（usableCount 4>3 时剔一个）→ 之后去好 exit
//           的建路因好 middle 被剔/被饿死而失败。
//   新逻辑：先不怪 middle，待同一 exit 被别的 middle 走通才回头判负；bad 永远走不通 → 谁都不判负 → 好 exit 照常建成。
// 判据：close(bad) 后，连建到 3 个好 exit 必须全部成功。
// 跑：corepack pnpm exec tsx scripts/buildcircuit-exit-blame-test.ts
import { randomBytes } from 'node:crypto';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  bytesToHex,
  type RelayDescriptor,
} from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { makeHsDeps } from '../packages/node/src/relay/hsbridge.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 4 个真实中继（127.0.0.1，端口 7991-7994）。最后一个当“坏 exit”（稍后 close）。
  const ports = [7991, 7992, 7993, 7994];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const resolveMap = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => resolveMap.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  const [r0, r1, r2, bad] = nodes;
  const goodIds = [r0.id, r1.id, r2.id];
  await sleep(150);

  const descriptors: RelayDescriptor[] = nodes.map((n) => ({
    address: n.id,
    onionPubHex: bytesToHex(n.onion.pub),
    host: n.host,
    port: n.port,
    bandwidth: 'm',
    stakeTxid: '0',
  }));
  const deps = makeHsDeps(() => descriptors, undefined, { allowPrivateHosts: true });

  // 暖缓存：先建一条到好 exit 的电路（顺带把全部 4 个中继探测为可达并缓存）。
  const warm = await deps.buildCircuit(r0.id);
  warm.close();
  check('暖身：建路到好 exit 成功（系统正常）', true);

  // 杀掉坏 exit：它此刻仍被缓存为可达（TTL 内），故建路仍会选它当 exit，走到 EXTEND 才发现连不上。
  const badRelay = relays[3];
  await badRelay.close();
  await sleep(100);

  // 建路到已死的 bad exit：必然失败。关键是这一串失败**不应**把好 middle 判负。
  let badThrew = false;
  try {
    const c = await deps.buildCircuit(bad.id);
    c.close();
  } catch {
    badThrew = true;
  }
  check('建路到已死 exit 抛错（无法建成）', badThrew);

  // 现在连建到 3 个好 exit：新逻辑下好 middle 未被误剔 → 全部成功。
  // （旧逻辑会在上一步把某个好 middle markBad，导致这里有 exit 建不成。）
  let goodBuilds = 0;
  for (const id of goodIds) {
    try {
      const c = await deps.buildCircuit(id);
      c.close();
      goodBuilds++;
    } catch {
      /* 记为失败 */
    }
  }
  check('坏 exit 不冤枉好 middle：建路到 3 个好 exit 全部成功', goodBuilds === 3);

  for (const r of relays) await r.close();
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
