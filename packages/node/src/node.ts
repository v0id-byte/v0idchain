// 节点：把 blockchain + 钱包 + p2p + 挖矿循环捏在一起。
import type { WebSocket } from 'ws';
import {
  Blockchain,
  Wallet,
  Block,
  Transaction,
  SYMBOL,
  createTransaction,
  loadOrCreateWallet,
  loadChain,
  saveChain,
  parseMarket,
  makeListing,
  BUY_PREFIX,
  DEL_PREFIX,
} from '@v0idchain/core';
import { P2P } from './p2p.js';

export interface NodeOptions {
  dataDir: string;
  p2pPort: number;
  advertise?: string;
  peers?: string[];
  maxPeers?: number;
}

export class V0idNode {
  readonly bc: Blockchain;
  readonly wallet: Wallet;
  readonly p2p: P2P;
  private readonly opts: NodeOptions;

  private epoch = 0; // 链一变就 +1，用于打断正在进行的挖矿
  private seenTx = new Set<string>(); // 已见过的交易，避免广播回声
  private static readonly MAX_SEEN = 5000; // seenTx 上限，FIFO 淘汰，防止长跑内存无界增长
  private mining = false;
  // ---- 同步门控：连上网络且追平后才开挖，避免一启动就从创世单独挖出一条平行链 ----
  private firstPeerAt = 0; // 首次连上对等节点的时刻（断网清零）
  private lastSyncAt = 0; // 最近收到 BLOCKS（同步）消息的时刻
  private initialSyncDone = false; // 初始同步是否完成
  private syncing = false; // 当前是否在“等同步”而暂不挖矿（给状态行/仪表盘看）

  /** 记下一个已见 txid，超上限就淘汰最早的（Set 保持插入序） */
  private markSeen(txid: string): void {
    this.seenTx.add(txid);
    if (this.seenTx.size > V0idNode.MAX_SEEN) {
      const oldest = this.seenTx.values().next().value;
      if (oldest !== undefined) this.seenTx.delete(oldest);
    }
  }

  constructor(opts: NodeOptions) {
    this.opts = opts;
    this.wallet = loadOrCreateWallet(opts.dataDir);
    this.bc = loadChain(opts.dataDir);
    this.p2p = new P2P({
      advertiseUrl: opts.advertise,
      maxPeers: opts.maxPeers,
      handlers: {
        getLatest: () => this.bc.latest,
        getChain: () => this.bc.chain,
        getHeight: () => this.bc.height,
        getAddress: () => this.wallet.address,
        onBlocks: (blocks, from) => this.onBlocks(blocks, from),
        onTx: (tx, from) => this.onTx(tx, from),
      },
    });
  }

  start(): void {
    this.p2p.start(this.opts.p2pPort);
    // 运营者显式种子：trusted（置顶、允许私网/环回，不被 gossip 过滤或淘汰）
    for (const url of this.opts.peers ?? []) this.p2p.connect(url, true);
  }

  // ---- 钱包动作 ----
  /** 本节点发起转账：算好 nonce、签名、进池、广播 */
  send(to: string, amount: number, memo = ''): { ok: boolean; tx?: Transaction; error?: string } {
    return this.submit(this.wallet, to, amount, memo);
  }

  private submit(
    wallet: Wallet,
    to: string,
    amount: number,
    memo: string,
  ): { ok: boolean; tx?: Transaction; error?: string } {
    const pending = this.bc.mempool.filter((t) => t.from === wallet.address).length;
    const nonce = this.bc.nonceOf(wallet.address) + pending;
    const tx = createTransaction(wallet, to, amount, nonce, memo);
    const r = this.bc.addTransaction(tx);
    if (!r.ok) return { ok: false, error: r.error };
    this.markSeen(tx.txid);
    this.p2p.broadcast({ type: 'TX', tx });
    this.persist();
    return { ok: true, tx };
  }

  // ---- 集市（基于转账+memo，不改共识）----
  /** 上架：自转 1 币，memo 记商品。需先有 ≥1 余额，且上架交易被挖进区块后才会出现在集市。 */
  marketSell(price: number, title: string): { ok: boolean; tx?: Transaction; error?: string } {
    const r = makeListing(price, title);
    if (!r.ok) return { ok: false, error: r.error };
    return this.submit(this.wallet, this.wallet.address, 1, r.memo!);
  }

  /** 在链上按 id 或唯一前缀找一件商品 */
  private findListing(idOrPrefix: string) {
    const ms = parseMarket(this.bc.chain).filter((x) => x.id === idOrPrefix || x.id.startsWith(idOrPrefix));
    if (ms.length === 0) return { error: '找不到该商品（可能还没被挖进区块）' as const };
    if (ms.length > 1) return { error: 'id 不唯一，请填更长的前缀' as const };
    return { listing: ms[0] };
  }

  /** 购买：付标价给卖家，memo 引用上架 txid（用完整 txid 引用，杜绝歧义） */
  marketBuy(id: string): { ok: boolean; tx?: Transaction; error?: string } {
    const f = this.findListing(id);
    if (!f.listing) return { ok: false, error: f.error };
    const l = f.listing;
    if (l.delisted) return { ok: false, error: '该商品已下架' };
    if (l.sold) return { ok: false, error: '该商品已售出' };
    if (l.seller === this.wallet.address) return { ok: false, error: '不能买自己的商品（可用 delist 撤单）' };
    return this.submit(this.wallet, l.seller, l.price, `${BUY_PREFIX}${l.id}`);
  }

  /** 撤单：卖家本人发 DEL memo */
  marketDelist(id: string): { ok: boolean; tx?: Transaction; error?: string } {
    const f = this.findListing(id);
    if (!f.listing) return { ok: false, error: f.error };
    if (f.listing.seller !== this.wallet.address) return { ok: false, error: '只能撤自己的单' };
    return this.submit(this.wallet, this.wallet.address, 1, `${DEL_PREFIX}${f.listing.id}`);
  }

  /** 全部商品（标注 mine = 是否本节点上架） */
  market() {
    const me = this.wallet.address;
    return parseMarket(this.bc.chain).map((l) => ({ ...l, mine: l.seller === me }));
  }

  // ---- 挖矿 ----
  /** 挖一个块：成功则上链、持久化、广播 */
  async mineOnce(): Promise<Block | null> {
    const startEpoch = this.epoch;
    const block = await this.bc.mine(this.wallet.address, () => this.epoch !== startEpoch);
    if (block) {
      this.onChainChanged();
      this.p2p.broadcast({ type: 'BLOCKS', blocks: [block] });
    }
    return block;
  }

  /**
   * 能否安全开挖？没配 --peers 的独立/创世节点恒可挖；联网节点必须先“连上 + 追平”，
   * 否则会从创世自己挖出一条平行链造成分叉。断网期间也暂停（不挖陈旧分叉）。
   */
  private canMine(): boolean {
    const networked = (this.opts.peers ?? []).length > 0;
    if (!networked) return true;
    if (this.p2p.peerCount() === 0) {
      this.firstPeerAt = 0;
      this.initialSyncDone = false; // 断网 → 重连后重新走一遍同步判定
      return false;
    }
    if (this.initialSyncDone) return true; // 已追平 → 连着就能挖
    if (this.firstPeerAt === 0) this.firstPeerAt = Date.now();
    const now = Date.now();
    // 连上 ≥3s、收到过同步消息、且最近 2.5s 没再涌入新块（说明历史补完了）→ 判定追平
    if (now - this.firstPeerAt > 3000 && this.lastSyncAt > 0 && now - this.lastSyncAt > 2500) {
      this.initialSyncDone = true;
      return true;
    }
    if (now - this.firstPeerAt > 30000) {
      this.initialSyncDone = true; // 兜底：连上 30s 还没判完也放行，避免永远不挖
      return true;
    }
    return false;
  }

  startMining(intervalMs: number): void {
    this.mining = true;
    const loop = async () => {
      if (!this.mining) return;
      if (!this.canMine()) {
        this.syncing = true; // 没连上/没追平 → 等，不挖（避免分叉）
        setTimeout(loop, 1000);
        return;
      }
      this.syncing = false;
      await this.mineOnce(); // 等这块挖完（PoW 真用时间）再排下一块
      if (this.mining) setTimeout(loop, intervalMs);
    };
    setTimeout(loop, intervalMs);
  }

  stopMining(): void {
    this.mining = false;
  }

  // ---- 接收 P2P 消息 ----
  private onBlocks(blocks: Block[], from: WebSocket): void {
    if (!blocks?.length) return;
    this.lastSyncAt = Date.now(); // 收到任何 BLOCKS（哪怕不比我新）都算“对方在跟我同步”
    const newLatest = blocks[blocks.length - 1];
    if (newLatest.index <= this.bc.height) return; // 对方不比我新

    if (blocks.length === 1 && newLatest.prevHash === this.bc.latest.hash) {
      // 正好是我的下一块
      if (this.bc.addBlock(newLatest).ok) {
        this.onChainChanged();
        this.p2p.broadcast({ type: 'BLOCKS', blocks: [newLatest] }, from);
      }
    } else if (blocks.length === 1) {
      // 落后不止一块（或有分叉）→ 要全链
      this.p2p.send(from, { type: 'QUERY_ALL' });
    } else {
      // 收到整条链 → 最长链规则
      if (this.bc.replaceChain(blocks).replaced) {
        this.onChainChanged();
        this.p2p.broadcast({ type: 'BLOCKS', blocks: [this.bc.latest] }, from);
      }
    }
  }

  private onTx(tx: Transaction, from: WebSocket): void {
    if (this.seenTx.has(tx.txid)) return;
    if (this.bc.addTransaction(tx).ok) {
      this.markSeen(tx.txid);
      this.p2p.broadcast({ type: 'TX', tx }, from); // 继续扩散
      this.persist();
    }
  }

  // ---- 杂项 ----
  private onChainChanged(): void {
    this.epoch++;
    this.persist();
  }

  private persist(): void {
    saveChain(this.opts.dataDir, this.bc);
  }

  info() {
    return {
      address: this.wallet.address,
      symbol: SYMBOL,
      height: this.bc.height,
      blocks: this.bc.chain.length,
      balance: this.bc.balanceOf(this.wallet.address),
      mempool: this.bc.mempool.length,
      difficulty: this.bc.tipDifficulty(),
      peers: this.p2p.peerCount(),
      peerList: this.p2p.peerList(),
      syncing: this.syncing, // true = 正在等连接/同步，暂未挖矿
    };
  }
}
