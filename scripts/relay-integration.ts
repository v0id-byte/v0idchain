// 三跳电路端到端集成测试（真实 WebSocket，无链）。证明“真的可用”+ 匿名属性。
// 跑：corepack pnpm exec tsx scripts/relay-integration.ts
import { randomBytes } from 'node:crypto';
import { CELL_BODY_LEN, MAX_CELL_CTR, getPublicKey, publicKeyToAddress, generateOnionKeypair, utf8ToBytes } from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient, type HopSpec } from '../packages/node/src/relay/client.js';
import { decodeCell } from '../packages/node/src/relay/cells.js';
import { RelayCircuitTable, relayAddBackwardLayer, relayForward, type RelayCircuit, type CellLink } from '../packages/node/src/relay/circuit.js';

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

  // ---- 前向防重放回归（修复 n=0 边界 bug + nonce 上限）----
  {
    const dummy: CellLink = { lid: -1, send() {}, close() {}, isOpen: () => true };
    const fk = (x: number) => new Uint8Array(32).fill(x);
    const fake: RelayCircuit = {
      prevConn: dummy,
      prevCirc: 'z',
      keys: { encForward: fk(1), encBackward: fk(2), macForward: fk(3), macBackward: fk(4) },
      maxFwdCtr: -1,
      bwdBase: 0,
      bwdLocal: 0,
      createdAt: 0,
      lastSeen: 0,
      cellTokens: 1e9, // 满桶 → 不干扰防重放断言
      cellRefillAt: 0,
      cellDropped: 0,
      cellDropWindowAt: 0,
    };
    const body = new Uint8Array(CELL_BODY_LEN);
    check('首个前向 n=0 被接受', relayForward(fake, body, 0).kind !== 'drop');
    check('重放 n=0 被丢弃', relayForward(fake, body, 0).kind === 'drop');
    check('递增 n=5 被接受', relayForward(fake, body, 5).kind !== 'drop');
    check('乱序/重放 n=3(<5) 被丢弃', relayForward(fake, body, 3).kind === 'drop');
    check('达到 2^48 nonce 上限被丢弃', relayForward(fake, body, MAX_CELL_CTR).kind === 'drop');
    check('后向达到 2^48 nonce 上限被丢弃', relayAddBackwardLayer(fake, body, MAX_CELL_CTR) === null);

    const table = new RelayCircuitTable();
    const dup = { ...fake, createdAt: 1 };
    const next: CellLink = { lid: -2, send() {}, close() {}, isOpen: () => true };
    check('重复 CREATE circId 被拒', table.add(fake) === true && table.add(dup) === false);
    check('首次 EXTEND linkNext 成功', table.linkNext(fake, next, 'next-1') === true);
    check('重复 EXTEND 不覆盖旧 next', table.linkNext(fake, next, 'next-2') === false && table.byNext('next-1') === fake && !table.byNext('next-2'));
  }

  // ---- cell 解码边界回归 ----
  {
    const key = 'a'.repeat(64);
    const body = 'b'.repeat(CELL_BODY_LEN * 2);
    check('CREATE 握手 x 必须正好 64 hex', decodeCell(JSON.stringify({ t: 'CREATE', c: 'c', x: '0' })) === null);
    check('CREATED y/a 必须正好 64 hex', decodeCell(JSON.stringify({ t: 'CREATED', c: 'c', y: key, a: 'f' })) === null);
    check('RELAY n 达到 nonce 上限被拒', decodeCell(JSON.stringify({ t: 'RELAY', c: 'c', d: 'b', n: MAX_CELL_CTR, b: body })) === null);
  }

  client.close();
  await new Promise((r) => setTimeout(r, 200));
  check('DESTROY 释放三跳电路状态', relays.every((r) => r.circuits === 0));

  const dropper = new CircuitClient();
  await withTimeout(dropper.connect(hops[0]), 5000, 'dropper connect');
  check('close 前守卫有 1 条电路', relays[0].circuits === 1);
  (dropper as any).ws.close();
  await new Promise((r) => setTimeout(r, 200));
  check('WebSocket 直接关闭也清理电路', relays[0].circuits === 0);
  await Promise.all(relays.map((r) => r.close()));

  const publicLike = {
    id: publicKeyToAddress(getPublicKey(randomBytes(32))),
    onion: generateOnionKeypair(),
    port: 7734,
    host: '127.0.0.1',
  };
  const privateNext = {
    id: publicKeyToAddress(getPublicKey(randomBytes(32))),
    onion: generateOnionKeypair(),
    port: 7735,
    host: '127.0.0.1',
  };
  const publicLikeRelay = new RelayNode(
    publicLike.id,
    publicLike.onion,
    (id) => (id === privateNext.id ? { host: privateNext.host, port: privateNext.port } : undefined),
    publicLike.port,
    publicLike.host,
    false,
  );
  await new Promise((r) => setTimeout(r, 150));
  const blockedClient = new CircuitClient();
  await withTimeout(
    blockedClient.connect({ id: publicLike.id, onionPub: publicLike.onion.pub, host: publicLike.host, port: publicLike.port }),
    5000,
    'blocked connect',
  );
  let privateExtendRejected = false;
  try {
    await withTimeout(
      blockedClient.extend({ id: privateNext.id, onionPub: privateNext.onion.pub, host: privateNext.host, port: privateNext.port }),
      5000,
      'private extend reject',
    );
  } catch {
    privateExtendRejected = true;
  }
  check('公开 relay 拒绝 private descriptor EXTEND', privateExtendRejected === true);
  await new Promise((r) => setTimeout(r, 200));
  check('private descriptor 拒绝后清理电路', publicLikeRelay.circuits === 0);
  blockedClient.close();
  await publicLikeRelay.close();
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
