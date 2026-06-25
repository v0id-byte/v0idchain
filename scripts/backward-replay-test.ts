// 客户端侧后向 cell 严格防重放（feat/onion-entry-guards，2A-3 的 Part 2）。
// 中继后向路径对重放是 best-effort（telescoping 多发起跳 → 无单一单调序列可强制），严格防线落在**客户端**：
// 建路后所有后向 cell 都由终点跳 originateBackward（共用单一单调 n）→ 客户端按 n 单调丢重放。
// 本测试在“真实 wire”上注入重放，断言每条后向 cell 至多被交付一次：
//   ① RdvChannel 的端到端 ctr 去重（纯单元：把同一密封 cell 喂两次 → onData 仅一次）——显式具名检查；
//   ② 流模式：在 client↔relay 间插一个**复制后向帧**的 ws 代理，重放的 CMD_DATA 不会令流多收字节；
//   ③ HS 取回：同一代理下，重放的 CMD_HS_RESP 不会污染重组（取回仍是单份正确 JSON）。
// 跑：corepack pnpm exec tsx scripts/backward-replay-test.ts
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  utf8ToBytes,
  rdvSeal,
  CMD_RDV_DATA,
  identityPub,
  encodeV0idAddress,
  blindPublic,
  descriptorId,
  buildDescriptor,
  responsibleHsDirs,
  type IntroPoint,
} from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { CircuitClient, type HopSpec } from '../packages/node/src/relay/client.js';
import { RdvChannel } from '../packages/node/src/relay/hsclient.js';
// ws 链在 packages/node 下（脚本从仓库根跑）；CJS 默认导入再取命名。
import wsPkg from '../packages/node/node_modules/ws/index.js';
const WebSocketServer = (wsPkg as any).WebSocketServer;
const WebSocket = (wsPkg as any).WebSocket ?? wsPkg;

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('超时: ' + label)), ms))]);

/**
 * 透明 ws 代理：客户端连 listenPort，代理桥接到 realRelay。可切换“复制后向帧”：开启后，每个 relay→client
 * 的帧都额外再发一份（= 网络层重放）。前向帧(client→relay)原样单发。只复制后向，避免扰动前向计数。
 */
function makeDuplicatingProxy(listenPort: number, realHost: string, realPort: number) {
  const state = { duplicateBackward: false };
  const wss = new WebSocketServer({ host: '127.0.0.1', port: listenPort });
  wss.on('connection', (client: any) => {
    const upstream = new WebSocket(`ws://${realHost}:${realPort}`);
    const outbox: string[] = [];
    upstream.on('open', () => {
      for (const m of outbox) upstream.send(m);
      outbox.length = 0;
    });
    // client → relay：原样转发（单发）。
    client.on('message', (d: any) => {
      const s = String(d);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(s);
      else outbox.push(s);
    });
    // relay → client：转发；若开启复制，再发一份（重放）。
    upstream.on('message', (d: any) => {
      const s = String(d);
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(s);
      if (state.duplicateBackward) client.send(s); // 网络层重放同一后向 cell
    });
    const closeBoth = () => {
      try {
        client.close();
      } catch {}
      try {
        upstream.close();
      } catch {}
    };
    client.on('close', closeBoth);
    client.on('error', closeBoth);
    upstream.on('close', closeBoth);
    upstream.on('error', closeBoth);
  });
  return { state, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

async function main() {
  // ---- ① RdvChannel 端到端 ctr 去重（纯单元，显式具名检查）----
  {
    const key = new Uint8Array(32).fill(0x11);
    // 极简 circ 桩：只需捕获 onRdv(CMD_RDV_DATA) 的回调 + 提供 onRdvDestroy 空实现。
    let rdvDataHandler: ((data: Uint8Array) => void) | null = null;
    const stubCirc: any = {
      onRdv: (cmd: number, cb: (d: Uint8Array) => void) => {
        if (cmd === CMD_RDV_DATA) rdvDataHandler = cb;
      },
      onRdvDestroy: () => {},
      sendToTerminus: () => {},
      close: () => {},
    };
    // 收=recvKey=key（与下面 rdvSeal 用同一 key）。
    const ch = new RdvChannel(stubCirc, new Uint8Array(32).fill(0x22), key);
    let delivered = 0;
    let lastBytes = '';
    ch.onData((b) => {
      delivered++;
      lastBytes = dec(b);
    });
    const cell = rdvSeal(key, 0, utf8ToBytes('rdv-payload-once')); // ctr=0
    rdvDataHandler!(cell); // 首次交付
    rdvDataHandler!(cell); // 重放同一 cell（同 ctr=0）→ 必被 recvMaxCtr 去重
    check('RdvChannel：重放的同一 e2e cell 至多交付一次', delivered === 1);
    check('RdvChannel：交付内容正确', lastBytes === 'rdv-payload-once');
    // 再发一个更高 ctr 的合法 cell → 应被交付（去重不误伤新 cell）。
    rdvDataHandler!(rdvSeal(key, 1, utf8ToBytes('next')));
    check('RdvChannel：更高 ctr 的新 cell 仍被交付', delivered === 2);
  }

  // ---- 公共：3 中继 + echo 出口，供 ②③ 复用 ----
  const ECHO_PORT = 7819;
  const echo = createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise<void>((r) => echo.listen(ECHO_PORT, '127.0.0.1', () => r()));

  const ports = [7811, 7812, 7813];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  relays.forEach((r) => r.setExitPolicy((host, port) => host === '127.0.0.1' && port === ECHO_PORT));
  await sleep(150);

  const hopOf = (id: string): HopSpec => {
    const n = nodes.find((x) => x.id === id)!;
    return { id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port };
  };
  const allRelayIds = nodes.map((n) => n.id);

  // ---- ② 流模式：在 guard 前插复制代理；重放的 CMD_DATA 不令流多收 ----
  {
    const PROXY_PORT = 7818;
    // guard = nodes[0]，但客户端连代理端口；代理桥到真实 guard。ntor 身份仍用真实 guard 的 id/onion。
    const proxy = makeDuplicatingProxy(PROXY_PORT, '127.0.0.1', nodes[0].port);
    await sleep(50);
    const guardViaProxy: HopSpec = { id: nodes[0].id, onionPub: nodes[0].onion.pub, host: '127.0.0.1', port: PROXY_PORT };

    const client = new CircuitClient();
    await withTimeout(client.connect(guardViaProxy), 5000, 'connect via proxy');
    await withTimeout(client.extend(hopOf(nodes[1].id)), 5000, 'extend1');
    await withTimeout(client.extend(hopOf(nodes[2].id)), 5000, 'extend2');

    let onDataCalls = 0;
    const recv: number[] = [];
    let expected = 0;
    let resolveRecv: (() => void) | null = null;
    client.onData((b) => {
      onDataCalls++;
      for (const v of b) recv.push(v);
      if (resolveRecv && recv.length >= expected) resolveRecv();
    });
    const connected = await withTimeout(client.beginStream('127.0.0.1', ECHO_PORT), 5000, 'beginStream');
    check('流模式：经代理 CONNECT 成功', connected === true);

    // 开启后向复制：之后每条后向 cell 都被代理重放一次。
    proxy.state.duplicateBackward = true;
    const msg = utf8ToBytes('replay-me');
    expected = msg.length;
    const w = new Promise<void>((r) => (resolveRecv = r));
    client.write(msg); // 出口 echo 回 1 个 DATA cell → 代理复制成 2 个；客户端应只交付 1 次
    await withTimeout(w, 5000, 'echo under replay');
    // 给被复制的重放 cell 充足时间抵达（若没被丢，会让 recv 翻倍 / onDataCalls 多一次）。
    await sleep(200);
    check('流模式：重放的 CMD_DATA 被丢（回显字节不重复）', dec(Uint8Array.from(recv)) === dec(msg));
    check('流模式：单条 echo 的 onData 恰好一次（重放未二次交付）', onDataCalls === 1);

    proxy.state.duplicateBackward = false;
    client.close();
    await proxy.close();
  }

  // ---- ③ HS 取回：重放的 CMD_HS_RESP 不污染重组（取回仍单份正确 JSON）----
  {
    const seed = randomBytes(32);
    const A = identityPub(seed);
    const address = encodeV0idAddress(A);
    const TP = 20000;
    const Ap = blindPublic(A, TP);
    const descId = descriptorId(Ap, TP);
    const introPoints: IntroPoint[] = [
      { relayId: '0x' + 'a1'.repeat(32), relayOnionPubHex: 'b1'.repeat(32), authKeyHex: 'c1'.repeat(32) },
    ];
    const desc = buildDescriptor(seed, TP, introPoints, '99'.repeat(32));
    const json = JSON.stringify(desc);
    const hsdirs = responsibleHsDirs(descId, allRelayIds, 3);
    const hsdirId = hsdirs[0];

    // 先正常发布到该 HSDir（不经代理）。
    {
      const others = allRelayIds.filter((id) => id !== hsdirId);
      const c = new CircuitClient();
      await withTimeout(c.connect(hopOf(others[0])), 5000, 'pub connect');
      await withTimeout(c.extend(hopOf(others[1])), 5000, 'pub extend1');
      await withTimeout(c.extend(hopOf(hsdirId)), 5000, 'pub extend2');
      const ok = await withTimeout(c.hsPublish(descId, json), 5000, 'hsPublish');
      c.close();
      check('HS：描述符发布成功（前置）', ok === true);
    }

    // 经复制代理取回：HSDir 把 RESP 分帧多 cell 回来，代理把每个后向 cell 复制一份。
    const PROXY_PORT = 7820;
    const others = allRelayIds.filter((id) => id !== hsdirId);
    const proxy = makeDuplicatingProxy(PROXY_PORT, '127.0.0.1', nodes.find((n) => n.id === others[0])!.port);
    await sleep(50);
    const guardViaProxy: HopSpec = {
      id: others[0],
      onionPub: nodes.find((n) => n.id === others[0])!.onion.pub,
      host: '127.0.0.1',
      port: PROXY_PORT,
    };
    const fc = new CircuitClient();
    await withTimeout(fc.connect(guardViaProxy), 5000, 'fetch connect via proxy');
    await withTimeout(fc.extend(hopOf(others[1])), 5000, 'fetch extend1');
    await withTimeout(fc.extend(hopOf(hsdirId)), 5000, 'fetch extend2');
    proxy.state.duplicateBackward = true; // 取回应答全程被重放
    const fetched = await withTimeout(fc.hsFetch(descId), 5000, 'hsFetch under replay');
    fc.close();
    await proxy.close();
    check('HS：重放后向 RESP 下取回仍是单份正确 JSON', fetched === json);
  }

  // ---- 收尾 ----
  echo.close();
  for (const r of relays) void r.close();
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
