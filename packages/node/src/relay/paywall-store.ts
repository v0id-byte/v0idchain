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

  constructor(dataDir: string, id: string) {
    this.file = join(dataDir, `paywall-${id}.json`);
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

  /** 待兑现（已收、尚未向铸币厂兑现）的券快照。运营者据此 REDEEM 得款（兑现 CLI 集成为后续）。 */
  get pending(): MintToken[] {
    return [...this.state.accepted];
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
