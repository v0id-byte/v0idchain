// 本地 HTTP 控制接口：CLI 子命令（send/balance/mine…）通过它和运行中的节点对话。
// 用 node:http，零额外依赖。只监听 127.0.0.1。
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { isValidAddress } from '@v0idchain/core';
import type { V0idNode } from './node.js';

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

export function startHttpApi(node: V0idNode, port: number, token: string) {
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
          case '/mempool':
            return json(200, node.bc.mempool);
          case '/peers':
            return json(200, node.p2p.peerList());
          case '/market':
            return json(200, node.market());
          case '/balance': {
            const address = url.searchParams.get('address') || node.wallet.address;
            return json(200, { address, balance: node.bc.balanceOf(address) });
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
            const r = node.send(String(body.to), Number(body.amount), String(body.memo ?? ''));
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
        }
      }

      json(404, { error: 'not found' });
    } catch (e) {
      json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
