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
  addressToPublicKeyHex,
  wrapForward,
  unwrapBackward,
  CMD_EXTEND,
  CMD_DATA,
  CMD_EXTENDED,
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

  private onMsg(m: CellMsg): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p(m);
    } else this.buffered.push(m);
  }
  private nextCell(): Promise<CellMsg> {
    return new Promise((res) => {
      const b = this.buffered.shift();
      if (b) res(b);
      else this.pending = res;
    });
  }
  private sendCell(m: CellMsg): void {
    this.ws!.send(encodeCell(m));
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

  get hopCount(): number {
    return this.hops.length;
  }
  close(): void {
    if (this.ws) this.sendCell({ t: 'DESTROY', c: this.c0 });
    this.ws?.close();
  }
}
