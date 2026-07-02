// A.2 在线核销服务（`.v0id` 隐藏服务前端）。第三方付费站点（≠铸币厂）在放行前把访客券**匿名**提交给铸币厂核销：
//   站点经自身电路连本服务 → 铸币厂看不到站点 IP（保匿名，对齐 thesis「匿名优先」与用户选定的 .v0id 触达方式）；
//   服务侧调 `MintDaemon.spend` 原子核销（验签 + 全局标记已花 + 记 owed）→ 回 ok/spent。全局已花集是唯一权威 →
//   同一张券给第二个站点核销必被拒 = **跨服务方双花归零**（PAYWALL-PROTOCOL §3B）。放行只多一次链下洋葱往返，不碰链。
//
// 协议（隧道内，u32be 长度前缀 JSON 帧，单次请求-应答后关通道）：
//   站点→铸币厂  SPEND {"t":"spend","v":1,"provider":"0x…","vouchers":[[denom,"serial","sig"], …]}
//   铸币厂→站点  OK    {"t":"ok","gross":N}   /   ERR {"t":"err","code":"spent|invalid|bad"}
import { randomBytes } from 'node:crypto';
import { generateOnionKeypair, utf8ToBytes, type OnionKeypair } from '@v0idchain/core';
import { HiddenService } from '../relay/hsservice.js';
import { connectHiddenService, type RdvChannel } from '../relay/hsclient.js';
import type { HsDeps } from '../relay/hsbridge.js';
import type { MintDaemon } from './mintd.js';
import type { MintToken } from './token.js';

const CHUNK = 400; // 单 cell 净荷上限 ~461B，取 400 留余量（与 paywall/hsbridge 同口径）
const REQ_TIMEOUT_MS = 15_000; // 单次核销请求封顶（含建路+洋葱往返）
const MAX_FRAME = 64 * 1024; // 单帧上限（一次可核销几十张券，够用且防内存滥用）

function sendFrame(ch: RdvChannel, obj: unknown): void {
  const json = utf8ToBytes(JSON.stringify(obj));
  const f = new Uint8Array(4 + json.length);
  new DataView(f.buffer).setUint32(0, json.length, false); // big-endian 长度前缀
  f.set(json, 4);
  for (let o = 0; o < f.length; o += CHUNK) ch.send(f.subarray(o, o + CHUNK));
}

function readFrame(ch: RdvChannel, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = new Uint8Array(0);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('核销请求超时'));
    }, timeoutMs);
    ch.onClose(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('核销通道关闭'));
    });
    ch.onData((b) => {
      if (done) return;
      const n = new Uint8Array(buf.length + b.length);
      n.set(buf, 0);
      n.set(b, buf.length);
      buf = n;
      if (buf.length < 4) return;
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (len > MAX_FRAME) {
        done = true;
        clearTimeout(timer);
        return reject(new Error('核销帧过大'));
      }
      if (buf.length < 4 + len) return; // 未收全 → 等更多 cell
      done = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + len))));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('核销帧 JSON 非法'));
      }
    });
  });
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
            sendFrame(channel, { t: 'err', code: 'bad' });
            return void channel.close();
          }
          const vouchers: MintToken[] = msg.vouchers.map((a: any) => (Array.isArray(a) ? { denom: a[0], serial: a[1], sig: a[2] } : a));
          try {
            const { gross } = opts.daemon.spend(vouchers, msg.provider); // 原子核销：验签 + 全局标记已花 + 记 owed
            spendCount++;
            sendFrame(channel, { t: 'ok', gross });
          } catch (e) {
            sendFrame(channel, { t: 'err', code: classifySpendError(e) });
          }
          channel.close(); // 单次请求-应答，随即关通道
        })
        .catch(() => channel.close());
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

/** 便捷封装：站点仅知铸币厂 `.v0id` 地址时，自建电路 → 核销 → 关通道。供在线 acceptor 复用。 */
export async function spendViaMint(mintAddr: string, deps: HsDeps, vouchers: MintToken[], provider: string): Promise<SpendVerdict> {
  const { channel } = await connectHiddenService(mintAddr, deps.buildCircuit, deps.directory);
  try {
    return await requestMintSpend(channel, vouchers, provider);
  } finally {
    channel.close();
  }
}
