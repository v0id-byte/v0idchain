// 多节点集成测试：真实 WebSocket 连接，验证区块广播、转账同步、迟到节点追链、双向出块。
import { rmSync } from 'node:fs';
import { V0idNode, startHttpApi } from '../packages/node/src/index.js'; // 用 Node 25 内置的全局 WebSocket 客户端
import { Wallet } from '../packages/core/src/index.js';

const DIR = '.data/it';
rmSync(DIR, { recursive: true, force: true });

let failed = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

const node1 = new V0idNode({ dataDir: `${DIR}/n1`, p2pPort: 6101 });
const node2 = new V0idNode({ dataDir: `${DIR}/n2`, p2pPort: 6102, peers: ['ws://127.0.0.1:6101'] });
node1.start();
node2.start();

const alice = Wallet.generate();

console.log('\n— 双节点连接 —');
const t0 = Date.now();
await waitFor(() => node1.p2p.peerCount() === 1 && node2.p2p.peerCount() === 1);
check(`双向握手完成（${Date.now() - t0}ms）`, node1.p2p.peerCount() === 1 && node2.p2p.peerCount() === 1);

console.log('\n— node1 挖矿（出币），node2 应同步 —');
// 出块奖励为 1（见 BLOCK_REWARD），挖 10 块让 node1 攒够余额：先转 3 给 alice（+手续费1），
// 后面 HTTP API 还会再 send 5（+手续费1），需保证 node1 始终有余额，否则 /send 会 400。
for (let i = 0; i < 10; i++) await node1.mineOnce();
await waitFor(() => node2.bc.height === node1.bc.height);
check('node2 链高追平 node1', node2.bc.height === node1.bc.height && node1.bc.height === 10);
check('两节点链顶 hash 一致', node2.bc.latest.hash === node1.bc.latest.hash);

console.log('\n— node1 用挖来的币转 3 给 alice，跨节点结算 —');
node1.send(alice.address, 3);
await waitFor(() => node2.bc.mempool.length === 1); // 交易广播到 node2 的池
check('交易广播到 node2 的交易池', node2.bc.mempool.length === 1);
await node2.mineOnce(); // 由 node2 打包
await waitFor(() => node1.bc.height === node2.bc.height);
check('node1 同步了 node2 出的块', node1.bc.height === node2.bc.height);
check('两节点都认 alice 余额 = 3（实收金额，手续费另计）', node1.bc.balanceOf(alice.address) === 3 && node2.bc.balanceOf(alice.address) === 3);
check('发送方 node1 被扣 金额+手续费（10 - 3 - 1 = 6）', node1.bc.balanceOf(node1.wallet.address) === 6);
check('打包者 node2 收得 出块奖励+手续费（= 2）', node2.bc.balanceOf(node2.wallet.address) === 2);
check('两节点链顶一致', node1.bc.latest.hash === node2.bc.latest.hash);

console.log('\n— 迟到节点 node3 接入，应自动追上整条链 —');
const node3 = new V0idNode({ dataDir: `${DIR}/n3`, p2pPort: 6103, peers: ['ws://127.0.0.1:6101'] });
node3.start();
await waitFor(() => node3.bc.height === node1.bc.height, 5000);
check('node3 追上链高', node3.bc.height === node1.bc.height);
check('node3 链顶与全网一致', node3.bc.latest.hash === node1.bc.latest.hash);
check('node3 也算出 alice 余额 = 3', node3.bc.balanceOf(alice.address) === 3);

console.log('\n— 健壮性：畸形/恶意消息不能打挂节点 —');
const heightBefore = node1.bc.height;
await new Promise<void>((resolve) => {
  const evil = new WebSocket('ws://127.0.0.1:6101'); // Node 内置的 WHATWG WebSocket 客户端
  evil.onopen = () => {
    evil.send('not json at all{{{');
    evil.send(JSON.stringify({ type: 'PEERS' })); // 缺 peers
    evil.send(JSON.stringify({ type: 'PEERS', peers: 42 })); // peers 非数组
    evil.send(JSON.stringify({ type: 'BLOCKS', blocks: 'nope' })); // blocks 非数组
    evil.send(JSON.stringify({ type: 'BLOCKS', blocks: [{ index: 1, junk: true }] })); // 畸形块
    evil.send(JSON.stringify({ type: 'TX' })); // 缺 tx
    evil.send(JSON.stringify({ type: 'TX', tx: { amount: 'lots' } })); // 畸形交易
    evil.send(JSON.stringify({ type: 'HELLO' })); // 缺字段
    evil.send(JSON.stringify({ type: 12345 })); // type 非字符串
    setTimeout(() => {
      evil.close();
      resolve();
    }, 300);
  };
  evil.onerror = () => resolve();
});
await node1.mineOnce(); // 还能正常出块？
check('节点在畸形消息轰炸后仍存活并能出块', node1.bc.height === heightBefore + 1);
await waitFor(() => node2.bc.height === node1.bc.height);
check('遭轰炸后全网仍能正常同步', node2.bc.latest.hash === node1.bc.latest.hash);

console.log('\n— HTTP API + 浏览器 CORS 预检 + token 鉴权 —');
const API_TOKEN = 'it-token-' + Math.random().toString(16).slice(2);
const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` };
startHttpApi(node1, 7301, API_TOKEN);
await sleep(150); // 等 listen
// 浏览器对 POST+JSON 会先发 OPTIONS 预检；必须 204 且带 CORS 头，否则仪表盘“Failed to fetch”
const pre = await fetch('http://127.0.0.1:7301/send', {
  method: 'OPTIONS',
  headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' },
});
check('OPTIONS 预检返回 204', pre.status === 204);
check('预检带 allow-methods=POST', (pre.headers.get('access-control-allow-methods') ?? '').includes('POST'));
check('预检放行 authorization 头', (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase().includes('authorization'));
// 无 token 的写请求必须被拒（防同机他进程/他用户盗币）
const noAuth = await fetch('http://127.0.0.1:7301/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ to: alice.address, amount: 5 }),
});
check('POST /send 无 token 被拒(401)', noAuth.status === 401);
const okPost = await fetch('http://127.0.0.1:7301/send', {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ to: alice.address, amount: 5 }),
});
check('POST /send 带 token 合法请求成功', okPost.status === 200);
const badPost = await fetch('http://127.0.0.1:7301/send', {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ to: 'not-an-address', amount: 5 }),
});
check('POST /send 畸形地址被拒(400)', badPost.status === 400);

console.log('\n— 持久化：重启 node1 应从磁盘恢复 —');
const h = node1.bc.height;
const reloaded = new V0idNode({ dataDir: `${DIR}/n1`, p2pPort: 6111 });
check('从磁盘恢复链高', reloaded.bc.height === h);
check('从磁盘恢复 alice 余额', reloaded.bc.balanceOf(alice.address) === 3);

console.log(failed === 0 ? '\n🎉 集成测试全部通过\n' : `\n💥 ${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
