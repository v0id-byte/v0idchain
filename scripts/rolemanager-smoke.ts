// RoleManager 冒烟（Phase 2F-1）：验证「运行时切角色」整条路径——既直接打 RoleManager，也经 HTTP API。
// 覆盖：GET /roles 初始全 off → POST /mine/start 令牌门控 + 链高增长 → POST /relay/start 后 status.relay.on
// + cell 端口可连 → POST /relay/stop 后拆干净（circuits===0、端口拒连）→ 幂等启停 → hs 前置（<3 中继）回 409。
// 跑：corepack pnpm exec tsx scripts/rolemanager-smoke.ts
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { V0idNode, startHttpApi, loadOrCreateOnionKey, RoleManager } from '../packages/node/src/index.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond: () => boolean, timeoutMs: number, label: string) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('超时: ' + label);
    await sleep(80);
  }
};
// 一次性探测某端口当下是否接受 TCP 连接（中继 cell 端口的「在听 / 已拆」判据）。
const portOpen = (port: number, host = '127.0.0.1') =>
  new Promise<boolean>((res) => {
    const s = connect(port, host);
    const done = (v: boolean) => {
      s.destroy();
      res(v);
    };
    s.on('connect', () => done(true));
    s.on('error', () => res(false));
    setTimeout(() => done(false), 1500);
  });

async function main() {
  const dataDir = join(tmpdir(), 'v0id-rolemgr-smoke');
  rmSync(dataDir, { recursive: true, force: true });

  const P2P_PORT = 6091;
  const API_PORT = 7091;
  const RELAY_PORT = 6181;
  const TOKEN = 'smoke-token-2f1';
  const API = `http://127.0.0.1:${API_PORT}`;

  const node = new V0idNode({ dataDir, p2pPort: P2P_PORT, peers: [] });
  node.start();

  const roleManager = new RoleManager({
    node,
    dataDir,
    onion: loadOrCreateOnionKey(dataDir),
    relayPort: RELAY_PORT,
    relayAdvertiseHost: '127.0.0.1',
    relayBindHost: '127.0.0.1', // 自测绑回环即可（CLI 默认 0.0.0.0 对外）
  });
  const server = startHttpApi(node, API_PORT, TOKEN, roleManager);
  await sleep(150);

  // 经 HTTP 调一个端点；wantAuth=true 带令牌。返回 {status, body}。
  const hit = async (method: 'GET' | 'POST', path: string, body?: unknown, withToken = true) => {
    const res = await fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', ...(withToken ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };

  // ---- 1) GET /roles 初始全 off（无需令牌）----
  const r0 = await hit('GET', '/roles', undefined, false);
  check('GET /roles 200（无需令牌）', r0.status === 200);
  check('初始 relay/hs/mine 全 off', r0.body.relay.on === false && r0.body.hs.on === false && r0.body.mine.on === false);
  check('初始 status 形状含 socks/relay/hs/mine', !!r0.body.socks && !!r0.body.relay && !!r0.body.hs && !!r0.body.mine);

  // ---- 2) POST 令牌门控：无令牌 → 401 ----
  const noTok = await hit('POST', '/mine/start', { intervalMs: 30 }, false);
  check('POST /mine/start 无令牌 → 401', noTok.status === 401);

  // ---- 3) POST /mine/start（带令牌）→ 开挖 + 链高增长 ----
  const h0 = node.bc.height;
  const mineRes = await hit('POST', '/mine/start', { intervalMs: 30 });
  check('POST /mine/start 200', mineRes.status === 200);
  check('status.mine.on === true 且 intervalMs=30', mineRes.body.mine.on === true && mineRes.body.mine.intervalMs === 30);
  await waitUntil(() => node.bc.height > h0, 15000, '挖矿令链高增长');
  check('挖矿使链高增长（HTTP 控制生效）', node.bc.height > h0);

  // 顺带：挖到余额（中继自动发布要余额≥2，也证明 node 在出币）
  await waitUntil(() => node.bc.balanceOf(node.wallet.address) >= 2, 15000, '挖到 ≥2 余额');
  check('挖矿得币（余额 ≥2）', node.bc.balanceOf(node.wallet.address) >= 2);

  // ---- 4) POST /relay/start → relay 上线 + cell 端口可连 ----
  check('relay 启动前 cell 端口未监听', (await portOpen(RELAY_PORT)) === false);
  const relayRes = await hit('POST', '/relay/start');
  check('POST /relay/start 200', relayRes.status === 200);
  check('status.relay.on === true', relayRes.body.relay.on === true);
  check('status.relay.port === RELAY_PORT', relayRes.body.relay.port === RELAY_PORT);
  check('status.relay.address === 节点地址', relayRes.body.relay.address === node.wallet.address);
  await sleep(200); // 等 WebSocketServer 绑定
  check('relay cell 端口现可连接', (await portOpen(RELAY_PORT)) === true);

  // 幂等：再 start 一次仍 on（不抛、不重复绑端口）
  const relayAgain = await hit('POST', '/relay/start');
  check('POST /relay/start 幂等（再调仍 200 且 on）', relayAgain.status === 200 && relayAgain.body.relay.on === true);

  // ---- 5) POST /relay/stop → 拆干净（端口拒连 + circuits 归零）----
  const stopRes = await hit('POST', '/relay/stop');
  check('POST /relay/stop 200', stopRes.status === 200);
  check('status.relay.on === false', stopRes.body.relay.on === false);
  check('status.relay.circuits === 0', stopRes.body.relay.circuits === 0);
  await sleep(200);
  check('relay 停止后 cell 端口拒连（已拆）', (await portOpen(RELAY_PORT)) === false);

  // 幂等：再 stop 一次 no-op
  const stopAgain = await hit('POST', '/relay/stop');
  check('POST /relay/stop 幂等（再调仍 200 且 off）', stopAgain.status === 200 && stopAgain.body.relay.on === false);

  // 停后还能再起（生命周期可重入）
  const relayRestart = await hit('POST', '/relay/start');
  await sleep(200);
  check('relay 停后可重启（端口再次可连）', relayRestart.body.relay.on === true && (await portOpen(RELAY_PORT)) === true);
  await hit('POST', '/relay/stop');
  await sleep(150);

  // ---- 6) HS 前置：单节点链上中继 < 3 → /hs/start 回 409 干净错误（不崩进程）----
  check('当前链上中继 < 3（HS 前置不满足）', node.relays().length < 3);
  const hsRes = await hit('POST', '/hs/start', { host: '127.0.0.1', port: 8080 });
  check('POST /hs/start 中继不足 → 409', hsRes.status === 409);
  check('409 带清晰中文 error（中继不足）', typeof hsRes.body.error === 'string' && hsRes.body.error.includes('中继不足'));
  check('hs 仍 off（未半启动）', node.relays().length < 3 && (await hit('GET', '/roles', undefined, false)).body.hs.on === false);

  // ---- 7) HS 入参校验：缺/坏 port → 400 ----
  const hsBad = await hit('POST', '/hs/start', { host: '127.0.0.1', port: 0 });
  check('POST /hs/start 非法 port → 400', hsBad.status === 400);

  // ---- 8) 直接打 RoleManager（非 HTTP）：startMine 幂等 + stopMine 生效 ----
  const sBefore = roleManager.status();
  roleManager.startMine(30); // 已在挖 → no-op
  check('RoleManager.startMine 幂等（仍 on）', roleManager.status().mine.on === true && sBefore.mine.on === true);
  roleManager.stopMine();
  check('RoleManager.stopMine 生效（off）', roleManager.status().mine.on === false);
  const mineStopHttp = await hit('GET', '/roles', undefined, false);
  check('GET /roles 反映 mine 已停', mineStopHttp.body.mine.on === false);

  // ---- 9) roles 未接线时的占位（用一个不带 roles 的临时 api）----
  const bareToken = 'bare';
  const bareApi = startHttpApi(node, API_PORT + 1, bareToken); // 不传 roleManager
  await sleep(120);
  const bareRoles = await (await fetch(`http://127.0.0.1:${API_PORT + 1}/roles`)).json() as any;
  check('未接 RoleManager 时 GET /roles 回全 off 占位', bareRoles.relay.on === false && bareRoles.mine.on === false);
  const bareStart = await fetch(`http://127.0.0.1:${API_PORT + 1}/relay/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bareToken}` },
  });
  check('未接 RoleManager 时 POST /relay/start → 400', bareStart.status === 400);
  bareApi.close();

  // ---- 收尾：确保无活动角色泄漏 ----
  await roleManager.stopRelay();
  await roleManager.stopHs();
  roleManager.stopMine();
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
