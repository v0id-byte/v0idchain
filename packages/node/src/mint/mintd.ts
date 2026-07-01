// 铸币厂守护进程（Phase A：透明可信清算所）。链下逻辑，不进共识：
//   · 监听链上充值 `MINT|DEPOSIT` → 给充值人记「可发券额度」（allowance）。
//   · 发券 issue：额度足则签发记名券、额度扣减。**核心不变量：Σ已发 ≤ Σ充值（额度不为负）= 绝不超发**
//     ——它镜像链上「兑现 ≤ 储备」，共同保证每张券都兑得出（偿付能力）。
//   · 兑现 redeem：验券（签名 + 未花过 + 批内不重复）→ 记 serial 已花 → 成形一笔 REDEEM 交易付给服务方。
// 授权纪律同 measurer：mintWallet 从 0600 钱包文件加载；只有 mintWallet.address === MINT_ADDRESS，链才接受其 REDEEM
//   （本地生成的钱包地址 ≠ 常量 → 链上兑现接受属部署期；但发券/验券/额度/防双花逻辑与 MINT_ADDRESS 常量无关，可完整自测）。
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTransaction,
  computeMintState,
  isMintDeposit,
  isValidAddress,
  REDEEM_PREFIX,
  MIN_FEE,
  MINT_ACTIVATION_HEIGHT,
  MINT_ESCROW_ADDRESS,
  SYSTEM_ADDRESSES,
  redeemSplit,
  type Block,
  type Transaction,
  type Wallet,
} from '@v0idchain/core';
import { issueToken, verifyToken, type MintToken } from './token.js';

/**
 * 充值确认深度（默认）：只给「已被确认 ≥N 块」的充值记额度。缓解浅 reorg——若刚上链的充值块被孤立，
 * 它还在未确认窗口内、尚未记额度，不会留下无对应储备的额度。**深 reorg（> N 块）仍是残余风险**：
 * 已记额度的充值被孤块化时游标不会回退，需运营者人工对账（Phase A 托管信任范畴，Phase C 联邦/储备证明再收敛）。
 */
const DEFAULT_DEPOSIT_CONFIRMATIONS = 6;

/** 守护进程持久化状态（落 0600 JSON）。allowances/issued/spentSerials 是链下账本，丢了可从链重扫充值恢复 allowance（已花券除外）。 */
export interface MintDaemonState {
  mintAddress: string; // 加载到的钱包地址（应 === MINT_ADDRESS，否则链不接受其 REDEEM）
  allowances: Record<string, number>; // 用户地址 → 可发券额度（= 该用户累计充值 − 累计已发）
  issued: number; // 累计已发券面额（全网）
  spentSerials: string[]; // 已兑现的券序列号（防双花）
  scannedHeight: number; // 已扫描到的链高（增量同步充值，避免重复计充值）
}

export interface MintDaemonOpts {
  dataDir: string; // 状态目录（mint-state.json 落这里，0600）
  mintWallet: Wallet; // 铸币厂签名钱包（签券 + 签 REDEEM）；.address 应 === MINT_ADDRESS
  depositConfirmations?: number; // 充值确认深度（默认 DEFAULT_DEPOSIT_CONFIRMATIONS=6；测试可设 0）
}

/** 一次兑现的结果：待广播的 REDEEM 交易 + 拆分明细。 */
export interface RedeemResult {
  tx: Transaction; // 待广播的 REDEEM 交易（from=铸币厂, to=服务方, amount=0, memo=REDEEM|<gross>）
  gross: number; // 兑现面额总额（= 批内券面额之和）
  net: number; // 服务方实得（gross − 抽成）
  fee: number; // 回流国库的抽成
}

export class MintDaemon {
  private readonly stateFile: string;
  private readonly wallet: Wallet;
  private readonly confirmations: number;
  private state: MintDaemonState;
  private spent: Set<string>; // spentSerials 的内存索引（O(1) 查双花）

  constructor(opts: MintDaemonOpts) {
    this.stateFile = join(opts.dataDir, 'mint-state.json');
    this.wallet = opts.mintWallet;
    this.confirmations = Math.max(0, opts.depositConfirmations ?? DEFAULT_DEPOSIT_CONFIRMATIONS);
    this.state = this.load(opts);
    this.spent = new Set(this.state.spentSerials);
  }

  /** 只读状态视图。 */
  get current(): MintDaemonState {
    return this.state;
  }

  /** 某用户当前可发券额度。用 typeof 守卫：防原型链上的 constructor/toString 等键把继承函数当成额度。 */
  allowanceOf(address: string): number {
    const v = this.state.allowances[address];
    return typeof v === 'number' ? v : 0;
  }

  private load(opts: MintDaemonOpts): MintDaemonState {
    if (existsSync(this.stateFile)) {
      // 金融账本：状态文件存在但损坏 → **fail closed 抛错**，绝不静默回退空状态（否则会把老充值重扫成新额度、
      // 丢失已发/已花 serial → 重复发券/重复兑现）。运营者须显式恢复备份或人工重建后再启动。
      const raw = readFileSync(this.stateFile, 'utf8');
      let d: MintDaemonState;
      try {
        d = JSON.parse(raw) as MintDaemonState;
      } catch (e) {
        throw new Error(`铸币状态文件损坏 ${this.stateFile}：${e instanceof Error ? e.message : String(e)}。请从备份恢复或人工核对后再启动（拒绝自动重置账本）。`);
      }
      return {
        mintAddress: d.mintAddress ?? opts.mintWallet.address,
        allowances: d.allowances ?? {},
        issued: d.issued ?? 0,
        spentSerials: Array.isArray(d.spentSerials) ? d.spentSerials : [],
        scannedHeight: d.scannedHeight ?? MINT_ACTIVATION_HEIGHT - 1,
      };
    }
    // 文件不存在 = 首次启动 → 干净空状态（无账本可丢）。
    return {
      mintAddress: opts.mintWallet.address,
      allowances: {},
      issued: 0,
      spentSerials: [],
      scannedHeight: MINT_ACTIVATION_HEIGHT - 1,
    };
  }

  /** 0600 落盘。 */
  private persist(): void {
    mkdirSync(join(this.stateFile, '..'), { recursive: true });
    this.state.spentSerials = [...this.spent];
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.stateFile, 0o600);
    } catch {
      /* 尽力而为 */
    }
  }

  /**
   * 增量扫链同步充值：只给「已确认 ≥ confirmations 块」的 `MINT|DEPOSIT`（且 ≥ 激活高度）记额度。
   * 游标只推进到 safeTip = tip − confirmations，未确认窗口内的充值下次再记 → 缓解浅 reorg 记入孤块充值。
   * 幂等靠 scannedHeight 游标（只处理新确认块）。深 reorg 残余风险见 DEFAULT_DEPOSIT_CONFIRMATIONS 注释。
   */
  syncDeposits(chain: Block[]): void {
    if (chain.length === 0) return;
    const tip = chain[chain.length - 1].index; // 用末块真实 index 作游标（不假设 数组下标===区块高度）
    const safeTip = tip - this.confirmations; // 只信已确认深度内的充值
    if (safeTip <= this.state.scannedHeight) return; // 无新确认块，什么都不做（含首启动 scannedHeight=激活-1）
    for (const b of chain) {
      if (b.index <= this.state.scannedHeight || b.index > safeTip || b.index < MINT_ACTIVATION_HEIGHT) continue;
      for (const tx of b.transactions) {
        if (tx.to === MINT_ESCROW_ADDRESS && isMintDeposit(tx.memo) && tx.amount > 0) {
          this.state.allowances[tx.from] = (this.allowanceOf(tx.from)) + tx.amount;
        }
      }
    }
    this.state.scannedHeight = safeTip;
    this.persist();
  }

  /**
   * 给用户发一张面额 denom 的券：额度足则扣额度、签发、落盘。额度不足抛错。
   * **不变量**：额度扣减保证 Σ已发 ≤ Σ充值 → 绝不超发 → 每张券都兑得出。
   */
  issue(userAddress: string, denom: number): MintToken {
    if (!isValidAddress(userAddress)) throw new Error('用户地址格式无效'); // 拒非法/原型链键（constructor/toString…），否则可能无额度也发出券
    if (!Number.isSafeInteger(denom) || denom < 1) throw new Error('券面额须为正整数');
    const bal = this.allowanceOf(userAddress);
    if (bal < denom) throw new Error(`额度不足：可发 ${bal}，请求 ${denom}（先充值）`);
    this.state.allowances[userAddress] = bal - denom;
    this.state.issued += denom;
    const tok = issueToken(denom, this.wallet.privateKey);
    this.persist();
    return tok;
  }

  /** 验一批券（验签 + 防双花：已花/批内重复 + 收款校验）→ 返回面额合计与去重 serial。不改状态（预览与正式兑现共用）。 */
  private verifyBatch(tokens: MintToken[], providerAddress: string): { gross: number; serials: string[] } {
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error('无券可兑现');
    // 先校验收款地址：非法地址会让 addTransaction 拒掉 REDEEM，但那时 serial 已标记已花 → 券白白报废。故这里就拦。
    if (!isValidAddress(providerAddress)) throw new Error('兑现收款地址格式无效');
    if (SYSTEM_ADDRESSES.has(providerAddress)) throw new Error('兑现收款不能是系统/托管地址');
    const seen = new Set<string>();
    let gross = 0;
    for (const t of tokens) {
      if (!verifyToken(t, this.wallet.address)) throw new Error(`券验签失败（serial=${t?.serial ?? '?'}）`);
      if (this.spent.has(t.serial)) throw new Error(`券已兑现过（双花：serial=${t.serial}）`);
      if (seen.has(t.serial)) throw new Error(`批内重复券（serial=${t.serial}）`);
      seen.add(t.serial);
      gross += t.denom;
    }
    return { gross, serials: [...seen] };
  }

  /** 只验券 + 算拆分，**不**标记已花、**不**成形交易（供 CLI 预览，不消耗券）。 */
  dryRedeem(tokens: MintToken[], providerAddress: string): { gross: number; net: number; fee: number } {
    const { gross } = this.verifyBatch(tokens, providerAddress);
    return { gross, ...redeemSplit(gross) };
  }

  /**
   * 服务方兑现一批券：验签 + 防双花 → 记 serial 已花 → 成形一笔 REDEEM 交易付给服务方（面额−抽成）。
   * @param mintNonce 铸币厂钱包当前链上 nonce（调用方从链获取）
   * @returns 待广播的 REDEEM 交易 + 拆分明细（广播成功且被种子接受后，链上储备减少、抽成落国库）
   */
  redeem(tokens: MintToken[], providerAddress: string, mintNonce: number): RedeemResult {
    const { gross, serials } = this.verifyBatch(tokens, providerAddress);
    // 先扣双花再成形交易：链不追踪 serial，若不先标记可能对同一券成形两笔 REDEEM 造成超兑（超付储备）；
    // 故宁可「广播失败也已标记」（重发用相同 serial 会被再拦），不冒超兑风险。
    for (const s of serials) this.spent.add(s);
    const { net, fee } = redeemSplit(gross);
    const tx = createTransaction(this.wallet, providerAddress, 0, mintNonce, `${REDEEM_PREFIX}${gross}`, MIN_FEE);
    this.persist();
    return { tx, gross, net, fee };
  }

  /** 储备/发行/偿付总览（链上储备 + 链下发行账本）。 */
  reserve(chain: Block[]): { onchain: ReturnType<typeof computeMintState>; issued: number; outstanding: number } {
    const onchain = computeMintState(chain);
    return { onchain, issued: this.state.issued, outstanding: this.state.issued - onchain.redeemed };
  }
}
