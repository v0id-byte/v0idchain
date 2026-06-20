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
    for (const url of this.opts.peers ?? []) this.p2p.connect(url);
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

  // ---- 挖矿 ----
  /** 挖一个块：成功则上链、持久化、广播 */
  mineOnce(): Block | null {
    const startEpoch = this.epoch;
    const block = this.bc.mine(this.wallet.address, () => this.epoch !== startEpoch);
    if (block) {
      this.onChainChanged();
      this.p2p.broadcast({ type: 'BLOCKS', blocks: [block] });
    }
    return block;
  }

  startMining(intervalMs: number): void {
    this.mining = true;
    const loop = () => {
      if (!this.mining) return;
      this.mineOnce();
      setTimeout(loop, intervalMs);
    };
    setTimeout(loop, intervalMs);
  }

  stopMining(): void {
    this.mining = false;
  }

  // ---- 接收 P2P 消息 ----
  private onBlocks(blocks: Block[], from: WebSocket): void {
    if (!blocks?.length) return;
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
    };
  }
}
