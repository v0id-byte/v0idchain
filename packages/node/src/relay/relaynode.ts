// 中继节点（cell 平面服务端）：独立 WebSocketServer 收发 cell，按 circId 路由洋葱电路。
//
// 关键：中继**只在直接收到 CREATE 时**跑一次 ntor（建立“客户端↔本跳”的密钥）。延伸(EXTEND)时它只是把客户端
// 给下一跳的握手**转发**出去（发一个 CREATE 给下一跳、把回来的 CREATED 包成后向 EXTENDED 还给客户端）——
// 它**永远不知道**更深各跳的密钥与内容。这正是洋葱路由的匿名性来源：没有任何单跳同时知道两端 + 全路径。
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import {
  ntorServer,
  type OnionKeypair,
  hexToBytes,
  bytesToHex,
  addressToPublicKeyHex,
  CMD_EXTEND,
  CMD_EXTENDED,
  CMD_DATA,
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
/** 出口投递回调：收到面向本节点(出口)的 DATA → 业务处理 + reply 走原电路后向回客户端。 */
export type ExitHandler = (data: Uint8Array, reply: (resp: Uint8Array) => void) => void;

let LID = 0;
const mintCirc = () => randomBytes(8).toString('hex');

export class RelayNode {
  private wss: WebSocketServer;
  private table = new RelayCircuitTable();
  private idPub: Uint8Array;
  private exitHandler?: ExitHandler;

  constructor(
    readonly id: string, // 本中继钱包地址 0x..（= ntor relayId）
    private onion: OnionKeypair, // 静态 onion 密钥（公钥即 RELAY| 描述符的 okey）
    private resolve: RelayResolver,
    readonly port: number,
    readonly host = '127.0.0.1',
  ) {
    this.idPub = hexToBytes(addressToPublicKeyHex(id));
    this.wss = new WebSocketServer({ host, port });
    this.wss.on('connection', (ws) => this.wrap(ws));
  }

  onExit(h: ExitHandler): void {
    this.exitHandler = h;
  }
  get circuits(): number {
    return this.table.size;
  }
  async close(): Promise<void> {
    for (const c of this.table.all()) c.prevConn.close();
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
    ws.on('error', () => {});
    return link;
  }

  private onCell(link: CellLink, m: CellMsg): void {
    switch (m.t) {
      case 'CREATE': {
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
          maxFwdCtr: 0,
          bwdBase: makeBwdBase(randomBytes(3)),
          bwdLocal: 0,
          createdAt: Date.now(),
        };
        this.table.add(circ);
        link.send({ t: 'CREATED', c: m.c, y: bytesToHex(r.serverEph), a: bytesToHex(r.auth) });
        return;
      }
      case 'CREATED': {
        // 下一跳对我们(代客户端)发的 CREATE 的应答 → 包成后向 EXTENDED 还给客户端。
        const circ = this.table.byNext(m.c);
        if (!circ) return;
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
          if (!circ) return;
          const act = relayForward(circ, hexToBytes(m.b), m.n);
          if (act.kind === 'drop') return;
          if (act.kind === 'forward') {
            if (circ.nextConn && circ.nextCirc)
              circ.nextConn.send({ t: 'RELAY', c: circ.nextCirc, d: 'f', n: m.n, b: bytesToHex(act.body) });
            return;
          }
          // act.kind === 'self'：是给我的命令
          if (act.cmd === CMD_EXTEND) this.handleExtend(circ, act.data);
          else if (act.cmd === CMD_DATA && this.exitHandler)
            this.exitHandler(act.data, (resp) => this.sendBackward(circ, CMD_DATA, resp));
          return;
        }
        // 后向：来自下一跳，加本跳一层送回 prev
        const circ = this.table.byNext(m.c);
        if (!circ) return;
        const body = relayAddBackwardLayer(circ, hexToBytes(m.b), m.n);
        circ.prevConn.send({ t: 'RELAY', c: circ.prevCirc, d: 'b', n: m.n, b: bytesToHex(body) });
        return;
      }
      case 'DESTROY': {
        const circ = this.table.byPrev(m.c) ?? this.table.byNext(m.c);
        if (!circ) return;
        this.table.remove(circ);
        if (circ.nextConn && circ.nextCirc) circ.nextConn.send({ t: 'DESTROY', c: circ.nextCirc });
        return;
      }
    }
  }

  // EXTEND 数据 = nextHopId(32) ‖ clientEphX(32)。拨号下一跳、铸 nextCirc、转发 CREATE。
  private handleExtend(circ: RelayCircuit, data: Uint8Array): void {
    if (data.length < 64) return;
    const nextId = '0x' + bytesToHex(data.subarray(0, 32));
    const x = bytesToHex(data.subarray(32, 64));
    const at = this.resolve(nextId);
    if (!at) return; // 只连目录里的已知中继（杜绝 SSRF/放大）
    const ws = new WebSocket(`ws://${at.host}:${at.port}`, { maxPayload: 1 << 16 });
    const next = this.wrap(ws);
    const nextCirc = mintCirc();
    this.table.linkNext(circ, next, nextCirc);
    next.send({ t: 'CREATE', c: nextCirc, x }); // 缓冲到 open 后发
  }

  private sendBackward(circ: RelayCircuit, cmd: number, data: Uint8Array): void {
    const { n, body } = originateBackward(circ, cmd, data);
    circ.prevConn.send({ t: 'RELAY', c: circ.prevCirc, d: 'b', n, b: bytesToHex(body) });
  }
}
