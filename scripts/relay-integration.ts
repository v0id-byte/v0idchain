// 三跳电路端到端集成测试（真实 WebSocket，无链）。证明“真的可用”+ 匿名属性。
// 跑：corepack pnpm exec tsx scripts/relay-integration.ts
import { randomBytes } from 'node:crypto';
import { getPublicKey, publicKeyToAddress, generateOnionKeypair, utf8ToBytes } from '../packages/core/src/index.js';
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
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`超时: ${label}`)), ms))]);
}

async function main() {
  // 3 个中继：各有 钱包地址(=身份/relayId) + 独立 onion 密钥 + cell 入口端口
  const ports = [7731, 7732, 7733];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    const id = publicKeyToAddress(getPublicKey(sk));
    const onion = generateOnionKeypair();
    return { id, onion, port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);

  // 启动 3 个中继；每个都挂 exitHandler 记录“是否把 DATA 明文投到了本节点”——只有真正的出口应触发。
  const exitCalls: { idx: number; text: string }[] = [];
  const relays = nodes.map((n, idx) => {
    const r = new RelayNode(n.id, n.onion, resolve, n.port, n.host);
    r.onExit((data, reply) => {
      exitCalls.push({ idx, text: dec(data) });
      reply(utf8ToBytes('ECHO:' + dec(data))); // 出口回显
    });
    return r;
  });
  await new Promise((r) => setTimeout(r, 150)); // 等监听就绪

  // 客户端按目录选 3 跳建路：G0(守卫)→G1(中继)→G2(出口)
  const hops: HopSpec[] = nodes.map((n) => ({ id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port }));
  const client = new CircuitClient();
  await withTimeout(client.connect(hops[0]), 5000, 'connect 守卫');
  check('握手守卫成功（1 跳）', client.hopCount === 1);
  await withTimeout(client.extend(hops[1]), 5000, 'extend 中继');
  check('延伸到中继成功（2 跳）', client.hopCount === 2);
  await withTimeout(client.extend(hops[2]), 5000, 'extend 出口');
  check('延伸到出口成功（3 跳）', client.hopCount === 3);

  // ---- 功能：DATA 经 3 跳往返 ----
  const reply = await withTimeout(client.sendData(utf8ToBytes('hello hidden service')), 5000, 'sendData');
  check('3 跳往返数据正确', dec(reply) === 'ECHO:hello hidden service');

  // 多次往返（验证前向计数器/nonce 唯一性不串味）
  const r2 = await withTimeout(client.sendData(utf8ToBytes('second message')), 5000, 'sendData2');
  const r3 = await withTimeout(client.sendData(utf8ToBytes('third')), 5000, 'sendData3');
  check('第 2 次往返正确', dec(r2) === 'ECHO:second message');
  check('第 3 次往返正确', dec(r3) === 'ECHO:third');

  // ---- 匿名属性 ----
  // 只有出口(idx=2)能读出 DATA 明文；守卫(0)与中继(1)只盲转发，从不认领 → 它们的 exitHandler 一次都不触发。
  console.log(`  · exitCalls = ${exitCalls.length} 次，命中节点下标 = [${exitCalls.map((c) => c.idx).join(',')}]（应全为 2=出口）`);
  check('只有出口读到明文（守卫/中继盲转发）', exitCalls.length === 3 && exitCalls.every((c) => c.idx === 2));
  // 每个中继恰好承载 1 条电路
  check('守卫承载 1 电路', relays[0].circuits === 1);
  check('中继承载 1 电路', relays[1].circuits === 1);
  check('出口承载 1 电路', relays[2].circuits === 1);

  client.close();
  await Promise.all(relays.map((r) => r.close()));
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
