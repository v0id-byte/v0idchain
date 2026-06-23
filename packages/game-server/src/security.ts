// 上线前安全硬化：安全响应头、CORS 白名单、每 IP 速率限制、入参严格校验。
// 本服务不持任何用户私钥（/api/tx 只广播已签名交易），但它即将与生产业务(pianotuner)共机，
// 故把面向公网的攻击面收紧到最小：绑本机 + 严格头 + 限流 + 拒绝畸形输入。节点仍是共识权威，这里只做廉价前置拦截。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidAddress } from '@v0idchain/core';
import { CORS_ORIGINS, MAX_BODY_BYTES, MAX_LAYOUT_BYTES, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from './config.js';

/** 取客户端 IP。信任本机 nginx 反代的 X-Forwarded-For 首段；否则用 socket 远端地址。 */
export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * 安全响应头（所有响应都带）。CSP 用 API 级最严格策略（无脚本/对象/框架来源），
 * 反代/前端各自的页面 CSP 由前端负责，这里只锁住 JSON API 本身。
 */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-permitted-cross-domain-policies': 'none',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * 计算一次响应应附带的全部安全头 + 按 origin 命中的 CORS 头。
 * - 只有 origin 命中白名单才回显该 origin（绝不 '*'）；未命中则不回 CORS 头（浏览器据此拦截）。
 * - 始终回 Vary: Origin，避免缓存把某个 origin 的 CORS 决策错配给另一个。
 */
export function securityHeaders(req: IncomingMessage): Record<string, string> {
  const h: Record<string, string> = { ...SECURITY_HEADERS, vary: 'Origin' };
  const origin = req.headers.origin;
  if (typeof origin === 'string' && CORS_ORIGINS.includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-methods'] = 'GET, POST, PUT, OPTIONS';
    h['access-control-allow-headers'] = 'content-type';
    h['access-control-max-age'] = '600';
  }
  return h;
}

/** 读取请求体并强制大小上限：累计超过 MAX_BODY_BYTES 立即销毁连接，挡住超大 body 撑爆内存。 */
export function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    let bytes = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        resolve({});
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// —— 每 IP 速率限制（固定窗口计数，内存实现，无新依赖）——
const hits = new Map<string, { count: number; resetAt: number }>();

/** 写端点限流：同一 IP 在 RATE_LIMIT_WINDOW_MS 窗口内超过 RATE_LIMIT_MAX 次即拒。返回 true=放行。 */
export function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now >= rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (rec.count >= RATE_LIMIT_MAX) return false;
  rec.count++;
  return true;
}

// 定期清理过期窗口，避免 map 无界增长（unref：不阻止进程退出）。
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now >= rec.resetAt) hits.delete(ip);
}, RATE_LIMIT_WINDOW_MS).unref();

// —— 入参校验：廉价前置拦截畸形输入，节点仍做共识级完整校验 ——
const HEX64 = /^0x[0-9a-f]{64}$/; // 地址（= isValidAddress）
const HEX_SIG = /^[0-9a-f]{1,256}$/; // ed25519 签名 hex（128 hex；放宽到 256 容错）
const HEX_TXID = /^[0-9a-f]{64}$/; // txid = sha256 hex（无 0x 前缀）

function isSafeNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * 校验一笔“已签名交易”的形状与字段合法性（不验签——那是节点的活；这里只挡明显畸形/注入/超界）。
 * 通过返回 null；不通过返回简短中文错误。
 */
export function validateSignedTx(tx: unknown): string | null {
  if (!tx || typeof tx !== 'object') return '缺少或非法的已签名 tx';
  const t = tx as Record<string, unknown>;
  if (typeof t.from !== 'string' || !HEX64.test(t.from)) return 'from 地址格式无效';
  if (typeof t.to !== 'string' || !HEX64.test(t.to)) return 'to 地址格式无效';
  if (!isSafeNonNegInt(t.amount)) return 'amount 必须为非负安全整数';
  if (!isSafeNonNegInt(t.fee)) return 'fee 必须为非负安全整数';
  if (!isSafeNonNegInt(t.nonce)) return 'nonce 必须为非负安全整数';
  if (t.burn !== undefined && !isSafeNonNegInt(t.burn)) return 'burn 必须为非负安全整数';
  if (typeof t.memo !== 'string' || [...t.memo].length > 512) return 'memo 非法或超长';
  if (typeof t.signature !== 'string' || !HEX_SIG.test(t.signature)) return 'signature 格式无效';
  if (typeof t.txid !== 'string' || !HEX_TXID.test(t.txid)) return 'txid 格式无效';
  if (typeof t.timestamp !== 'number' || !Number.isFinite(t.timestamp)) return 'timestamp 非法';
  return null;
}

/** 校验房间布局字符串：非空且不超字节上限（挡住超大布局占盘/占内存）。 */
export function validateLayout(layout: string): string | null {
  if (!layout) return '布局不能为空';
  if (Buffer.byteLength(layout, 'utf8') > MAX_LAYOUT_BYTES) return '布局过大';
  return null;
}

/** 校验 txid 查询参数（GET /api/tx）：必须是 64-hex sha256。 */
export function isValidTxid(txid: string): boolean {
  return HEX_TXID.test(txid);
}

/** 复用：地址校验（与 core 一致，便于 server 统一从 security 取）。 */
export { isValidAddress };
