// 入口守卫（GuardManager，Phase 2A-1）自测：钉住第一跳、持久化、缓慢轮换、排除/下线剪枝、self 排除，
// 以及**真实电路**层面验证“所有电路复用同一守卫作 hop0”。镜像既有 selftest 风格（check + process.exit）。
// 跑：corepack pnpm exec tsx scripts/guards-test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getPublicKey, publicKeyToAddress, generateOnionKeypair, type RelayDescriptor } from '../packages/core/src/index.js';
import { GuardManager } from '../packages/node/src/relay/guards.js';
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);

// 造一个假中继描述符（只填选守卫用得到的字段；onionPubHex/host/port 占位，本段不建真电路）。
function fakeRelay(i: number): RelayDescriptor {
  return {
    address: `0xrelay${i.toString().padStart(2, '0')}`,
    onionPubHex: 'a'.repeat(64),
    host: '127.0.0.1',
    port: 9000 + i,
    bandwidth: 'm',
    stakeTxid: '0',
  };
}

async function main() {
  const dir8 = Array.from({ length: 8 }, (_, i) => fakeRelay(i));

  // ---- 1. 钉住：同一 GuardManager 连叫 20 次 currentGuard → 始终同一 id ----
  {
    const tmp = mkdtempSync(join(tmpdir(), 'guards-'));
    const gm = new GuardManager(tmp, { lifetimeMs: 60_000 });
    const first = gm.currentGuard(dir8);
    let sticky = first !== undefined;
    for (let i = 0; i < 20; i++) if (gm.currentGuard(dir8) !== first) sticky = false;
    check('20 次 currentGuard 始终返回同一守卫（钉住）', sticky);
    check('守卫集大小 = sampleSize(3)', gm.allGuards().length === 3);

    // ---- 2. 持久化：新 GuardManager（同 dataDir）→ 同一守卫 ----
    const gm2 = new GuardManager(tmp, { lifetimeMs: 60_000 });
    check('新 GuardManager（同 dataDir）读回同一守卫（持久化）', gm2.currentGuard(dir8) === first);

    // ---- 4. exclude={主守卫} → 返回不同的备份守卫 ----
    const backup = gm2.currentGuard(dir8, new Set([first!]));
    check('exclude 主守卫 → 返回不同的备份守卫', backup !== undefined && backup !== first);
    check('备份守卫仍在持久守卫集内', gm2.allGuards().includes(backup!));

    rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 3. 轮换：用可控时钟，把 now 推过 lifetimeMs → 守卫被重采样（sampledAt 刷新；id 可能变）----
  {
    const tmp = mkdtempSync(join(tmpdir(), 'guards-'));
    let clock = 1_000_000;
    const gm = new GuardManager(tmp, { lifetimeMs: 10_000, now: () => clock });
    const before = gm.currentGuard(dir8);
    const beforeSet = gm.allGuards().slice();
    clock += 20_000; // 推过寿命：旧守卫到期
    const after = gm.currentGuard(dir8);
    // 旧守卫到期被剔除 + 重采样：要么换了 id，要么（极小概率重采到同一个）至少 sampledAt 刷新使集合内容变化。
    const rotated = after !== before || JSON.stringify(gm.allGuards()) !== JSON.stringify(beforeSet);
    check('now 推过 lifetimeMs → 守卫轮换/重采样', rotated);
    // 新守卫持久化：再 new 一个读回，应与轮换后一致（且非旧的已过期项）。
    const gm2 = new GuardManager(tmp, { lifetimeMs: 10_000, now: () => clock });
    check('轮换后的新守卫已持久化', gm2.currentGuard(dir8) === after);
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 5. 守卫从目录消失 → 被剪枝 + 替换 ----
  {
    const tmp = mkdtempSync(join(tmpdir(), 'guards-'));
    const gm = new GuardManager(tmp, { lifetimeMs: 60_000 });
    const primary = gm.currentGuard(dir8)!;
    // 目录里抽掉这个主守卫（中继下线）→ 它应被剪枝，currentGuard 返回另一个，且 primary 不再在集内。
    const shrunk = dir8.filter((d) => d.address !== primary);
    const replaced = gm.currentGuard(shrunk);
    check('守卫从目录消失 → 被剪枝替换（返回新守卫）', replaced !== undefined && replaced !== primary);
    check('下线的守卫已不在持久集内', !gm.allGuards().includes(primary));
    check('剪枝后仍补足到 sampleSize', gm.allGuards().length === 3);
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 6. selfId 永不被选作守卫 ----
  {
    const tmp = mkdtempSync(join(tmpdir(), 'guards-'));
    // 只放 4 个中继，其中一个是 self → self 必须被排除，守卫只能从另 3 个里选。
    const self = dir8[0].address;
    const small = dir8.slice(0, 4);
    const gm = new GuardManager(tmp, { lifetimeMs: 60_000, selfId: self });
    // 反复采样多轮（含轮换）确保 self 一直不入选。
    let selfNeverPicked = true;
    for (let round = 0; round < 30; round++) {
      gm.currentGuard(small);
      if (gm.allGuards().includes(self)) selfNeverPicked = false;
    }
    check('selfId 永不被选作守卫', selfNeverPicked);
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 7. 真实电路：5 个 RelayNode，3 条到不同出口的电路都用同一守卫作 hop0 ----
  {
    const ports = [7951, 7952, 7953, 7954, 7955, 7956, 7957]; // 7 个：3 守卫 + ≥3 非守卫出口才不撞
    const nodes = ports.map((port) => {
      const sk = randomBytes(32);
      const onion = generateOnionKeypair();
      const id = publicKeyToAddress(getPublicKey(sk));
      return { id, onion, port, host: '127.0.0.1' };
    });
    const resolveMap = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
    const resolve: RelayResolver = (id) => resolveMap.get(id);
    const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
    await sleep(150);

    // 真链上目录形态的描述符（buildCircuit 需要 onionPubHex/host/port 来 ntor 握手）。
    const directory: RelayDescriptor[] = nodes.map((n) => ({
      address: n.id,
      onionPubHex: Buffer.from(n.onion.pub).toString('hex'),
      host: n.host,
      port: n.port,
      bandwidth: 'm',
      stakeTxid: '0',
    }));
    const hopOf = (d: RelayDescriptor): HopSpec => ({
      id: d.address,
      onionPub: Uint8Array.from(Buffer.from(d.onionPubHex, 'hex')),
      host: d.host,
      port: d.port,
    });

    const tmp = mkdtempSync(join(tmpdir(), 'guards-'));
    const gm = new GuardManager(tmp, { lifetimeMs: 60_000 });

    // makeHsDeps 风格的 buildCircuit，但把选中的 hops 暴露出来供断言（守卫管理器选 hop0）。
    const builtHops: { guard: string; middle: string; exit: string }[] = [];
    async function buildCircuit(exitRelayId: string): Promise<CircuitClient> {
      const gid = gm.currentGuard(directory, new Set([exitRelayId]))!;
      const guard = directory.find((d) => d.address === gid)!;
      const middlePool = directory.filter((d) => d.address !== guard.address && d.address !== exitRelayId);
      const middle = middlePool[Math.floor(Math.random() * middlePool.length)];
      const exit = directory.find((d) => d.address === exitRelayId)!;
      builtHops.push({ guard: guard.address, middle: middle.address, exit: exit.address });
      const c = new CircuitClient();
      await withTimeout(c.connect(hopOf(guard)), 5000, 'connect guard');
      await withTimeout(c.extend(hopOf(middle)), 5000, 'extend middle');
      await withTimeout(c.extend(hopOf(exit)), 5000, 'extend exit');
      return c;
    }

    // 先确定守卫集，再取 3 个**非守卫**地址作出口 → 出口绝不与主守卫相撞，
    // 故主守卫恒被用作 hop0（确定、不 flaky）。出口==主守卫时 currentGuard 会按设计退到备份守卫——
    // 那是正确行为（同一电路不复用同一中继），但会让“三电路同一守卫”这条断言偶发不成立，故此处规避。
    gm.currentGuard(directory);
    const guardSet = new Set(gm.allGuards());
    const exits = nodes.filter((n) => !guardSet.has(n.id)).slice(0, 3).map((n) => n.id);
    const circuits: CircuitClient[] = [];
    for (const ex of exits) circuits.push(await buildCircuit(ex));

    const guardsUsed = new Set(builtHops.map((h) => h.guard));
    check('3 条电路都用同一守卫作 hop0', guardsUsed.size === 1);
    const theGuard = builtHops[0].guard;
    check('守卫 ≠ 每条电路的 middle 与 exit', builtHops.every((h) => h.guard !== h.middle && h.guard !== h.exit));

    // 交叉验证：承载电路最多的中继应正是那个守卫，且承载 ≥3（3 条电路的 hop0 都过它）。
    const guardRelay = relays.find((_, i) => nodes[i].id === theGuard)!;
    check('守卫中继承载 ≥3 条电路（hop0 全过它）', guardRelay.circuits >= 3);
    const maxCircuits = Math.max(...relays.map((r) => r.circuits));
    check('守卫中继是承载电路最多的中继', guardRelay.circuits === maxCircuits);

    // 收尾：flush 一次再关（避免 close cell 与建路 cell 竞争），void close。
    for (const c of circuits) c.close();
    await sleep(200);
    for (const r of relays) void r.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
