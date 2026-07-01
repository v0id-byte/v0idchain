// 本地 HTTP 控制接口：CLI 子命令（send/balance/mine…）通过它和运行中的节点对话。
// 用 node:http，零额外依赖。只监听 127.0.0.1。
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { STAKING_ACTIVATION_HEIGHT, isValidAddress, minFeeFor } from '@v0idchain/core';
import type { V0idNode } from './node.js';
import type { RoleManager } from './relay/rolemanager.js';

const MAX_LIGHT_BLOCK_RANGE = 10_000;
const MAX_HEADER_RANGE = 100_000;
const MAX_ADDRESS_PROOF_SPAN = 100_000;

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// roles 可选：传入则暴露 GET /roles（只读）+ 角色启停 POST（令牌门控）。不传 = 既有行为不变（4 参可选，不破坏调用方）。
export function startHttpApi(node: V0idNode, port: number, token: string, roles?: RoleManager) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // CORS 只放行本机（localhost/127.0.0.1）页面，绝不用 '*'：
    // 否则你浏览的任意恶意网站都能 fetch 本机正在运行的节点 POST /send 盗币（本地 CSRF）。
    const origin = req.headers.origin;
    const cors: Record<string, string> = {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      // 含 authorization：否则浏览器对带 Bearer 的 POST 预检会失败（仪表盘转账/挖矿全 Failed to fetch）
      'access-control-allow-headers': 'content-type, authorization',
      vary: 'Origin',
    };
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      cors['access-control-allow-origin'] = origin;
    }
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify(obj));
    };

    // CORS 预检：浏览器对 POST + JSON 会先发 OPTIONS，必须带齐 CORS 头回 204，
    // 否则仪表盘的转账/水龙头/挖矿全部 “Failed to fetch”。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    try {
      if (req.method === 'GET') {
        switch (url.pathname) {
          case '/health':
            return json(200, { ok: true });
          case '/info':
            return json(200, node.info());
          case '/chain':
            return json(200, node.bc.chain);
          case '/headers': {
            const from = Number(url.searchParams.get('from') ?? 0);
            const requestedTo = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : node.bc.height;
            if (!Number.isInteger(from) || !Number.isInteger(requestedTo) || from < 0 || requestedTo < from) {
              return json(400, { error: 'from/to 必须是合法高度范围' });
            }
            const to = Math.min(requestedTo, from + MAX_HEADER_RANGE - 1);
            return json(200, { from, to, total: node.bc.chain.length, headers: node.headers(from, to) });
          }
          case '/blocks': {
            const from = Number(url.searchParams.get('from'));
            const to = Number(url.searchParams.get('to'));
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
              return json(400, { error: 'from/to 必须是合法高度范围' });
            }
            const cappedTo = Math.min(to, from + MAX_LIGHT_BLOCK_RANGE - 1);
            return json(200, { from, to: cappedTo, total: node.bc.chain.length, blocks: node.blockRange(from, cappedTo) });
          }
          case '/recent': {
            const maxBlocks = Number(url.searchParams.get('maxBlocks') ?? 10_000);
            const minTimestamp = Number(url.searchParams.get('minTimestamp') ?? 0);
            if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || !Number.isFinite(minTimestamp)) {
              return json(400, { error: 'maxBlocks 必须是正整数，minTimestamp 必须是数字' });
            }
            return json(200, {
              maxBlocks: Math.min(maxBlocks, MAX_LIGHT_BLOCK_RANGE),
              minTimestamp,
              total: node.bc.chain.length,
              blocks: node.recentBlocks(Math.min(maxBlocks, MAX_LIGHT_BLOCK_RANGE), minTimestamp),
            });
          }
          case '/mempool':
            return json(200, node.bc.mempool);
          case '/peers':
            return json(200, node.p2p.peerList());
          case '/market':
            return json(200, node.market());
          case '/messages': {
            const address = url.searchParams.get('address') || node.wallet.address;
            return json(200, node.messages(address));
          }
          case '/newcomers':
            return json(200, node.recentNewcomers());
          case '/names':
            return json(200, node.names());
          case '/relays':
            return json(200, node.relays());
          case '/roles':
            // 角色状态（只读、无需令牌，与 /info 同级）：GUI 据此渲染中继/隐藏服务/挖矿开关。
            // 未接 RoleManager 时回全 off 的占位形，调用方无须区分。
            return json(200, roles?.status() ?? {
              socks: { on: false, port: null },
              relay: { on: false, port: null, address: null, circuits: 0, published: false },
              hsList: [],
              mine: { on: false, intervalMs: null },
            });
          case '/hs/lasterror': {
            // 最近一次 .v0id SOCKS 连接失败的具体原因（只读、无需令牌，与 /roles 同级）：GUI 拿 ERR_SOCKS_CONNECTION_FAILED
            // 后查它、把 Chromium 通用错误页换成中文原因。未接 RoleManager 或无记录 → 404。
            const addr = url.searchParams.get('addr') || '';
            const err = roles?.hsError(addr);
            return err ? json(200, err) : json(404, { error: 'not found' });
          }
          case '/redpackets':
            return json(200, node.redPackets());
          case '/balance': {
            const address = url.searchParams.get('address') || node.wallet.address;
            return json(200, { address, balance: node.bc.balanceOf(address) });
          }
          case '/stake':
            // 本节点自己的质押池（只读、无需令牌）：含锁定高度 / 已罚没 / 是否已赎回。GUI 中继板块据此展示。
            return json(200, node.stakes());
          case '/rewards':
            // 本节点收到的中继激励发放（只读）。引导期暂不发放 → 多半为空数组（见 INCENTIVE-PROTOCOL）。
            return json(200, node.rewards());
          case '/tx': {
            // 按 txid 查确认状态（只读、无需令牌）：客户端轮询“处理中 → 已到账”。
            const txid = url.searchParams.get('txid') || '';
            if (!txid) return json(400, { error: '缺少 txid 参数' });
            return json(200, node.txStatus(txid));
          }
          case '/tx-proof': {
            const txid = url.searchParams.get('txid') || '';
            if (!/^[0-9a-f]{64}$/.test(txid)) return json(400, { error: 'txid 必须是 64 位 hex' });
            const proof = node.txProof(txid);
            return proof ? json(200, proof) : json(404, { error: 'not found' });
          }
          case '/address-proofs': {
            const address = url.searchParams.get('address') || '';
            if (!isValidAddress(address)) return json(400, { error: 'address 必须是合法地址' });
            const from = Number(url.searchParams.get('from') ?? 0);
            const requestedTo = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : node.bc.height;
            if (!Number.isInteger(from) || !Number.isInteger(requestedTo) || from < 0 || requestedTo < from) {
              return json(400, { error: 'from/to 必须是合法高度范围' });
            }
            const to = Math.min(requestedTo, from + MAX_ADDRESS_PROOF_SPAN - 1);
            return json(200, { address, from, to, proofs: node.addressProofs(address, from, to) });
          }
        }
      }

      if (req.method === 'POST') {
        // 写接口（转账/挖矿/连接/集市）需 Bearer 令牌：挡住同机其他进程/用户直接调本地 API 盗币。
        // 读接口（GET）与 /health 不设防，方便仪表盘只读展示。
        if (req.headers.authorization !== `Bearer ${token}`) {
          return json(401, { error: 'unauthorized：缺少或错误的 API token' });
        }
        const body = await readBody(req);
        switch (url.pathname) {
          case '/send': {
            if (!isValidAddress(String(body.to))) return json(400, { error: '收款地址格式无效' });
            const amount = Number(body.amount);
            const fee = body.fee === undefined ? minFeeFor(amount) : Number(body.fee);
            const r = node.send(String(body.to), amount, String(body.memo ?? ''), fee);
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/message': {
            if (!isValidAddress(String(body.to))) return json(400, { error: '收件地址格式无效' });
            const text = String(body.text ?? '');
            if (!text) return json(400, { error: '消息正文不能为空' });
            const burn = body.burn === undefined ? undefined : Number(body.burn);
            const fee = body.fee === undefined ? undefined : Number(body.fee);
            const r = node.message(String(body.to), text, burn, fee, Boolean(body.encrypt));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/name/claim': {
            const r = node.claimName(String(body.name ?? ''));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/redpacket': {
            const r = node.redPacket(Number(body.total), Number(body.count), String(body.mode ?? 'r'));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/redpacket/grab': {
            const r = node.grabRedPacket(String(body.id));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/redpacket/refund': {
            const r = node.refundRedPacket(String(body.id));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/stake': {
            // 质押：转给托管地址 + memo STAKE|<role>，锁定 STAKE_MIN[role]。
            // 激活高度前 `STAKE|` 转托管仍会被旧/未激活共识当作普通转账，
            // 所以 API 必须先挡住，避免 Bearer 客户端把押金转进托管却不生成质押池。
            if (node.bc.height < STAKING_ACTIVATION_HEIGHT) {
              return json(400, { error: `质押尚未激活（当前高度 ${node.bc.height}，激活高度 ${STAKING_ACTIVATION_HEIGHT}）` });
            }
            const r = node.stake(String(body.role ?? '') as Parameters<typeof node.stake>[0]);
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/unstake': {
            // 赎回：amount=0 + memo UNSTAKE|<stakeId>，过锁定期后取回本金-已罚没。
            const r = node.unstake(String(body.stakeId ?? ''));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/mine': {
            const n = Number(body.blocks ?? 1);
            if (!Number.isInteger(n) || n < 1) return json(400, { error: 'blocks 必须是正整数' });
            const mined: string[] = [];
            for (let i = 0; i < n; i++) {
              const b = await node.mineOnce();
              if (b) mined.push(b.hash);
            }
            return json(200, { mined });
          }
          case '/connect': {
            node.p2p.connect(String(body.url), true); // 本地运营者显式连接：trusted
            return json(200, { ok: true });
          }
          case '/market/sell': {
            const r = node.marketSell(Number(body.price), String(body.title ?? ''));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/market/buy': {
            const r = node.marketBuy(String(body.id));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/market/delist': {
            const r = node.marketDelist(String(body.id));
            return r.ok ? json(200, { txid: r.tx!.txid }) : json(400, { error: r.error });
          }
          case '/tx/submit': {
            // 广播一笔“客户端已签名”的交易（自托管钱包 / 游戏 web 端）。节点只校验+广播，绝不代签。
            const tx = body.tx;
            if (!tx || typeof tx !== 'object' || typeof tx.txid !== 'string' || typeof tx.signature !== 'string') {
              return json(400, { error: '缺少或非法的 tx（需含 txid 与 signature 的已签名交易）' });
            }
            const r = node.acceptTx(tx as Parameters<typeof node.acceptTx>[0]);
            return r.ok ? json(200, { ok: true, txid: tx.txid }) : json(400, { error: r.error });
          }
          // ---- 角色运行时启停（Phase 2F-1，令牌门控；GUI 不重启守护即可切角色）----
          // 未接 RoleManager（headless 老用法）→ 400「未启用角色控制」。
          // 角色方法抛错（如链上中继 < 3、hs target 非法）→ 409 + {error}，进程不崩。每个成功都回最新 status()。
          case '/relay/start':
            if (!roles) return json(400, { error: '本节点未启用角色控制（RoleManager 未接线）' });
            try { return json(200, await roles.startRelay()); } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
          case '/relay/stop':
            if (!roles) return json(400, { error: '本节点未启用角色控制（RoleManager 未接线）' });
            try { return json(200, await roles.stopRelay()); } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
          case '/hs/start': {
            if (!roles) return json(400, { error: '本节点未启用角色控制（RoleManager 未接线）' });
            const host = String(body.host ?? '');
            const hport = Number(body.port);
            if (!host || !Number.isInteger(hport) || hport < 1 || hport > 65535) {
              return json(400, { error: 'hs 需合法 host 与 port（如 {"host":"127.0.0.1","port":8080}）' });
            }
            let intros: number | undefined;
            if (body.intros !== undefined) {
              intros = Number(body.intros);
              if (!Number.isInteger(intros) || intros < 1) return json(400, { error: 'intros 必须是 ≥1 的整数' });
            }
            const hsName = typeof body.name === 'string' ? body.name : '';
            try {
              const { id, address } = await roles.startHs({ host, port: hport }, { name: hsName, intros });
              return json(200, { id, address });
            } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
          }
          case '/hs/stop': {
            if (!roles) return json(400, { error: '本节点未启用角色控制（RoleManager 未接线）' });
            const stopId = typeof body.id === 'string' && body.id ? body.id : undefined;
            try { await roles.stopHs(stopId); return json(200, { ok: true }); } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
          }
          case '/wallet/import': {
            if (roles?.status().relay.on) {
              return json(409, { error: '中继运行中，请先停止中继再导入钱包（避免描述符与新钱包地址不一致）' });
            }
            const pk = String(body.privateKey ?? '');
            try {
              const address = node.importWallet(pk);
              return json(200, { address });
            } catch (e) { return json(400, { error: e instanceof Error ? e.message : String(e) }); }
          }
          case '/mine/start': {
            if (!roles) return json(400, { error: '本节点未启用角色控制（RoleManager 未接线）' });
            const iv = body.intervalMs === undefined ? 0 : Number(body.intervalMs);
            if (!Number.isInteger(iv) || iv < 0) return json(400, { error: 'intervalMs 必须是非负整数（0=连续挖）' });
            return json(200, roles.startMine(iv));
          }
          case '/mine/stop':
            if (!roles) return json(400, { error: '本节点未启用角色控制（RoleManager 未接线）' });
            return json(200, roles.stopMine());
        }
      }

      json(404, { error: 'not found' });
    } catch (e) {
      json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  // 端口被占等监听错误：给一行中文提示再退出，别甩一坨 Node 堆栈给用户
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`✖ API 端口 ${port} 已被占用——换 --api-port，或先关掉占用它的进程。`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, '127.0.0.1');
  return server;
}
