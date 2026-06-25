// 角色管理器（Phase 2F-1）：把 CLI `start` 里散落的「中继 / 隐藏服务 / 挖矿」启停逻辑收成一个对象，
// 让 GUI（或 HTTP API）能在**运行时**把这些角色 ON/OFF，而不必重启守护进程。CLI 旗标在启动时仍是
// 「调用对应 roleManager.startX(...)」——行为与历史完全一致，只是经过本类这层间接。
//
// 设计取舍（与 CLAUDE.md 的「简单优先 / 外科手术式改动」一致）：
//   - 本类只**搬运**既有接线，不发明新协议/密码学。GuardManager / makeHsDeps / pickHops / 自动发布循环
//     都是从 cli/src/index.ts 原样抬过来的（含其注释意图）。
//   - 所有启停**幂等**：启一个已在跑的角色 = no-op 返回当前 status；停一个已停的角色 = no-op。
//   - SOCKS 维持「启用即常开」的现状（轻量基座）：本类只持有其引用供 status 展示，**不**做运行时启停
//     （GUI 不要求切 SOCKS；切它意味着 .v0id 出站/隐藏服务客户端能力一起没，留作后续）。
//   - `<3 中继`前置：socks（pickHops）与 hs（serveHiddenService）需要链上目录已有 ≥3 中继才能建路。
//     这里把它做成**明确报错/通知**（startHs 抛干净 Error / startRelay 的发布循环静默等待），绝不崩进程。
import {
  bytesToHex,
  hexToBytes,
  type OnionKeypair,
} from '@v0idchain/core';
import type { V0idNode } from '../node.js';
import { RelayNode, type RelayResolver } from './relaynode.js';
import { SocksProxy, type HopPicker } from './socks.js';
import { GuardManager } from './guards.js';
import { makeHsDeps, serveHiddenService, type HsDeps } from './hsbridge.js';
import type { HopSpec } from './client.js';
import type { MixnetOpts } from './relaynode.js';

/** 建路所需的链上中继下限（与 CLI pickHops / makeHsDeps「不足 3 个」同语义）。 */
const MIN_RELAYS = 3;
/** 自动发布描述符的重试周期（ms）——与 CLI 原值一致：余额够且尚未发布时定期重试一次。 */
const PUBLISH_RETRY_MS = 5000;

export interface RoleManagerOptions {
  node: V0idNode;
  dataDir: string;
  /** onion 静态密钥（中继描述符的 okey；由调用方 loadOrCreateOnionKey 提供，保证与磁盘一致）。 */
  onion: OnionKeypair;
  /** 中继 cell 入口端口（独立于 p2p / api 端口）。 */
  relayPort: number;
  /** 中继对外广播 host（公网/局域网才需要；默认 127.0.0.1）。发布描述符与本地绑定都用它。 */
  relayAdvertiseHost?: string;
  /** 中继 cell 监听绑定地址（默认 0.0.0.0，与 CLI 一致：对外可达）。 */
  relayBindHost?: string;
  /** 出口策略：允许作出口连到的 host:port 集合（来自 --exit-allow；空 = deny-all 纯中继）。 */
  exitAllow?: string[];
  /** Mixnet 模式（--mixnet）：传入则中继逐跳混入随机延迟（默认 undefined = 关 = 同步转发）。 */
  mixnet?: MixnetOpts;
  /** SOCKS 监听端口（仅用于 status 展示；SOCKS 由调用方在启动时一次性拉起）。 */
  socksPort?: number;
}

/** GET /roles 返回的形状（GUI 读它渲染开关状态）。字段填已知项，未启用角色给 off + 占位。 */
export interface RoleStatus {
  socks: { on: boolean; port: number | null };
  relay: { on: boolean; port: number | null; address: string | null; circuits: number; published: boolean };
  hs: { on: boolean; address: string | null; target: { host: string; port: number } | null };
  mine: { on: boolean; intervalMs: number | null };
}

/**
 * 角色管理器：拥有运行时可切换的中继 / 隐藏服务 / 挖矿三角色，并持有 SOCKS 引用供 status 展示。
 * 内部唯一持有：一个共享 GuardManager（socks + hs 共用，攻击面统一）、由它派生的 hsDeps、pickHops，
 * 以及活动句柄（relay / hs / 挖矿态）。
 */
export class RoleManager {
  private readonly node: V0idNode;
  private readonly dataDir: string;
  private readonly onion: OnionKeypair;
  private readonly relayPort: number;
  private readonly relayAdvertiseHost: string;
  private readonly relayBindHost: string;
  private readonly exitAllow: string[];
  private readonly mixnet?: MixnetOpts;

  /** 共享入口守卫管理器：socks 与 hs（makeHsDeps）共用同一个 → 两边电路用同一守卫，攻击面统一收窄。 */
  private readonly guard: GuardManager;
  /** 隐藏服务接线依赖（选路器 + 名录）：每次都从链上重新快照（`() => node.relays()`），自然跟随链增长。 */
  private readonly hsDeps: HsDeps;
  /** 从链上目录解析中继地址 → cell 入口（EXTEND 拨号 & SOCKS 选路用）。 */
  private readonly resolver: RelayResolver;

  // ---- 活动句柄 ----
  private relay?: RelayNode;
  private relayPublished = false; // 中继描述符是否已上链（自动发布循环置位）
  private publishTimer?: ReturnType<typeof setInterval>;
  private hs?: { address: string; stop: () => void };
  private hsTarget?: { host: string; port: number };
  private socks?: SocksProxy;
  private socksPort: number | null = null;
  // 挖矿态：node 内部自己也有 mining 标志，但本类需对外报 on/intervalMs，故在此镜像一份。
  private mineOn = false;
  private mineIntervalMs: number | null = null;

  constructor(opts: RoleManagerOptions) {
    this.node = opts.node;
    this.dataDir = opts.dataDir;
    this.onion = opts.onion;
    this.relayPort = opts.relayPort;
    this.relayAdvertiseHost = opts.relayAdvertiseHost ?? '127.0.0.1';
    this.relayBindHost = opts.relayBindHost ?? '0.0.0.0';
    this.exitAllow = opts.exitAllow ?? [];
    this.mixnet = opts.mixnet;
    this.socksPort = opts.socksPort ?? null;

    this.guard = new GuardManager(this.dataDir, { selfId: this.node.wallet.address });
    this.hsDeps = makeHsDeps(() => this.node.relays(), this.guard);
    this.resolver = (id: string) => {
      const d = this.node.relays().find((r) => r.address === id);
      return d ? { host: d.host, port: d.port } : undefined;
    };
  }

  /**
   * SOCKS 选路（从 CLI 原样抬过来）：hop0 = 持久守卫（与 HS 共用同一 GuardManager）；守卫不可用则失败/等待
   * 冷却恢复，绝不回退随机入口。链上中继 < 3 → 抛「中继不足」。middle ≠ guard、exit ≠ guard ∧ ≠ middle。
   */
  private pickHops: HopPicker = (): HopSpec[] => {
    const all = this.node.relays();
    if (all.length < MIN_RELAYS) throw new Error('链上中继不足 3 个，暂无法建路');
    const hop = (d: (typeof all)[number]): HopSpec => ({ id: d.address, onionPub: hexToBytes(d.onionPubHex), host: d.host, port: d.port });
    const gid = this.guard.currentGuard(all);
    const guard = gid ? all.find((d) => d.address === gid) : undefined;
    if (!guard) throw new Error('钉住守卫均不可用，暂无法建路');
    const afterGuard = all.filter((d) => d.address !== guard.address);
    const middle = afterGuard[Math.floor(Math.random() * afterGuard.length)];
    const exitPool = afterGuard.filter((d) => d.address !== middle.address);
    const exit = exitPool[Math.floor(Math.random() * exitPool.length)];
    return [hop(guard), hop(middle), hop(exit)];
  };

  // ---- 中继 ----

  /**
   * 启动 .v0id 洋葱中继：在 cell 端口起 RelayNode（含出口策略），并起 5s 自动发布循环（余额够且尚未发布时
   * 把 RELAY| 描述符上链，挖矿/收款后自动生效）。已在跑 → no-op。中继本身不需链上 ≥3（发布自己的描述符即可）。
   */
  async startRelay(): Promise<RoleStatus> {
    if (this.relay) return this.status(); // 幂等
    const relay = new RelayNode(
      this.node.wallet.address,
      this.onion,
      this.resolver,
      this.relayPort,
      this.relayBindHost,
      undefined,
      {},
      this.mixnet,
    );
    if (this.exitAllow.length) {
      const set = new Set(this.exitAllow);
      relay.setExitPolicy((host, port) => set.has(`${host}:${port}`));
    }
    this.relay = relay;
    this.relayPublished = false;
    // 自动发布描述符（从 CLI tryPublish 抬过来）：余额够且尚未发布时发一次。
    const onionPubHex = bytesToHex(this.onion.pub);
    const tryPublish = () => {
      if (this.relayPublished) return;
      const existing = this.node.relays().find((r) => r.address === this.node.wallet.address);
      if (existing && existing.onionPubHex === onionPubHex && existing.host === this.relayAdvertiseHost && existing.port === this.relayPort) {
        this.relayPublished = true;
        return;
      }
      if (this.node.bc.balanceOf(this.node.wallet.address) < 2) return; // 余额不够发布手续费 → 等
      const pub = this.node.publishRelay(onionPubHex, this.relayAdvertiseHost, this.relayPort);
      if (pub.ok) this.relayPublished = true;
    };
    tryPublish();
    this.publishTimer = setInterval(tryPublish, PUBLISH_RETRY_MS);
    this.publishTimer.unref?.();
    return this.status();
  }

  /** 停止中继：关 cell 端口（await close 拆掉所有电路）+ 清掉自动发布定时器。已停 → no-op。 */
  async stopRelay(): Promise<RoleStatus> {
    if (this.publishTimer) {
      clearInterval(this.publishTimer);
      this.publishTimer = undefined;
    }
    if (this.relay) {
      await this.relay.close();
      this.relay = undefined;
    }
    this.relayPublished = false;
    return this.status();
  }

  // ---- 隐藏服务 ----

  /**
   * 托管一个 .v0id 隐藏服务，把进来的会合连接转发到本机 target host:port。需链上 ≥3 中继（建引入/会合电路）。
   * 已在跑 → no-op 返回当前 status（不重复托管）。前置不满足 → 抛干净 Error（API 转 409，CLI 打一行通知）。
   */
  async startHs(target: { host: string; port: number }, numIntros = 3): Promise<RoleStatus> {
    if (this.hs) return this.status(); // 幂等：已托管则不再起第二个
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !target.host) {
      throw new Error('hs target 非法：需 host:port，例如 127.0.0.1:8080');
    }
    if (this.node.relays().length < MIN_RELAYS) {
      throw new Error('链上中继不足 3 个，暂无法托管隐藏服务（待更多 relay 上链后重试）');
    }
    const { address, stop } = await serveHiddenService({ dataDir: this.dataDir, target, deps: this.hsDeps, numIntros });
    this.hs = { address, stop };
    this.hsTarget = { ...target };
    return this.status();
  }

  /** 停止隐藏服务：销毁所有引入/会合电路（描述符在 HSDir 上靠 TTL 自然过期）。已停 → no-op。 */
  async stopHs(): Promise<RoleStatus> {
    if (this.hs) {
      this.hs.stop();
      this.hs = undefined;
      this.hsTarget = undefined;
    }
    return this.status();
  }

  // ---- 挖矿 ----

  /** 开挖（委托 node.startMining）。已在挖 → no-op（不重复起循环，避免双挖竞争）。 */
  startMine(intervalMs: number): RoleStatus {
    if (this.mineOn) return this.status(); // 幂等
    this.node.startMining(intervalMs);
    this.mineOn = true;
    this.mineIntervalMs = intervalMs;
    return this.status();
  }

  /** 停挖（委托 node.stopMining）。已停 → no-op。 */
  stopMine(): RoleStatus {
    if (this.mineOn) {
      this.node.stopMining();
      this.mineOn = false;
      this.mineIntervalMs = null;
    }
    return this.status();
  }

  // ---- SOCKS（常开基座，不做运行时启停；本类只持有引用供 status）----

  /**
   * 登记一个已由调用方拉起的 SocksProxy（启动时一次性，常开）。仅用于 status 展示；本类不负责其生命周期。
   * 注：SOCKS 切换不在 2F-1 范围内（它是轻量常开基座；切它会一并失去 .v0id 出站/隐藏服务客户端能力）。
   */
  attachSocks(socks: SocksProxy, port: number): void {
    this.socks = socks;
    this.socksPort = port;
  }

  /** 供调用方在启动时构造 SocksProxy 用的两件依赖（pickHops + 共享 hsDeps + guard 失败回调）。 */
  socksWiring(): { pickHops: HopPicker; hsDeps: HsDeps; onGuardFail: (g: HopSpec) => void } {
    return {
      pickHops: this.pickHops,
      hsDeps: this.hsDeps,
      onGuardFail: (g) => this.guard.markUnreachable(g.id),
    };
  }

  // ---- 只读元信息（CLI 启动打印用；不暴露可变内部句柄）----

  /** 本中继 onion 公钥（描述符 okey；CLI 打印 okey 前缀用）。 */
  get onionPub(): Uint8Array {
    return this.onion.pub;
  }
  /** 中继 cell 入口端口（CLI 打印 / 调用方诊断用）。 */
  get relayCellPort(): number {
    return this.relayPort;
  }

  // ---- 状态 ----

  /** 当前各角色状态（GUI 读它）。纯 JSON 对象，无副作用。 */
  status(): RoleStatus {
    return {
      socks: { on: !!this.socks, port: this.socks ? this.socksPort : null },
      relay: {
        on: !!this.relay,
        port: this.relay ? this.relayPort : null,
        address: this.relay ? this.node.wallet.address : null,
        circuits: this.relay ? this.relay.circuits : 0,
        published: this.relayPublished,
      },
      hs: { on: !!this.hs, address: this.hs ? this.hs.address : null, target: this.hsTarget ? { ...this.hsTarget } : null },
      mine: { on: this.mineOn, intervalMs: this.mineOn ? this.mineIntervalMs : null },
    };
  }
}
