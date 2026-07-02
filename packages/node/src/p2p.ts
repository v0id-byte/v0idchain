// P2P 网络：WebSocket 全双工，区块/交易广播，peer gossip 自动发现，断线自动重连。
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import {
  verify,
  addressToPublicKeyHex,
  blockHeaders,
  recentBlockWindow,
  findTxInclusionProof,
  addressInclusionProofs,
  type Block,
  type BlockHeader,
  type Transaction,
  type TxInclusionProof,
} from '@v0idchain/core';
import { type Conn, WsConn } from './transport.js';
import { RtcTransport, signalPayloadHex, type SignalMsg } from './rtc.js';

/** ws 连接 + 保活标记。ws 自身的类型里没有 isAlive，按 ws 官方保活写法在此扩出来（避免 any）。详见 P2P.startHeartbeat。 */
type KeepAliveWs = WebSocket & { isAlive?: boolean };

/** 节点间消息协议 */
export type P2PMessage =
  | { type: 'HELLO'; address: string; height: number; listen: string }
  | { type: 'QUERY_LATEST' }
  | { type: 'QUERY_ALL' }
  | { type: 'BLOCKS'; blocks: Block[]; from?: number; total?: number }
  | { type: 'QUERY_HEADERS'; from?: number; to?: number }
  | { type: 'HEADERS'; headers: BlockHeader[]; from?: number; total?: number }
  | { type: 'QUERY_BLOCK_RANGE'; from: number; to: number }
  | { type: 'QUERY_RECENT'; maxBlocks?: number; minTimestamp?: number }
  | { type: 'QUERY_TX_PROOF'; txid: string }
  | { type: 'TX_PROOF'; txid: string; proof?: TxInclusionProof; error?: string }
  | { type: 'QUERY_ADDRESS_PROOFS'; address: string; from?: number; to?: number }
  | { type: 'ADDRESS_PROOFS'; address: string; proofs: TxInclusionProof[]; from?: number; to?: number }
  | { type: 'TX'; tx: Transaction }
  | { type: 'QUERY_PEERS' }
  | { type: 'PEERS'; peers: string[] }
  | { type: 'PEER_ANNOUNCE'; address: string } // RTC 平面发现：广播某 peerId 已上线、可经我中继信令
  | SignalMsg; // SIGNAL_OFFER / SIGNAL_ANSWER / SIGNAL_ICE（§3.3）

/** 上层（节点）需要提供的回调 —— 让 p2p 不依赖 blockchain，避免循环引用 */
export interface P2PHandlers {
  getLatest(): Block;
  getChain(): Block[];
  getMempool(): Transaction[];
  getHeight(): number;
  getAddress(): string;
  onBlocks(blocks: Block[], from: Conn): void;
  onTx(tx: Transaction, from: Conn): void;
  onPeer?(address: string, listen: string): void; // HELLO 学到对方地址时回调（上层据此发现“新节点上线”）
  signSignal?(payloadHex: string): string; // 用本节点 ed25519 私钥签 WebRTC 信令；提供它 + enableRtc 才启用 RTC
}

export interface P2POptions {
  handlers: P2PHandlers;
  advertiseUrl?: string; // 对外广播的本节点地址（公网/局域网）；缺省用 ws://127.0.0.1:<port>
  maxPeers?: number;
  peersFile?: string;   // peers.json 路径；有则启动时加载、每 60s + stop 时写回
  enableRtc?: boolean;  // 本节点是否做 WebRTC 对端（需 node-datachannel + handlers.signSignal）；默认 false
  relaySignaling?: boolean; // 是否为别人介绍对端 + 1-hop 转发 SDP/ICE（种子可只做中继、不做 RTC 对端）；默认 = enableRtc
  serveChain?: boolean; // 是否响应 QUERY_LATEST/QUERY_ALL 供别人同步整链；默认 true（false = 纯信令中继，不服务链）
}

interface PeerMeta {
  address?: string;
  listen?: string; // 对方对外可连的 ws 地址
}

/**
 * 是否“公网可路由”地址：仅放行全局单播；拒绝环回 / RFC1918 私网 / 链路本地 / ULA / IPv4-mapped / NAT64 / 未指定。
 * 只用于过滤 **gossip 学来的** 地址（HELLO listen / PEERS），防被诱导去拨内网服务（SSRF 类）；
 * 运营者显式 --peers / 本地 /connect 走 trusted 通道、不过滤。仅过滤 IP 字面量，域名无法在此同步解析（DNS rebinding 超范围）。
 */
export function isPublicWsUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // 去掉 IPv6 字面量的方括号与 zone-id（Node 的 URL.hostname 对 ws:// 会**保留方括号**，
  // 不剥的话 [::1] / [::ffff:127.0.0.1] 都绕过下面的判断）
  host = host.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (host === '' || host === 'localhost') return false;
  if (host.includes(':')) {
    // IPv6：只放行全局单播 2000::/3（首个 hextet 落在 0x2000–0x3fff）。其余一律拒——含 ::1/:: 环回、
    // fe80 链路本地、fc/fd ULA、::ffff: IPv4-mapped、64:ff9b:: NAT64、多播等——杜绝用 IPv4-mapped
    // 等写法绕过私网过滤去拨内网（SSRF）。Node 把 ::ffff:127.0.0.1 规整成 ::ffff:7f00:1（十六进制），
    // 故按前缀文本逐一黑名单并不可靠，这里用“只放行全局单播”的白名单。
    const first = host.startsWith('::') ? 0 : parseInt(host.split(':')[0] || '', 16);
    return first >= 0x2000 && first <= 0x3fff;
  }
  if (host === '0.0.0.0') return false; // 未指定
  if (/^127\./.test(host)) return false; // 环回
  if (/^10\./.test(host)) return false; // RFC1918
  if (/^192\.168\./.test(host)) return false; // RFC1918
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false; // RFC1918
  if (/^169\.254\./.test(host)) return false; // 链路本地
  return true;
}

export class P2P {
  private wss?: WebSocketServer;
  private port = 0;
  private readonly handlers: P2PHandlers;
  private readonly maxPeers: number;
  private readonly advertise?: string;

  /** knownUrls 上限，封顶以防 gossip 灌爆内存 / 重连风暴 */
  private static readonly MAX_KNOWN = 512;

  /**
   * 单条 WS 消息大小上限。ws 默认 100MB，攻击者可发巨型 JSON 触发 OOM。
   * 这里收到 64MB：足够 QUERY_ALL 整链同步（≈1KB/块 → 约 6 万块的余量），又挡住更大的 OOM。
   * 注意：整链作为单条消息发送，链极长时仍会触顶 —— 彻底的做法是分片同步（教学链暂留此上限）。
   */
  private static readonly MAX_WS_PAYLOAD = 64 * 1024 * 1024;

  /**
   * 分块同步（QUERY_ALL 拆片）单连接聚合上限：chunkBuffers 最多为一条连接攒这么多块。
   * 防 OOM：BLOCKS 分片的 `total` 是对端自报、不可信——没有上限时一个已连 peer 发
   * `{from:0, total:1e15}` 就能让缓冲无界增长直至进程 OOM（攻击者零成本、无需私钥/PoW）。
   * 100 万块远超教学链可见规模（当前 ~数千块、约 360×），诚实整链同步绝不触顶；真要长到逼近
   * 这个数，运营者把常量调大即可（纯本机校验、各节点无需一致）。
   */
  private static readonly MAX_SYNC_BLOCKS = 1_000_000;

  /**
   * 分块同步**全局**聚合上限：所有连接的 chunkBuffers 合计不超过这么多块。
   * 上面的 per-connection 上限只挡单连接；但 inbound 连接数本身没有上限（setupSocket 不计 maxPeers），
   * 多条恶意 inbound 各撑一份缓冲仍会叠加把内存吃满（种子常跑在内存有限的树莓派上）。这里再加一道全局闸：
   * 整机所有分片缓冲合计封顶在此值（~1.2GB 量级），合法同步（几个 peer × 现链 ~数千块 = 几十 MB）绝不触顶。
   */
  private static readonly MAX_SYNC_BLOCKS_GLOBAL = 1_200_000;

  /** 单次轻客户端范围查询最多返回多少个完整块，避免把 QUERY_BLOCK_RANGE 变成无界整链下载。 */
  private static readonly MAX_LIGHT_BLOCK_RANGE = 10_000;

  /** 单次地址历史证明最多扫多少个高度。证明只是“返回项的存在证明”，不是全局无遗漏证明。 */
  private static readonly MAX_ADDRESS_PROOF_SPAN = 100_000;

  /**
   * WebRTC DataChannel 整链同步的分片大小（块数）。SCTP DataChannel 安全互操作上限 16 KiB、
   * >256 KiB 会被 Chromium/libwebrtc 硬关通道（docs/WEBRTC-MESH-DESIGN.md §3.5 / [V4]）。
   * 12 块 × ~1KB/块 安全落在 16 KiB 内。仅作用于 conn.kind==='rtc' 路径；WS 路径仍用 500。
   */
  private static readonly CHUNK_RTC = 12;

  /** 当前已连接的对等连接 → 元信息（key 是传输无关的 Conn，底层可能是 ws 或 rtc） */
  private peers = new Map<Conn, PeerMeta>();
  /** 分块同步缓冲：对等节点把大链拆片发来时，在这里攒齐再交给上层 */
  private chunkBuffers = new Map<Conn, { blocks: Block[]; total: number }>();
  /** 听说过的对外地址（用于发现 + 重连） */
  private knownUrls = new Set<string>();
  /** 运营者显式提供的种子（--peers / 本地 /connect）：永不被 gossip 淘汰，且允许私网/环回地址 */
  private pinnedUrls = new Set<string>();
  /** 正在/已经拨号的地址，避免重复连接 */
  private dialedUrls = new Set<string>();
  private readonly peersFile?: string;

  // ---- WebRTC mesh（Stage 1，docs/WEBRTC-MESH-DESIGN.md）----
  private static readonly STUN_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
  private readonly enableRtc: boolean;
  private readonly relaySignaling: boolean;
  private readonly serveChain: boolean;
  private rtc?: RtcTransport; // 异步加载完成后赋值；未启用/加载失败时为 undefined（节点保持 WS-only）
  /** 信令限速：以【收到信令的连接】为键（连接身份不可伪造，防冒名顶替挤掉受害者配额） */
  private readonly signalTimes = new Map<Conn, number[]>();

  constructor(opts: P2POptions) {
    this.handlers = opts.handlers;
    this.maxPeers = opts.maxPeers ?? 8;
    this.advertise = opts.advertiseUrl;
    this.peersFile = opts.peersFile;
    this.enableRtc = opts.enableRtc ?? false;
    this.relaySignaling = opts.relaySignaling ?? this.enableRtc; // RTC 对端默认也帮忙中继；纯中继节点单独开
    this.serveChain = opts.serveChain ?? true;
  }

  private get selfUrl(): string {
    return this.advertise ?? `ws://127.0.0.1:${this.port}`;
  }

  start(port: number): void {
    this.port = port;
    // 注意：不要给 WebSocketServer 传 pingInterval —— ws 的 ServerOptions 里没有这个选项（运行时会被
    // 静默忽略、保活成 no-op，且 @types/ws 报 TS2353）。真正的 WS 保活见下面的 startHeartbeat。
    this.wss = new WebSocketServer({ port, maxPayload: P2P.MAX_WS_PAYLOAD });
    // 端口被占等监听错误：给一行中文提示再退出，别甩 Node 堆栈
    this.wss.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`✖ P2P 端口 ${port} 已被占用——换 --p2p-port，或先关掉占用它的进程。`);
        process.exit(1);
      }
      throw e;
    });
    this.wss.on('connection', (ws) => this.setupSocket(ws));
    this.startHeartbeat(this.wss); // WS 保活：周期性 ping/pong，剔除死连接 + 刷新弱网/热点下移动端的连接映射
    this.loadPeers(); // 读取上次保存的邻居表，种子挂了也能找到已知节点
    // 每 5s 尝试补连已知但未连上的节点（自愈 + 种子节点重连，掉线后快速回网）
    setInterval(() => this.reconnect(), 5_000).unref?.();
    // 每 60s 持久化一次邻居表（Bitcoin peers.dat 同款机制）
    setInterval(() => this.savePeers(), 60_000).unref?.();
    this.initRtc(); // 启用时异步加载 node-datachannel，让本节点也能 WebRTC 打洞
  }

  /**
   * WebSocket 保活（ws 官方推荐写法）。
   *
   * 缘起：commit 43b7758「热点网络 WS 保活」本想给 WebSocketServer 传 `pingInterval` 选项做保活，
   * 但 ws 的 ServerOptions 根本没有这个选项 —— 运行时被静默忽略（保活成了 no-op），还让 node 包的
   * `typecheck` 报 TS2353。这里换成真正生效的官方写法。
   *
   * 机制：每 20s 给每条 inbound 连接发一个 WS 协议级 ping；对端 ws 库会自动回 pong，我们在连接的
   * 'pong' 事件里把它标记为存活（见 setupSocket）。若某连接到了下一轮仍未回过 pong（isAlive===false），
   * 判定为死连接并 terminate 掉。ping/pong 往返会在双向产生周期流量，从而刷新移动端(iOS/Android)在
   * 热点/弱网下被中间设备(NAT/防火墙)维护的连接映射，避免空闲被静默掐断 —— 这正是 43b7758 的初衷。
   *
   * 只遍历 wss.clients（inbound 连接）：移动端通常是主动拨入种子的一侧，对种子而言即 inbound，已覆盖到
   * 真正需要保活的链路；ping/pong 的双向流量也顺带让拨出方那一端的连接保活。
   */
  private startHeartbeat(wss: WebSocketServer): void {
    const interval = setInterval(() => {
      for (const ws of wss.clients) {
        const ka = ws as KeepAliveWs;
        if (ka.isAlive === false) {
          ka.terminate(); // 上一轮 ping 后始终没回 pong → 判死，强制断开（terminate 不走关闭握手）
          continue;
        }
        ka.isAlive = false; // 先置否，等本轮 ping 的 pong 回来再续命
        ka.ping();
      }
    }, 20_000); // 20s：足够频繁地刷新典型 30–60s 的 NAT/防火墙空闲超时
    interval.unref?.(); // 与 reconnect/savePeers 定时器一致：别让保活定时器吊住进程退出
    wss.on('close', () => clearInterval(interval)); // 服务器关闭即停止保活
  }

  /** 是否已经连到某个对外地址（按对方广播的 listen 判断） */
  private isConnectedTo(url: string): boolean {
    for (const m of this.peers.values()) if (m.listen === url) return true;
    return false;
  }

  /** 只接受形如 ws://host:port 的合法地址，挡住恶意节点灌进来的垃圾 URL */
  private isValidWsUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return (u.protocol === 'ws:' || u.protocol === 'wss:') && !!u.hostname;
    } catch {
      return false;
    }
  }

  /**
   * 受控地记入已知地址：先校验，再封顶。容量满时**淘汰最早的非置顶地址**（FIFO，Set 保持插入序），
   * 让新学到的诚实种子能挤掉攻击者灌入的垃圾；运营者种子（pinned）永不被淘汰。
   */
  private addKnown(url: string, pinned = false): void {
    if (!this.isValidWsUrl(url)) return;
    if (this.knownUrls.has(url)) {
      if (pinned) this.pinnedUrls.add(url);
      return;
    }
    if (this.knownUrls.size >= P2P.MAX_KNOWN) {
      let victim: string | undefined;
      for (const u of this.knownUrls) {
        if (!this.pinnedUrls.has(u)) {
          victim = u;
          break;
        }
      }
      if (victim === undefined) return; // 全是置顶种子 → 拒绝新增
      this.knownUrls.delete(victim);
    }
    this.knownUrls.add(url);
    if (pinned) this.pinnedUrls.add(url);
  }

  /**
   * 主动连接一个对等节点。trusted=true = 运营者显式提供（--peers / 本地 /connect）：地址被置顶
   * （不被 gossip 淘汰）且允许私网/环回。gossip 学来的地址（trusted=false）必须公网可路由，否则拒绝。
   */
  connect(url: string, trusted = false): void {
    url = url.trim();
    if (!url || url === this.selfUrl || this.dialedUrls.has(url) || this.isConnectedTo(url)) return;
    if (!this.isValidWsUrl(url)) return;
    if (!trusted && !isPublicWsUrl(url)) return; // gossip 来的私网/环回地址一律拒绝
    // 把“在途拨号”也计入上限，避免重连定时器一次性发起成百上千个连接
    if (this.peers.size + this.dialedUrls.size >= this.maxPeers) return;
    this.dialedUrls.add(url);
    this.addKnown(url, trusted);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { maxPayload: P2P.MAX_WS_PAYLOAD }); // 拨出方同样限大小：整链同步走这条 socket 收
    } catch {
      this.dialedUrls.delete(url);
      return;
    }
    ws.on('open', () => this.setupSocket(ws, url));
    ws.on('error', () => {
      this.dialedUrls.delete(url);
    });
  }

  private reconnect(): void {
    for (const url of this.knownUrls) {
      // 置顶（运营者）种子按 trusted 重连，允许其私网/环回地址继续回拨
      if (!this.dialedUrls.has(url)) this.connect(url, this.pinnedUrls.has(url));
    }
  }

  /** 初始化一条 WS 连接：包成 Conn、登记、握手、收消息、清理 */
  private setupSocket(ws: WebSocket, dialedUrl?: string): void {
    const conn = new WsConn(ws);
    this.peers.set(conn, dialedUrl ? { listen: dialedUrl } : {});
    // WS 保活：新连接先记为存活；之后每收到一个 pong（对 startHeartbeat 所发 ping 的自动回应）就续命，
    // startHeartbeat 据此判定并剔除不再回 pong 的死连接（详见该方法）。
    const ka = ws as KeepAliveWs;
    ka.isAlive = true;
    ws.on('pong', () => { ka.isAlive = true; });
    ws.on('message', (raw) => this.handle(conn, raw.toString()));
    ws.on('close', () => this.cleanup(conn, dialedUrl));
    ws.on('error', () => this.cleanup(conn, dialedUrl));
    // 握手：自报家门 + 问最新块 + 问对方认识谁
    this.send(conn, {
      type: 'HELLO',
      address: this.handlers.getAddress(),
      height: this.handlers.getHeight(),
      listen: this.selfUrl,
    });
    this.send(conn, { type: 'QUERY_LATEST' });
    this.send(conn, { type: 'QUERY_PEERS' });
  }

  private clampRange(chain: Block[], from: number, to: number, max: number): { from: number; to: number } | null {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
    if (chain.length === 0 || from >= chain.length) return null;
    const end = Math.min(to, chain.length - 1, from + max - 1);
    return { from, to: end };
  }

  /** 把当前交易池补给一个 peer。用于新 peer 追链后也能看到已广播但未打包的交易。 */
  private sendMempool(conn: Conn): void {
    for (const tx of this.handlers.getMempool()) this.send(conn, { type: 'TX', tx });
  }

  private cleanup(conn: Conn, dialedUrl?: string): void {
    this.peers.delete(conn);
    this.chunkBuffers.delete(conn); // 连接断了，清掉该连接的残留分片缓冲
    this.signalTimes.delete(conn); // 清掉该连接的信令限速计数
    if (dialedUrl) this.dialedUrls.delete(dialedUrl); // 允许之后重连
  }

  private handle(conn: Conn, raw: string): void {
    // 来自对等节点的消息一律视为不可信：解析失败、字段类型不对、结构畸形都直接丢弃，
    // 绝不让一个畸形包打挂整个节点。
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      switch (msg.type) {
        case 'HELLO': {
          if (
            typeof msg.listen !== 'string' ||
            typeof msg.address !== 'string' ||
            typeof msg.height !== 'number'
          ) {
            return;
          }
          // 去重：已有另一条连到同一对外地址的连接（双方同时互拨时会发生）。
          // 用地址字典序做确定性 tie-break，保证只有一侧主动关闭，避免两边都关或都不关。
          for (const [sock, m] of this.peers) {
            if (sock !== conn && m.listen === msg.listen) {
              if (this.handlers.getAddress() > msg.address) conn.close();
              return;
            }
          }
          const meta = this.peers.get(conn) ?? {};
          meta.address = msg.address;
          meta.listen = msg.listen;
          this.peers.set(conn, meta);
          conn.id = msg.address; // peerId 寻址（§3.2）：供 §3.3 信令 1-hop 中继按地址定位连接
          this.handlers.onPeer?.(msg.address, msg.listen); // 上层据此发现“新节点上线”（自行去重）
          if (this.relaySignaling) this.introducePeer(conn, msg.address); // RTC 平面：把双方互相介绍，便于打洞
          if (isPublicWsUrl(msg.listen)) this.addKnown(msg.listen); // gossip 学来的 listen：仅记公网地址
          if (msg.height > this.handlers.getHeight()) this.send(conn, { type: 'QUERY_ALL' });
          else if (msg.height === this.handlers.getHeight()) this.sendMempool(conn);
          break;
        }
        case 'QUERY_LATEST':
          if (this.serveChain) {
            this.send(conn, { type: 'BLOCKS', blocks: [this.handlers.getLatest()] });
            this.sendMempool(conn);
          }
          break;
        case 'QUERY_ALL': {
          if (!this.serveChain) break; // 纯信令中继节点不提供整链同步
          const chain = this.handlers.getChain();
          // 分片大小按传输选：WS 走 500（≈500KB，64MB 上限内）；RTC 走 CHUNK_RTC（§3.5，避开 16KiB DataChannel 上限）。
          const CHUNK = conn.kind === 'rtc' ? P2P.CHUNK_RTC : 500;
          // RTC 路径必须分片，绝不单条发全链（[V4]）；WS 路径保留“整链快捷”逐字节不变。
          if (conn.kind === 'ws' && chain.length <= CHUNK) {
            this.send(conn, { type: 'BLOCKS', blocks: chain });
          } else {
            for (let i = 0; i < chain.length; i += CHUNK) {
              this.send(conn, {
                type: 'BLOCKS',
                blocks: chain.slice(i, Math.min(i + CHUNK, chain.length)),
                from: i,
                total: chain.length,
              });
            }
          }
          this.sendMempool(conn);
          break;
        }
        case 'QUERY_HEADERS': {
          if (!this.serveChain) break;
          const chain = this.handlers.getChain();
          const range = this.clampRange(
            chain,
            typeof msg.from === 'number' ? msg.from : 0,
            typeof msg.to === 'number' ? msg.to : chain.length - 1,
            P2P.MAX_SYNC_BLOCKS,
          );
          if (!range) break;
          this.send(conn, {
            type: 'HEADERS',
            headers: blockHeaders(chain.slice(range.from, range.to + 1)),
            from: range.from,
            total: chain.length,
          });
          break;
        }
        case 'QUERY_BLOCK_RANGE': {
          if (!this.serveChain) break;
          const chain = this.handlers.getChain();
          const range = this.clampRange(chain, msg.from, msg.to, P2P.MAX_LIGHT_BLOCK_RANGE);
          if (!range) break;
          this.send(conn, { type: 'BLOCKS', blocks: chain.slice(range.from, range.to + 1), from: range.from, total: chain.length });
          this.sendMempool(conn);
          break;
        }
        case 'QUERY_RECENT': {
          if (!this.serveChain) break;
          const maxBlocks =
            Number.isInteger(msg.maxBlocks) && msg.maxBlocks > 0
              ? Math.min(msg.maxBlocks, P2P.MAX_LIGHT_BLOCK_RANGE)
              : P2P.MAX_LIGHT_BLOCK_RANGE;
          const minTimestamp = Number.isFinite(msg.minTimestamp) ? Number(msg.minTimestamp) : 0;
          this.send(conn, { type: 'BLOCKS', blocks: recentBlockWindow(this.handlers.getChain(), maxBlocks, minTimestamp) });
          this.sendMempool(conn);
          break;
        }
        case 'QUERY_TX_PROOF': {
          if (!this.serveChain || typeof msg.txid !== 'string') break;
          const proof = findTxInclusionProof(this.handlers.getChain(), msg.txid);
          this.send(conn, proof ? { type: 'TX_PROOF', txid: msg.txid, proof } : { type: 'TX_PROOF', txid: msg.txid, error: 'not found' });
          break;
        }
        case 'QUERY_ADDRESS_PROOFS': {
          if (!this.serveChain || typeof msg.address !== 'string') break;
          const chain = this.handlers.getChain();
          const range = this.clampRange(
            chain,
            typeof msg.from === 'number' ? msg.from : 0,
            typeof msg.to === 'number' ? msg.to : chain.length - 1,
            P2P.MAX_ADDRESS_PROOF_SPAN,
          );
          if (!range) break;
          this.send(conn, {
            type: 'ADDRESS_PROOFS',
            address: msg.address,
            proofs: addressInclusionProofs(chain, msg.address, range.from, range.to),
            from: range.from,
            to: range.to,
          });
          break;
        }
        case 'BLOCKS': {
          if (!Array.isArray(msg.blocks)) break;
          if (typeof msg.from === 'number' && typeof msg.total === 'number') {
            // 分块同步：对方把大链拆片发来，攒齐后再交给上层。
            // 防 OOM（不可信输入）：开片时校验 `total` 必须是 [1, MAX_SYNC_BLOCKS] 的整数——挡住
            // `{total:1e15}` / NaN / Infinity / 负数 这类把缓冲撑爆的恶意值；攒片时聚合长度不得超过
            // 对端自己承诺的 total（诚实发送方永不超发），一旦超发就丢弃该连接的整个分片缓冲。
            if (msg.from === 0) {
              if (!Number.isInteger(msg.total) || msg.total < 1 || msg.total > P2P.MAX_SYNC_BLOCKS) break;
              this.chunkBuffers.set(conn, { blocks: [], total: msg.total });
            }
            const buf = this.chunkBuffers.get(conn);
            if (!buf || buf.total !== msg.total) break; // total 对不上（新一轮请求），丢弃旧片
            if (buf.blocks.length + msg.blocks.length > buf.total) {
              this.chunkBuffers.delete(conn); // 收到的片比承诺的多 → 异常/恶意，丢弃缓冲
              break;
            }
            // 全局闸：所有连接的分片缓冲合计不得超过 MAX_SYNC_BLOCKS_GLOBAL（防多 inbound 连接叠加 OOM）。
            // 每次重算（缓冲条目数 = 连接数，量很小，开销可忽略）。
            let globalBuffered = 0;
            for (const b of this.chunkBuffers.values()) globalBuffered += b.blocks.length;
            if (globalBuffered + msg.blocks.length > P2P.MAX_SYNC_BLOCKS_GLOBAL) {
              this.chunkBuffers.delete(conn);
              break;
            }
            buf.blocks.push(...msg.blocks);
            if (buf.blocks.length >= buf.total) {
              this.chunkBuffers.delete(conn);
              this.handlers.onBlocks(buf.blocks, conn);
            }
          } else {
            this.handlers.onBlocks(msg.blocks, conn);
          }
          break;
        }
        case 'TX':
          if (msg.tx && typeof msg.tx === 'object') this.handlers.onTx(msg.tx, conn);
          break;
        case 'QUERY_PEERS':
          this.send(conn, { type: 'PEERS', peers: [...this.knownUrls, this.selfUrl] });
          break;
        case 'PEER_ANNOUNCE':
          if (typeof msg.address === 'string') this.rtc?.discover(msg.address, conn); // 仅本节点启用 RTC 时生效
          break;
        case 'SIGNAL_OFFER':
        case 'SIGNAL_ANSWER':
        case 'SIGNAL_ICE':
          this.routeSignal(conn, msg); // 验签 + 限速 + 时窗 → 喂本地 / 1-hop 中继给目标
          break;
        case 'PEERS':
          if (Array.isArray(msg.peers)) {
            for (const url of msg.peers) if (typeof url === 'string') this.connect(url);
          }
          break;
      }
    } catch {
      // 畸形 block/tx 在校验时抛错 → 丢弃该消息，节点继续运行
    }
  }

  send(conn: Conn, msg: P2PMessage): void {
    conn.send(msg); // 序列化 + OPEN 检查下沉到各传输的 Conn 实现（WsConn/RtcConn）
  }

  /** 广播给所有连接（可排除来源，避免回声） */
  broadcast(msg: P2PMessage, except?: Conn): void {
    for (const conn of this.peers.keys()) {
      if (conn !== except) conn.send(msg);
    }
  }

  peerCount(): number {
    return this.peers.size;
  }

  /** 当前 WebRTC（rtc）对端数量；未启用/未加载 RTC 时为 0。诊断/测试用。 */
  rtcPeerCount(): number {
    return this.rtc?.count() ?? 0;
  }

  /** 各对端传输类型（'ws'|'rtc'）列表。诊断用。 */
  peerKinds(): string[] {
    return [...this.peers.keys()].map((c) => c.kind);
  }

  peerList(): { url?: string; address?: string }[] {
    return [...this.peers.values()].map((m) => ({ url: m.listen, address: m.address }));
  }

  // ---- WebRTC mesh（Stage 1）：信令中继 + 连接采纳 ----

  /** 启动后异步加载 node-datachannel；成功则本节点能 WebRTC 打洞，失败则保持 WS-only（绝不崩）。 */
  private initRtc(): void {
    if (!this.enableRtc || !this.handlers.signSignal) return;
    RtcTransport.load({
      selfAddress: this.handlers.getAddress(),
      iceServers: P2P.STUN_SERVERS,
      sign: (hex) => this.handlers.signSignal!(hex),
      sendSignal: (m, via) => this.sendSignal(m, via),
      onOpen: (c) => this.adoptRtcConn(c),
      onMessage: (c, raw) => this.handle(c, raw),
      onClose: (c) => this.cleanup(c),
      maxPeers: this.maxPeers,
      peerCount: () => this.peers.size,
    }).then((t) => {
      this.rtc = t ?? undefined;
      if (!t) console.error('⚠ WebRTC 不可用（node-datachannel 未加载）；本节点降级为 WS-only。');
    });
  }

  /** 把新来者与已有对端互相介绍（发 PEER_ANNOUNCE），让它们据 peerId 发起 RTC 打洞（种子充当介绍人）。 */
  private introducePeer(newConn: Conn, addr: string): void {
    if (!addr || addr === this.handlers.getAddress()) return;
    for (const [c, m] of this.peers) {
      if (c === newConn) continue;
      c.send({ type: 'PEER_ANNOUNCE', address: addr }); // 告诉其它对端：addr 上线了
      if (m.address && m.address !== addr) newConn.send({ type: 'PEER_ANNOUNCE', address: m.address }); // 告诉新来者：谁在线
    }
  }

  /** 把一条信令送上线：优先走学到该对端的那条连接（种子）；否则发给所有 WS 连接由其 1-hop 中继。 */
  private sendSignal(msg: SignalMsg, via?: Conn): void {
    if (via && this.peers.has(via) && via.isOpen()) {
      via.send(msg);
      return;
    }
    for (const conn of this.peers.keys()) if (conn.kind === 'ws') conn.send(msg);
  }

  /** DataChannel 打开 → 当作一条普通对等连接登记并握手（与 setupSocket 同款 HELLO/QUERY）。 */
  private adoptRtcConn(conn: Conn): void {
    if (this.peers.has(conn)) return;
    this.peers.set(conn, { address: conn.id });
    this.send(conn, {
      type: 'HELLO',
      address: this.handlers.getAddress(),
      height: this.handlers.getHeight(),
      listen: this.selfUrl,
    });
    this.send(conn, { type: 'QUERY_LATEST' });
    this.sendMempool(conn);
  }

  /**
   * 处理一条信令：验签（防伪造 offer / 放大）+ 限速 + 时窗后，喂给本地 RTC 或 1-hop 中继给目标。
   * 跳数硬上限 1：to 不是自己就只转一次给目标连接，绝不再扩散。
   */
  private routeSignal(conn: Conn, msg: any): void {
    // 既不中继、也不做 RTC 对端的默认节点：信令与它无关，连验签都不必做（省 CPU + 收紧“零行为变化”）。
    if (!this.relaySignaling && !this.rtc) return;
    if (
      typeof msg.to !== 'string' ||
      typeof msg.from !== 'string' ||
      typeof msg.sig !== 'string' ||
      typeof msg.ts !== 'number'
    ) {
      return;
    }
    if (!/^0x[0-9a-f]{64}$/.test(msg.from)) return; // from 必须是合法地址（= ed25519 公钥）
    if (Math.abs(Date.now() - msg.ts) > 60_000) return; // 时窗：拒重放
    // 限速键 = 收到信令的【连接】而非 msg.from：连接身份不可伪造，攻击者无法冒用受害者地址耗尽其配额
    // 把受害者的合法信令在中继处挤掉；同时把每连接的验签 CPU 也封顶（验签前先挡）。
    if (!this.signalAllowed(conn)) return;
    if (!verify(msg.sig, signalPayloadHex(msg), addressToPublicKeyHex(msg.from))) return; // 验签
    if (msg.to === this.handlers.getAddress()) {
      this.rtc?.onSignal(msg as SignalMsg, conn); // 发给我的 → 喂本地 PeerConnection
    } else if (this.relaySignaling) {
      for (const [c, m] of this.peers) {
        if (m.address === msg.to) {
          c.send(msg as SignalMsg); // 1-hop 中继给目标（仅中继节点转发，绝不再扩散）
          break;
        }
      }
    }
  }

  /** 信令限速：每【连接】10s 内 ≤ 100 条（ICE trickle 会有若干 candidate，足够且能挡洪泛）。条目随连接断开清理。 */
  private signalAllowed(conn: Conn): boolean {
    const now = Date.now();
    const arr = (this.signalTimes.get(conn) ?? []).filter((t) => now - t < 10_000);
    if (arr.length >= 100) {
      this.signalTimes.set(conn, arr);
      return false;
    }
    arr.push(now);
    this.signalTimes.set(conn, arr);
    return true;
  }

  stop(): void {
    this.savePeers(); // 优雅退出时写一次，保住最新邻居表
    this.rtc?.stop();
    for (const conn of this.peers.keys()) conn.close();
    this.wss?.close();
  }

  // ---- peers.json 持久化（Bitcoin peers.dat 同款：重启后不依赖种子就能找到邻居）----
  private loadPeers(): void {
    if (!this.peersFile) return;
    try {
      // 兜底收紧权限：早期版本生成的 peers.json 可能是 0644（与 wallet/token/chain 统一为 0600）。
      try { chmodSync(this.peersFile, 0o600); } catch { /* 尽力而为 */ }
      const data = JSON.parse(readFileSync(this.peersFile, 'utf8'));
      if (Array.isArray(data)) {
        for (const url of data) if (typeof url === 'string') this.addKnown(url);
      }
    } catch { /* 文件不存在或格式错误，静默忽略 */ }
  }

  private savePeers(): void {
    if (!this.peersFile) return;
    try {
      // 只存公网可路由地址（过滤掉自身、环回、私网），重启后才能真正连上
      const urls = [...this.knownUrls].filter((u) => u !== this.selfUrl && isPublicWsUrl(u));
      // 0600：与 wallet/token/chain 统一收紧本机数据文件权限（peers.json 仅公网 URL、不机密，仍统一）。
      writeFileSync(this.peersFile, JSON.stringify(urls), { mode: 0o600 });
      try { chmodSync(this.peersFile, 0o600); } catch { /* 尽力而为 */ }
    } catch { /* 磁盘写失败静默忽略，不能因此崩节点 */ }
  }
}
