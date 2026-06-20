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

export class P2P {
  private wss?: WebSocketServer;
  private port = 0;
  private readonly handlers: P2PHandlers;
  private readonly maxPeers: number;
  private readonly advertise?: string;

  /** knownUrls 上限，封顶以防 gossip 灌爆内存 / 重连风暴 */
  private static readonly MAX_KNOWN = 512;

  /** 当前已连接的 socket → 元信息 */
  private peers = new Map<WebSocket, PeerMeta>();
  /** 听说过的对外地址（用于发现 + 重连） */
  private knownUrls = new Set<string>();
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
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => this.setupSocket(ws));
    // 每 15s 尝试补连已知但未连上的节点（自愈 + 种子节点重连）
    setInterval(() => this.reconnect(), 15_000).unref?.();
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

  /** 受控地记入已知地址：先校验，再封顶（防止 gossip 把 knownUrls 撑爆 → 重连风暴） */
  private addKnown(url: string): void {
    if (!this.isValidWsUrl(url)) return;
    if (this.knownUrls.size >= P2P.MAX_KNOWN && !this.knownUrls.has(url)) return;
    this.knownUrls.add(url);
  }

  /** 主动连接一个对等节点 */
  connect(url: string): void {
    url = url.trim();
    if (!url || url === this.selfUrl || this.dialedUrls.has(url) || this.isConnectedTo(url)) return;
    if (!this.isValidWsUrl(url)) return;
    // 把“在途拨号”也计入上限，避免重连定时器一次性发起成百上千个连接
    if (this.peers.size + this.dialedUrls.size >= this.maxPeers) return;
    this.dialedUrls.add(url);
    this.addKnown(url);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
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
      if (!this.dialedUrls.has(url)) this.connect(url);
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
          this.addKnown(msg.listen);
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
