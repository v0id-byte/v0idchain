// 描述符 DHT 端到端（Phase 2B-b）：服务经电路把描述符发布到负责的 HSDir 中继，客户端（只知 .v0id 地址）
// 算出同一 descId、经新电路取回、解析还原引入点。真实 WebSocket，5 个中继，无链（静态目录）。
// 跑：corepack pnpm exec tsx scripts/hs-dht-test.ts
import { randomBytes } from 'node:crypto';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  identityPub,
  encodeV0idAddress,
  decodeV0idAddress,
  blindPublic,
  descriptorId,
  buildDescriptor,
  parseDescriptor,
  responsibleHsDirs,
  type Descriptor,
  type IntroPoint,
} from '../packages/core/src/index.js';
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
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);

async function main() {
  // ---- 5 个中继（静态目录），端口 7841-7845 ----
  const ports = [7841, 7842, 7843, 7844, 7845];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  await new Promise((r) => setTimeout(r, 150));

  const hopOf = (id: string): HopSpec => {
    const n = nodes.find((x) => x.id === id)!;
    return { id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port };
  };
  const allRelayIds = nodes.map((n) => n.id);

  // 建一条 3 跳电路，终点(出口)=指定 hsdir。guard/middle 取另外两个不同中继。
  async function circuitTo(hsdirId: string): Promise<CircuitClient> {
    const others = allRelayIds.filter((id) => id !== hsdirId);
    const guard = others[0];
    const middle = others[1];
    const c = new CircuitClient();
    await withTimeout(c.connect(hopOf(guard)), 5000, 'connect guard');
    await withTimeout(c.extend(hopOf(middle)), 5000, 'extend middle');
    await withTimeout(c.extend(hopOf(hsdirId)), 5000, 'extend hsdir');
    return c;
  }

  // ---- 服务侧：构造描述符 + 发布到 3 个负责的 HSDir ----
  const seed = randomBytes(32); // hs 身份种子
  const A = identityPub(seed);
  const address = encodeV0idAddress(A);
  const TP = 20000;
  const Ap = blindPublic(A, TP);
  const descId = descriptorId(Ap, TP);
  const introPoints: IntroPoint[] = [
    { relayId: '0x' + 'a1'.repeat(32), relayOnionPubHex: 'b1'.repeat(32), authKeyHex: 'c1'.repeat(32) },
    { relayId: '0x' + 'a2'.repeat(32), relayOnionPubHex: 'b2'.repeat(32), authKeyHex: 'c2'.repeat(32) },
  ];
  const serviceOnionPubHex = '99'.repeat(32);
  const desc = buildDescriptor(seed, TP, introPoints, serviceOnionPubHex);
  const json = JSON.stringify(desc);
  const hsdirs = responsibleHsDirs(descId, allRelayIds, 3);
  check('responsibleHsDirs 返回 3 个 HSDir', hsdirs.length === 3 && new Set(hsdirs).size === 3);
  console.log(`  · descId=${descId.slice(0, 16)}… 负责 HSDir = [${hsdirs.map((id) => id.slice(0, 8)).join(', ')}]`);
  console.log(`  · 描述符 JSON 长度 = ${json.length}B（> 单 cell 485B → 走多 cell 分帧）`);

  let publishOk = 0;
  for (const hsdirId of hsdirs) {
    const c = await circuitTo(hsdirId);
    const ok = await withTimeout(c.hsPublish(descId, json), 5000, 'hsPublish');
    if (ok) publishOk++;
    c.close();
  }
  check('至少 1 个 HSDir 接受发布', publishOk >= 1);
  console.log(`  · 发布成功 = ${publishOk}/${hsdirs.length}`);

  // ---- 客户端侧：只知 address，独立推出 descId 并取回 ----
  const A2 = decodeV0idAddress(address);
  check('decodeV0idAddress(address) 成功', A2 !== null);
  const Ap2 = blindPublic(A2!, TP);
  const descId2 = descriptorId(Ap2, TP);
  check('客户端独立算出的 descId 与服务端一致', descId2 === descId);

  const fetchClient = await circuitTo(hsdirs[0]);
  const fetched = await withTimeout(fetchClient.hsFetch(descId2), 5000, 'hsFetch');
  fetchClient.close();
  check('hsFetch 取回的 JSON 与发布的一致', fetched === json);

  // 解析还原引入点（只用 address，验证端到端机密性闭环）。
  let parsedOk = false;
  if (fetched !== null) {
    const parsed = parseDescriptor(address, JSON.parse(fetched) as Descriptor);
    parsedOk =
      parsed !== null &&
      JSON.stringify(parsed.introPoints) === JSON.stringify(introPoints) &&
      parsed.serviceOnionPubHex === serviceOnionPubHex;
  }
  check('parseDescriptor 还原 2 个引入点 + serviceOnionPubHex', parsedOk);

  // ---- 负例 1：取回一个不存在的 descId → null ----
  const randId = randomBytes(32).toString('hex');
  const negClient = await circuitTo(hsdirs[0]);
  const miss = await withTimeout(negClient.hsFetch(randId), 5000, 'hsFetch miss');
  negClient.close();
  check('取回不存在的 descId → null', miss === null);

  // ---- 负例 2：篡改描述符（翻 enc 一字节）发布 → HSDir 拒收（false）----
  const tampered: Descriptor = { ...desc };
  const encBytes = Uint8Array.from(Buffer.from(desc.enc, 'hex'));
  encBytes[30] ^= 0xff;
  tampered.enc = Buffer.from(encBytes).toString('hex');
  const tamperedJson = JSON.stringify(tampered);
  const tamperClient = await circuitTo(hsdirs[0]);
  const tamperOk = await withTimeout(tamperClient.hsPublish(descId, tamperedJson), 5000, 'hsPublish tampered');
  tamperClient.close();
  check('篡改描述符发布被 HSDir 拒收（false）', tamperOk === false);

  // 验证篡改未污染存储：原 descId 仍能取回未篡改的原文。
  const verifyClient = await circuitTo(hsdirs[0]);
  const stillGood = await withTimeout(verifyClient.hsFetch(descId), 5000, 'hsFetch after tamper');
  verifyClient.close();
  check('篡改发布未覆盖原存储（原文仍可取回）', stillGood === json);

  // ---- 负例 3：越键发布（descId 与 desc.ap 不符）被拒 ----
  const wrongKeyClient = await circuitTo(hsdirs[0]);
  const wrongKeyOk = await withTimeout(wrongKeyClient.hsPublish(randId, json), 5000, 'hsPublish wrong key');
  wrongKeyClient.close();
  check('越键发布（descId≠descriptorId(ap,tp)）被拒（false）', wrongKeyOk === false);

  // ---- 收尾 ----
  for (const r of relays) void r.close();
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
