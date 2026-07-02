// 访客券钱包（Phase A.1 客户端）：持有一叠铸币厂记名券（MintToken[]），供 SOCKS 访问付费 .v0id 站点时**自动预付**。
// 券是无记名持有物 → 文件 0600、fail-closed（损坏 / 非数组 / 任一条目结构非法都拒用，绝不静默重置丢券或误判余额）。
//
// 关键不变量：**券只有付款成功（PAYOK）后才移出钱包**。select() 只在**内存里预留（reserved）**、不改文件；付款成功后 commit()
// 才落盘删除，付款失败/中断则 rollback() 仅释放预留（文件未改 → 券留钱包可重试）。并发连接经 reserved 集互斥 → 绝不重复选同一张
// 券（否则一张券被两条在途连接各递一次：对同一服务被判重复、对不同服务方则同券被受理两次 = 双花）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifyToken, type MintToken } from '../mint/token.js';
import type { VoucherSelection, VoucherSource } from './socks.js';

export class VoucherWallet {
  private lock: Promise<void> = Promise.resolve(); // 串行化 select/commit/rollback：并发连接不交错读写同一钱包文件
  private readonly reserved = new Set<string>(); // 已选未 commit 的 serial：并发连接跳过 → 防重复选同一张券

  /** @param file 券文件路径（JSON 数组 MintToken[]，即 `v0id mint issue --out` 的产物）。@param mintAddress 铸币厂地址，用于只挑本厂签的有效券。 */
  constructor(
    private readonly file: string,
    private readonly mintAddress: string,
  ) {}

  /**
   * 读券文件（fail-closed）。文件不存在 → 空钱包；否则先收紧到 0600（券是无记名持有物，别留给同机他人可读），再解析。
   * **损坏 / 非数组 / 任一条目结构非法都抛错**——绝不静默当空钱包或跳过坏条目：否则可能把「文件坏了」误判成「余额不足」，
   * 或让坏条目在**付款成功后**的 commit 落盘时才触发崩溃 → 留下已被服务方核销、却仍留在钱包的死券。
   */
  private read(): MintToken[] {
    if (!existsSync(this.file)) return [];
    try {
      chmodSync(this.file, 0o600); // 收紧既有文件权限（如用户从别处 cp 进来的 0644 券文件）——bearer 密钥不容他人可读
    } catch {
      /* 尽力而为 */
    }
    const raw = readFileSync(this.file, 'utf8');
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      throw new Error(`券钱包文件损坏 ${this.file}：${e instanceof Error ? e.message : String(e)}（拒用以免误判余额/丢券，请核对后再访问付费站点）`);
    }
    if (!Array.isArray(arr)) throw new Error(`券钱包文件不是 JSON 数组：${this.file}`);
    for (const t of arr) {
      if (!isStructuralToken(t)) throw new Error(`券钱包含结构非法的条目：${this.file}（fail-closed：核对后再用，避免付款后触坏条目丢券）`);
    }
    return arr as MintToken[];
  }

  private write(tokens: MintToken[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* 尽力而为 */
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
   * 选一叠面额合计 ≥ price 的有效券并**内存预留**（不改文件）。返回 commit（付款成功后落盘移出）+ rollback（失败/中断释放预留）。
   * 只算**未被其它在途连接预留**的可用券——并发连接因此不会挑到同一张（防跨连接双递）。可用有效券不足 price → 抛错（未预留）。
   */
  select(price: number): Promise<VoucherSelection> {
    return this.serialize(() => {
      const available = this.read().filter((t) => verifyToken(t, this.mintAddress) && !this.reserved.has(t.serial));
      const total = available.reduce((s, t) => s + t.denom, 0);
      if (total < price) {
        throw new Error(`券余额不足：钱包可用有效券合计 ${total}，本站需 ${price}（先向运营者充值换券：\`v0id token buy\` → 运营者 \`mint issue\`）`);
      }
      const chosen = pickVouchers(available, price);
      const serials = new Set(chosen.map((t) => t.serial));
      for (const s of serials) this.reserved.add(s); // 预留：文件此刻不动，付款成功才 commit 落盘删除
      let done = false; // 防 commit/rollback 被调两次
      const commit = () =>
        this.serialize(() => {
          if (done) return;
          done = true;
          this.write(this.read().filter((t) => !serials.has(t.serial))); // 付款已成 → 落盘移出钱包（重读，避免踩别的 commit 的改动）
          for (const s of serials) this.reserved.delete(s);
        });
      const rollback = () =>
        this.serialize(() => {
          if (done) return;
          done = true;
          for (const s of serials) this.reserved.delete(s); // 付款失败/中断 → 仅释放预留，文件未改 → 券留钱包可重试
        });
      return { vouchers: chosen, commit, rollback };
    });
  }

  /** 作为 SOCKS 的 voucherSource 注入。忽略 addr（Phase A.1 单一铸币厂，券对所有付费站点通用），仅按 price 选券。 */
  source(): VoucherSource {
    return (_addr, price) => this.select(price);
  }
}

/** 结构校验（非签名）：MintToken 须是带 number denom / string serial / string sig 的对象。null / 缺字段 / 错类型 → false。 */
function isStructuralToken(t: unknown): t is MintToken {
  if (!t || typeof t !== 'object') return false;
  const v = t as Record<string, unknown>;
  return typeof v.denom === 'number' && typeof v.serial === 'string' && typeof v.sig === 'string';
}

/**
 * 从可用券里挑覆盖 price、尽量少溢付的券（Phase A.1 付费墙全额核销、**无找零**）。
 * ① 恰好等额单张 → 零溢付；② 否则在「能单张覆盖 price 的最小单券」与「小面额升序累加」两个候选里取**总额更小**者（并列取张数更少）。
 * 例：price=6、钱包 [5,10] → 候选 a=[10](溢 4) 胜过 b=[5,10](溢 9) → 选 [10]。前置：available 面额和 ≥ price（由 select 保证）。
 * （启发式，非最优子集和：小额付费墙够用；建议运营者按站价发等额券以零溢付。）
 */
function pickVouchers(available: MintToken[], price: number): MintToken[] {
  const exact = available.find((t) => t.denom === price);
  if (exact) return [exact];
  const sum = (ts: MintToken[]) => ts.reduce((s, t) => s + t.denom, 0);
  const candidates: MintToken[][] = [];
  // 候选 a：能单张覆盖 price 的最小单券（避免用一堆小券凑出远超 price 的总额）
  const singles = available.filter((t) => t.denom >= price).sort((x, y) => x.denom - y.denom);
  if (singles.length) candidates.push([singles[0]]);
  // 候选 b：小面额升序累加到刚覆盖
  const accum: MintToken[] = [];
  let s = 0;
  for (const t of [...available].sort((x, y) => x.denom - y.denom)) {
    if (s >= price) break;
    accum.push(t);
    s += t.denom;
  }
  candidates.push(accum); // available 和 ≥ price → accum 必覆盖
  return candidates.sort((p, q) => sum(p) - sum(q) || p.length - q.length)[0]; // 总额更小者（并列张数更少）
}
