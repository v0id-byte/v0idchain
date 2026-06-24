// 洋葱电路客户端：telescoping 建路（与守卫直接 ntor，其余各跳经已建好的部分电路 EXTEND），然后向出口收发 DATA。
// 客户端**不签名、不暴露身份**：ntor 的 AUTH 由中继向客户端单向认证；客户端保持匿名。
import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import {
  ntorClientStart,
  ntorClientFinish,
  type CircuitKeys,
  hexToBytes,
  bytesToHex,
  utf8ToBytes,
  addressToPublicKeyHex,
  wrapForward,
  unwrapBackward,
  CMD_EXTEND,
  CMD_DATA,
  CMD_EXTENDED,
  CMD_BEGIN,
  CMD_CONNECTED,
  CMD_END,
  CELL_DATA_LEN,
} from '@v0idchain/core';
import { type CellMsg, decodeCell, encodeCell } from './cells.js';

/** 一跳的选路信息（来自链上中继目录 parseRelays）。 */
export interface HopSpec {
  id: string; // 中继钱包地址 0x..
  onionPub: Uint8Array; // 其 onion 静态公钥 B（描述符 okey）
  host: string;
  port: number;
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
}

export class CircuitClient {
  private ws: WebSocket | null = null;
  private readonly c0 = randomBytes(8).toString('hex'); // 客户端↔守卫 link 上的 circId
  private hops: { id: string; idPub: Uint8Array; keys: CircuitKeys }[] = [];
  private fwdN = 0; // 前向单调计数器（nonce 源 + 各跳防重放）
  private pending: ((m: CellMsg) => void) | null = null;
  private buffered: CellMsg[] = [];
  private streaming = false;
  private connectWaiter: ((ok: boolean) => void) | null = null;
  private dataCb: ((b: Uint8Array) => void) | null = null;
  private dataQueue: Uint8Array[] = [];
  private endCb: (() => void) | null = null;
  private ended = false;

  private onMsg(m: CellMsg): void {
    if (!this.streaming) {
      // 建路阶段：请求/响应（CREATED / 后向 EXTENDED）
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p(m);
      } else this.buffered.push(m);
      return;
    }
    // 流阶段：仅期待后向 RELAY cell；解封后按 cmd 路由，MAC 失败即丢 → 注入/乱序 cell 无法令流错配。
    if (m.t === 'DESTROY') {
      const w = this.connectWaiter;
      this.connectWaiter = null;
      w?.(false);
      this.ended = true;
      this.endCb?.();
      return;
    }
    if (m.t !== 'RELAY' || m.d !== 'b') return;
    const inner = unwrapBackward(this.keys(), this.hops.length - 1, hexToBytes(m.b), m.n);
    if (!inner) return;
    if (inner.cmd === CMD_CONNECTED) {
      const w = this.connectWaiter;
      this.connectWaiter = null;
      w?.(inner.data[0] === 0);
    } else if (inner.cmd === CMD_DATA) {
      if (this.dataCb) this.dataCb(inner.data);
      else this.dataQueue.push(inner.data);
    } else if (inner.cmd === CMD_END) {
      this.ended = true;
      this.endCb?.();
    }
  }
  private nextCell(): Promise<CellMsg> {
    return new Promise((res) => {
      const b = this.buffered.shift();
      if (b) res(b);
      else this.pending = res;
    });
  }
  private sendCell(m: CellMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeCell(m));
  }
  private keys(): CircuitKeys[] {
    return this.hops.map((h) => h.keys);
  }

  /** 第 1 跳（守卫）：直接拨号 + ntor 握手。 */
  async connect(guard: HopSpec): Promise<void> {
    const ws = new WebSocket(`ws://${guard.host}:${guard.port}`, { maxPayload: 1 << 16 });
    this.ws = ws;
    await waitOpen(ws);
    ws.on('message', (d) => {
      const m = decodeCell(String(d));
      if (m) this.onMsg(m);
    });
    const st = ntorClientStart();
    this.sendCell({ t: 'CREATE', c: this.c0, x: bytesToHex(st.ephPublic) });
    const created = await this.nextCell();
    if (created.t !== 'CREATED') throw new Error(`守卫未回 CREATED: ${created.t}`);
    const idPub = hexToBytes(addressToPublicKeyHex(guard.id));
    const keys = ntorClientFinish(st, idPub, guard.onionPub, hexToBytes(created.y), hexToBytes(created.a));
    if (!keys) throw new Error('守卫 ntor 认证失败');
    this.hops.push({ id: guard.id, idPub, keys });
  }

  /** 经当前部分电路把电路延伸到下一跳。 */
  async extend(hop: HopSpec): Promise<void> {
    const t = this.hops.length - 1; // EXTEND 面向当前终点跳
    const st = ntorClientStart();
    const idPub = hexToBytes(addressToPublicKeyHex(hop.id));
    const data = new Uint8Array(64);
    data.set(idPub, 0); // nextHopId(32)
    data.set(st.ephPublic, 32); // clientEphX(32)
    const n = this.fwdN++;
    this.sendCell({ t: 'RELAY', c: this.c0, d: 'f', n, b: bytesToHex(wrapForward(this.keys(), t, CMD_EXTEND, data, n)) });
    const resp = await this.nextCell();
    if (resp.t !== 'RELAY' || resp.d !== 'b') throw new Error(`EXTEND 未回后向 cell: ${resp.t}`);
    const inner = unwrapBackward(this.keys(), t, hexToBytes(resp.b), resp.n);
    if (!inner || inner.cmd !== CMD_EXTENDED) throw new Error('EXTEND 应答非法/MAC 失败');
    const keys = ntorClientFinish(st, idPub, hop.onionPub, inner.data.subarray(0, 32), inner.data.subarray(32, 64));
    if (!keys) throw new Error(`第 ${t + 2} 跳 ntor 认证失败`);
    this.hops.push({ id: hop.id, idPub, keys });
  }

  /** 向出口发一段数据并等其后向回包（请求/响应）。 */
  async sendData(payload: Uint8Array): Promise<Uint8Array> {
    const t = this.hops.length - 1; // 出口
    const n = this.fwdN++;
    this.sendCell({ t: 'RELAY', c: this.c0, d: 'f', n, b: bytesToHex(wrapForward(this.keys(), t, CMD_DATA, payload, n)) });
    const resp = await this.nextCell();
    if (resp.t !== 'RELAY' || resp.d !== 'b') throw new Error(`DATA 未回后向 cell: ${resp.t}`);
    const inner = unwrapBackward(this.keys(), t, hexToBytes(resp.b), resp.n);
    if (!inner || inner.cmd !== CMD_DATA) throw new Error('DATA 响应非法/MAC 失败');
    return inner.data;
  }

  /** 开流：让出口 CONNECT 到 host:port。返回是否连通（出口策略可能拒）。 */
  async beginStream(host: string, port: number): Promise<boolean> {
    this.streaming = true;
    const t = this.hops.length - 1;
    const n = this.fwdN++;
    const target = utf8ToBytes(`${host}:${port}`);
    this.sendCell({ t: 'RELAY', c: this.c0, d: 'f', n, b: bytesToHex(wrapForward(this.keys(), t, CMD_BEGIN, target, n)) });
    return new Promise<boolean>((res) => {
      this.connectWaiter = res;
    });
  }
  /** 向流写字节（按 ≤485B 分片为多个 cell，保序）。 */
  write(data: Uint8Array): void {
    const t = this.hops.length - 1;
    for (let o = 0; o < data.length; o += CELL_DATA_LEN) {
      const n = this.fwdN++;
      const chunk = data.subarray(o, o + CELL_DATA_LEN);
      this.sendCell({ t: 'RELAY', c: this.c0, d: 'f', n, b: bytesToHex(wrapForward(this.keys(), t, CMD_DATA, chunk, n)) });
    }
  }
  /** 出口→客户端 流数据回调。 */
  onData(cb: (b: Uint8Array) => void): void {
    this.dataCb = cb;
    for (const b of this.dataQueue.splice(0)) cb(b);
  }
  /** 流关闭（出口 TCP close）回调。 */
  onEnd(cb: () => void): void {
    this.endCb = cb;
    if (this.ended) cb();
  }
  /** 主动关流（通知出口 end）。 */
  endStream(): void {
    const t = this.hops.length - 1;
    const n = this.fwdN++;
    this.sendCell({ t: 'RELAY', c: this.c0, d: 'f', n, b: bytesToHex(wrapForward(this.keys(), t, CMD_END, new Uint8Array(0), n)) });
  }

  get hopCount(): number {
    return this.hops.length;
  }
  close(): void {
    if (this.ws) this.sendCell({ t: 'DESTROY', c: this.c0 });
    this.ws?.close();
  }
}
