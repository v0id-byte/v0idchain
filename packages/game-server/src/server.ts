// 游戏服务器 HTTP 接口（阶段 0）：链只读代理 + 提交已签名交易 + faucet + 房间。
// CORS 放开（'*'）是安全的：本服务**不持有任何用户私钥**——/api/tx 只广播“已签名”交易（无特权），
// /api/faucet 由限额+限速+全局上限把关（非 CORS）。这与节点本地 API（用节点私钥代签，必须锁 localhost）不同。
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { isValidAddress, petsOf, parsePets } from '@v0idchain/core';
import type { Transaction } from '@v0idchain/core';
import { PORT } from './config.js';
import * as chain from './chain.js';
import { dispense } from './faucet.js';
import { getRoom, putRoom, listRoomAddresses } from './rooms.js';

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export function startServer(): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    try {
      if (req.method === 'GET') {
        switch (p) {
          case '/health':
            return json(200, { ok: true });
          case '/api/info':
            return json(200, await chain.getInfo());
          case '/api/names':
            return json(200, await chain.getNames());
          case '/api/rooms': {
            // 串门名册：所有已发布房间的属主（带链上昵称）。
            const addrs = listRoomAddresses();
            const reg = (await chain.getNames()) as { addressToName?: Record<string, string> };
            return json(200, addrs.map((a) => ({ address: a, name: reg.addressToName?.[a] })));
          }
          case '/api/market':
            return json(200, await chain.getMarket());
          case '/api/chain':
            return json(200, await chain.getChain());
          case '/api/balance': {
            const address = url.searchParams.get('address') ?? '';
            if (!isValidAddress(address)) return json(400, { error: '地址格式无效' });
            return json(200, { address, balance: await chain.getBalance(address) });
          }
          case '/api/nonce': {
            const address = url.searchParams.get('address') ?? '';
            if (!isValidAddress(address)) return json(400, { error: '地址格式无效' });
            return json(200, { address, nonce: await chain.getNonce(address) });
          }
          case '/api/pets': {
            const address = url.searchParams.get('address');
            const bc = await chain.snapshot();
            // 不带 address → 全部崽；带 address → 该地址当前拥有的崽（服务器算好省客户端整链扫描）
            return json(200, address ? petsOf(bc.chain, address) : parsePets(bc.chain));
          }
          case '/api/room': {
            const address = url.searchParams.get('address') ?? '';
            if (!isValidAddress(address)) return json(400, { error: '地址格式无效' });
            const rec = getRoom(address);
            const chainHash = await chain.latestRoomHash(address); // 链上最新版本,供客户端校验
            return json(200, { ...(rec ?? { layout: null }), chainHash });
          }
          case '/api/tx': {
            const txid = url.searchParams.get('txid') ?? '';
            if (!txid) return json(400, { error: '缺少 txid' });
            return json(200, await chain.getTxStatus(txid));
          }
        }
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        switch (p) {
          case '/api/faucet':
            return json(200, await dispense(String(body.address ?? ''), clientIp(req)));
          case '/api/tx': {
            const tx = body.tx as Transaction | undefined;
            if (!tx || typeof tx.txid !== 'string' || typeof tx.signature !== 'string') {
              return json(400, { error: '缺少或非法的已签名 tx' });
            }
            const r = await chain.submitSigned(tx);
            return r.ok ? json(200, { ok: true, txid: r.txid }) : json(400, { error: r.error });
          }
        }
      }

      if (req.method === 'PUT' && p === '/api/room') {
        const body = await readBody(req);
        const address = String(body.address ?? '');
        const layout = String(body.layout ?? '');
        if (!isValidAddress(address)) return json(400, { error: '地址格式无效' });
        if (!layout) return json(400, { error: '布局不能为空' });
        return json(200, putRoom(address, layout, body.versionTx ? String(body.versionTx) : undefined));
      }

      json(404, { error: 'not found' });
    } catch (e) {
      // 上游节点不可达等：回 502，附原因，别甩堆栈
      json(502, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`✖ 游戏服务器端口 ${PORT} 已被占用——换 GAME_PORT，或先关掉占用它的进程。`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(PORT);
  return server;
}
