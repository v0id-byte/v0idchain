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
import { isIP } from 'node:net';
import { existsSync, statSync } from 'node:fs';
import type { V0idNode } from '../node.js';
import { RelayNode, isPublicIpAddress, type RelayResolver } from './relaynode.js';
import { SocksProxy, type HopPicker } from './socks.js';
import { GuardManager } from './guards.js';
import { makeHsDeps, serveHiddenService, type HsDeps } from './hsbridge.js';
import { serveStaticDir } from './staticserve.js';
import { RelayReachability } from './reachability.js';
import type { HopSpec } from './client.js';
import type { MixnetOpts } from './relaynode.js';

/** 建路所需的链上中继下限（与 CLI pickHops / makeHsDeps「不足 3 个」同语义）。 */
const MIN_RELAYS = 3;
/** 自动发布描述符的重试周期（ms）——与 CLI 原值一致：余额够且尚未发布时定期重试一次。 */
const PUBLISH_RETRY_MS = 5000;
/** 最近 .v0id 连接失败原因缓存上限（瞬态、不落盘，同 GuardManager.unreachable 的取舍）——超则逐出最旧。 */
const MAX_HS_ERRORS = 128;

/**
 * 该中继广播 host 是否值得把 RELAY| 描述符上链。回环/私网 host 对任何远端客户端都不可达 → 上链只会污染
 * 全网中继目录（latest-wins 注册一旦写入永久无法注销，正是 PR#32 不得不在消费侧加抗污染选路的根因）。
 * 判定口径（与拨号方 dialRelay 的 SSRF 守卫**同款** isPublicIpAddress，避免两处漂移）：
 *   - 私网/回环 **IP 字面量**（127.x / 10.x / 192.168.x / 169.254.x / ::1 / fc·fd… 全套）→ 不发；
 *   - `localhost`（回环主机名，isIP 认不出）→ 不发；
 *   - 公网 IP → 发；
 *   - 其余**主机名**（含经 CF 隧道暴露的中继域名，可能解析到公网）→ 发：其真实可达性由拨号方在
 *     dialRelay 里按 DNS 解析结果用同一个 isPublicIpAddress 把关，此处不做同步 DNS（保持纯函数 + 不阻塞）。
 */
function isPublishableAdvertiseHost(host: string): boolean {
  if (host === 'localhost') return false;
  if (isIP(host)) return isPublicIpAddress(host);
  return true;
}

export interface RoleManagerOptions {
  node: V0idNode;
  dataDir: string;
  /** onion 静态密钥（中继描述符的 okey；由调用方 loadOrCreateOnionKey 提供，保证与磁盘一致）。 */
  onion: OnionKeypair;
  /** 中继 cell 入口端口（独立于 p2p / api 端口）。 */
  relayPort: number;
  /** 中继对外广播 host（公网/局域网才需要；默认 127.0.0.1）。发布描述符与本地绑定都用它。 */
  relayAdvertiseHost?: string;
  /** 中继描述符对外广播的**端口**（默认 = relayPort）。经 CF 隧道暴露时设 443：本地仍监听 relayPort，链上广播 443 → 拨号方走 wss://。 */
  relayAdvertisePort?: number;
  /** 中继 cell 监听绑定地址（默认 0.0.0.0，与 CLI 一致：对外可达）。 */
  relayBindHost?: string;
  /** 出口策略：允许作出口连到的 host:port 集合（来自 --exit-allow；空 = deny-all 纯中继）。 */
  exitAllow?: string[];
  /** Mixnet 模式（--mixnet）：传入则中继逐跳混入随机延迟（默认 undefined = 关 = 同步转发）。 */
  mixnet?: MixnetOpts;
  /** SOCKS 监听端口（仅用于 status 展示；SOCKS 由调用方在启动时一次性拉起）。 */
  socksPort?: number;
}

/** 单个托管服务的状态（多服务场景）。 */
export interface HsStatusEntry {
  id: string;
  address: string;
  target: { host: string; port: number };
  name: string;
  connCount: number;
  /** 'static' = 零后端内置静态文件夹托管（见 staticserve.ts）；'external' = 用户自己起的 host:port 后端。 */
  backend: 'external' | 'static';
  staticDir?: string; // backend='static' 时，被发布的本地文件夹路径
}

/** GET /roles 返回的形状（GUI 读它渲染开关状态）。字段填已知项，未启用角色给 off + 占位。 */
export interface RoleStatus {
  socks: { on: boolean; port: number | null };
  relay: {
    on: boolean;
    port: number | null;
    address: string | null;
    circuits: number;
    published: boolean;
    // 可达性自检结果：null=从未测试；测试打的是本中继自己广播的 host:port（见 selfCheckReachable）。
    reachableSelf: boolean | null;
    reachableSelfAt: number | null;
  };
  hsList: HsStatusEntry[]; // 所有活动托管服务列表（空 = 无）
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
  private readonly relayAdvertisePort: number;
  private readonly relayBindHost: string;
  private readonly exitAllow: string[];
  private readonly mixnet?: MixnetOpts;

  /** 共享入口守卫管理器：socks 与 hs（makeHsDeps）共用同一个 → 两边电路用同一守卫，攻击面统一收窄。 */
  private readonly guard: GuardManager;
  /** 隐藏服务接线依赖（选路器 + 名录）：每次都从链上重新快照（`() => node.relays()`），自然跟随链增长。 */
  private readonly hsDeps: HsDeps;
  /** 从链上目录解析中继地址 → cell 入口（EXTEND 拨号 & SOCKS 选路用）。 */
  private readonly resolver: RelayResolver;
  /** 可达性探测缓存：GUI「中继数量」统计与本中继自检共用同一份缓存（暖缓存、避免重复探测）。 */
  private readonly reachability = new RelayReachability();

  // ---- 活动句柄 ----
  private relay?: RelayNode;
  private relayPublished = false; // 中继描述符是否已上链（自动发布循环置位）
  private publishTimer?: ReturnType<typeof setInterval>;
  /** 最近一次自检结果（探自己的广播 host:port）；下线时清空，避免展示「上一次开中继时」的陈旧结果。 */
  private lastSelfCheck: { ok: boolean; at: number } | null = null;
  private hsMap: Map<
    string,
    {
      id: string;
      address: string;
      stop: () => void;
      getConnCount: () => number;
      target: { host: string; port: number };
      name: string;
      backend: 'external' | 'static';
      staticDir?: string;
    }
  > = new Map();
  private socks?: SocksProxy;
  private socksPort: number | null = null;
  /** 最近一次 SOCKS .v0id 连接失败原因，按目标地址存（GET /hs/lasterror 供 GUI 展示具体原因用）。 */
  private hsErrors: Map<string, { ts: number; reason: string }> = new Map();
  // 挖矿态：node 内部自己也有 mining 标志，但本类需对外报 on/intervalMs，故在此镜像一份。
  private mineOn = false;
  private mineIntervalMs: number | null = null;

  constructor(opts: RoleManagerOptions) {
    this.node = opts.node;
    this.dataDir = opts.dataDir;
    this.onion = opts.onion;
    this.relayPort = opts.relayPort;
    this.relayAdvertiseHost = opts.relayAdvertiseHost ?? '127.0.0.1';
    this.relayAdvertisePort = opts.relayAdvertisePort ?? opts.relayPort;
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
    // 回环/私网广播 host（如浏览器默认的 127.0.0.1）对远端不可达：只起本地 cell 中继，**不**自动把描述符
    // 上链。否则每个开了中继角色的浏览器都会往全网目录灌一条死的 127.0.0.1 中继，且 latest-wins 永久无法
    // 注销 —— 正是 PR#32 消费侧抗污染选路要兜的那种污染。设 --relay-advertise 为公网地址/域名后即恢复上链。
    if (!isPublishableAdvertiseHost(this.relayAdvertiseHost)) {
      console.warn(
        `  [中继] 广播地址 ${this.relayAdvertiseHost} 为回环/私网，跳过描述符上链（中继仅本地可用；设 --relay-advertise 为公网地址/域名后全网可发现）`,
      );
      return this.status();
    }
    // 自动发布描述符（从 CLI tryPublish 抬过来）：余额够且尚未发布时发一次。
    const onionPubHex = bytesToHex(this.onion.pub);
    const tryPublish = () => {
      if (this.relayPublished) return;
      const existing = this.node.relays().find((r) => r.address === this.node.wallet.address);
      if (existing && existing.onionPubHex === onionPubHex && existing.host === this.relayAdvertiseHost && existing.port === this.relayAdvertisePort) {
        this.relayPublished = true;
        return;
      }
      if (this.node.bc.balanceOf(this.node.wallet.address) < 2) return; // 余额不够发布手续费 → 等
      const pub = this.node.publishRelay(onionPubHex, this.relayAdvertiseHost, this.relayAdvertisePort);
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
    this.lastSelfCheck = null; // 中继已下线，上一次的可达结果不再有意义
    return this.status();
  }

  /**
   * 中继可达性自检：探测「本中继自己广播的 host:port」，回答用户最常问的「我是不是真的上线了」。
   * 只是 best-effort 提示（同 RelayReachability 的取舍）：测的是「探测节点连得上你」，不是「已被全网选中转发」。
   * 中继未启动 → 抛错（API 转 409），避免测出一个无意义的假阴性。
   */
  async selfCheckReachable(): Promise<boolean> {
    if (!this.relay) throw new Error('中继未上线，无法自检');
    const ok = await this.reachability.probeOne({ host: this.relayAdvertiseHost, port: this.relayAdvertisePort });
    this.lastSelfCheck = { ok, at: Date.now() };
    return ok;
  }

  /**
   * 中继数量统计：{ registered=链上曾注册过的全部地址数, reachable=当前已知可达数（探测缓存过滤） }。
   * 链上目录只会增长、从不注销（latest-wins 也无法删除早已下线的中继），registered 单独展示会显得虚高，
   * 故额外跑一次可达性探测（复用 pickHops 同款 RelayReachability，暖缓存内 TTL 期内近乎零成本）。
   */
  async liveRelayCount(): Promise<{ registered: number; reachable: number }> {
    const all = this.node.relays();
    await this.reachability.refresh(all);
    return { registered: all.length, reachable: this.reachability.knownUsable(all).length };
  }

  // ---- 隐藏服务（多服务支持）----

  /**
   * 托管一个 .v0id 隐藏服务，把进来的会合连接转发到一个本机 TCP 落地。需链上 ≥3 中继。
   * 落地二选一：① 传 `target`（host:port）——用户自己起的外部后端；② opts.staticDir——零后端，
   * 内置起一个只读静态文件服务器发布该文件夹（见 staticserve.ts），serveHiddenService 本就后端无关，
   * 静态服务器的本地端口直接当 target 用即可，不需要 hsbridge.ts 知道「静态」这回事。
   * 每次调用启动一个独立服务（不同 .v0id 地址），返回 { id, address }。
   * 前置不满足 → 抛干净 Error（API 转 409，CLI 打一行通知）。
   */
  async startHs(
    target?: { host: string; port: number },
    opts?: { name?: string; intros?: number; staticDir?: string },
  ): Promise<{ id: string; address: string }> {
    if (!!target === !!opts?.staticDir) {
      throw new Error('host:port 与 staticDir 须二选一（不能都传或都不传）');
    }
    if (target && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !target.host)) {
      throw new Error('hs target 非法：需 host:port，例如 127.0.0.1:8080');
    }
    if (opts?.staticDir && (!existsSync(opts.staticDir) || !statSync(opts.staticDir).isDirectory())) {
      throw new Error('所选文件夹不存在或不是目录');
    }
    if (this.node.relays().length < MIN_RELAYS) {
      throw new Error('链上中继不足 3 个，暂无法托管隐藏服务（待更多 relay 上链后重试）');
    }
    const backend: 'external' | 'static' = opts?.staticDir ? 'static' : 'external';
    // id 派生须与「目标」一一对应且跨重启稳定（同一目标复用同一身份文件 → .v0id 地址不变）：
    // 外部后端用 host:port；静态托管的落地端口每次都是随机临时端口，改用文件夹路径本身做稳定 id。
    const id = backend === 'static'
      ? `static_${opts!.staticDir}`.replace(/[^a-zA-Z0-9]/g, '_')
      : `${target!.host.replace(/[^a-zA-Z0-9]/g, '_')}_${target!.port}`;
    if (this.hsMap.has(id)) {
      const existing = this.hsMap.get(id)!;
      return { id: existing.id, address: existing.address };
    }
    let resolvedTarget = target;
    let staticStop: (() => void) | undefined;
    if (backend === 'static') {
      const { port, stop } = await serveStaticDir({ dir: opts!.staticDir! });
      resolvedTarget = { host: '127.0.0.1', port };
      staticStop = stop;
    }
    try {
      const { address, stop, getConnCount } = await serveHiddenService({
        dataDir: this.dataDir,
        identityKey: id,
        target: resolvedTarget!,
        deps: this.hsDeps,
        numIntros: opts?.intros,
      });
      const combinedStop = () => {
        stop();
        staticStop?.(); // 一并关掉静态文件服务器，避免留下没人用的孤儿监听
      };
      this.hsMap.set(id, {
        id,
        address,
        stop: combinedStop,
        getConnCount,
        target: { ...resolvedTarget! },
        name: opts?.name ?? '',
        backend,
        staticDir: opts?.staticDir,
      });
      return { id, address };
    } catch (e) {
      staticStop?.(); // 隐藏服务起失败（如引入点建路失败）→ 别留一个没人用的静态服务器孤儿进程
      throw e;
    }
  }

  /** 停止指定 id 的隐藏服务（不传 id 则停止所有）。 */
  async stopHs(id?: string): Promise<void> {
    if (id) {
      const entry = this.hsMap.get(id);
      if (entry) { entry.stop(); this.hsMap.delete(id); }
    } else {
      for (const entry of this.hsMap.values()) entry.stop();
      this.hsMap.clear();
    }
  }

  /** 当前活动隐藏服务列表（只读快照）。 */
  hsList(): HsStatusEntry[] {
    return [...this.hsMap.values()].map(e => ({
      id: e.id,
      address: e.address,
      target: e.target,
      name: e.name,
      connCount: e.getConnCount(),
      backend: e.backend,
      staticDir: e.staticDir,
    }));
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

  /** 供调用方在启动时构造 SocksProxy 用的依赖（pickHops + 共享 hsDeps + guard/hs 失败回调）。 */
  socksWiring(): { pickHops: HopPicker; hsDeps: HsDeps; onGuardFail: (g: HopSpec) => void; onHsFail: (addr: string, reason: string) => void } {
    return {
      pickHops: this.pickHops,
      hsDeps: this.hsDeps,
      onGuardFail: (g) => this.guard.markUnreachable(g.id),
      onHsFail: (addr, reason) => this.recordHsError(addr, reason),
    };
  }

  /** 记一条 .v0id 连接失败原因（同地址覆盖旧值；超容量逐出最旧）。 */
  private recordHsError(addr: string, reason: string): void {
    this.hsErrors.delete(addr); // 先删后插 = 顶到 Map 迭代顺序末尾，配合下面 FIFO 逐出
    this.hsErrors.set(addr, { ts: Date.now(), reason });
    if (this.hsErrors.size > MAX_HS_ERRORS) {
      const oldest = this.hsErrors.keys().next().value;
      if (oldest !== undefined) this.hsErrors.delete(oldest);
    }
  }

  /** 查最近一次某 .v0id 地址的连接失败原因（GET /hs/lasterror 用）。无记录 → undefined。 */
  hsError(addr: string): { ts: number; reason: string } | undefined {
    return this.hsErrors.get(addr);
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
        reachableSelf: this.lastSelfCheck ? this.lastSelfCheck.ok : null,
        reachableSelfAt: this.lastSelfCheck ? this.lastSelfCheck.at : null,
      },
      hsList: this.hsList(),
      mine: { on: this.mineOn, intervalMs: this.mineOn ? this.mineIntervalMs : null },
    };
  }
}
