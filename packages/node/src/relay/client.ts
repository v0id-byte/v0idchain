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
  CMD_HS_PUBLISH,
  CMD_HS_FETCH,
  CMD_HS_RESP,
  CMD_HS_END,
  CMD_DROP,
  CELL_DATA_LEN,
  nextCoverDelayMs,
  DEFAULT_COVER_RATE,
} from '@v0idchain/core';
import { type CellMsg, decodeCell, encodeCell } from './cells.js';
import { encodeFramed, FrameReassembler } from './hsdir.js';
import { type AntiReplayState, newAntiReplay, accept } from './antireplay.js';

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
  // HS 请求模式（描述符 DHT 发布/取回）：与 streaming 互斥，路由后向 CMD_HS_RESP/CMD_HS_END 到当前在途请求。
  private hsing = false;
  private hsReq: { onResp: (cell: Uint8Array) => void; onEnd: () => void } | null = null;
  private connectWaiter: ((ok: boolean) => void) | null = null;
  private dataCb: ((b: Uint8Array) => void) | null = null;
  private dataQueue: Uint8Array[] = [];
  private endCb: (() => void) | null = null;
  private ended = false;
  // 会合模式（Phase 2B-c）：电路常开，按 cmd 把解封后的后向 cell 派发到注册的回调。与 streaming/hsing 互斥。
  private rdvMode = false;
  private rdvHandlers = new Map<number, (data: Uint8Array) => void>();
  private rdvDestroyCb: (() => void) | null = null;
  // 后向 cell 解封前的去重：客户端用**滑动窗口防重放**记忆已见 n，重放（已见/太老）即丢，但接受窗口内乱序 n。
  // 适用于建路后的全部三种后向消费模式（streaming / hsing / rdvMode）——它们各自的后向 cell 都由**终点跳**
  // originateBackward 发出（共用单一近连续 n 命名空间）。Mixnet 逐跳延迟同样会重排后向 cell → 必须用窗口而非
  // 严格单调，否则被重排到后面的合法后向 cell 会被误丢。建路阶段不用本检查：telescoping 的多条 EXTENDED 来自
  // 不同发起跳、n 命名空间互不相干（task 注：中继后向防重放因此只能是 best-effort；窗口防线落在此处客户端侧）。
  private bwdReplay: AntiReplayState = newAntiReplay();
  // Mixnet 客户端环路 cover（Phase 2C）：周期发 CMD_DROP 掩护 cell 到终点跳，让电路恒有流量 → 观察者分不清何时有真数据。
  private coverTimer: ReturnType<typeof setTimeout> | null = null;

  private onMsg(m: CellMsg): void {
    if (this.rdvMode) {
      if (m.t === 'DESTROY') {
        this.ended = true;
        const cb = this.rdvDestroyCb;
        this.rdvDestroyCb = null;
        cb?.();
        return;
      }
      if (m.t !== 'RELAY' || m.d !== 'b') return;
      const inner = unwrapBackward(this.keys(), this.hops.length - 1, hexToBytes(m.b), m.n);
      if (!inner) return; // MAC 失败 → 丢
      if (!accept(this.bwdReplay, m.n)) return; // 仅 MAC 合法后推进窗口：重放/太老 → 丢；窗口内乱序 → 接受
      this.rdvHandlers.get(inner.cmd)?.(inner.data);
      return;
    }
    if (this.hsing) {
      // HS 请求模式：只期待后向 RELAY cell；解封后路由 CMD_HS_RESP/CMD_HS_END 到在途请求。
      if (m.t === 'DESTROY') {
        const r = this.hsReq;
        this.hsReq = null;
        r?.onEnd(); // 电路被毁 = 视作 END 收尾（无 RESP → 上层得到失败/null）
        this.ended = true;
        return;
      }
      if (m.t !== 'RELAY' || m.d !== 'b') return;
      // 后向滑动窗口防重放：HS 应答全部由终点跳（HSDir）originateBackward 发出，共用一个近连续 n 命名空间
      // → 重放/太老即丢、窗口内乱序接受（与 rdvMode 同法）。否则一条重放的 CMD_HS_RESP 会被重组器重复消费。
      const inner = unwrapBackward(this.keys(), this.hops.length - 1, hexToBytes(m.b), m.n);
      if (!inner || !this.hsReq) return; // MAC 失败/无在途请求 → 丢
      if (!accept(this.bwdReplay, m.n)) return; // 仅 MAC 合法后推进窗口
      if (inner.cmd === CMD_HS_RESP) this.hsReq.onResp(inner.data);
      else if (inner.cmd === CMD_HS_END) {
        const r = this.hsReq;
        this.hsReq = null;
        r.onEnd();
      }
      return;
    }
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
    // 后向滑动窗口防重放：流阶段所有后向 cell（CONNECTED/DATA/END）均由出口跳 originateBackward，共用近连续 n
    // → 重放/太老即丢、窗口内乱序接受（与 rdvMode 同法）。否则一条重放的 CMD_DATA 会令流多收一份字节。
    const inner = unwrapBackward(this.keys(), this.hops.length - 1, hexToBytes(m.b), m.n);
    if (!inner) return;
    if (!accept(this.bwdReplay, m.n)) return; // 仅 MAC 合法后推进窗口
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

  // ---- 隐藏服务描述符 DHT：经本电路把终点跳（=某 HSDir）当应答方，发布/取回描述符 ----

  // 把一条逻辑消息分帧成多个前向 cell（CMD_HS_PUBLISH/CMD_HS_FETCH），按 fwdN 单调发出（保序）。
  private sendHsRequest(cmd: number, msg: Uint8Array): void {
    const t = this.hops.length - 1; // 终点跳 = HSDir
    for (const cell of encodeFramed(msg)) {
      const n = this.fwdN++;
      this.sendCell({ t: 'RELAY', c: this.c0, d: 'f', n, b: bytesToHex(wrapForward(this.keys(), t, cmd, cell, n)) });
    }
  }

  /**
   * 发布描述符到本电路终点的 HSDir。msg = descIdHex(64 ascii) ‖ descriptorJSON。
   * 收到 CMD_HS_RESP("OK") 再 CMD_HS_END → true；CMD_HS_END 前未见 "OK" → false（HSDir 拒收）。
   */
  hsPublish(descIdHex: string, descJson: string): Promise<boolean> {
    this.hsing = true;
    const msg = utf8ToBytes(descIdHex + descJson);
    return new Promise<boolean>((res) => {
      let ok = false;
      this.hsReq = {
        onResp: (cell) => {
          if (new TextDecoder().decode(cell) === 'OK') ok = true;
        },
        onEnd: () => res(ok),
      };
      this.sendHsRequest(CMD_HS_PUBLISH, msg);
    });
  }

  /**
   * 从本电路终点的 HSDir 取回描述符。发 CMD_HS_FETCH(descIdHex)，重组 CMD_HS_RESP 分帧块至 CMD_HS_END。
   * 命中 → 返回 JSON 字符串；END 时零 RESP 字节（未命中）→ null。
   */
  hsFetch(descIdHex: string): Promise<string | null> {
    this.hsing = true;
    const msg = utf8ToBytes(descIdHex);
    return new Promise<string | null>((res) => {
      const reasm = new FrameReassembler(1 << 20); // 取回侧重组上限（1MiB，宽松；描述符远小于此）
      let gotResp = false;
      this.hsReq = {
        onResp: (cell) => {
          gotResp = true;
          reasm.push(cell);
        },
        onEnd: () => {
          if (!gotResp) return res(null); // 零 RESP = 未命中
          const out = reasm.take();
          res(out ? new TextDecoder().decode(out) : null); // 帧残缺/非法 → null
        },
      };
      this.sendHsRequest(CMD_HS_FETCH, msg);
    });
  }

  // ---- 会合平面（Phase 2B-c）：电路常开，向终点跳发控制/数据命令，按 cmd 派发后向应答 ----

  /** 进入会合模式（电路常开）。之后所有后向 cell 经 MAC 校验后按 cmd 派发到 onRdv 注册的回调。 */
  enterRdvMode(): void {
    this.rdvMode = true;
  }
  /** 注册某后向 cmd 的处理回调（如 CMD_INTRODUCE2 / CMD_RENDEZVOUS2 / CMD_RDV_DATA）。 */
  onRdv(cmd: number, cb: (data: Uint8Array) => void): void {
    this.rdvHandlers.set(cmd, cb);
  }
  /** 电路被销毁（对端/链路断）时的通知（用于会合通道收尾）。 */
  onRdvDestroy(cb: () => void): void {
    this.rdvDestroyCb = cb;
    if (this.ended) cb();
  }
  /** 向终点跳发一个前向命令（面向终点跳，单 cell；data ≤ CELL_DATA_LEN）。会合控制/数据均经此发出。 */
  sendToTerminus(cmd: number, data: Uint8Array): void {
    const t = this.hops.length - 1;
    const n = this.fwdN++;
    this.sendCell({ t: 'RELAY', c: this.c0, d: 'f', n, b: bytesToHex(wrapForward(this.keys(), t, cmd, data, n)) });
  }
  /**
   * 发一个前向命令并等待某个特定后向 cmd 的应答（建立请求/应答语义，如 ESTABLISH_*→*_ESTABLISHED）。
   * 须先 enterRdvMode()。命中 awaitCmd → resolve(data)；超时由调用方 withTimeout 兜。
   */
  sendAwaitRdv(sendCmd: number, sendData: Uint8Array, awaitCmd: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((res) => {
      this.rdvHandlers.set(awaitCmd, (data) => {
        this.rdvHandlers.delete(awaitCmd);
        res(data);
      });
      this.sendToTerminus(sendCmd, sendData);
    });
  }

  // ---- Mixnet 客户端环路 cover（Phase 2C）：掩护流量，让电路在“没有真数据”时也恒有 cell 流过 ----

  /**
   * 发一个 cover（掩护）cell：面向**终点跳**包一个 CMD_DROP（随机填充净荷），走与真数据**完全相同**的
   * wrapForward + sendCell 前向路径、占用同一前向计数器 fwdN → 线缆上与一个 CMD_DATA cell 不可区分。
   * 终点跳剥到 CMD_DROP 后静默丢弃（不投递、不回应）。中间跳当普通 cell 盲转发，看不出是 cover。
   * 注：必须已建好电路（至少 1 跳）；未建路时无终点可寻 → 直接返回（不发）。
   */
  sendCover(): void {
    const t = this.hops.length - 1;
    if (t < 0) return; // 尚未建路 → 无终点跳
    const pad = randomBytes(CELL_DATA_LEN); // 随机填充：内容无意义（终点直接丢），仅为占满定长 body 不泄露“这是 cover”
    const n = this.fwdN++;
    this.sendCell({ t: 'RELAY', c: this.c0, d: 'f', n, b: bytesToHex(wrapForward(this.keys(), t, CMD_DROP, pad, n)) });
  }

  /**
   * 启动 cover 调度器：以 Poisson 到达（指数间隔，均值 1/rate 秒）持续发 cover cell，每次发完重排下一次。
   * 这让一条电路恒有流量 → 全局被动观察者无法据“何时有 cell”推断“何时有真数据”。
   * rate ≤ 0 或电路已关 → 不启动。重复调用先停旧调度器再起新的（避免叠加多个）。auto-stop 于 stopCover()/close()。
   */
  startCover(ratePerSec: number = DEFAULT_COVER_RATE): void {
    this.stopCover();
    if (!(ratePerSec > 0) || this.ended || !this.ws) return;
    const tick = () => {
      this.sendCover();
      const next = nextCoverDelayMs(ratePerSec);
      if (!Number.isFinite(next)) return; // rate 退化 → 停（防御）
      this.coverTimer = setTimeout(tick, next);
      this.coverTimer.unref?.(); // 不阻止进程退出
    };
    const first = nextCoverDelayMs(ratePerSec);
    if (!Number.isFinite(first)) return;
    this.coverTimer = setTimeout(tick, first);
    this.coverTimer.unref?.();
  }

  /** 停止 cover 调度器（清当前定时器；不影响已发出的 cover cell）。 */
  stopCover(): void {
    if (this.coverTimer) {
      clearTimeout(this.coverTimer);
      this.coverTimer = null;
    }
  }

  get hopCount(): number {
    return this.hops.length;
  }
  close(): void {
    this.stopCover(); // 关电路时自动停 cover（不再发掩护 cell）
    if (this.ws) this.sendCell({ t: 'DESTROY', c: this.c0 });
    this.ws?.close();
  }
}
