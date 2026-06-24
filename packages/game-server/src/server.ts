// 游戏服务器 HTTP 接口（阶段 0）：链只读代理 + 提交已签名交易 + faucet + 房间。
// 安全姿态：绑 127.0.0.1（只接本机 nginx 反代）、所有响应带安全头、CORS 走白名单（非 '*'）、
// 写端点每 IP 限流 + 请求体限大小、入参严格校验、错误只回简短信息不甩堆栈。
// 本服务**不持有任何用户私钥**——/api/tx 只广播“已签名”交易（无特权）；节点仍是共识权威。
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import {
  petsOf, parsePets, fishOf, parseFish, farmOf, parseFarm,
  parseNames, resolveAddressName, petRarity, deriveFeed, minesOf, parseMines,
} from '@v0idchain/core';
import type { Block, Transaction, FeedEvent, Rarity } from '@v0idchain/core';
import { PORT, BIND } from './config.js';
import * as chain from './chain.js';
import { dispense } from './faucet.js';
import { getRoom, putRoom, listRoomAddresses } from './rooms.js';
import { recordVisit, getVisitCount } from './visits.js';
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

// 动态流缓存：按链长度（区块数）作键，长度没变就直接复用上次聚合结果（deriveFeed 整链扫描，省得每次重算）。
let feedCache: { len: number; events: FeedEvent[] } | null = null;
function buildFeed(c: Block[]): FeedEvent[] {
  if (!feedCache || feedCache.len !== c.length) feedCache = { len: c.length, events: deriveFeed(c, 100) };
  return feedCache.events;
}

// 稀有度档位排序（越大越稀有），用于 profile 取“最高稀有度”/“稀有崽数”。
const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

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
          case '/api/mines': {
            const address = url.searchParams.get('address');
            if (address !== null && !isValidAddress(address)) return json(400, { error: '地址格式无效' });
            const bc = await chain.snapshot();
            return json(200, address ? minesOf(bc.chain, address) : parseMines(bc.chain));
          }
          case '/api/feed': {
            // 全网动态流（最新在前）。mode=all → 全部；mode=<合法地址> → 只看该 actor 的动态。limit ≤ 100（默认 80）。
            const mode = url.searchParams.get('mode') ?? 'all';
            const n = Number(url.searchParams.get('limit'));
            const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 80;
            const all = buildFeed(await chain.getChain()); // 按链长度缓存的整链聚合
            let events = mode !== 'all' && isValidAddress(mode) ? all.filter((e) => e.actor === mode) : all;
            if (events.length > limit) events = events.slice(0, limit);
            return json(200, { events });
          }
          case '/api/profile': {
            // 某地址的社交名片：链上聚合（昵称/余额/入链时间/崽/鱼/农场/烧币）+ 便利层（房间/串门数）。扁平 JSON 供前端直接用。
            const address = url.searchParams.get('address') ?? '';
            if (!isValidAddress(address)) return json(400, { error: '地址格式无效' });
            const bc = await chain.snapshot();
            const c = bc.chain;
            const nickname = resolveAddressName(parseNames(c), address);

            // 入链时间：首个出现该地址（作为 from 或 to）的区块/交易。都没有 → 0/0。
            let joinHeight = 0;
            let joinTimestamp = 0;
            outer: for (const b of c) {
              for (const tx of b.transactions) {
                if (tx.from === address || tx.to === address) {
                  joinHeight = b.index;
                  joinTimestamp = tx.timestamp;
                  break outer;
                }
              }
            }

            const pets = petsOf(c, address);
            const rarePets = pets.filter((p) => RARITY_RANK[petRarity(p.gene)] >= RARITY_RANK.epic).length;

            const fish = fishOf(c, address);
            let bestRarity: Rarity | undefined;
            for (const f of fish) {
              if (bestRarity === undefined || RARITY_RANK[f.traits.rarity] > RARITY_RANK[bestRarity]) {
                bestRarity = f.traits.rarity;
              }
            }

            const fv = farmOf(c, address);
            const farm = fv.plots.length || fv.zones.length || fv.crops.length
              ? { plots: fv.plots.length, zones: fv.zones.length, harvests: fv.crops.length }
              : null;

            // 累计烧币：该地址作为 from 的所有 burn 之和（私信/孵崽/钓鱼/农场动作等都烧进虚空）。
            let totalBurned = 0;
            for (const b of c) {
              for (const tx of b.transactions) {
                if (tx.from === address) totalBurned += tx.burn ?? 0;
              }
            }

            const room = getRoom(address);
            return json(200, {
              address,
              nickname, // 可能 undefined
              balance: bc.balanceOf(address),
              joinHeight,
              joinTimestamp,
              petCount: pets.length,
              rarePets, // epic + legendary
              fishCount: fish.length,
              bestRarity, // 可能 undefined
              farm, // { plots, zones, harvests } 或 null
              hasRoom: !!(room && room.layout),
              totalBurned,
              visitCount: getVisitCount(address),
            });
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
          case '/api/visit': {
            // 串门足迹：记 visitor 串了 target 的门（便利层，不上链）。自串忽略但仍 200。
            const visitor = String(body.visitor ?? '');
            const target = String(body.target ?? '');
            if (!isValidAddress(visitor)) return json(400, { error: 'visitor 地址格式无效' });
            if (!isValidAddress(target)) return json(400, { error: 'target 地址格式无效' });
            if (visitor !== target) recordVisit(visitor, target);
            return json(200, { ok: true, visitCount: getVisitCount(target) });
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
