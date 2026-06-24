// 中继节点（cell 平面服务端）：独立 WebSocketServer 收发 cell，按 circId 路由洋葱电路。
//
// 关键：中继**只在直接收到 CREATE 时**跑一次 ntor（建立“客户端↔本跳”的密钥）。延伸(EXTEND)时它只是把客户端
// 给下一跳的握手**转发**出去（发一个 CREATE 给下一跳、把回来的 CREATED 包成后向 EXTENDED 还给客户端）——
// 它**永远不知道**更深各跳的密钥与内容。这正是洋葱路由的匿名性来源：没有任何单跳同时知道两端 + 全路径。
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns';
import { connect, isIP, type Socket } from 'node:net';
import {
  ntorServer,
  type OnionKeypair,
  hexToBytes,
  bytesToHex,
  addressToPublicKeyHex,
  CMD_EXTEND,
  CMD_EXTENDED,
  CMD_DATA,
  CMD_BEGIN,
  CMD_CONNECTED,
  CMD_END,
  CELL_DATA_LEN,
} from '@v0idchain/core';
import { type CellMsg, decodeCell, encodeCell } from './cells.js';
import {
  RelayCircuitTable,
  type RelayCircuit,
  type CellLink,
  relayForward,
  relayAddBackwardLayer,
  originateBackward,
  makeBwdBase,
} from './circuit.js';

/** 目录解析器：中继地址 → 其 cell 入口 host:port。生产用 parseRelays(chain)，测试可注入静态 map。 */
export type RelayResolver = (id: string) => { host: string; port: number } | undefined;
/** 出口投递回调（数据报模式，用于自检/echo）：收到面向本节点(出口)的 DATA → 业务处理 + reply 走原电路后向。 */
export type ExitHandler = (data: Uint8Array, reply: (resp: Uint8Array) => void) => void;
/** 出口策略：是否允许本中继作出口连到 host:port。默认 deny-all（中继不当无意识开放出口）。 */
export type ExitPolicy = (host: string, port: number) => boolean;

let LID = 0;
const mintCirc = () => randomBytes(8).toString('hex');
/** 单中继电路硬上限（粗粒度抗内存耗尽兜底）。细粒度（按 IP/连接限速、TTL 清扫、半开清理）属 Phase 2 加固。 */
const MAX_CIRCUITS = 2048;
const CELL_WS_MAX_PAYLOAD = 1 << 12;

function isLocalListenHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isPublicIpAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split('.').map((x) => Number(x));
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (kind === 6) {
    const h = address.toLowerCase();
    if (h.startsWith('::ffff:') && h.includes('.')) return isPublicIpAddress(h.slice(7));
    return !(h === '::' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || /^fe[89ab]/.test(h) || h.startsWith('ff'));
  }
  return false;
}

function wsHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export class RelayNode {
  private wss: WebSocketServer;
  private table = new RelayCircuitTable();
  private idPub: Uint8Array;
  private exitHandler?: ExitHandler;
  private exitPolicy: ExitPolicy = () => false; // 默认 deny-all
  private streams = new Map<RelayCircuit, Socket>(); // 出口：电路 → 其 TCP 流（v1 每电路 1 条流）

  constructor(
    readonly id: string, // 本中继钱包地址 0x..（= ntor relayId）
    private onion: OnionKeypair, // 静态 onion 密钥（公钥即 RELAY| 描述符的 okey）
    private resolve: RelayResolver,
    readonly port: number,
    readonly host = '127.0.0.1',
    private allowPrivateRelayTargets = isLocalListenHost(host),
  ) {
    this.idPub = hexToBytes(addressToPublicKeyHex(id));
    this.wss = new WebSocketServer({ host, port, maxPayload: CELL_WS_MAX_PAYLOAD });
    this.wss.on('connection', (ws) => this.wrap(ws));
  }

  onExit(h: ExitHandler): void {
    this.exitHandler = h;
  }
  /** 设置出口策略（允许作出口连到哪些 host:port）。不设 = deny-all。 */
  setExitPolicy(p: ExitPolicy): void {
    this.exitPolicy = p;
  }
  get circuits(): number {
    return this.table.size;
  }
  async close(): Promise<void> {
    for (const c of this.table.all()) this.destroyCircuit(c, undefined, 'shutdown', true);
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  // 把一条 ws 包成 CellLink 并挂消息分发。出站(CONNECTING)时先缓冲、open 后补发。
  private wrap(ws: WebSocket): CellLink {
    const outbox: CellMsg[] = [];
    const link: CellLink = {
      lid: LID++,
      send: (m) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeCell(m));
        else if (ws.readyState === WebSocket.CONNECTING) outbox.push(m);
      },
      close: () => ws.close(),
      isOpen: () => ws.readyState === WebSocket.OPEN,
    };
    ws.on('open', () => {
      for (const m of outbox) ws.send(encodeCell(m));
      outbox.length = 0;
    });
    ws.on('message', (d) => {
      const m = decodeCell(String(d));
      if (m) this.onCell(link, m);
    });
    ws.on('close', () => this.cleanupLink(link));
    ws.on('error', () => this.cleanupLink(link));
    return link;
  }

  private cleanupLink(link: CellLink): void {
    for (const circ of this.table.all()) {
      if (circ.prevConn === link || circ.nextConn === link) this.destroyCircuit(circ, link, 'link-closed');
    }
  }

  private destroyCircuit(circ: RelayCircuit, source?: CellLink, reason = 'destroy', closePrev = false): void {
    this.table.remove(circ);
    this.streams.get(circ)?.destroy();
    this.streams.delete(circ);
    if (circ.nextConn && circ.nextCirc) {
      if (source !== circ.nextConn) circ.nextConn.send({ t: 'DESTROY', c: circ.nextCirc, r: reason });
      circ.nextConn.close();
    }
    if (source !== circ.prevConn) circ.prevConn.send({ t: 'DESTROY', c: circ.prevCirc, r: reason });
    if (closePrev) circ.prevConn.close();
  }

  private onCell(link: CellLink, m: CellMsg): void {
    switch (m.t) {
      case 'CREATE': {
        if (this.table.byPrev(m.c)) {
          link.send({ t: 'DESTROY', c: m.c, r: 'duplicate-circuit' });
          return;
        }
        if (this.table.size >= MAX_CIRCUITS) {
          link.send({ t: 'DESTROY', c: m.c, r: 'overloaded' });
          return;
        }
        // 直接握手：建立“客户端↔本跳”的密钥（本跳是某客户端电路的这一跳）。
        const r = ntorServer(this.idPub, this.onion, hexToBytes(m.x));
        if (!r) {
          link.send({ t: 'DESTROY', c: m.c, r: 'ntor-fail' });
          return;
        }
        const circ: RelayCircuit = {
          prevConn: link,
          prevCirc: m.c,
          keys: r.keys,
          maxFwdCtr: -1, // -1 = 尚未见 cell；使首个 n=0 被接受、之后 n=0 重放即丢
          bwdBase: makeBwdBase(randomBytes(3)),
          bwdLocal: 0,
          createdAt: Date.now(),
        };
        if (!this.table.add(circ)) {
          link.send({ t: 'DESTROY', c: m.c, r: 'duplicate-circuit' });
          return;
        }
        link.send({ t: 'CREATED', c: m.c, y: bytesToHex(r.serverEph), a: bytesToHex(r.auth) });
        return;
      }
      case 'CREATED': {
        // 下一跳对我们(代客户端)发的 CREATE 的应答 → 包成后向 EXTENDED 还给客户端。
        const circ = this.table.byNext(m.c);
        if (!circ || circ.nextConn !== link) return;
        const data = new Uint8Array(64);
        data.set(hexToBytes(m.y), 0); // Y(32)
        data.set(hexToBytes(m.a), 32); // AUTH(32)
        const { n, body } = originateBackward(circ, CMD_EXTENDED, data);
        circ.prevConn.send({ t: 'RELAY', c: circ.prevCirc, d: 'b', n, b: bytesToHex(body) });
        return;
      }
      case 'RELAY': {
        if (m.d === 'f') {
          const circ = this.table.byPrev(m.c);
          if (!circ || circ.prevConn !== link) return;
          const act = relayForward(circ, hexToBytes(m.b), m.n);
          if (act.kind === 'drop') return;
          if (act.kind === 'forward') {
            if (circ.nextConn && circ.nextCirc)
              circ.nextConn.send({ t: 'RELAY', c: circ.nextCirc, d: 'f', n: m.n, b: bytesToHex(act.body) });
            return;
          }
          // act.kind === 'self'：是给我的命令（本跳是终点/出口）
          if (act.cmd === CMD_EXTEND) this.handleExtend(circ, act.data);
          else if (act.cmd === CMD_BEGIN) this.handleBegin(circ, act.data);
          else if (act.cmd === CMD_DATA) {
            const s = this.streams.get(circ);
            if (s) s.write(Buffer.from(act.data)); // 流模式：写到出口 TCP
            else if (this.exitHandler) this.exitHandler(act.data, (resp) => this.sendBackward(circ, CMD_DATA, resp)); // 数据报/echo 模式
          } else if (act.cmd === CMD_END) {
            this.streams.get(circ)?.end();
            this.streams.delete(circ);
          }
          return;
        }
        // 后向：来自下一跳，加本跳一层送回 prev
        const circ = this.table.byNext(m.c);
        if (!circ || circ.nextConn !== link) return;
        const body = relayAddBackwardLayer(circ, hexToBytes(m.b), m.n);
        if (!body) return;
        circ.prevConn.send({ t: 'RELAY', c: circ.prevCirc, d: 'b', n: m.n, b: bytesToHex(body) });
        return;
      }
      case 'DESTROY': {
        const byPrev = this.table.byPrev(m.c);
        if (byPrev && byPrev.prevConn === link) {
          this.destroyCircuit(byPrev, link, m.r);
          return;
        }
        const byNext = this.table.byNext(m.c);
        if (byNext && byNext.nextConn === link) this.destroyCircuit(byNext, link, m.r);
        return;
      }
    }
  }

  private dialRelay(host: string, port: number, cb: (ws: WebSocket | null) => void): void {
    if (this.allowPrivateRelayTargets) {
      cb(new WebSocket(`ws://${wsHost(host)}:${port}`, { maxPayload: CELL_WS_MAX_PAYLOAD }));
      return;
    }
    if (isIP(host)) {
      cb(isPublicIpAddress(host) ? new WebSocket(`ws://${wsHost(host)}:${port}`, { maxPayload: CELL_WS_MAX_PAYLOAD }) : null);
      return;
    }
    lookup(host, { all: false }, (err, address, family) => {
      if (err || !address || !isPublicIpAddress(address)) {
        cb(null);
        return;
      }
      cb(new WebSocket(`ws://${family === 6 ? `[${address}]` : address}:${port}`, { maxPayload: CELL_WS_MAX_PAYLOAD }));
    });
  }

  // EXTEND 数据 = nextHopId(32) ‖ clientEphX(32)。拨号下一跳、铸 nextCirc、转发 CREATE。
  private handleExtend(circ: RelayCircuit, data: Uint8Array): void {
    if (data.length < 64) return;
    if (circ.nextConn || circ.nextCirc) {
      this.destroyCircuit(circ, undefined, 'already-extended');
      return;
    }
    const nextId = '0x' + bytesToHex(data.subarray(0, 32));
    const x = bytesToHex(data.subarray(32, 64));
    const at = this.resolve(nextId);
    if (!at) {
      this.destroyCircuit(circ, undefined, 'unknown-relay');
      return;
    }
    this.dialRelay(at.host, at.port, (ws) => {
      if (!ws) {
        this.destroyCircuit(circ, undefined, 'blocked-relay-target');
        return;
      }
      if (this.table.byPrev(circ.prevCirc) !== circ || circ.nextConn || circ.nextCirc) {
        ws.close();
        return;
      }
      const next = this.wrap(ws);
      const nextCirc = mintCirc();
      if (!this.table.linkNext(circ, next, nextCirc)) {
        next.close();
        this.destroyCircuit(circ, undefined, 'extend-failed');
        return;
      }
      next.send({ t: 'CREATE', c: nextCirc, x }); // 缓冲到 open 后发
    });
  }

  // BEGIN 数据 = UTF8 "host:port"。按出口策略拨号 TCP，连通后回 CONNECTED(0)、桥接双向字节流。
  private handleBegin(circ: RelayCircuit, data: Uint8Array): void {
    if (this.streams.has(circ)) return; // v1 每电路 1 条流
    const target = new TextDecoder().decode(data);
    const i = target.lastIndexOf(':');
    const host = i > 0 ? target.slice(0, i) : '';
    const port = Number(target.slice(i + 1));
    if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535 || !this.exitPolicy(host, port)) {
      this.sendBackward(circ, CMD_CONNECTED, Uint8Array.of(1)); // 拒绝/非法
      return;
    }
    const sock = connect(port, host);
    sock.on('connect', () => {
      this.streams.set(circ, sock);
      this.sendBackward(circ, CMD_CONNECTED, Uint8Array.of(0));
    });
    sock.on('data', (buf: Buffer) => {
      for (let o = 0; o < buf.length; o += CELL_DATA_LEN)
        this.sendBackward(circ, CMD_DATA, new Uint8Array(buf.subarray(o, o + CELL_DATA_LEN)));
    });
    sock.on('close', () => {
      if (this.streams.has(circ)) this.sendBackward(circ, CMD_END, new Uint8Array(0));
      this.streams.delete(circ);
    });
    sock.on('error', () => {
      if (this.streams.has(circ)) this.sendBackward(circ, CMD_END, new Uint8Array(0));
      else this.sendBackward(circ, CMD_CONNECTED, Uint8Array.of(1)); // 连接失败
      this.streams.delete(circ);
    });
  }

  private sendBackward(circ: RelayCircuit, cmd: number, data: Uint8Array): void {
    const { n, body } = originateBackward(circ, cmd, data);
    circ.prevConn.send({ t: 'RELAY', c: circ.prevCirc, d: 'b', n, b: bytesToHex(body) });
  }
}
