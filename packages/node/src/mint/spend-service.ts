// A.2 在线核销服务（`.v0id` 隐藏服务前端）。第三方付费站点（≠铸币厂）在放行前把访客券**匿名**提交给铸币厂核销：
//   站点经自身电路连本服务 → 铸币厂看不到站点 IP（保匿名，对齐 thesis「匿名优先」与用户选定的 .v0id 触达方式）；
//   服务侧调 `MintDaemon.spend` 原子核销（验签 + 全局标记已花 + 记 owed）→ 回 ok/spent。全局已花集是唯一权威 →
//   同一张券给第二个站点核销必被拒 = **跨服务方双花归零**（PAYWALL-PROTOCOL §3B）。放行只多一次链下洋葱往返，不碰链。
//
// 协议（隧道内，单次请求-应答后关通道）。帧按 cell 分片，**每片带 [u16 序号][u16 总片数] 头 → 顺序无关重组**
// （mixnet 逐跳延迟会让 RDV cell 乱序到达，纯按到达顺序拼接会串错；故按序号收齐再拼）：
//   站点→铸币厂  SPEND {"t":"spend","v":1,"provider":"0x…","vouchers":[[denom,"serial","sig"], …]}
//   铸币厂→站点  OK    {"t":"ok","gross":N}   /   ERR {"t":"err","code":"spent|invalid|bad"}
import { randomBytes } from 'node:crypto';
import { generateOnionKeypair, utf8ToBytes, MINT_ADDRESS, type OnionKeypair } from '@v0idchain/core';
import { HiddenService } from '../relay/hsservice.js';
import { connectHs, type HsDeps } from '../relay/hsbridge.js';
import type { RdvChannel } from '../relay/hsclient.js';
import type { VoucherVerifier, VoucherVerdict } from '../relay/paywall.js';
import type { MintDaemon } from './mintd.js';
import { verifyToken, type MintToken } from './token.js';

const HDR = 4; // 每 cell 头：[u16 序号][u16 总片数]
const CHUNK = 400; // 每 cell 净荷上限（单 cell ~461B 减去头，留余量；与 paywall/hsbridge 同口径）
const REQ_TIMEOUT_MS = 15_000; // 单次核销请求封顶（含建路 + 洋葱往返）
const REPLY_GRACE_MS = 3_000; // 服务方发完应答后**宽限**再关通道（不与应答同 tick 关，防 mixnet 下 DESTROY 抢在被延迟的应答之前到）
const MAX_FRAME = 64 * 1024; // 单帧总字节上限（一次可核销几十张券，够用且防内存滥用）
const MAX_CELLS = 256; // 单帧分片数上限（防伪造巨大 count）

/** 把一个对象编成带序号分片的帧发出（顺序无关：接收端按序号重组）。 */
function sendFrame(ch: RdvChannel, obj: unknown): void {
  const json = utf8ToBytes(JSON.stringify(obj));
  const count = Math.max(1, Math.ceil(json.length / CHUNK));
  for (let i = 0; i < count; i++) {
    const chunk = json.subarray(i * CHUNK, (i + 1) * CHUNK);
    const cell = new Uint8Array(HDR + chunk.length);
    const dv = new DataView(cell.buffer);
    dv.setUint16(0, i, false); // 序号
    dv.setUint16(2, count, false); // 总片数
    cell.set(chunk, HDR);
    ch.send(cell);
  }
}

/** 读回一个帧：按序号收齐所有分片再拼接解析（乱序到达也正确）。超时/通道关 → 抛。 */
function readFrame(ch: RdvChannel, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const parts = new Map<number, Uint8Array>();
    let count = -1;
    let bytes = 0;
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('核销请求超时')), timeoutMs);
    ch.onClose(() => fail(new Error('核销通道关闭')));
    ch.onData((b) => {
      if (done || b.length < HDR) return;
      const dv = new DataView(b.buffer, b.byteOffset, HDR);
      const idx = dv.getUint16(0, false);
      const cnt = dv.getUint16(2, false);
      if (cnt < 1 || cnt > MAX_CELLS) return fail(new Error('核销帧分片数异常'));
      if (idx >= cnt || parts.has(idx)) return; // 越界/重复片 → 忽略（RFC6479 已挡重放，这里再防御一层）
      count = cnt;
      const chunk = b.subarray(HDR);
      bytes += chunk.length;
      if (bytes > MAX_FRAME) return fail(new Error('核销帧过大'));
      parts.set(idx, chunk);
      if (parts.size < count) return; // 未集齐（顺序无关，收齐 count 片即可）
      const merged = new Uint8Array(bytes);
      let off = 0;
      for (let i = 0; i < count; i++) {
        merged.set(parts.get(i)!, off);
        off += parts.get(i)!.length;
      }
      done = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(new TextDecoder().decode(merged)));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('核销帧 JSON 非法'));
      }
    });
  });
}

/** 发完应答后**宽限再关**通道：不与应答同 tick 关，避免 mixnet 下即时传播的 DESTROY 抢在被延迟的应答之前到达客户端。 */
function replyThenClose(ch: RdvChannel, reply: unknown): void {
  sendFrame(ch, reply);
  const t = setTimeout(() => ch.close(), REPLY_GRACE_MS);
  t.unref?.(); // 别因宽限定时器拖住进程退出
}

export interface MintSpendServiceOptions {
  daemon: MintDaemon; // 铸币厂守护（掌 MINT 钱包 + 全局已花集 + owed 账本）
  deps: HsDeps; // 选路器 + 中继目录
  seed?: Uint8Array; // hs 身份种子（→ .v0id 地址）；省略则随机（**生产应持久化以固定地址**，同 serveHiddenService 纪律）
  onion?: OnionKeypair; // 服务静态 onion 钥；省略则随机
  numIntros?: number;
}

/**
 * 托管铸币厂在线核销服务。返回 `.v0id` 地址（告知第三方站点作 `--mint <addr>.v0id`）+ stop。
 * 身份（seed/onion）由调用方提供并持久化以固定地址；未提供则随机（仅测试/临时）。
 */
export async function serveMintSpendService(
  opts: MintSpendServiceOptions,
): Promise<{ address: string; stop: () => void; getSpendCount: () => number }> {
  let spendCount = 0;
  const svc = new HiddenService({
    seed: opts.seed ?? randomBytes(32),
    onion: opts.onion ?? generateOnionKeypair(),
    build: opts.deps.buildCircuit,
    dir: opts.deps.directory,
    numIntros: opts.numIntros,
    handler: (channel) => {
      readFrame(channel, REQ_TIMEOUT_MS)
        .then((msg) => {
          if (!msg || msg.t !== 'spend' || !Array.isArray(msg.vouchers) || typeof msg.provider !== 'string') {
            return void replyThenClose(channel, { t: 'err', code: 'bad' });
          }
          const vouchers: MintToken[] = msg.vouchers.map((a: any) => (Array.isArray(a) ? { denom: a[0], serial: a[1], sig: a[2] } : a));
          try {
            const { gross } = opts.daemon.spend(vouchers, msg.provider); // 原子核销：验签 + 全局标记已花 + 记 owed
            spendCount++;
            replyThenClose(channel, { t: 'ok', gross });
          } catch (e) {
            replyThenClose(channel, { t: 'err', code: classifySpendError(e) });
          }
        })
        .catch(() => channel.close()); // 读请求就失败（超时/通道关）→ 无应答可发，直接关
    },
  });
  await svc.start();
  return { address: svc.address, stop: () => svc.stop(), getSpendCount: () => spendCount };
}

/** spend 抛错 → 协议 code（供站点区分：已花 / 验签失败 / 其它）。 */
function classifySpendError(e: unknown): 'spent' | 'invalid' | 'bad' {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes('双花') || m.includes('已兑现')) return 'spent';
  if (m.includes('验签')) return 'invalid';
  return 'bad';
}

export interface SpendVerdict {
  ok: boolean;
  gross?: number; // ok 时 = 核销面额
  code?: string; // 拒时 = spent|invalid|bad
}

/** 站点侧：经一条已连到铸币厂核销服务的通道核销一批券。返回放行判定（不抛协议错，超时/断开由通道层抛）。 */
export async function requestMintSpend(channel: RdvChannel, vouchers: MintToken[], provider: string): Promise<SpendVerdict> {
  sendFrame(channel, { t: 'spend', v: 1, provider, vouchers: vouchers.map((v) => [v.denom, v.serial, v.sig]) });
  const msg = await readFrame(channel, REQ_TIMEOUT_MS);
  if (msg?.t === 'ok') return { ok: true, gross: msg.gross };
  if (msg?.t === 'err') return { ok: false, code: msg.code };
  return { ok: false, code: 'bad' };
}

/**
 * 便捷封装：站点仅知铸币厂 `.v0id` 地址时，自建电路 → 核销 → 关通道。供在线 acceptor 复用。
 * 用 `connectHs`（多次有界重试）而非裸 `connectHiddenService`：单次 fetch/RP/INTRODUCE 可能瞬时失败，
 * 与 SOCKS/桥接的 HS 客户端路径同款重试 → 健康的核销服务不会因一次瞬断而误拒有效付费访问。
 */
export async function spendViaMint(mintAddr: string, deps: HsDeps, vouchers: MintToken[], provider: string): Promise<SpendVerdict> {
  const { channel } = await connectHs(mintAddr, deps);
  try {
    return await requestMintSpend(channel, vouchers, provider);
  } finally {
    channel.close();
  }
}

/**
 * 第三方付费站点用的**在线核销 VoucherVerifier**（A.2）：放行前把访客券提交给铸币厂 `.v0id` 核销服务，防跨服务方双花。
 * @param mintHsAddr 铸币厂核销服务的 `.v0id` 地址（≠铸币厂钱包地址）。@param provider 站点收款地址（mint 记 owed[provider]，日后 settle 得款）。
 * @param mintAddress 铸币厂**钱包**地址（验签用；默认共识常量 MINT_ADDRESS，测试传本地 mint 地址）。
 *
 * verify()：**先本地做可离线判定的部分**——验签（对公开的 mintAddress）+ 批内不重复 + 面额和 ≥ price。这既省掉对无效/不足券的
 * 洋葱往返，又**确保只把签名有效且够额的券送去核销**（否则铸币厂会把不够额的券也标记已花 → 站点收了被烧的券却仍欠费）。
 * 本地全过 → 才 `spendViaMint` 让铸币厂原子核销（全局防双花 + 记 owed）。连不上铸币厂/超时 → 抛，由 runPaywallServer 归一为未付费。
 */
export function makeOnlineVerifier(mintHsAddr: string, deps: HsDeps, provider: string, mintAddress: string = MINT_ADDRESS): VoucherVerifier {
  return {
    async verify(vouchers: MintToken[], price: number): Promise<VoucherVerdict> {
      if (!Array.isArray(vouchers) || vouchers.length === 0) return { ok: false, gross: 0, code: 'insufficient', need: price, got: 0 };
      const seen = new Set<string>();
      let gross = 0;
      for (const v of vouchers) {
        if (!v || typeof v.serial !== 'string' || !verifyToken(v, mintAddress)) return { ok: false, gross: 0, code: 'invalid' };
        if (seen.has(v.serial)) return { ok: false, gross: 0, code: 'spent' }; // 批内重复 → 按已花处理
        seen.add(v.serial);
        gross += v.denom;
      }
      if (gross < price) return { ok: false, gross, code: 'insufficient', need: price, got: gross };
      // 本地 sig+面额已过 → 提交铸币厂原子核销（全局防双花 + 记 owed[provider]）；多一次链下洋葱往返，仍不碰链。
      const v = await spendViaMint(mintHsAddr, deps, vouchers, provider);
      if (v.ok) return { ok: true, gross: v.gross ?? gross };
      return { ok: false, gross: 0, code: v.code === 'spent' ? 'spent' : 'invalid' };
    },
  };
}
