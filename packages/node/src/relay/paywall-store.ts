// 付费墙服务方持久化（Phase A.1）：① 已花序列号——**跨重启防双花**（否则重启后同一张券可再次访问）；
// ② 已受理券——留存供**日后向铸币厂兑现**（服务方攒券后 REDEEM 得款）。0600 落盘、fail-closed（损坏拒启，同 mintd 纪律）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { MintToken } from '../mint/token.js';

interface PaywallState {
  spentSerials: string[]; // 已受理（已花）券的序列号（防双花）
  accepted: MintToken[]; // 已受理、待向铸币厂兑现的整券（denom+serial+sig）
}

export class PaywallStore {
  private readonly file: string;
  private state: PaywallState;
  readonly spent: Set<string>; // spentSerials 的内存索引（传给 VoucherAcceptor 作其已花集）

  /**
   * @param dirOrFile 数据目录（配合 id → `<dir>/paywall-<id>.json`）或直接给完整券库文件路径（id 省略）。
   *        后者供 `mint redeem --paywall <path>` 按完整路径打开运营者的券库兑现。
   * @param id 省略 = dirOrFile 即完整文件路径。
   */
  constructor(dirOrFile: string, id?: string) {
    this.file = id !== undefined ? join(dirOrFile, `paywall-${id}.json`) : dirOrFile;
    this.state = this.load();
    this.spent = new Set(this.state.spentSerials);
  }

  private load(): PaywallState {
    if (existsSync(this.file)) {
      // 金融账本：文件存在但损坏 → **fail closed 抛错**，绝不静默重置（否则丢已花集 → 重启后旧券可重用访问）。
      const raw = readFileSync(this.file, 'utf8');
      let d: PaywallState;
      try {
        d = JSON.parse(raw) as PaywallState;
      } catch (e) {
        throw new Error(`付费墙状态文件损坏 ${this.file}：${e instanceof Error ? e.message : String(e)}。请从备份恢复或人工核对后再启动。`);
      }
      return {
        spentSerials: Array.isArray(d.spentSerials) ? d.spentSerials : [],
        accepted: Array.isArray(d.accepted) ? d.accepted : [],
      };
    }
    return { spentSerials: [], accepted: [] };
  }

  /** 记一批已受理券：并入已花集 + 追加待兑现，落盘。由 VoucherAcceptor 的 onAccept 回调驱动。 */
  record(vouchers: MintToken[], serials: string[]): void {
    for (const s of serials) this.spent.add(s);
    for (const v of vouchers) this.state.accepted.push(v);
    this.persist();
  }

  /** 待兑现（已收、尚未向铸币厂兑现）的券快照。运营者据此 REDEEM 得款（见 `mint redeem --paywall`）。 */
  get pending(): MintToken[] {
    return [...this.state.accepted];
  }

  /**
   * 标记一批券已向铸币厂兑现：按序列号从 accepted 移除（不再重复兑现）。**保留 spentSerials 不动**——
   * 防访问双花的已花集在兑现后必须依旧生效，否则同一张券又能再次访问付费站点。
   * 落盘前**重读最新文件**再改：缩小与「在跑节点并发追加新 accepted」的相互覆盖窗口（A.1 仍建议节点空闲时兑现）。
   */
  markRedeemed(serials: string[]): void {
    const gone = new Set(serials);
    const fresh = this.load(); // 重读：可能有节点在兑现期间新收的券 / 新的已花序列号
    fresh.accepted = fresh.accepted.filter((t) => !gone.has(t.serial));
    for (const s of fresh.spentSerials) this.spent.add(s); // 并入最新已花集（persist 会以 this.spent 落盘）
    this.state = fresh;
    this.persist();
  }

  private persist(): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    this.state.spentSerials = [...this.spent];
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* 尽力而为 */
    }
  }
}
