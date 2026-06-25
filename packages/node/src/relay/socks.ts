// 本地 SOCKS5 前端：普通程序（curl/浏览器）把它当代理 → 每个 CONNECT 建一条 3 跳洋葱电路、双向桥接字节。
// 这让洋葱传输从“库”变成“能用的客户端匿名代理”。仅实现 CONNECT（RFC 1928），no-auth。
// 两类目标：① 普通 host:port → Tor-exit 式客户端匿名（目标服务看到出口而非你）；
//          ② <地址>.v0id（ATYP=domain）→ 走 rendezvous 连一个隐藏服务（双方互不知 IP）。后者需注入 HS deps；不注入时拒绝 .v0id。
import { createServer, type Server, type Socket } from 'node:net';
import { CircuitClient, type HopSpec } from './client.js';
import { connectHs, bridgeChannelToSocket, type HsDeps } from './hsbridge.js';

/** 选路器：返回有序 3 跳 [守卫, 中继, 出口]。生产应做 guard 钉固 + 加权随机；v1 由调用方注入。 */
export type HopPicker = () => HopSpec[];

// 顺序读固定字节数的小工具（SOCKS 握手是短小的顺序读）。
function makeReader(sock: Socket) {
  let buf = Buffer.alloc(0);
  let waiter: { n: number; res: (b: Buffer) => void } | null = null;
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    tryResolve();
  };
  function tryResolve() {
    if (waiter && buf.length >= waiter.n) {
      const w = waiter;
      waiter = null;
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.res(Buffer.from(out));
    }
  }
  sock.on('data', onData);
  return {
    read: (n: number) => new Promise<Buffer>((res) => ((waiter = { n, res }), tryResolve())),
    done: () => {
      sock.off('data', onData);
      return buf; // 握手后残留的字节 = 隧道流的开头
    },
  };
}

// SOCKS5 应答（10 字节）：VER REP RSV ATYP=IPv4 BND.ADDR=0 BND.PORT=0
const reply = (rep: number) => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]);
const MAX_CONNECT_ATTEMPTS = 3;

export class SocksProxy {
  private server: Server;
  constructor(
    private pickHops: HopPicker,
    readonly port: number,
    readonly host = '127.0.0.1',
    private hsDeps?: HsDeps, // 注入则 <地址>.v0id 经 rendezvous 连隐藏服务；不注入则 .v0id 返回 SOCKS 失败
  ) {
    this.server = createServer((s) => this.handle(s).catch(() => s.destroy()));
    this.server.listen(port, host);
  }
  close(): void {
    this.server.close();
  }

  private async handle(sock: Socket): Promise<void> {
    sock.on('error', () => {});
    const r = makeReader(sock);

    // 1) 协商：VER NMETHODS METHODS → 选 no-auth
    const greet = await r.read(2);
    if (greet[0] !== 0x05) return void sock.destroy();
    await r.read(greet[1]); // methods（忽略）
    sock.write(Buffer.from([0x05, 0x00]));

    // 2) 请求：VER CMD RSV ATYP …
    const head = await r.read(4);
    if (head[0] !== 0x05 || head[1] !== 0x01) {
      // 仅支持 CONNECT
      sock.write(reply(0x07));
      return void sock.destroy();
    }
    const atyp = head[3];
    let target: string;
    if (atyp === 0x01) {
      const a = await r.read(4);
      target = `${a[0]}.${a[1]}.${a[2]}.${a[3]}`;
    } else if (atyp === 0x03) {
      const len = (await r.read(1))[0];
      target = (await r.read(len)).toString('utf8');
    } else {
      sock.write(reply(0x08)); // 地址类型不支持（IPv6 留 Phase 2）
      return void sock.destroy();
    }
    const pb = await r.read(2);
    const port = (pb[0] << 8) | pb[1];

    // 2.5) .v0id 隐藏服务：经 rendezvous 连接，而非走 clearnet 出口。target 即 .v0id 地址（ATYP=domain）。
    if (target.endsWith('.v0id')) return void (await this.handleHidden(sock, r, target));

    // 3) 建电路 + 开流
    let client: CircuitClient | null = null;
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
      const hops = this.pickHops();
      const c = new CircuitClient();
      try {
        await c.connect(hops[0]);
        await c.extend(hops[1]);
        await c.extend(hops[2]);
        const ok = await c.beginStream(target, port);
        if (ok) {
          client = c;
          break;
        }
      } catch {
        // 换一条路再试；最后统一回 SOCKS 失败。
      }
      c.close();
    }
    if (!client) {
      sock.write(reply(0x05)); // 连接被拒（出口策略/目标拒/建路失败）
      return void sock.destroy();
    }
    sock.write(reply(0x00)); // 成功

    // 4) 双向桥接
    const leftover = r.done();
    if (leftover.length) client.write(new Uint8Array(leftover));
    client.onData((b) => sock.write(Buffer.from(b)));
    client.onEnd(() => sock.end());
    sock.on('data', (d) => client.write(new Uint8Array(d)));
    let closed = false;
    const closeCircuit = (sendEnd: boolean) => {
      if (closed) return;
      closed = true;
      if (sendEnd) client.endStream();
      client.close();
    };
    sock.on('close', () => closeCircuit(true));
    sock.on('error', () => closeCircuit(false));
  }

  // .v0id 分支：取描述符 → 经会合点与隐藏服务建端到端通道 → 把通道与本地 sock 双向桥接（与 clearnet 出口同形）。
  // 未注入 HS deps / 连接失败（地址未发布、握手失败、超时）→ 回 SOCKS 失败（不挂起，curl 会立即收到拒绝）。
  private async handleHidden(sock: Socket, r: ReturnType<typeof makeReader>, addr: string): Promise<void> {
    if (!this.hsDeps) {
      sock.write(reply(0x08)); // 未配置隐藏服务能力 → 地址类型/目标不支持
      return void sock.destroy();
    }
    let channel;
    try {
      channel = await connectHs(addr, this.hsDeps);
    } catch {
      sock.write(reply(0x04)); // 主机不可达（服务未发布 / 取不到描述符 / 握手失败）
      return void sock.destroy();
    }
    sock.write(reply(0x00)); // 成功
    // 握手阶段读到的残留字节 = 隧道流开头，交给 bridge 在挂好监听后灌入通道（分片 + 字节序由 bridge 负责）。
    const leftover = r.done();
    bridgeChannelToSocket(channel, sock, new Uint8Array(leftover));
  }
}
