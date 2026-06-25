// 电路状态 + 中继侧逐 cell 决策（纯逻辑，I/O 在 relaynode.ts / client.ts）。
//
// nonce/计数器设计（流加密绝不能 (key,nonce) 重用）：
// - **前向**：客户端持有单调计数器，每个前向 cell n=fwdN++。全程各跳用同一 n → 同一前向密钥不重用；中继按
//   **滑动窗口防重放**（antireplay.ts，RFC 6479 风格）放行：接受窗口内尚未见过的乱序 n、丢重复/太老/越界 n。
//   旧实现要求 n 严格增，但 Mixnet 逐跳随机延迟会重排前向 cell → 严格法会误丢被重排到后面的合法 cell（流丢包）；
//   窗口法在保留全部防重放性质（真重放仍被拦、nonce 悬崖仍守）的同时让乱序合法 cell 通过。
// - **后向**：cell 由某跳发起，而中继**不知道自己的全局跳位**（这正是匿名性）。故每条 RelayCircuit 建时取一个随机 24-bit
//   base，后向 n = base·2²⁰ + 本跳本地计数。不同发起跳 base 几乎不可能相撞 → 杜绝 (encBackward_i, nonce) 重用，且无需跳位。
//   ⚠️ v1 后向防重放为 best-effort（MAC 防伪造；重放只是把同样数据重投给客户端，客户端按自身电路态去重）。
import type { CircuitKeys } from '@v0idchain/core';
import { applyLayer, unpackCellBody, packCellBody, nonceFromCounter, MAX_CELL_CTR } from '@v0idchain/core';
import { type AntiReplayState, accept } from './antireplay.js';
import type { CellMsg } from './cells.js';

const BWD_LOCAL_BITS = 2 ** 20; // 每跳本地后向计数空间（每电路百万 cell 足够）

/** cell 平面的一条连接句柄（独立于共识 Conn；匿名，无 peerId）。 */
export interface CellLink {
  readonly lid: number; // 本地连接序号（仅本机调试/去重用）
  readonly ip?: string; // 该连接的来源 IP（ws 升级请求的 remoteAddress）：仅用于每-IP 电路配额；出站/未知连接为 undefined
  send(m: CellMsg): void;
  close(): void;
  isOpen(): boolean;
}

/** 中继侧一条电路的拼接态：prev(朝客户端) ⇄ next(朝下一跳)。中继只按 circId 路由，绝不存客户端身份。 */
export interface RelayCircuit {
  prevConn: CellLink;
  prevCirc: string;
  nextConn?: CellLink; // 延伸后才有；无 = 本跳是出口
  nextCirc?: string;
  keys: CircuitKeys; // 本跳与客户端协商出的 4 把密钥（中继视角）
  fwdReplay: AntiReplayState; // 前向滑动窗口防重放（替代旧 maxFwdCtr 单调计数；接受窗口内乱序、拦重复/太老/越界）
  bwdBase: number; // 本跳后向 n 的随机命名空间基
  bwdLocal: number; // 本跳本地后向计数
  createdAt: number;
  // ---- DoS 加固（feat/onion-entry-guards）：TTL 清扫 / 每电路 cell 限速 / EXTEND 连接超时。----
  lastSeen: number; // 最近一次前/后向 cell 的时间戳；空闲清扫据此回收僵尸电路（init = createdAt）
  cellTokens: number; // 前向 cell 限速令牌桶余量（borrow signalAllowed 思路）
  cellRefillAt: number; // 上次令牌补充时间戳（按经过时长 × 速率补）
  cellDropped: number; // 当前窗口内被限速丢弃的 cell 计数（超阈值 → 判定洪泛销毁电路）
  cellDropWindowAt: number; // 丢弃计数窗口起点（每窗口归零）
  extendTimer?: ReturnType<typeof setTimeout>; // EXTEND 拨号下一跳的连接超时句柄；CREATED 到达或拆电路时清
  // ---- Mixnet（Phase 2C，默认关；仅 mixnet 启用时使用）：本电路当前因混入延迟而“扣在手里”的 setTimeout 句柄集合。----
  // 每个 setTimeout 在到点把一个被延迟的转发/后向 cell 真正发出；其回调先把自己从此集合摘除。拆电路时清空全部（不让延迟 cell 在 teardown 后还发）。
  mixTimers?: Set<ReturnType<typeof setTimeout>>;
  // Mixnet 延迟在“同一电路、同一出方向”上必须保 FIFO：TCP/HS 分帧等上层协议依赖 cell 序，若独立 timer 直接乱序发出，
  // 滑窗防重放虽不会误丢 cell，但出口/客户端会按到达顺序交付字节而破坏流语义。下面两个时间戳是 prev/next 出方向的
  // 下一可发送时间水位；每个新 cell 追加在该方向队尾，仍有随机间隔，但不重排同一有序流。
  mixPrevReadyAt?: number;
  mixNextReadyAt?: number;
}

/** 中继的电路表。circId 全局随机唯一 → 用两张表按“来向”区分：前向 cell 落 incoming，后向 cell 落 outgoing。 */
export class RelayCircuitTable {
  private incoming = new Map<string, RelayCircuit>(); // key = prevCirc（前向 cell 的 circId）
  private outgoing = new Map<string, RelayCircuit>(); // key = nextCirc（后向 cell 的 circId）

  add(circ: RelayCircuit): boolean {
    if (this.incoming.has(circ.prevCirc)) return false;
    this.incoming.set(circ.prevCirc, circ);
    return true;
  }
  /** 延伸成功后登记下一跳 circId（使后向 cell 能按 nextCirc 找回本电路）。 */
  linkNext(circ: RelayCircuit, nextConn: CellLink, nextCirc: string): boolean {
    if (circ.nextConn || circ.nextCirc || this.outgoing.has(nextCirc)) return false;
    circ.nextConn = nextConn;
    circ.nextCirc = nextCirc;
    this.outgoing.set(nextCirc, circ);
    return true;
  }
  byPrev(circId: string): RelayCircuit | undefined {
    return this.incoming.get(circId);
  }
  byNext(circId: string): RelayCircuit | undefined {
    return this.outgoing.get(circId);
  }
  remove(circ: RelayCircuit): void {
    this.incoming.delete(circ.prevCirc);
    if (circ.nextCirc) this.outgoing.delete(circ.nextCirc);
  }
  get size(): number {
    return this.incoming.size;
  }
  all(): RelayCircuit[] {
    return [...this.incoming.values()];
  }
}

/** 每电路前向 cell 限速：令牌桶（borrow p2p signalAllowed）。按经过时长补令牌，无令牌 → 返回 false（丢该 cell）。
 *  rate=每秒补令牌数(=稳态吞吐上限)，burst=桶容量(=瞬时突发上限)。在 relaynode 的前向路径里、剥层之前调用。 */
export function takeCellToken(circ: RelayCircuit, now: number, rate: number, burst: number): boolean {
  const elapsed = now - circ.cellRefillAt;
  if (elapsed > 0) {
    circ.cellTokens = Math.min(burst, circ.cellTokens + (elapsed * rate) / 1000);
    circ.cellRefillAt = now;
  }
  if (circ.cellTokens >= 1) {
    circ.cellTokens -= 1;
    return true;
  }
  return false;
}

/** 下一个后向 n（命名空间化，避免跨发起跳重用）。 */
export function nextBackwardCtr(circ: RelayCircuit): number {
  return circ.bwdBase * BWD_LOCAL_BITS + circ.bwdLocal++;
}

/** 随机 24-bit 后向 base（relaynode 建电路时调用，传入 randomBytes）。 */
export function makeBwdBase(rand3: Uint8Array): number {
  return ((rand3[0] << 16) | (rand3[1] << 8) | rand3[2]) >>> 0;
}

function isValidCellCounter(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0 && n < MAX_CELL_CTR;
}

export type ForwardAction =
  | { kind: 'self'; cmd: number; data: Uint8Array } // 剥到本跳：是给我的命令（EXTEND / DATA-to-exit）
  | { kind: 'forward'; body: Uint8Array } // 还要往下一跳转发
  | { kind: 'drop' }; // 重放 / 畸形

/** 中继处理一个**前向** cell：剥掉本跳一层，判断“给我”还是“转发”。同时做前向滑动窗口防重放 + nonce 上限防护。 */
export function relayForward(circ: RelayCircuit, bodyHex: Uint8Array, n: number): ForwardAction {
  // 滑动窗口防重放（含 nonce 悬崖检查）：接受窗口内尚未见过的乱序 n（Mixnet 重排必需），丢重复/太老/越界 n。
  if (!accept(circ.fwdReplay, n)) return { kind: 'drop' };
  const peeled = applyLayer(circ.keys.encForward, nonceFromCounter(n), bodyHex);
  const mine = unpackCellBody(peeled, circ.keys.macForward);
  if (mine) return { kind: 'self', cmd: mine.cmd, data: mine.data };
  return { kind: 'forward', body: peeled };
}

/** 中继处理一个**后向** cell（来自下一跳）：加上本跳一层，得到要发给 prev 的 body。 */
export function relayAddBackwardLayer(circ: RelayCircuit, bodyHex: Uint8Array, n: number): Uint8Array | null {
  if (!isValidCellCounter(n)) return null;
  return applyLayer(circ.keys.encBackward, nonceFromCounter(n), bodyHex);
}

/** 中继**发起**一个后向 cell（如 EXTENDED）：打包 + 套本跳后向层。返回 {n, body} 发给 prev。 */
export function originateBackward(circ: RelayCircuit, cmd: number, data: Uint8Array): { n: number; body: Uint8Array } {
  const n = nextBackwardCtr(circ);
  const body = applyLayer(circ.keys.encBackward, nonceFromCounter(n), packCellBody(cmd, data, circ.keys.macBackward));
  return { n, body };
}
