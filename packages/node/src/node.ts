// 节点：把 blockchain + 钱包 + p2p + 挖矿循环捏在一起。
import type { Conn } from './transport.js';
import {
  Blockchain,
  Wallet,
  Block,
  Transaction,
  SYMBOL,
  MIN_FEE,
  FEE_RATE_BPS,
  minFeeFor,
  MESSAGE_BURN,
  MAX_MEMO,
  NULL_ADDRESS,
  SYSTEM_ADDRESSES,
  encryptMemo,
  decryptMemo,
  isEncryptedMemo,
  sign,
  createTransaction,
  createMessage,
  loadOrCreateWallet,
  loadChain,
  saveChain,
  parseMarket,
  parseMessages,
  parseNames,
  registryToJSON,
  makeNameClaim,
  parseRedPackets,
  makeRedPacket,
  RED_ESCROW_ADDRESS,
  CLAIM_PREFIX,
  REFUND_PREFIX,
  collectAddresses,
  makeListing,
  BUY_PREFIX,
  DEL_PREFIX,
  makeRelayClaim,
  parseRelays,
  relaysToJSON,
  makeStake,
  computeStakeState,
  STAKE_ESCROW_ADDRESS,
  UNSTAKE_PREFIX,
  type StakeRole,
} from '@v0idchain/core';
import { P2P } from './p2p.js';

const short = (addr: string) => (addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr);

/** 新成员事件：本次会话内首次见到的对等节点，或首次出现在链上的地址 */
export interface Newcomer {
  kind: 'peer' | 'address';
  address: string;
  at: number; // 发现时刻（本地时间戳）
  listen?: string; // kind=peer：对方对外 ws 地址
  height?: number; // kind=address：首次出现的区块高度
}

export interface NodeOptions {
  dataDir: string;
  p2pPort: number;
  advertise?: string;
  peers?: string[];
  maxPeers?: number;
  enableRtc?: boolean; // 启用 WebRTC mesh 传输（实验性，需 node-datachannel）；默认 false
  relaySignaling?: boolean; // 只做信令中继/介绍人（种子可不做 RTC 对端）；默认 = enableRtc
  serveChain?: boolean; // 是否服务整链同步；默认 true（false = 纯信令中继）
  onNotice?: (msg: string) => void; // 有新成员/事件时即时回调（CLI 传 console.log → 运行中实时打印）
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

  // ---- 新人发现：新节点上线 + 新地址首次上链 ----
  private seenPeers = new Set<string>(); // 本次会话已见过的对等节点地址（去重）
  private knownAddresses = new Set<string>(); // 已在链上出现过的地址（启动时按现有链播种，不刷屏历史）
  private lastScanHeight = 0; // 已扫描到的链高（增量检测新地址）
  private newcomers: Newcomer[] = []; // 最近的新成员（环形，最新在前）
  private static readonly MAX_NEWCOMERS = 100;

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
    // 启动时把现有链里的地址全部记为“已知”，并把扫描指针对齐链顶 —— 之后只对新涌现的地址报“新人”，不刷屏历史
    this.knownAddresses = collectAddresses(this.bc.chain);
    this.lastScanHeight = this.bc.height;
    this.p2p = new P2P({
      advertiseUrl: opts.advertise,
      maxPeers: opts.maxPeers,
      peersFile: opts.dataDir + '/peers.json',
      enableRtc: opts.enableRtc,
      relaySignaling: opts.relaySignaling,
      serveChain: opts.serveChain,
      handlers: {
        getLatest: () => this.bc.latest,
        getChain: () => this.bc.chain,
        getMempool: () => this.bc.mempool,
        getHeight: () => this.bc.height,
        getAddress: () => this.wallet.address,
        onBlocks: (blocks, from) => this.onBlocks(blocks, from),
        onTx: (tx, from) => this.onTx(tx, from),
        onPeer: (address, listen) => this.onPeer(address, listen),
        signSignal: (hex) => sign(hex, this.wallet.privateKey), // 用本节点私钥签 WebRTC 信令（§3.3）
      },
    });
  }

  start(): void {
    this.p2p.start(this.opts.p2pPort);
    // 运营者显式种子：trusted（置顶、允许私网/环回，不被 gossip 过滤或淘汰）
    for (const url of this.opts.peers ?? []) this.p2p.connect(url, true);
  }

  // ---- 钱包动作 ----
  /** 本节点发起转账：算好 nonce、签名、进池、广播。fee 省略时自动按比例计算（minFeeFor(amount)）。 */
  send(to: string, amount: number, memo = '', fee?: number): { ok: boolean; tx?: Transaction; error?: string } {
    return this.submit(this.wallet, to, amount, memo, fee ?? minFeeFor(amount));
  }

  /**
   * 给某地址发一条链上消息：不转币、烧 burn 个 $V0ID 进虚空、付 fee 给矿工。算好 nonce、签名、进池、广播。
   * encrypt=true → 用收件人公钥端到端加密正文（只有收发双方能解），密文以 `ENC|` 上链。
   */
  message(
    to: string,
    text: string,
    burn = MESSAGE_BURN,
    fee = MIN_FEE,
    encrypt = false,
  ): { ok: boolean; tx?: Transaction; error?: string } {
    let body = text;
    if (encrypt) {
      body = encryptMemo(text, to, this.wallet.privateKey);
      if ([...body].length > MAX_MEMO) {
        return { ok: false, error: `加密后超长（${[...body].length}>${MAX_MEMO}），消息太长` };
      }
    }
    const pending = this.bc.mempool.filter((t) => t.from === this.wallet.address).length;
    const nonce = this.bc.nonceOf(this.wallet.address) + pending;
    const tx = createMessage(this.wallet, to, body, nonce, burn, fee);
    const r = this.bc.addTransaction(tx);
    if (!r.ok) return { ok: false, error: r.error };
    this.markSeen(tx.txid);
    this.p2p.broadcast({ type: 'TX', tx });
    this.persist();
    return { ok: true, tx };
  }

  /**
   * 某地址的消息：received = 发给它的、sent = 它发出的（默认查本节点自己）。只含已上链的消息。
   * 加密私信（`ENC|`）用本节点私钥尝试解密：能解（本人收/发的）→ text=明文、encrypted=true；
   * 解不开（非本人，即查别人地址）→ 保留密文、locked=true。
   */
  messages(address = this.wallet.address) {
    const me = this.wallet.address;
    const decode = (m: ReturnType<typeof parseMessages>[number]) => {
      if (!isEncryptedMemo(m.text)) return { ...m, encrypted: false, locked: false };
      const other = m.to === me ? m.from : m.to; // 我是收件人→对方=发件人，否则→收件人
      const plain = decryptMemo(m.text, other, this.wallet.privateKey);
      return { ...m, encrypted: true, locked: plain === null, text: plain ?? m.text };
    };
    const all = parseMessages(this.bc.chain);
    return {
      address,
      received: all.filter((m) => m.to === address).map(decode),
      sent: all.filter((m) => m.from === address).map(decode),
    };
  }

  // ---- 链上昵称（全网唯一抢注）----
  /** 抢注一个昵称：自转 1 币 + memo `NAME|<名字>`（需 ≥2 余额；被挖进区块后生效）。先到先得。 */
  claimName(name: string): { ok: boolean; tx?: Transaction; error?: string } {
    const r = makeNameClaim(name);
    if (!r.ok) return { ok: false, error: r.error };
    return this.submit(this.wallet, this.wallet.address, 1, r.memo!, MIN_FEE);
  }

  /** 昵称注册表（名字↔地址），可 JSON 序列化 */
  names() {
    return registryToJSON(parseNames(this.bc.chain));
  }

  /** 发布本节点为洋葱中继：自转 1 币 + memo `RELAY|<okey>|<host:port>|<bw>|<stake>`（挖进区块后全网可发现）。 */
  publishRelay(onionPubHex: string, host: string, port: number): { ok: boolean; tx?: Transaction; error?: string } {
    const r = makeRelayClaim(onionPubHex, host, port);
    if (!r.ok) return { ok: false, error: r.error };
    return this.submit(this.wallet, this.wallet.address, 1, r.memo!, MIN_FEE);
  }

  /** 链上中继目录（地址→描述符），可 JSON 序列化 */
  relays() {
    return relaysToJSON(parseRelays(this.bc.chain));
  }

  // ---- 中继质押托管（Phase 3A-1）----
  /** 质押：转给质押托管地址 + memo `STAKE|<role>`，锁定该角色最低押金 STAKE_MIN[role]（需 ≥ 押金+手续费 余额）。 */
  stake(role: StakeRole): { ok: boolean; tx?: Transaction; error?: string } {
    const r = makeStake(role);
    if (!r.ok) return { ok: false, error: r.error };
    return this.submit(this.wallet, STAKE_ESCROW_ADDRESS, r.amount!, r.memo!, minFeeFor(r.amount!));
  }

  /** 赎回：发 UNSTAKE 交易（amount=0），过锁定期后取回本金-已罚没。stakeId = STAKE 交易 txid。 */
  unstake(stakeId: string): { ok: boolean; tx?: Transaction; error?: string } {
    return this.submit(this.wallet, this.wallet.address, 0, `${UNSTAKE_PREFIX}${stakeId}`, MIN_FEE);
  }

  /** 本节点地址名下的质押池列表（只读，从链上质押状态过滤出 staker=本地址）。 */
  stakes() {
    const me = this.wallet.address;
    return [...computeStakeState(this.bc.chain).entries()]
      .filter(([, p]) => p.staker === me)
      .map(([id, p]) => ({ id, ...p }));
  }

  /**
   * 本节点收到的中继激励发放（只读）：扫链上 `to==本地址` 且 memo 以 `REWARD|` 开头的交易。
   * 当前引导期不发放奖励（见 INCENTIVE-PROTOCOL）→ 正常返回空数组；接入按 epoch 结算后自然填充。
   * 仅做“展示/对账”，与共识无关（不解释 memo 语义、不改变余额计算）。
   */
  rewards() {
    const me = this.wallet.address;
    const out: { txid: string; from: string; amount: number; memo: string; height: number }[] = [];
    for (const b of this.bc.chain) {
      for (const tx of b.transactions) {
        if (tx.to === me && typeof tx.memo === 'string' && tx.memo.startsWith('REWARD|')) {
          out.push({ txid: tx.txid, from: tx.from, amount: tx.amount, memo: tx.memo, height: b.index });
        }
      }
    }
    return out;
  }

  // ---- 链上抢红包 ----
  /** 发红包：转给托管地址 + memo `RED|份数|模式`，锁总额、开池（需 ≥ 总额+手续费 余额；挖进区块后可抢）。 */
  redPacket(total: number, count: number, mode = 'r', fee?: number): { ok: boolean; tx?: Transaction; error?: string } {
    const r = makeRedPacket(total, count, mode as 'r' | 'e');
    if (!r.ok) return { ok: false, error: r.error };
    return this.submit(this.wallet, RED_ESCROW_ADDRESS, r.total!, r.memo!, fee ?? minFeeFor(r.total!));
  }

  /** 按 id 或唯一前缀找一个红包 */
  private findRed(idOrPrefix: string) {
    const ms = parseRedPackets(this.bc.chain).filter((p) => p.id === idOrPrefix || p.id.startsWith(idOrPrefix));
    if (ms.length === 0) return { error: '找不到该红包（可能还没被挖进区块）' as const };
    if (ms.length > 1) return { error: 'id 不唯一，请填更长的前缀' as const };
    return { red: ms[0] };
  }

  /** 抢红包：发 CLAIM 交易（amount=0），拼手气份额由共识按区块 hash 派发。 */
  grabRedPacket(idOrPrefix: string, fee = MIN_FEE): { ok: boolean; tx?: Transaction; error?: string } {
    const f = this.findRed(idOrPrefix);
    if (!f.red) return { ok: false, error: f.error };
    return this.submit(this.wallet, this.wallet.address, 0, `${CLAIM_PREFIX}${f.red.id}`, fee);
  }

  /** 退款：发起人在过期后取回剩余（发 REFUND 交易，amount=0）。 */
  refundRedPacket(idOrPrefix: string, fee = MIN_FEE): { ok: boolean; tx?: Transaction; error?: string } {
    const f = this.findRed(idOrPrefix);
    if (!f.red) return { ok: false, error: f.error };
    return this.submit(this.wallet, this.wallet.address, 0, `${REFUND_PREFIX}${f.red.id}`, fee);
  }

  /** 所有红包（标注 mine = 我发的、grabbedByMe = 我抢过） */
  redPackets() {
    const me = this.wallet.address;
    return parseRedPackets(this.bc.chain).map((p) => ({
      ...p,
      mine: p.creator === me,
      grabbedByMe: p.claims.some((c) => c.who === me),
    }));
  }

  // ---- 新人发现 ----
  private notice(msg: string): void {
    this.opts.onNotice?.(msg);
  }

  private pushNewcomer(n: Newcomer): void {
    this.newcomers.unshift(n);
    if (this.newcomers.length > V0idNode.MAX_NEWCOMERS) this.newcomers.length = V0idNode.MAX_NEWCOMERS;
  }

  /** 最近的新成员（最新在前），供 API / 仪表盘查看 */
  recentNewcomers(): Newcomer[] {
    return this.newcomers;
  }

  /** P2P 学到一个对等节点地址：本次会话首见即记为“新节点上线” */
  private onPeer(address: string, listen: string): void {
    if (!address || address === this.wallet.address || this.seenPeers.has(address)) return;
    this.seenPeers.add(address);
    this.notice(`🆕 新节点上线 ${short(address)} via ${listen}`);
    this.pushNewcomer({ kind: 'peer', address, listen, at: Date.now() });
  }

  /** 链增长后扫描新区块，发现“首次上链”的地址（增量；遇到回滚则静默重建已知集，避免刷屏） */
  private detectNewAddresses(): void {
    const h = this.bc.height;
    if (h <= this.lastScanHeight) {
      // 链未增长或发生回滚（reorg 变短）：静默把已知集与现有链对齐，不报“新人”
      if (h < this.lastScanHeight) this.knownAddresses = collectAddresses(this.bc.chain);
      this.lastScanHeight = h;
      return;
    }
    for (let i = this.lastScanHeight + 1; i <= h; i++) {
      for (const tx of this.bc.chain[i].transactions) {
        for (const addr of [tx.from, tx.to]) {
          // 跳过系统/协议地址（虚空、红包托管…）——它们不是真人，别误报成“新地址首次上链”
          if (SYSTEM_ADDRESSES.has(addr) || this.knownAddresses.has(addr)) continue;
          this.knownAddresses.add(addr);
          this.notice(`🆕 新地址首次上链 ${short(addr)} @ #${i}`);
          this.pushNewcomer({ kind: 'address', address: addr, height: i, at: Date.now() });
        }
      }
    }
    this.lastScanHeight = h;
  }

  private submit(
    wallet: Wallet,
    to: string,
    amount: number,
    memo: string,
    fee: number,
  ): { ok: boolean; tx?: Transaction; error?: string } {
    const pending = this.bc.mempool.filter((t) => t.from === wallet.address).length;
    const nonce = this.bc.nonceOf(wallet.address) + pending;
    const tx = createTransaction(wallet, to, amount, nonce, memo, fee);
    const r = this.bc.addTransaction(tx);
    if (!r.ok) return { ok: false, error: r.error };
    this.markSeen(tx.txid);
    this.p2p.broadcast({ type: 'TX', tx });
    this.persist();
    return { ok: true, tx };
  }

  // ---- 集市（基于转账+memo，不改共识）----
  /** 上架：自转 1 币（带最低手续费），memo 记商品。需 ≥ 1+手续费 余额，且上架交易被挖进区块后才会出现在集市。 */
  marketSell(price: number, title: string): { ok: boolean; tx?: Transaction; error?: string } {
    const r = makeListing(price, title);
    if (!r.ok) return { ok: false, error: r.error };
    return this.submit(this.wallet, this.wallet.address, 1, r.memo!, MIN_FEE);
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
    return this.submit(this.wallet, l.seller, l.price, `${BUY_PREFIX}${l.id}`, minFeeFor(l.price));
  }

  /** 撤单：卖家本人发 DEL memo */
  marketDelist(id: string): { ok: boolean; tx?: Transaction; error?: string } {
    const f = this.findListing(id);
    if (!f.listing) return { ok: false, error: f.error };
    if (f.listing.seller !== this.wallet.address) return { ok: false, error: '只能撤自己的单' };
    return this.submit(this.wallet, this.wallet.address, 1, `${DEL_PREFIX}${f.listing.id}`, MIN_FEE);
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
  private onBlocks(blocks: Block[], from: Conn): void {
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

  private onTx(tx: Transaction, from: Conn): void {
    if (this.seenTx.has(tx.txid)) return;
    if (this.bc.addTransaction(tx).ok) {
      this.markSeen(tx.txid);
      this.p2p.broadcast({ type: 'TX', tx }, from); // 继续扩散
      this.persist();
    }
  }

  /**
   * 接收一笔“外部已签名”的交易并广播 —— 给自托管钱包客户端（如游戏 web 端，经 HTTP /tx/submit 提交）用。
   * 与 P2P 的 onTx 同一条入池路径（bc.addTransaction 做自洽 + 余额 + nonce 校验），区别仅是没有来源 peer 要排除，
   * 故向全网广播。节点**只校验、不代签**：私钥始终只在客户端，节点伪造不了这笔交易。幂等：重复提交直接当成功。
   */
  acceptTx(tx: Transaction): { ok: boolean; error?: string } {
    if (this.seenTx.has(tx.txid)) return { ok: true };
    const r = this.bc.addTransaction(tx);
    if (!r.ok) return { ok: false, error: r.error };
    this.markSeen(tx.txid);
    this.p2p.broadcast({ type: 'TX', tx });
    this.persist();
    return { ok: true };
  }

  /**
   * 按 txid 查这笔交易的确认状态（只读，供客户端轮询“处理中 → 已到账”）：
   *   confirmed = 已被打包进区块（附区块高度 / hash）
   *   pending   = 还在交易池里等矿工打包
   *   unknown   = 本节点没见过（广播还没扩散到，或 txid 写错）
   * 从链顶往回找——刚发出的交易通常在最近的区块。
   */
  txStatus(txid: string): {
    txid: string;
    status: 'confirmed' | 'pending' | 'unknown';
    height?: number;
    blockHash?: string;
  } {
    for (let i = this.bc.chain.length - 1; i >= 0; i--) {
      const blk = this.bc.chain[i];
      if (blk.transactions.some((t) => t.txid === txid)) {
        return { txid, status: 'confirmed', height: blk.index, blockHash: blk.hash };
      }
    }
    if (this.bc.mempool.some((t) => t.txid === txid)) return { txid, status: 'pending' };
    return { txid, status: 'unknown' };
  }

  // ---- 杂项 ----
  private onChainChanged(): void {
    this.epoch++;
    this.detectNewAddresses(); // 链一变就看有没有新地址首次上链
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
      minFee: MIN_FEE, // 最低手续费（gas），供 CLI/仪表盘提示与表单默认值
      feeRateBps: FEE_RATE_BPS, // 比例手续费率（基点），供客户端动态计算推荐手续费
      messageBurn: MESSAGE_BURN, // 发消息默认销毁额，供表单默认值
      burned: this.bc.balanceOf(NULL_ADDRESS), // 🔥 全网已烧进虚空的 $V0ID 总额
      peers: this.p2p.peerCount(),
      peerList: this.p2p.peerList(),
      newcomers: this.newcomers.length, // 本次会话发现的新成员数
      syncing: this.syncing, // true = 正在等连接/同步，暂未挖矿
    };
  }
}
