// 电路状态 + 中继侧逐 cell 决策（纯逻辑，I/O 在 relaynode.ts / client.ts）。
//
// nonce/计数器设计（流加密绝不能 (key,nonce) 重用）：
// - **前向**：客户端持有单调计数器，每个前向 cell n=fwdN++。全程各跳用同一 n → 同一前向密钥不重用；中继按 n>maxSeen 防重放。
// - **后向**：cell 由某跳发起，而中继**不知道自己的全局跳位**（这正是匿名性）。故每条 RelayCircuit 建时取一个随机 24-bit
//   base，后向 n = base·2²⁰ + 本跳本地计数。不同发起跳 base 几乎不可能相撞 → 杜绝 (encBackward_i, nonce) 重用，且无需跳位。
//   ⚠️ v1 后向防重放为 best-effort（MAC 防伪造；重放只是把同样数据重投给客户端，客户端按自身电路态去重）。
import type { CircuitKeys } from '@v0idchain/core';
import { applyLayer, unpackCellBody, packCellBody, nonceFromCounter, MAX_CELL_CTR } from '@v0idchain/core';
import type { CellMsg } from './cells.js';

const BWD_LOCAL_BITS = 2 ** 20; // 每跳本地后向计数空间（每电路百万 cell 足够）

/** cell 平面的一条连接句柄（独立于共识 Conn；匿名，无 peerId）。 */
export interface CellLink {
  readonly lid: number; // 本地连接序号（仅本机调试/去重用）
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
  maxFwdCtr: number; // 前向防重放：已见的最大 n（初始 -1 = 尚未见任何 cell，使首个 n=0 也被接受一次）
  bwdBase: number; // 本跳后向 n 的随机命名空间基
  bwdLocal: number; // 本跳本地后向计数
  createdAt: number;
}

/** 中继的电路表。circId 全局随机唯一 → 用两张表按“来向”区分：前向 cell 落 incoming，后向 cell 落 outgoing。 */
export class RelayCircuitTable {
  private incoming = new Map<string, RelayCircuit>(); // key = prevCirc（前向 cell 的 circId）
  private outgoing = new Map<string, RelayCircuit>(); // key = nextCirc（后向 cell 的 circId）

  add(circ: RelayCircuit): void {
    this.incoming.set(circ.prevCirc, circ);
  }
  /** 延伸成功后登记下一跳 circId（使后向 cell 能按 nextCirc 找回本电路）。 */
  linkNext(circ: RelayCircuit, nextConn: CellLink, nextCirc: string): void {
    circ.nextConn = nextConn;
    circ.nextCirc = nextCirc;
    this.outgoing.set(nextCirc, circ);
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

/** 下一个后向 n（命名空间化，避免跨发起跳重用）。 */
export function nextBackwardCtr(circ: RelayCircuit): number {
  return circ.bwdBase * BWD_LOCAL_BITS + circ.bwdLocal++;
}

/** 随机 24-bit 后向 base（relaynode 建电路时调用，传入 randomBytes）。 */
export function makeBwdBase(rand3: Uint8Array): number {
  return ((rand3[0] << 16) | (rand3[1] << 8) | rand3[2]) >>> 0;
}

export type ForwardAction =
  | { kind: 'self'; cmd: number; data: Uint8Array } // 剥到本跳：是给我的命令（EXTEND / DATA-to-exit）
  | { kind: 'forward'; body: Uint8Array } // 还要往下一跳转发
  | { kind: 'drop' }; // 重放 / 畸形

/** 中继处理一个**前向** cell：剥掉本跳一层，判断“给我”还是“转发”。同时做前向计数器防重放 + nonce 上限防护。 */
export function relayForward(circ: RelayCircuit, bodyHex: Uint8Array, n: number): ForwardAction {
  // 防重放：n 必须严格增（maxFwdCtr 初始 -1 → 首个 n=0 也接受、之后 n=0 重放即丢）。并拒绝逼近 2^53 浮点悬崖的 n。
  if (n <= circ.maxFwdCtr || n > MAX_CELL_CTR) return { kind: 'drop' };
  circ.maxFwdCtr = n;
  const peeled = applyLayer(circ.keys.encForward, nonceFromCounter(n), bodyHex);
  const mine = unpackCellBody(peeled, circ.keys.macForward);
  if (mine) return { kind: 'self', cmd: mine.cmd, data: mine.data };
  return { kind: 'forward', body: peeled };
}

/** 中继处理一个**后向** cell（来自下一跳）：加上本跳一层，得到要发给 prev 的 body。 */
export function relayAddBackwardLayer(circ: RelayCircuit, bodyHex: Uint8Array, n: number): Uint8Array {
  return applyLayer(circ.keys.encBackward, nonceFromCounter(n), bodyHex);
}

/** 中继**发起**一个后向 cell（如 EXTENDED）：打包 + 套本跳后向层。返回 {n, body} 发给 prev。 */
export function originateBackward(circ: RelayCircuit, cmd: number, data: Uint8Array): { n: number; body: Uint8Array } {
  const n = nextBackwardCtr(circ);
  const body = applyLayer(circ.keys.encBackward, nonceFromCounter(n), packCellBody(cmd, data, circ.keys.macBackward));
  return { n, body };
}
