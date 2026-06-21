// P2P 网络：WebSocket 全双工，区块/交易广播，peer gossip 自动发现，断线自动重连。
import { WebSocket, WebSocketServer } from 'ws';
import type { Block, Transaction } from '@v0idchain/core';

/** 节点间消息协议 */
export type P2PMessage =
  | { type: 'HELLO'; address: string; height: number; listen: string }
  | { type: 'QUERY_LATEST' }
  | { type: 'QUERY_ALL' }
  | { type: 'BLOCKS'; blocks: Block[] }
  | { type: 'TX'; tx: Transaction }
  | { type: 'QUERY_PEERS' }
  | { type: 'PEERS'; peers: string[] };

/** 上层（节点）需要提供的回调 —— 让 p2p 不依赖 blockchain，避免循环引用 */
export interface P2PHandlers {
  getLatest(): Block;
  getChain(): Block[];
  getHeight(): number;
  getAddress(): string;
  onBlocks(blocks: Block[], from: WebSocket): void;
  onTx(tx: Transaction, from: WebSocket): void;
}

export interface P2POptions {
  handlers: P2PHandlers;
  advertiseUrl?: string; // 对外广播的本节点地址（公网/局域网）；缺省用 ws://127.0.0.1:<port>
  maxPeers?: number;
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

  /** 当前已连接的 socket → 元信息 */
  private peers = new Map<WebSocket, PeerMeta>();
  /** 听说过的对外地址（用于发现 + 重连） */
  private knownUrls = new Set<string>();
  /** 运营者显式提供的种子（--peers / 本地 /connect）：永不被 gossip 淘汰，且允许私网/环回地址 */
  private pinnedUrls = new Set<string>();
  /** 正在/已经拨号的地址，避免重复连接 */
  private dialedUrls = new Set<string>();

  constructor(opts: P2POptions) {
    this.handlers = opts.handlers;
    this.maxPeers = opts.maxPeers ?? 8;
    this.advertise = opts.advertiseUrl;
  }

  private get selfUrl(): string {
    return this.advertise ?? `ws://127.0.0.1:${this.port}`;
  }

  start(port: number): void {
    this.port = port;
    this.wss = new WebSocketServer({ port, maxPayload: P2P.MAX_WS_PAYLOAD });
    this.wss.on('connection', (ws) => this.setupSocket(ws));
    // 每 5s 尝试补连已知但未连上的节点（自愈 + 种子节点重连，掉线后快速回网）
    setInterval(() => this.reconnect(), 5_000).unref?.();
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

  /** 初始化一条连接：登记、握手、收消息、清理 */
  private setupSocket(ws: WebSocket, dialedUrl?: string): void {
    this.peers.set(ws, dialedUrl ? { listen: dialedUrl } : {});
    ws.on('message', (raw) => this.handle(ws, raw.toString()));
    ws.on('close', () => this.cleanup(ws, dialedUrl));
    ws.on('error', () => this.cleanup(ws, dialedUrl));
    // 握手：自报家门 + 问最新块 + 问对方认识谁
    this.send(ws, {
      type: 'HELLO',
      address: this.handlers.getAddress(),
      height: this.handlers.getHeight(),
      listen: this.selfUrl,
    });
    this.send(ws, { type: 'QUERY_LATEST' });
    this.send(ws, { type: 'QUERY_PEERS' });
  }

  private cleanup(ws: WebSocket, dialedUrl?: string): void {
    this.peers.delete(ws);
    if (dialedUrl) this.dialedUrls.delete(dialedUrl); // 允许之后重连
  }

  private handle(ws: WebSocket, raw: string): void {
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
            if (sock !== ws && m.listen === msg.listen) {
              if (this.handlers.getAddress() > msg.address) ws.close();
              return;
            }
          }
          const meta = this.peers.get(ws) ?? {};
          meta.address = msg.address;
          meta.listen = msg.listen;
          this.peers.set(ws, meta);
          if (isPublicWsUrl(msg.listen)) this.addKnown(msg.listen); // gossip 学来的 listen：仅记公网地址
          if (msg.height > this.handlers.getHeight()) this.send(ws, { type: 'QUERY_ALL' });
          break;
        }
        case 'QUERY_LATEST':
          this.send(ws, { type: 'BLOCKS', blocks: [this.handlers.getLatest()] });
          break;
        case 'QUERY_ALL':
          this.send(ws, { type: 'BLOCKS', blocks: this.handlers.getChain() });
          break;
        case 'BLOCKS':
          if (Array.isArray(msg.blocks)) this.handlers.onBlocks(msg.blocks, ws);
          break;
        case 'TX':
          if (msg.tx && typeof msg.tx === 'object') this.handlers.onTx(msg.tx, ws);
          break;
        case 'QUERY_PEERS':
          this.send(ws, { type: 'PEERS', peers: [...this.knownUrls, this.selfUrl] });
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

  send(ws: WebSocket, msg: P2PMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** 广播给所有连接（可排除来源，避免回声） */
  broadcast(msg: P2PMessage, except?: WebSocket): void {
    for (const ws of this.peers.keys()) {
      if (ws !== except) this.send(ws, msg);
    }
  }

  peerCount(): number {
    return this.peers.size;
  }

  peerList(): { url?: string; address?: string }[] {
    return [...this.peers.values()].map((m) => ({ url: m.listen, address: m.address }));
  }

  stop(): void {
    for (const ws of this.peers.keys()) ws.close();
    this.wss?.close();
  }
}
