// 入口守卫（entry guards，Phase 2A-1）：把电路的“第一跳”钉死在一小撮持久守卫上，而不是每条电路随机挑守卫。
//
// 匿名理由（Tor entry-guard 思想的简化版）：
//   现状是每建一条电路都随机选第一跳。时间一长，一个运行着若干中继的攻击者迟早会成为你**某些**电路的入口；
//   入口位置一旦反复命中，再配合（端到端/时序）流量关联，就会逐步把你去匿名化——这是“多电路统计去匿名”。
//   修法：保留一小撮**持久**守卫（默认 3 个），让它们充当所有电路的入口并缓慢轮换。于是只有这固定的一小撮中继
//   有机会看到“你=入口”。攻击者要想拿到入口位置，必须恰好控制**这几个特定守卫之一**——把攻击面从“整个中继集”
//   收窄到“你钉住的这几个”，并随守卫寿命缓慢更替。
//
// 本类只管“选哪个守卫 + 持久化”，不碰任何握手/密码学；与 identity.ts/hsbridge.ts 的 0600 落盘同纪律。
// 刻意保持小而无外部依赖（仅 node:fs + RelayDescriptor 类型）：守卫策略越简单越好审计。
//
// 与 Tor 完整守卫规范的差距（诚实说明，见返回的设计笔记）：
//   - 不做带宽加权选择（uniformly-random）：低带宽/恶意中继被选中概率与高带宽相同。
//   - 不做 guard-confirmation / 入口节点可达性探测：守卫挑出来即记账，不验证它当下是否真的握手得通。
//   - 不分 primary/dystopic 列表、无 directory-guard 概念。
//   - 轮换是“到期即换”，非 Tor 的加权随机寿命分布。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { RelayDescriptor } from '@v0idchain/core';

interface GuardEntry {
  id: string; // 守卫中继的钱包地址（= 链上身份 / relayId）
  sampledAt: number; // 该守卫被采样（首次钉住）的时刻（ms）；寿命到期即剔除
}

interface GuardFile {
  guards: GuardEntry[];
}

export interface GuardManagerOptions {
  sampleSize?: number; // 持久守卫集大小（默认 3：1 主 + 2 备）
  lifetimeMs?: number; // 单个守卫寿命；到期剔除并重采样（默认 30 天）
  now?: () => number; // 时钟注入（测试用）
  selfId?: string; // 本节点地址：永不把自己选作守卫
}

const DEFAULT_SAMPLE_SIZE = 3;
const DEFAULT_LIFETIME_MS = 30 * 24 * 3600 * 1000; // 30 天

/**
 * 持久入口守卫管理器：维护一小撮钉住的守卫（落盘 <dataDir>/guards.json，0600），
 * 让所有电路复用同一守卫作第一跳，缓慢轮换。
 */
export class GuardManager {
  private readonly file: string;
  private readonly sampleSize: number;
  private readonly lifetimeMs: number;
  private readonly now: () => number;
  private readonly selfId?: string;

  constructor(private readonly dataDir: string, opts: GuardManagerOptions = {}) {
    this.file = join(dataDir, 'guards.json');
    this.sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    this.lifetimeMs = opts.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    this.now = opts.now ?? Date.now;
    this.selfId = opts.selfId;
  }

  /**
   * 返回当前应当用作第一跳的守卫地址（主守卫）：
   *   1. 读回持久集；剔除“已到寿（sampledAt+lifetimeMs<now）”或“已不在目录里（中继下线）”的守卫；有变动即落盘。
   *   2. 补足：当守卫数 < sampleSize 时，从目录里**均匀随机**挑一个“不是已有守卫、不在 exclude、不是 self”的中继钉住；落盘。
   *   3. 返回**第一个 id ∉ exclude** 的守卫（主守卫；其余为主守卫被排除/不可达时的备份）。全被排除/无可用 → undefined。
   * @param directory 当前链上中继目录快照（通常传 node.relays()）。
   * @param exclude   本次不能用作入口的中继（如该电路的出口 / 已知不可达的守卫）。
   */
  currentGuard(directory: RelayDescriptor[], exclude?: Set<string>): string | undefined {
    const dirIds = new Set(directory.map((d) => d.address));
    let guards = this.load();
    const before = guards.length;

    // 剔除到寿 / 已下线的守卫
    guards = guards.filter((g) => g.sampledAt + this.lifetimeMs >= this.now() && dirIds.has(g.id));

    // 补足到 sampleSize：候选 = 目录里不是已有守卫、不在 exclude、不是 self 的中继，均匀随机取。
    const have = new Set(guards.map((g) => g.id));
    while (guards.length < this.sampleSize) {
      const candidates = directory.filter(
        (d) => !have.has(d.address) && !(exclude?.has(d.address)) && d.address !== this.selfId,
      );
      if (candidates.length === 0) break; // 目录不够大：能钉几个钉几个（不报错，调用方自有“中继不足”兜底）
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      guards.push({ id: pick.address, sampledAt: this.now() });
      have.add(pick.address);
    }

    if (guards.length !== before || this.changed(guards)) this.persist(guards);

    // 主守卫 = 第一个不在 exclude 的守卫；其余为备份。
    for (const g of guards) {
      if (!exclude?.has(g.id)) return g.id;
    }
    return undefined;
  }

  /** 当前持久守卫的 id 列表（诊断/测试用；不触发剪枝/补足）。 */
  allGuards(): string[] {
    return this.load().map((g) => g.id);
  }

  // ---- 内部：持久化（mirror identity.ts/hsbridge.ts 的 0600 落盘纪律）----

  private cache: GuardEntry[] | null = null;

  private load(): GuardEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as GuardFile;
      const guards = Array.isArray(parsed.guards)
        ? parsed.guards.filter(
            (g): g is GuardEntry => typeof g?.id === 'string' && typeof g?.sampledAt === 'number',
          )
        : [];
      this.cache = guards.map((g) => ({ id: g.id, sampledAt: g.sampledAt }));
      return guards.map((g) => ({ id: g.id, sampledAt: g.sampledAt }));
    } catch {
      return []; // 文件损坏 → 当作空集重建（守卫会被重采样，宁可重置也不崩）
    }
  }

  // 与上次 persist/load 的内容是否不同（避免无谓写盘）。
  private changed(guards: GuardEntry[]): boolean {
    if (!this.cache || this.cache.length !== guards.length) return true;
    for (let i = 0; i < guards.length; i++) {
      if (this.cache[i].id !== guards[i].id || this.cache[i].sampledAt !== guards[i].sampledAt) return true;
    }
    return false;
  }

  private persist(guards: GuardEntry[]): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    const body = JSON.stringify({ guards } satisfies GuardFile);
    writeFileSync(tmp, body, { mode: 0o600 });
    chmodSync(tmp, 0o600); // 兜底：umask 影响时强制收紧
    // 原子替换：先写 .tmp 再 rename，避免半截文件（与 identity.ts 同纪律，额外加原子性）
    renameSync(tmp, this.file);
    this.cache = guards.map((g) => ({ id: g.id, sampledAt: g.sampledAt }));
  }
}
