// 隧道内付费墙协议（Phase A.1）。在已建好的 RdvChannel 之上跑一段**严格前缀**握手，通过后信道退化为透明字节管道。
//
// 速度铁律：放行（PAYOK）= 一次 verifyToken 验签（对公开常量 MINT_ADDRESS，µs 级）+ 查本地已花集（内存 O(1)），
//   **全程不碰链、不等出块**。访问延迟 = 隧道 RTT + 验签，与 8 秒出块时间无关。链只在「买券(访问前) / 结算(访问后)」
//   两处出现，都不在本握手里。价格由**已签名的 HS 描述符**携带（见 hsdesc.ts price 字段）→ 客户端连接前即知价，
//   **乐观预付**（PAY 作第一帧发出，不等服务方 PAYREQ）→ 付费墙只多一个隧道往返、零额外发现往返。
//
// 帧格式（控制阶段）：u32be 总长 ‖ 该长度的 UTF-8 JSON，可跨多 cell（RdvChannel.send 是单 cell，需自行分片累积）。
// PAYOK 之后不再分帧，纯透传（由 bridgeChannelToSocket 接管）。
//   访客→服务方  PAY   {"t":"pay","v":1,"vouchers":[[denom,"serial","sig"], …]}
//   服务方→访客  PAYOK {"t":"payok","v":1}                       → 之后桥接
//   服务方→访客  PAYERR{"t":"payerr","code":"insufficient|invalid|spent","need":N,"got":M}
import { verifyToken, type MintToken } from '../mint/token.js';
import { isValidAddress, utf8ToBytes } from '@v0idchain/core';
import type { RdvChannel } from './hsclient.js';

const RDV_CHUNK = 400; // 与 hsbridge 一致：单 cell 净荷上限 ~461B，取 400 留余量
const HANDSHAKE_TIMEOUT_MS = 10_000; // 付费握手封顶（防半死对端吊死连接）；纯隧道往返，正常几百 ms 内完成
const MAX_FRAME_BYTES = 16 * 1024; // 单帧上限（一次最多递几十张券，够用且防内存滥用）

/** 服务方对递进来的券做的判定：验签（对 MINT_ADDRESS）+ 未花过 + 面额和 ≥ price。 */
export interface VoucherVerdict {
  ok: boolean;
  gross: number; // 通过时 = 已受理的面额之和
  code?: 'insufficient' | 'invalid' | 'spent';
  need?: number;
  got?: number;
}

/**
 * 券受理器（服务方侧）：验签 + 本地防双花。**operator==mint 时本地已花集即全局集 → 零双花**（Phase A.1）；
 * 第三方服务方（A.2）应把 accept 换成「在线核销：提交给铸币厂原子性标记已花」以免跨服务方双花（见 PAYWALL-PROTOCOL §3）。
 */
export class VoucherAcceptor {
  private readonly mintAddress: string;
  private readonly spent: Set<string>;
  constructor(mintAddress: string, spent: Set<string> = new Set()) {
    this.mintAddress = mintAddress;
    this.spent = spent;
  }
  /** 已受理（已花）的券序列号——供 operator==mint 时与铸币厂兑现共享同一集合（构造时传入同一个 Set）。 */
  get spentSerials(): Set<string> {
    return this.spent;
  }
  /**
   * 判定一批券是否够付 price。**先只读校验全部（验签/未花/面额）**，全通过才一次性标记已花 →
   * 校验中途失败绝不留下"部分已花"的券（避免白白报废）。返回是否放行 + 受理面额。
   */
  accept(vouchers: MintToken[], price: number): VoucherVerdict {
    if (!Array.isArray(vouchers) || vouchers.length === 0) return { ok: false, gross: 0, code: 'insufficient', need: price, got: 0 };
    const seen = new Set<string>();
    let gross = 0;
    for (const v of vouchers) {
      if (!v || typeof v.serial !== 'string' || !verifyToken(v, this.mintAddress)) return { ok: false, gross: 0, code: 'invalid' };
      if (this.spent.has(v.serial) || seen.has(v.serial)) return { ok: false, gross: 0, code: 'spent' };
      seen.add(v.serial);
      gross += v.denom;
    }
    if (gross < price) return { ok: false, gross, code: 'insufficient', need: price, got: gross };
    for (const s of seen) this.spent.add(s); // 全通过 → 一次性核销
    return { ok: true, gross };
  }
}

// ---- 帧读写（控制阶段）----

function sendFrame(channel: RdvChannel, obj: unknown): void {
  const json = utf8ToBytes(JSON.stringify(obj));
  const framed = new Uint8Array(4 + json.length);
  new DataView(framed.buffer).setUint32(0, json.length, false); // big-endian 长度前缀
  framed.set(json, 4);
  for (let o = 0; o < framed.length; o += RDV_CHUNK) channel.send(framed.subarray(o, o + RDV_CHUNK));
}

/** 读回一个控制帧（累积 cell 到够长再解析）。返回 {msg, leftover}——leftover=帧之后多收的字节（A.1 正常为空，防御性透传给桥接）。 */
function readFrame(channel: RdvChannel, timeoutMs: number): Promise<{ msg: any; leftover: Uint8Array }> {
  return new Promise((resolve, reject) => {
    let buf = new Uint8Array(0);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('付费握手超时'));
    }, timeoutMs);
    channel.onClose(() => {
      // 握手期间通道被销毁（对端关/backend 预连失败即关通道）→ 快速失败，不必干等超时。
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('付费握手期间通道关闭'));
    });
    channel.onData((b) => {
      if (done) return;
      const next = new Uint8Array(buf.length + b.length);
      next.set(buf, 0);
      next.set(b, buf.length);
      buf = next;
      if (buf.length < 4) return;
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
      if (len > MAX_FRAME_BYTES) {
        done = true;
        clearTimeout(timer);
        return reject(new Error('付费帧过大'));
      }
      if (buf.length < 4 + len) return; // 未收全 → 等更多 cell
      done = true;
      clearTimeout(timer);
      const json = buf.subarray(4, 4 + len);
      const leftover = buf.subarray(4 + len);
      channel.detachData(); // 控制帧读完 → 摘除本回调，后续 cell 重新入队 → 交给随后的桥接无损接管
      try {
        resolve({ msg: JSON.parse(new TextDecoder().decode(json)), leftover });
      } catch (e) {
        reject(e instanceof Error ? e : new Error('付费帧 JSON 非法'));
      }
    });
  });
}

// ---- 服务方侧 ----

export interface PaywallServerResult {
  paid: boolean;
  gross: number;
  leftover: Uint8Array; // 握手后残留字节（透传给桥接，保证字节序）；A.1 正常为空
}

/**
 * 服务方侧握手：等客户端 PAY → 受理 → PAYOK/PAYERR。返回是否放行。放行后调用方再桥接到 --hs-target。
 * 不抛（超时/非法都归一为 paid=false），让调用方统一按"未付费"关闭通道。
 */
export async function runPaywallServer(channel: RdvChannel, price: number, acceptor: VoucherAcceptor): Promise<PaywallServerResult> {
  let frame: { msg: any; leftover: Uint8Array };
  try {
    frame = await readFrame(channel, HANDSHAKE_TIMEOUT_MS);
  } catch {
    return { paid: false, gross: 0, leftover: new Uint8Array(0) };
  }
  const msg = frame.msg;
  if (!msg || msg.t !== 'pay' || !Array.isArray(msg.vouchers)) {
    sendFrame(channel, { t: 'payerr', code: 'invalid' });
    return { paid: false, gross: 0, leftover: new Uint8Array(0) };
  }
  const vouchers: MintToken[] = msg.vouchers.map((a: any) =>
    Array.isArray(a) ? { denom: a[0], serial: a[1], sig: a[2] } : a,
  );
  const verdict = acceptor.accept(vouchers, price);
  if (!verdict.ok) {
    sendFrame(channel, { t: 'payerr', code: verdict.code, need: verdict.need, got: verdict.got });
    return { paid: false, gross: 0, leftover: new Uint8Array(0) };
  }
  sendFrame(channel, { t: 'payok', v: 1 });
  return { paid: true, gross: verdict.gross, leftover: frame.leftover };
}

// ---- 客户端侧 ----

/**
 * 客户端侧握手：把 vouchers 作第一帧 PAY 递上（乐观预付，价已从描述符得知）→ 等 PAYOK。PAYERR/超时 → 抛。
 * 返回 **PAYOK 帧之后同 cell 里紧跟的字节**（服务方若把响应开头与 PAYOK 合在一个 cell 发来）——调用方须把它写给下游 sock，
 * 否则这段响应开头会被静默丢弃。A.1 正常为空。
 */
export async function runPaywallClient(channel: RdvChannel, vouchers: MintToken[]): Promise<Uint8Array> {
  sendFrame(channel, { t: 'pay', v: 1, vouchers: vouchers.map((v) => [v.denom, v.serial, v.sig]) });
  const { msg, leftover } = await readFrame(channel, HANDSHAKE_TIMEOUT_MS);
  if (msg?.t === 'payok') return leftover;
  if (msg?.t === 'payerr') throw new Error(`付费被拒(${msg.code}${msg.need !== undefined ? `：需 ${msg.need}、递了 ${msg.got}` : ''})`);
  throw new Error('付费握手应答异常');
}

/** 校验一个地址串（供上层组装 acceptor 前的健壮性检查）。导出以复用 core 的判定，避免各写一份。 */
export const isMintAddress = isValidAddress;
