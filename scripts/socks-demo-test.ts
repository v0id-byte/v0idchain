// SOCKS5 端到端演示：真实 curl → 本地 SOCKS5 → 3 跳洋葱电路 → 真实 HTTP 服务。证明“能用”。
// 跑：corepack pnpm exec tsx scripts/socks-demo-test.ts
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { getPublicKey, publicKeyToAddress, generateOnionKeypair } from '../packages/core/src/index.js';
import { RelayNode, type RelayResolver } from '../packages/node/src/relay/relaynode.js';
import { SocksProxy } from '../packages/node/src/relay/socks.js';
import type { HopSpec } from '../packages/node/src/relay/client.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};

async function main() {
  const HTTP_PORT = 7798;
  const SOCKS_PORT = 7795;
  let sawRequest = false;
  const http = createServer((_req, res) => {
    sawRequest = true;
    res.end('Hello via onion\n');
  });
  await new Promise<void>((r) => http.listen(HTTP_PORT, '127.0.0.1', () => r()));

  // 3 中继
  const ports = [7751, 7752, 7753];
  const nodes = ports.map((port) => {
    const sk = randomBytes(32);
    return { id: publicKeyToAddress(getPublicKey(sk)), onion: generateOnionKeypair(), port, host: '127.0.0.1' };
  });
  const dir = new Map(nodes.map((n) => [n.id, { host: n.host, port: n.port }]));
  const resolve: RelayResolver = (id) => dir.get(id);
  const relays = nodes.map((n) => new RelayNode(n.id, n.onion, resolve, n.port, n.host));
  relays[2].setExitPolicy((host, port) => host === '127.0.0.1' && port === HTTP_PORT); // 仅放行本地 HTTP

  const hops: HopSpec[] = nodes.map((n) => ({ id: n.id, onionPub: n.onion.pub, host: n.host, port: n.port }));
  const socks = new SocksProxy(() => hops, SOCKS_PORT); // v1 固定 3 跳；生产 = guard 钉固 + 随机
  await new Promise((r) => setTimeout(r, 200));

  // 真实 curl 经 SOCKS5 走洋葱电路取回 HTTP
  const out = await new Promise<string>((res) =>
    exec(`curl -s --max-time 15 --socks5 127.0.0.1:${SOCKS_PORT} http://127.0.0.1:${HTTP_PORT}/`, (_e, so) => res(so || '')),
  );
  check('curl 经 SOCKS5 + 3 跳洋葱电路取回 HTTP 响应', out.includes('Hello via onion'));
  check('HTTP 服务确实被电路出口访问到（仅出口策略放行的目标可达）', sawRequest === true);
  // 注：电路计数是事后读取、会被 curl 关闭后的 teardown 竞争影响，仅作信息打印；
  //     非竞争的“3 跳不可关联”断言在 relay-integration.ts。
  console.log(`  · 三中继电路计数（事后、可能已 teardown）= [${relays.map((r) => r.circuits).join(',')}]`);

  socks.close();
  for (const r of relays) void r.close();
  http.close();
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
