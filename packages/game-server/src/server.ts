// 游戏服务器 HTTP 接口（阶段 0）：链只读代理 + 提交已签名交易 + faucet + 房间。
// 安全姿态：绑 127.0.0.1（只接本机 nginx 反代）、所有响应带安全头、CORS 走白名单（非 '*'）、
// 写端点每 IP 限流 + 请求体限大小、入参严格校验、错误只回简短信息不甩堆栈。
// 本服务**不持有任何用户私钥**——/api/tx 只广播“已签名”交易（无特权）；节点仍是共识权威。
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { petsOf, parsePets, fishOf, parseFish, farmOf, parseFarm } from '@v0idchain/core';
import type { Transaction } from '@v0idchain/core';
import { PORT, BIND } from './config.js';
import * as chain from './chain.js';
import { dispense } from './faucet.js';
import { getRoom, putRoom, listRoomAddresses } from './rooms.js';
import {
  clientIp,
  securityHeaders,
  readBody,
  rateLimitOk,
  validateSignedTx,
  validateLayout,
  isValidTxid,
  isValidAddress,
} from './security.js';

export function startServer(): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const headers = securityHeaders(req); // 安全头 + 命中白名单的 CORS 头，附在每个响应上
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    try {
      if (req.method === 'GET') {
        switch (p) {
          case '/health':
            // 不泄露敏感信息：只回存活 + 链高（无密钥/peer 内网地址/版本细节）。
            return json(200, { ok: true, height: await chain.height().catch(() => null) });
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
            if (address !== null && !isValidAddress(address)) return json(400, { error: '地址格式无效' });
            const bc = await chain.snapshot();
            // 不带 address → 全部崽；带 address → 该地址当前拥有的崽（服务器算好省客户端整链扫描）
            return json(200, address ? petsOf(bc.chain, address) : parsePets(bc.chain));
          }
          case '/api/fish': {
            // 只读：扫链还原渔获（parseFish 过滤 FISH| 自转烧币）。无写端点——铸造由客户端本地签名走 /api/tx。
            const address = url.searchParams.get('address');
            if (address !== null && !isValidAddress(address)) return json(400, { error: '地址格式无效' });
            const bc = await chain.snapshot();
            return json(200, address ? fishOf(bc.chain, address) : parseFish(bc.chain));
          }
          case '/api/farm': {
            // 只读：扫链还原农场（parseFarm 过滤 LAND/ZONE/PLANT/HARVEST 自转烧币）+ 动态地价预算。
            // 无写端点——买地/建区块/种植/收获均由客户端本地签名走 /api/tx（系统零增发）。
            const address = url.searchParams.get('address');
            if (address !== null && !isValidAddress(address)) return json(400, { error: '地址格式无效' });
            const bc = await chain.snapshot();
            return json(200, address ? farmOf(bc.chain, address) : parseFarm(bc.chain));
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
            if (!isValidTxid(txid)) return json(400, { error: 'txid 格式无效' });
            return json(200, await chain.getTxStatus(txid));
          }
        }
      }

      if (req.method === 'POST') {
        // 写端点：每 IP 限流（挡住单机刷量/暴力探测）。
        if (!rateLimitOk(clientIp(req))) return json(429, { error: '请求过于频繁，稍后再试' });
        const body = await readBody(req);
        switch (p) {
          case '/api/faucet':
            return json(200, await dispense(String(body.address ?? ''), clientIp(req)));
          case '/api/tx': {
            const invalid = validateSignedTx(body.tx);
            if (invalid) return json(400, { error: invalid });
            const r = await chain.submitSigned(body.tx as Transaction);
            return r.ok ? json(200, { ok: true, txid: r.txid }) : json(400, { error: r.error });
          }
        }
      }

      if (req.method === 'PUT' && p === '/api/room') {
        if (!rateLimitOk(clientIp(req))) return json(429, { error: '请求过于频繁，稍后再试' });
        const body = await readBody(req);
        const address = String(body.address ?? '');
        const layout = String(body.layout ?? '');
        if (!isValidAddress(address)) return json(400, { error: '地址格式无效' });
        const badLayout = validateLayout(layout);
        if (badLayout) return json(400, { error: badLayout });
        return json(200, putRoom(address, layout, body.versionTx ? String(body.versionTx) : undefined));
      }

      json(404, { error: 'not found' });
    } catch (e) {
      // 上游节点不可达等：回 502。不向外暴露堆栈/内部路径——细节只进服务端日志。
      console.error('[game-server] 请求处理出错:', e instanceof Error ? e.message : e);
      json(502, { error: '上游服务暂时不可用' });
    }
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`✖ 游戏服务器端口 ${PORT} 已被占用——换 GAME_PORT，或先关掉占用它的进程。`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(PORT, BIND);
  return server;
}
