// 本地 SOCKS5 前端：普通程序（curl/浏览器）把它当代理 → 每个 CONNECT 建一条 3 跳洋葱电路、双向桥接字节。
// 这让洋葱传输从“库”变成“能用的客户端匿名代理”。仅实现 CONNECT（RFC 1928），no-auth。
// 两类目标：① 普通 host:port → Tor-exit 式客户端匿名（目标服务看到出口而非你）；
//          ② <地址>.v0id（ATYP=domain）→ 走 rendezvous 连一个隐藏服务（双方互不知 IP）。后者需注入 HS deps；不注入时拒绝 .v0id。
import { createServer, type Server, type Socket } from 'node:net';
import { CircuitClient, type HopSpec } from './client.js';
import { connectHs, bridgeChannelToSocket, type HsDeps } from './hsbridge.js';
import { runPaywallClient } from './paywall.js';
import type { MintToken } from '../mint/token.js';

/** 券源：某付费 .v0id 站点要价 price 时，从本地钱包取一批面额和 ≥ price 的记名券。不足/无券应抛错（连接将被拒）。 */
export type VoucherSource = (addr: string, price: number) => Promise<MintToken[]>;

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
    private onGuardFail?: (guard: HopSpec) => void, // 连守卫(hop0)失败时回调 → 调用方据此把该守卫标记不可达、下次切备份
    private onHsFail?: (addr: string, reason: string) => void, // .v0id 连接失败时回调 → 调用方记下具体原因，供 GET /hs/lasterror 查询
    // middle/exit EXTEND 失败时回调（kind 区分哪一跳；exit 失败时附上 middle 供调用方消歧「怪 middle 还是怪 exit」）——
    // 调用方据此把链上目录里连不上/转不动的死中继计入可达性缓存，避免重试时反复挑中同一批死中继（同 hsbridge 的选路收敛）。
    private onHopFail?: (hop: HopSpec, kind: 'middle' | 'exit', middle?: HopSpec) => void,
    private onHopsProven?: (middle: HopSpec) => void, // 三跳全部建成时回调：middle 实测能转发，调用方可将其列为「已证骨干」
    private voucherSource?: VoucherSource, // 注入则能访问付费 .v0id 站点（自动从钱包取券预付）；不注入时付费站点返回 SOCKS 失败
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
        try {
          await c.connect(hops[0]);
        } catch (e) {
          this.onGuardFail?.(hops[0]); // 仅当连守卫(hop0)失败才回报 → 下次 pickHops 自动切钉住备份（不误伤并发新连接的钉固）
          throw e;
        }
        try {
          await c.extend(hops[1]);
        } catch (e) {
          this.onHopFail?.(hops[1], 'middle');
          throw e;
        }
        try {
          await c.extend(hops[2]);
        } catch (e) {
          this.onHopFail?.(hops[2], 'exit', hops[1]);
          throw e;
        }
        this.onHopsProven?.(hops[1]); // 三跳建成：middle 实测能转发到 exit
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
    let price: number | undefined;
    try {
      ({ channel, price } = await connectHs(addr, this.hsDeps));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[hs-connect] ${addr} 失败: ${reason}`);
      this.onHsFail?.(addr, reason);
      sock.write(reply(0x04)); // 主机不可达（服务未发布 / 取不到描述符 / 握手失败）
      return void sock.destroy();
    }
    // 付费站点（描述符携带 price>0）：在隧道内先跑付费墙握手（乐观预付），**通过后才回 SOCKS 成功**，
    // 让 curl 的 HTTP 请求只在付款后发出。放行全程链下（验签），不等出块 → 只多一个隧道往返。
    let payokLeftover: Uint8Array = new Uint8Array(0); // PAYOK 帧后同 cell 里紧跟的服务方响应开头（须写给 sock，不丢）
    if (price && price > 0) {
      if (!this.voucherSource) {
        this.onHsFail?.(addr, `站点需付费 ${price} $V0ID，但未配置券源`);
        channel.close();
        sock.write(reply(0x05));
        return void sock.destroy();
      }
      try {
        const vouchers = await this.voucherSource(addr, price);
        // 取券可能慢（钱包提示/读盘）。若此间 curl 已断开，别再递券——否则服务方核销掉券却无人接收（白烧券）。
        if (sock.destroyed) {
          channel.close();
          return;
        }
        payokLeftover = await runPaywallClient(channel, vouchers);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        this.onHsFail?.(addr, `付费失败：${reason}`);
        channel.close();
        sock.write(reply(0x05)); // 连接被拒（付费墙未通过）
        return void sock.destroy();
      }
    }
    sock.write(reply(0x00)); // 成功
    if (payokLeftover.length) sock.write(Buffer.from(payokLeftover)); // 服务方合帧发来的响应开头，先于后续通道字节写给下游
    // 握手阶段读到的残留字节 = 隧道流开头，交给 bridge 在挂好监听后灌入通道（分片 + 字节序由 bridge 负责）。
    const leftover = r.done();
    bridgeChannelToSocket(channel, sock, new Uint8Array(leftover));
  }
}
