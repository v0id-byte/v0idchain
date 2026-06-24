// 守护接线冒烟：验证“节点作中继加入网络”的整链——onion 密钥持久化 → 挖矿得币 → 发布 RELAY| 描述符上链
// → node.relays() 能发现自己 → RelayNode 真正绑定 cell 端口。跑：corepack pnpm exec tsx scripts/relay-daemon-smoke.ts
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { bytesToHex } from '../packages/core/src/index.js';
import { V0idNode, RelayNode, loadOrCreateOnionKey } from '../packages/node/src/index.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const waitUntil = async (cond: () => boolean, timeoutMs: number, label: string) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('超时: ' + label);
    await new Promise((r) => setTimeout(r, 100));
  }
};

async function main() {
  const dataDir = join(tmpdir(), 'v0id-relay-smoke');
  rmSync(dataDir, { recursive: true, force: true });

  const node = new V0idNode({ dataDir, p2pPort: 6071, peers: [] });
  node.start();
  node.startMining(30); // 间歇挖矿，给事件循环喘息

  // 1) onion 密钥持久化
  const onion = loadOrCreateOnionKey(dataDir);
  const onion2 = loadOrCreateOnionKey(dataDir);
  check('onion 密钥持久化（二次读回一致）', bytesToHex(onion.pub) === bytesToHex(onion2.pub));

  // 2) 挖到币
  await waitUntil(() => node.bc.balanceOf(node.wallet.address) >= 2, 15000, '挖到 ≥2 余额');
  check('挖矿得币（余额 ≥2）', node.bc.balanceOf(node.wallet.address) >= 2);

  // 3) 发布 RELAY| 描述符
  const pub = node.publishRelay(bytesToHex(onion.pub), '127.0.0.1', 6081);
  check('publishRelay 提交成功', pub.ok === true);

  // 4) 描述符被挖进区块 → 目录能发现自己
  await waitUntil(() => node.relays().some((r) => r.address === node.wallet.address), 15000, '描述符上链');
  const me = node.relays().find((r) => r.address === node.wallet.address);
  check('链上目录发现本中继', !!me);
  check('描述符 okey 正确', me?.onionPubHex === bytesToHex(onion.pub));
  check('描述符 host:port 正确', me?.host === '127.0.0.1' && me?.port === 6081);

  // 5) RelayNode 真正绑定 cell 端口
  const resolver = (id: string) => {
    const d = node.relays().find((r) => r.address === id);
    return d ? { host: d.host, port: d.port } : undefined;
  };
  const relay = new RelayNode(node.wallet.address, onion, resolver, 6081, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 200));
  const bound = await new Promise<boolean>((res) => {
    const s = connect(6081, '127.0.0.1');
    s.on('connect', () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
  });
  check('RelayNode cell 端口可连接', bound === true);

  void relay.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
