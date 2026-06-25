// 度量者探测自检（Phase 3A-2）：真实 WebSocket 中继 + 真实电路探测（无链）。
// 证明：① 探测穿过中继建短电路 + DATA 往返 → 在线判定；② 杀掉一个中继 → 它被判离线、其余在线；
//       ③ attestation 签名→验签往返成功，篡改任一字段则验签失败。
// 跑：corepack pnpm exec tsx scripts/measurer-test.ts
import { randomBytes } from 'node:crypto';
import { statSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPublicKey, publicKeyToAddress, generateOnionKeypair, bytesToHex, Wallet, type StakePool, type StakeRole } from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import {
  probeOnce,
  makeProbeSink,
  signAttestation,
  verifyAttestation,
  Measurer,
  type ProbeTarget,
  type Attestation,
} from '../packages/node/src/relay/measurer.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};

async function main() {
  // 3 个被探中继：各有 钱包地址(=relayId) + 独立 onion 密钥 + cell 入口端口。
  const ports = [7841, 7842, 7843];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    const id = publicKeyToAddress(getPublicKey(sk));
    const onion = generateOnionKeypair();
    return { id, onion, port, host: '127.0.0.1' };
  });
  // prober 自控的 sink（出口回显），也要进目录（target 经它 EXTEND，需能解析到它）。
  const sinkPort = 7849;

  // 共享 resolver：含 3 个 target + sink（本地测试天然满足「target 能解析 sink」的部署前提）。
  const dir = new Map<string, { host: string; port: number }>(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);

  // 启动 3 个被探中继（纯转发，无出口）。它们只需「能 CREATE + 转发 EXTEND/DATA」即可被判在线。
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  // 起 sink（回显出口），把它登记进共享目录。
  const { sink, node: sinkNode } = makeProbeSink(resolve, sinkPort, '127.0.0.1');
  dir.set(sink.id, { host: '127.0.0.1', port: sinkPort });
  await new Promise((r) => setTimeout(r, 200)); // 等所有监听就绪

  const targets: ProbeTarget[] = nodes.map((n) => ({ id: n.id, onionPubHex: bytesToHex(n.onion.pub), host: n.host, port: n.port }));

  // ---- ① 全员在线：每个 target 探测应通过（穿过它建 2 跳电路 + DATA 回显吻合）----
  for (const t of targets) {
    const ok = await probeOnce(t, sink, 4000);
    check(`在线中继 ${t.port} 探测通过（穿过它的电路 DATA 往返成功）`, ok === true);
  }

  // ---- ② 杀掉中继[1]：它被判离线，其余仍在线 ----
  await relays[1].close();
  await new Promise((r) => setTimeout(r, 200));
  const after = [];
  for (const t of targets) after.push({ port: t.port, ok: await probeOnce(t, sink, 2500) });
  check('被杀中继 7842 探测失败（判离线）', after.find((x) => x.port === 7842)?.ok === false);
  check('存活中继 7841 仍探测通过（判在线）', after.find((x) => x.port === 7841)?.ok === true);
  check('存活中继 7843 仍探测通过（判在线）', after.find((x) => x.port === 7843)?.ok === true);

  // ---- ③ attestation 签名 → 验签往返 + 篡改任一字段则验签失败 ----
  const measurer = Wallet.generate();
  const att: Attestation = { epoch: 7, relayId: targets[0].id, uptime: 0.666667, online: true, probes: 3, ok: 2, ts: Date.now() };
  signAttestation(att, measurer.privateKey);
  check('attestation 验签：度量者本人签的能通过', verifyAttestation(att, measurer.address));
  check('attestation 验签：换个地址（非签名者）验签失败', !verifyAttestation(att, Wallet.generate().address));
  // 篡改各字段（payload 覆盖的）后验签必败，证明 uptime/online/ok/epoch/relayId 都被签名保护。
  check('篡改 uptime → 验签失败', !verifyAttestation({ ...att, uptime: 1.0 }, measurer.address));
  check('篡改 online → 验签失败', !verifyAttestation({ ...att, online: false }, measurer.address));
  check('篡改 ok 计数 → 验签失败', !verifyAttestation({ ...att, ok: 3 }, measurer.address));
  check('篡改 epoch → 验签失败', !verifyAttestation({ ...att, epoch: 8 }, measurer.address));
  check('篡改 relayId → 验签失败', !verifyAttestation({ ...att, relayId: targets[1].id }, measurer.address));
  // ts 不进签名 payload（本地时钟，跨实现不稳定）→ 改 ts 不应影响验签（仍通过）。
  check('改 ts 不影响验签（ts 不进签名，按设计）', verifyAttestation({ ...att, ts: att.ts + 99999 }, measurer.address));
  check('无签名的 attestation 验签直接 false', !verifyAttestation({ ...att, sig: undefined }, measurer.address));

  // ---- ④ Measurer.runEpoch 守护路径：探一轮 → 签 attestation + 落 0600 state + 滚动掉线历史（CLI measure 依赖这条路径）----
  // 此时 7842 已被杀（离线），7841/7843 存活。给每个中继造一个「未赎回质押」，让 online→stakeId 掉线追踪生效。
  const dataDir = join(tmpdir(), 'v0id-measurer-test-' + randomBytes(4).toString('hex'));
  rmSync(dataDir, { recursive: true, force: true });
  const mw = Wallet.generate();
  const mkStake = (staker: string, role: StakeRole): [string, StakePool] => [
    `stk-${staker.slice(2, 10)}`.padEnd(64, '0'),
    { staker, role, amount: 50, lockedUntil: 0, createdHeight: 0, slashed: 0, withdrawn: false },
  ];
  const stakes = new Map<string, StakePool>([
    mkStake(targets[0].id, 'guard'), // 7841 alive
    mkStake(targets[1].id, 'middle'), // 7842 killed
    mkStake(targets[2].id, 'hsdir'), // 7843 alive
  ]);
  const stakeIdOf = (relayId: string) => [...stakes.entries()].find(([, p]) => p.staker === relayId)![0];
  const m = new Measurer({ dataDir, measurerPriv: mw.privateKey, measurerAddress: mw.address, probesPerEpoch: 2, probeTimeoutMs: 2500 });

  const atts0 = await m.runEpoch(targets, sink, stakes, 100, 0); // epoch 0
  check('runEpoch 为每个中继产出 1 份 attestation', atts0.length === 3);
  check('runEpoch：存活 7841 判 online', atts0.find((a) => a.relayId === targets[0].id)?.online === true);
  check('runEpoch：被杀 7842 判 offline（uptime 0）', atts0.find((a) => a.relayId === targets[1].id)?.online === false && atts0.find((a) => a.relayId === targets[1].id)?.uptime === 0);
  check('runEpoch：存活 7843 判 online', atts0.find((a) => a.relayId === targets[2].id)?.online === true);
  check('runEpoch 产出的 attestation 都带度量者签名且验签通过', atts0.every((a) => verifyAttestation(a, mw.address)));

  const stateFile = join(dataDir, 'measurer-state.json');
  check('runEpoch 落盘 measurer-state.json', existsSync(stateFile));
  // 0600 权限（与钱包/链文件同等收紧；含派生地址但不含私钥）。
  const mode = statSync(stateFile).mode & 0o777;
  check('state 文件权限收紧到 0600', mode === 0o600);
  const st0 = JSON.parse(readFileSync(stateFile, 'utf8'));
  check('state.lastEpoch == 0', st0.lastEpoch === 0);
  check('掉线历史：存活中继计数 0', st0.offlineHistory[stakeIdOf(targets[0].id)] === 0);
  check('掉线历史：被杀中继首轮计数 1', st0.offlineHistory[stakeIdOf(targets[1].id)] === 1);

  // 再跑 epoch 1（7842 仍死）→ 其连续掉线计数应累加到 2；存活的仍 0。
  await m.runEpoch(targets, sink, stakes, 110, 1);
  const st1 = JSON.parse(readFileSync(stateFile, 'utf8'));
  check('第二轮：被杀中继连续掉线累加到 2', st1.offlineHistory[stakeIdOf(targets[1].id)] === 2);
  check('第二轮：存活中继仍为 0（在线即清零）', st1.offlineHistory[stakeIdOf(targets[0].id)] === 0 && st1.offlineHistory[stakeIdOf(targets[2].id)] === 0);
  check('第二轮：state.lastEpoch == 1', st1.lastEpoch === 1);
  rmSync(dataDir, { recursive: true, force: true });

  // 清理
  await Promise.all([relays[0].close(), relays[2].close(), sinkNode.close()]);
  await new Promise((r) => setTimeout(r, 100));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
