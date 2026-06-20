// 区块链：创世、校验、余额/nonce 状态、mempool、自适应难度、最长链共识。
import { Block, calcBlockHash, meetsDifficulty, mineBlock } from './block.js';
import {
  Transaction,
  isCoinbase,
  verifyTransaction,
  createCoinbase,
  createGenesisTx,
} from './transaction.js';
import {
  BLOCK_REWARD,
  NULL_ADDRESS,
  GENESIS_TIMESTAMP,
  GENESIS_PREMINE_ADDRESS,
  GENESIS_DIFFICULTY,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  TARGET_BLOCK_TIME_MS,
  RETARGET_INTERVAL,
} from './config.js';
import { isValidAddress, merkleRoot } from './crypto.js';

/** 创世区块：不做 PoW，参数全固定 → 所有节点算出同一个 hash。 */
export function genesisBlock(): Block {
  const tx = createGenesisTx(GENESIS_PREMINE_ADDRESS);
  const template: Omit<Block, 'hash'> = {
    index: 0,
    timestamp: GENESIS_TIMESTAMP,
    prevHash: '0'.repeat(64),
    transactions: [tx],
    merkleRoot: merkleRoot([tx.txid]),
    difficulty: GENESIS_DIFFICULTY,
    nonce: 0,
    miner: NULL_ADDRESS,
  };
  return { ...template, hash: calcBlockHash(template) };
}

/**
 * 自适应难度：纯函数，从链历史确定性地算出 index 处区块应满足的难度（前导 0 比特数）。
 * 所有节点算法一致，因此无法伪造难度。每 RETARGET_INTERVAL 块按实际耗时调整一次。
 */
export function expectedDifficulty(chain: Block[], index: number): number {
  if (index === 0) return GENESIS_DIFFICULTY;
  const prev = chain[index - 1];
  // 非重定向点，或窗口会触及“时间戳是固定古值”的创世块 → 沿用上一块难度
  if (index % RETARGET_INTERVAL !== 0 || index - RETARGET_INTERVAL < 1) return prev.difficulty;

  const windowStart = chain[index - RETARGET_INTERVAL];
  // 窗口 = prev 与 windowStart 之间的实际耗时，跨越 RETARGET_INTERVAL-1 个出块间隔
  // （避开比特币那个 2015/2016 的 off-by-one，让重定向精确对齐目标）。
  const actual = prev.timestamp - windowStart.timestamp;
  const expected = (RETARGET_INTERVAL - 1) * TARGET_BLOCK_TIME_MS;
  // 每差一倍调 1 bit（log2），钳制单次 ±2；太快→加难度，太慢→减难度
  const delta = actual <= 0 ? 2 : Math.max(-2, Math.min(2, Math.round(Math.log2(expected / actual))));
  return Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, prev.difficulty + delta));
}

export interface ChainState {
  balances: Map<string, number>;
  nonces: Map<string, number>;
}

export interface ChainJSON {
  chain: Block[];
  mempool: Transaction[];
}

export class Blockchain {
  chain: Block[];
  mempool: Transaction[] = [];

  constructor() {
    this.chain = [genesisBlock()];
  }

  get latest(): Block {
    return this.chain[this.chain.length - 1];
  }

  /** 链高（创世为 0） */
  get height(): number {
    return this.chain.length - 1;
  }

  /** 下一块要求的难度（供展示用） */
  tipDifficulty(): number {
    return expectedDifficulty(this.chain, this.height + 1);
  }

  // ---- 状态：重放整条链，得到余额表与 nonce 表 ----
  computeState(chain: Block[] = this.chain): ChainState {
    const balances = new Map<string, number>();
    const nonces = new Map<string, number>();
    const credit = (addr: string, amt: number) =>
      balances.set(addr, (balances.get(addr) ?? 0) + amt);

    for (const block of chain) {
      for (const tx of block.transactions) {
        if (!isCoinbase(tx)) {
          credit(tx.from, -tx.amount);
          nonces.set(tx.from, (nonces.get(tx.from) ?? 0) + 1);
        }
        credit(tx.to, tx.amount);
      }
    }
    return { balances, nonces };
  }

  balanceOf(address: string): number {
    return this.computeState().balances.get(address) ?? 0;
  }

  /** 某地址已上链的交易数 = 下一笔交易应使用的 nonce */
  nonceOf(address: string): number {
    return this.computeState().nonces.get(address) ?? 0;
  }

  // ---- mempool：待打包交易池 ----
  /** 收一笔交易进池。会校验签名、nonce 顺序、（含池内待发）余额。 */
  addTransaction(tx: Transaction): { ok: boolean; error?: string } {
    if (isCoinbase(tx)) return { ok: false, error: 'coinbase 不能进入交易池' };
    // 先单独判金额，给出明确报错（否则非整数会被 verifyTransaction 当成“签名无效”，误导用户）
    if (!Number.isInteger(tx.amount) || tx.amount <= 0) return { ok: false, error: '金额必须是正整数' };
    if (!verifyTransaction(tx)) return { ok: false, error: '签名无效或备注超长' };
    if (!isValidAddress(tx.to) || tx.to === NULL_ADDRESS) {
      return { ok: false, error: '收款地址格式无效' }; // 防止打钱给畸形/空地址导致永久销毁
    }
    if (this.mempool.some((t) => t.txid === tx.txid)) return { ok: false, error: '交易已在池中' };

    const { balances, nonces } = this.computeState();
    const pending = this.mempool.filter((t) => t.from === tx.from);
    const expectedNonce = (nonces.get(tx.from) ?? 0) + pending.length;
    if (tx.nonce !== expectedNonce) {
      return { ok: false, error: `nonce 错误：期望 ${expectedNonce}，收到 ${tx.nonce}` };
    }
    const pendingOut = pending.reduce((s, t) => s + t.amount, 0);
    const available = (balances.get(tx.from) ?? 0) - pendingOut;
    if (tx.amount > available) {
      return { ok: false, error: `余额不足：可用 ${available}，需要 ${tx.amount}` };
    }
    this.mempool.push(tx);
    return { ok: true };
  }

  /** 从 mempool 顺序挑出能干净应用到当前链顶的交易（保证打出的块必然合法） */
  private selectMempoolTxs(): Transaction[] {
    const { balances, nonces } = this.computeState();
    const selected: Transaction[] = [];
    for (const tx of this.mempool) {
      const bal = balances.get(tx.from) ?? 0;
      const expected = nonces.get(tx.from) ?? 0;
      if (tx.nonce === expected && tx.amount <= bal && verifyTransaction(tx)) {
        selected.push(tx);
        balances.set(tx.from, bal - tx.amount);
        balances.set(tx.to, (balances.get(tx.to) ?? 0) + tx.amount);
        nonces.set(tx.from, expected + 1);
      }
    }
    return selected;
  }

  // ---- 挖矿 ----
  /** 打包 coinbase + mempool 交易，按自适应难度做 PoW，成功则上链。返回新块或 null（被打断）。 */
  async mine(minerAddress: string, shouldStop?: () => boolean): Promise<Block | null> {
    const index = this.height + 1;
    const transactions = [createCoinbase(minerAddress, index), ...this.selectMempoolTxs()];
    // 时间戳不能早于链顶（校验要求单调不减）
    const timestamp = Math.max(Date.now(), this.latest.timestamp);
    const template: Omit<Block, 'hash' | 'nonce'> = {
      index,
      timestamp,
      prevHash: this.latest.hash,
      transactions,
      merkleRoot: merkleRoot(transactions.map((t) => t.txid)),
      difficulty: expectedDifficulty(this.chain, index),
      miner: minerAddress,
    };
    const block = await mineBlock(template, shouldStop);
    if (!block) return null;
    return this.addBlock(block).ok ? block : null;
  }

  // ---- 上链 / 共识 ----
  /** 追加一个区块（必须是当前链顶的下一块，且整体合法） */
  addBlock(block: Block): { ok: boolean; error?: string } {
    if (block.index !== this.height + 1) return { ok: false, error: '区块高度不连续' };
    if (block.prevHash !== this.latest.hash) return { ok: false, error: 'prevHash 不匹配' };
    const v = Blockchain.validateChain([...this.chain, block]);
    if (!v.ok) return { ok: false, error: v.error };
    this.chain.push(block);
    this.dropMined(block);
    return { ok: true };
  }

  /** 最长链规则：收到更长的合法链则替换，并重新校验 mempool。 */
  replaceChain(incoming: Block[]): { ok: boolean; replaced: boolean; error?: string } {
    if (incoming.length <= this.chain.length) return { ok: true, replaced: false };
    const v = Blockchain.validateChain(incoming);
    if (!v.ok) return { ok: false, replaced: false, error: v.error };
    this.chain = incoming;
    this.revalidateMempool();
    return { ok: true, replaced: true };
  }

  private dropMined(block: Block): void {
    const mined = new Set(block.transactions.map((t) => t.txid));
    this.mempool = this.mempool.filter((t) => !mined.has(t.txid));
  }

  private revalidateMempool(): void {
    const old = this.mempool;
    this.mempool = [];
    for (const tx of old) this.addTransaction(tx); // 失效的会被自动丢弃
  }

  // ---- 整链校验（共识的唯一权威）----
  static validateChain(chain: Block[]): { ok: boolean; error?: string } {
    if (chain.length === 0) return { ok: false, error: '空链' };
    // 创世块必须与本地规范创世一致：既比对 .hash 字段（chain[1].prevHash 据此链接），
    // 又用内容重算 hash（绝不信任 wire 上的 .hash）。配合下方“每笔交易 txid===内容哈希”
    // 与 merkleRoot 校验，创世内容被完全锁定 —— 攻击者既改不了预挖归属，也无法凭空增发。
    const g = genesisBlock();
    if (chain[0].hash !== g.hash || calcBlockHash(chain[0]) !== g.hash) {
      return { ok: false, error: '创世块不一致' };
    }

    const balances = new Map<string, number>();
    const nonces = new Map<string, number>();
    const credit = (a: string, amt: number) => balances.set(a, (balances.get(a) ?? 0) + amt);

    for (let i = 0; i < chain.length; i++) {
      const b = chain[i];
      const isGenesis = i === 0;

      if (!isGenesis) {
        const prev = chain[i - 1];
        if (b.index !== prev.index + 1) return { ok: false, error: `#${i} 高度不连续` };
        if (b.prevHash !== prev.hash) return { ok: false, error: `#${i} prevHash 不匹配` };
        if (b.timestamp < prev.timestamp) return { ok: false, error: `#${i} 时间戳倒退` };
        // merkleRoot 必须等于交易集重算结果（区块头据此承诺整组交易）
        if (b.merkleRoot !== merkleRoot(b.transactions.map((t) => t.txid))) {
          return { ok: false, error: `#${i} merkleRoot 不匹配` };
        }
        // 难度必须等于由历史确定性算出的期望值（杜绝矿工私自降难度）
        if (b.difficulty !== expectedDifficulty(chain, i)) {
          return { ok: false, error: `#${i} 难度不符（期望 ${expectedDifficulty(chain, i)}）` };
        }
        if (calcBlockHash(b) !== b.hash) return { ok: false, error: `#${i} 区块 hash 被篡改` };
        if (!meetsDifficulty(b.hash, b.difficulty)) return { ok: false, error: `#${i} 未满足 PoW 难度` };

        const cb = b.transactions[0];
        if (!cb || !isCoinbase(cb)) return { ok: false, error: `#${i} 缺少 coinbase` };
        if (cb.to !== b.miner) return { ok: false, error: `#${i} coinbase 收款与矿工不符` };
        if (cb.amount !== BLOCK_REWARD) return { ok: false, error: `#${i} 区块奖励金额错误` };
        if (b.transactions.slice(1).some(isCoinbase)) return { ok: false, error: `#${i} 多个 coinbase` };
      }

      for (let j = 0; j < b.transactions.length; j++) {
        const tx = b.transactions[j];
        if (isCoinbase(tx)) {
          if (!isGenesis && j !== 0) return { ok: false, error: `#${i} coinbase 不在首位` };
          // coinbase/创世也必须校验 txid===内容哈希，把金额/收款方绑定到 txid，
          // 从而经由 merkleRoot→区块 hash 被 PoW 真正锚定，杜绝凭空增发。
          if (!verifyTransaction(tx)) return { ok: false, error: `#${i} coinbase txid 与内容不符` };
          credit(tx.to, tx.amount);
          continue;
        }
        if (!verifyTransaction(tx)) return { ok: false, error: `#${i} 交易签名无效` };
        const expected = nonces.get(tx.from) ?? 0;
        if (tx.nonce !== expected) {
          return { ok: false, error: `#${i} nonce 错误（${tx.from.slice(0, 10)}… 期望 ${expected}）` };
        }
        const bal = balances.get(tx.from) ?? 0;
        if (tx.amount > bal) return { ok: false, error: `#${i} 余额不足（双花/超额）` };
        credit(tx.from, -tx.amount);
        credit(tx.to, tx.amount);
        nonces.set(tx.from, expected + 1);
      }
    }
    return { ok: true };
  }

  // ---- 序列化 ----
  toJSON(): ChainJSON {
    return { chain: this.chain, mempool: this.mempool };
  }

  static fromJSON(data: ChainJSON): Blockchain {
    const bc = new Blockchain();
    bc.chain = data.chain;
    bc.mempool = data.mempool ?? [];
    return bc;
  }
}
