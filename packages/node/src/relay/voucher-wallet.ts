// 访客券钱包（Phase A.1 客户端）：持有一叠铸币厂记名券（MintToken[]），供 SOCKS 访问付费 .v0id 站点时**自动预付**。
// 券是无记名持有物 → 文件 0600、fail-closed（损坏拒用，绝不静默重置丢券或误判余额）。选券在内存串行化，避免并发连接互相踩文件。
//
// 关键不变量：**券只有在付款成功（PAYOK）后才移出钱包**。select() 只挑不删，返回一个 commit()；调用方（socks.handleHidden）
// 在 runPaywallClient 成功后才 await commit() 落盘删除。付款被拒 / 访客中途断开 → 不 commit → 券留在钱包可重试（服务方并未核销）。
//
// 找零：Phase A.1 的付费墙对递进来的券**全额核销、不找零**（见 paywall.ts accept）。故选券要尽量贴着 price，避免溢付：
//   ① 若有恰好等额的单张 → 直接用（零溢付）；② 否则小面额优先累加到覆盖。精确子集和的最优打包留待后续（A.1 建议按站价发等额券）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyToken, type MintToken } from '../mint/token.js';
import type { VoucherSelection, VoucherSource } from './socks.js';

export class VoucherWallet {
  private lock: Promise<void> = Promise.resolve(); // 串行化 select/commit：并发连接不会交错读写同一钱包文件

  /** @param file 券文件路径（JSON 数组 MintToken[]，即 `v0id mint issue --out` 的产物）。@param mintAddress 铸币厂地址，用于只挑本厂签的有效券。 */
  constructor(
    private readonly file: string,
    private readonly mintAddress: string,
  ) {}

  /** 读券文件（fail-closed：损坏/非数组 → 抛错，绝不静默当空钱包，以免把「文件坏了」误判成「余额不足」而放弃可用券）。 */
  private read(): MintToken[] {
    if (!existsSync(this.file)) return [];
    const raw = readFileSync(this.file, 'utf8');
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      throw new Error(`券钱包文件损坏 ${this.file}：${e instanceof Error ? e.message : String(e)}（拒用以免误判余额/丢券，请核对后再访问付费站点）`);
    }
    if (!Array.isArray(arr)) throw new Error(`券钱包文件不是 JSON 数组：${this.file}`);
    return arr as MintToken[];
  }

  private write(tokens: MintToken[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* 尽力而为：券是无记名持有物，别留给同机他人可读 */
    }
  }

  /** 串行化闸门：把 fn 排到 lock 链尾执行，返回其结果（成败都放行下一个，避免一次失败卡死后续连接）。 */
  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * 选一叠面额合计 ≥ price 的有效券。**只挑不删**——返回的 commit() 在付款成功后由调用方落盘删除这批券。
   * 有效券不足 price → 抛错（调用方据此回 SOCKS 失败、不动券）。
   */
  select(price: number): Promise<VoucherSelection> {
    return this.serialize(() => {
      const valid = this.read().filter((t) => verifyToken(t, this.mintAddress)); // 只认本厂签的券（伪券/别厂券直接排除）
      const total = valid.reduce((s, t) => s + t.denom, 0);
      if (total < price) {
        throw new Error(`券余额不足：钱包有效券合计 ${total}，本站需 ${price}（先向运营者充值换券：\`v0id token buy\` → 运营者 \`mint issue\`）`);
      }
      const chosen = pickVouchers(valid, price);
      const chosenSerials = new Set(chosen.map((t) => t.serial));
      const commit = () =>
        this.serialize(() => {
          // 重读→删这批券→落盘（此刻付款已成）。重读而非用旧快照：期间可能有别的 commit 改过文件。
          this.write(this.read().filter((t) => !chosenSerials.has(t.serial)));
        });
      return { vouchers: chosen, commit };
    });
  }

  /** 作为 SOCKS 的 voucherSource 注入。忽略 addr（Phase A.1 单一铸币厂，券对所有付费站点通用），仅按 price 选券。 */
  source(): VoucherSource {
    return (_addr, price) => this.select(price);
  }
}

/**
 * 从有效券里挑一叠覆盖 price、尽量少溢付的券（Phase A.1 无找零）。
 * ① 恰好等额的单张 → 零溢付，直接用；② 否则小面额优先累加到覆盖（每张加入时都还不够 → 无单张冗余）。
 * 前置：valid 面额和 ≥ price（由 select 保证）。
 */
function pickVouchers(valid: MintToken[], price: number): MintToken[] {
  const exact = valid.find((t) => t.denom === price);
  if (exact) return [exact];
  const asc = [...valid].sort((a, b) => a.denom - b.denom);
  const chosen: MintToken[] = [];
  let sum = 0;
  for (const t of asc) {
    if (sum >= price) break;
    chosen.push(t);
    sum += t.denom;
  }
  return chosen;
}
