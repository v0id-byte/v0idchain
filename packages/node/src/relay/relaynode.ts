// 中继节点（cell 平面服务端）：独立 WebSocketServer 收发 cell，按 circId 路由洋葱电路。
//
// 关键：中继**只在直接收到 CREATE 时**跑一次 ntor（建立“客户端↔本跳”的密钥）。延伸(EXTEND)时它只是把客户端
// 给下一跳的握手**转发**出去（发一个 CREATE 给下一跳、把回来的 CREATED 包成后向 EXTENDED 还给客户端）——
// 它**永远不知道**更深各跳的密钥与内容。这正是洋葱路由的匿名性来源：没有任何单跳同时知道两端 + 全路径。
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns';
import { connect, isIP, type Socket } from 'node:net';
import {
  ntorServer,
  type OnionKeypair,
  hexToBytes,
  bytesToHex,
  utf8ToBytes,
  addressToPublicKeyHex,
  CMD_EXTEND,
  CMD_EXTENDED,
  CMD_DATA,
  CMD_BEGIN,
  CMD_CONNECTED,
  CMD_END,
  CMD_HS_PUBLISH,
  CMD_HS_FETCH,
  CMD_HS_RESP,
  CMD_HS_END,
  CMD_ESTABLISH_INTRO,
  CMD_INTRO_ESTABLISHED,
  CMD_INTRODUCE1,
  CMD_INTRODUCE2,
  CMD_ESTABLISH_RENDEZVOUS,
  CMD_RENDEZVOUS_ESTABLISHED,
  CMD_RENDEZVOUS1,
  CMD_RENDEZVOUS2,
  CMD_RDV_DATA,
  CMD_DROP,
  sampleExpMs,
  DEFAULT_DELAY_MEAN_MS,
  DEFAULT_MAX_DELAY_MS,
  RDV_COOKIE_LEN,
  CELL_DATA_LEN,
  PERIOD_LEN,
  verifyDescriptorPublishable,
  descriptorId,
  type Descriptor,
} from '@v0idchain/core';
import { type CellMsg, decodeCell, encodeCell } from './cells.js';
import { encodeFramed, FrameReassembler } from './hsdir.js';
import {
  RelayCircuitTable,
  type RelayCircuit,
  type CellLink,
  relayForward,
  relayAddBackwardLayer,
  originateBackward,
  makeBwdBase,
  takeCellToken,
} from './circuit.js';
import { newAntiReplay } from './antireplay.js';

/** 目录解析器：中继地址 → 其 cell 入口 host:port。生产用 parseRelays(chain)，测试可注入静态 map。 */
export type RelayResolver = (id: string) => { host: string; port: number } | undefined;
/** 出口投递回调（数据报模式，用于自检/echo）：收到面向本节点(出口)的 DATA → 业务处理 + reply 走原电路后向。 */
export type ExitHandler = (data: Uint8Array, reply: (resp: Uint8Array) => void) => void;
/** 出口策略：是否允许本中继作出口连到 host:port。默认 deny-all（中继不当无意识开放出口）。 */
export type ExitPolicy = (host: string, port: number) => boolean;

let LID = 0;
const mintCirc = () => randomBytes(8).toString('hex');
/** 单中继电路硬上限（粗粒度抗内存耗尽兜底）。下面的 DoS 加固在其之上加细粒度回收/限速。 */
const MAX_CIRCUITS = 2048;
const CELL_WS_MAX_PAYLOAD = 1 << 12;

// ---- DoS 加固默认值（可经构造器 opts 覆盖；生产默认须明显高于真实用量，绝不误伤合法流量）----
/** 电路空闲多久没有任何 cell 即被清扫回收（无活动 = 大概率僵尸/半开）。 */
const CIRCUIT_IDLE_MS = 10 * 60 * 1000; // 10 min
/** 电路绝对最大寿命（无论是否活跃，到点强制回收，封顶长寿电路占用）。 */
const CIRCUIT_MAX_AGE_MS = 60 * 60 * 1000; // 1 h
/** 清扫定时器周期。 */
const SWEEP_INTERVAL_MS = 30 * 1000; // 30 s
/** 每电路前向 cell 稳态速率（cells/s）。须远高于流层真实需求（relay-stream-test 的 2000B 传输只需几十 cell）。 */
const CELL_RATE = 500;
/** 每电路前向 cell 突发桶容量（瞬时上限）。 */
const CELL_BURST = 1000;
/** 单个丢弃统计窗口（ms）：窗口内被限速丢弃的 cell 数超 CELL_FLOOD_KILL → 判定恶意洪泛 → 销毁电路。 */
const CELL_FLOOD_WINDOW_MS = 1000;
/** 一个窗口内丢弃达到此数即销毁电路（区分“偶发超速被削峰”与“持续灌爆”）。 */
const CELL_FLOOD_KILL = 2000;
/** EXTEND 拨号下一跳的连接超时：超时仍未建立(收到 CREATED) → 拆电路，避免黑洞下一跳令电路半开永挂。 */
const CONNECT_TIMEOUT_MS = 10 * 1000; // 10 s
/** 单条 CellLink（=单个客户端连接）可承载的电路数上限（宽松——中继间链路天然多路复用大量电路）。全局 MAX_CIRCUITS 仍是兜底。 */
const MAX_CIRCUITS_PER_CONN = 512;
/**
 * 单个来源 IP（跨该 IP 的所有连接合计）可承载的电路数上限。
 * 动机：每连接上限(512)×全局(2048) 意味着一个 IP 仅开 4 条连接就能钉死整台中继。按 IP 聚合配额封住这条路。
 * 生产默认须明显高于真实用量、且高到不误伤“多电路共用一个 IP”的合法重客户端 / 同机多电路（如本机自测全在 127.0.0.1）。
 */
const MAX_CIRCUITS_PER_IP = 256;

/**
 * Mixnet 模式（Phase 2C，opt-in；构造器不传 = 关 = 行为与历史完全一致，同步转发）。
 * 启用时，本中继把**每个**要转发的前向 cell（转下一跳）与每个要套层送回的后向 cell 各**扣住一个随机指数延迟**
 * （均值 delayMeanMs，钳到 maxDelayMs）再发出 → 打散 input→output 时序相关（全局被动观察者的关联攻击）。
 * 延迟**双向**施加（前向 'f' 转发 + 后向 'b' 套层），与 Loopix 每跳均混延迟一致。
 * maxHeldCells：单中继**同时**扣在手里的延迟 cell 总数硬上限（抗内存：入流已被 2A 的 cell 限速约束，
 * 故被扣 cell 数 ≲ 速率×均值；此 cap 是兜底，超额则直接丢弃该 cell 不再延迟入队）。
 */
export interface MixnetOpts {
  delayMeanMs?: number; // 每跳指数延迟均值（ms），默认 DEFAULT_DELAY_MEAN_MS=80
  maxDelayMs?: number; // 单 cell 单跳延迟硬上限（ms），默认 DEFAULT_MAX_DELAY_MS=2000
  maxHeldCells?: number; // 本中继同时扣住的延迟 cell 总数上限，默认 MIXNET_MAX_HELD_CELLS
}
/** 本中继同时“扣在手里”的延迟 cell 总数默认上限（抗内存兜底；远高于 速率×均值 的稳态期望）。 */
const MIXNET_MAX_HELD_CELLS = 50_000;

/** 可经构造器覆盖的 DoS 加固时序/阈值（测试用极小值以求快与确定）。 */
export interface RelayDosOpts {
  idleMs?: number;
  maxAgeMs?: number;
  sweepMs?: number;
  cellRate?: number;
  cellBurst?: number;
  floodWindowMs?: number;
  floodKill?: number;
  connectTimeoutMs?: number;
  maxPerConn?: number;
  maxPerIp?: number;
}
/** HSDir 存储的描述符条目硬上限（抗内存耗尽：插入前 prune 过期，仍满则拒新存）。 */
const MAX_HSDESCS = 10000;
/** 单条 HS 请求（PUBLISH/FETCH）重组上限：64B descIdHex + 一个宽松的描述符 JSON 上限，抗内存放大。 */
const MAX_HS_REQ_BYTES = 16 * 1024;

function isLocalListenHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isPublicIpAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split('.').map((x) => Number(x));
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (kind === 6) {
    const h = address.toLowerCase();
    if (h.startsWith('::ffff:') && h.includes('.')) return isPublicIpAddress(h.slice(7));
    return !(h === '::' || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || /^fe[89ab]/.test(h) || h.startsWith('ff'));
  }
  return false;
}

function wsHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * 把一个中继的 (host, port) 解析成可直接连接的 ws/wss URL，并施加 SSRF 守卫。返回 null = 拒连。
 * - 端口 443 视作经 Cloudflare 隧道暴露 → 用 wss:// 且**按主机名**连接（CF 边缘按 SNI/Host 路由，
 *   必须连主机名而非解析出的边缘 IP）；其余端口 = 明文 ws://。
 * - allowPrivate=false（生产默认）：私网/回环 IP 字面量、以及**解析到私网的主机名**一律回 null；
 *   allowPrivate=true（本机绑回环自测）：原样放行。
 * 拨号下一跳（dialRelay）与可达性探测（RelayReachability.probe）**复用此函数** → SSRF 口径只有一处，绝不漂移。
 * 异步：主机名需 DNS 解析后才能判定，故走回调（IP 字面量/放行私网分支为同步回调）。
 */
export function resolveRelayWsUrl(
  host: string,
  port: number,
  allowPrivate: boolean,
  cb: (url: string | null) => void,
): void {
  const scheme = port === 443 ? 'wss' : 'ws';
  const url = (target: string) => `${scheme}://${target}:${port}`;
  if (allowPrivate) {
    cb(url(wsHost(host)));
    return;
  }
  if (isIP(host)) {
    cb(isPublicIpAddress(host) ? url(wsHost(host)) : null);
    return;
  }
  // 主机名：解析并校验解析出的 IP 是公网才放行（挡住 host 解析到内网的 SSRF）。
  lookup(host, { all: false }, (err, address, family) => {
    if (err || !address || !isPublicIpAddress(address)) {
      cb(null);
      return;
    }
    // wss（CF 隧道）必须按主机名连接以走对 SNI；明文 ws 直接连解析出的公网 IP。
    cb(url(scheme === 'wss' ? host : family === 6 ? `[${address}]` : address));
  });
}

export class RelayNode {
  private wss: WebSocketServer;
  private table = new RelayCircuitTable();
  private idPub: Uint8Array;
  private exitHandler?: ExitHandler;
  private dropHandler?: () => void; // Mixnet：本跳作终点丢弃一个 CMD_DROP 掩护 cell 时的观察钩子（默认无；仅用于度量/自测，不影响丢弃语义）
  private exitPolicy: ExitPolicy = () => false; // 默认 deny-all
  private streams = new Map<RelayCircuit, Socket>(); // 出口：电路 → 其 TCP 流（v1 每电路 1 条流）
  // HSDir 描述符存储：descIdHex → {json, exp, rev}。跨电路存活（DHT 的意义），仅 TTL 过期/超量被清，不随电路销毁清空。
  // rev = 该 descId 当前存的描述符的修订号；发布时只接受 rev 严格更高者（同周期防回滚，见 handleHsPublish）。
  private hsdescs = new Map<string, { json: string; exp: number; rev: number }>();
  // 进行中的分帧 HS 请求重组器（按电路 + 命令；一条电路同一时刻一种 HS 请求在途）。随电路销毁清理。
  private hsReasm = new Map<RelayCircuit, { cmd: number; reasm: FrameReassembler }>();
  // ---- 引入点/会合点状态（Phase 2B-c）。本节点同时可担任 IP 与 RP；下面三张表互不干扰，均随电路销毁清理。----
  // 作 IP：authKeyHex → 服务的引入电路（该电路终点是本节点）。客户端 INTRODUCE1 携 authKey → 据此找到服务电路后向转发。
  private introTable = new Map<string, RelayCircuit>();
  private introByCirc = new Map<RelayCircuit, string>(); // 反查（电路销毁时摘除 introTable 项）
  // 作 RP：cookieHex → 客户端的会合电路（终点是本节点）。服务 RENDEZVOUS1 携 cookie → 据此找到客户端电路并拼接。
  private rdvTable = new Map<string, RelayCircuit>();
  private rdvByCirc = new Map<RelayCircuit, string>();
  // 作 RP：拼接对（双向）。RENDEZVOUS1 成功后把服务的会合电路 ↔ 客户端的会合电路互链；CMD_RDV_DATA 据此透传到对端。
  private splice = new Map<RelayCircuit, RelayCircuit>();
  // ---- DoS 加固状态 ----
  private perConn = new Map<CellLink, number>(); // 每客户端连接(prevConn)承载的电路计数（CREATE++ / destroy--）
  private perIp = new Map<string, number>(); // 每来源 IP 承载的电路计数（聚合该 IP 全部连接；CREATE++ / destroy--）。无 ip 的连接不计入。
  private sweepTimer: ReturnType<typeof setInterval>; // 空闲/超龄电路清扫定时器
  private dos: Required<RelayDosOpts>; // 解析后的 DoS 时序/阈值（默认 = 上面常量）
  // ---- Mixnet 状态（默认关）----
  private mix: { delayMeanMs: number; maxDelayMs: number; maxHeldCells: number } | null = null; // null = 关 = 同步转发
  private heldCells = 0; // 当前全中继被混入延迟“扣在手里”的 cell 总数（cap 用）

  constructor(
    readonly id: string, // 本中继钱包地址 0x..（= ntor relayId）
    private onion: OnionKeypair, // 静态 onion 密钥（公钥即 RELAY| 描述符的 okey）
    private resolve: RelayResolver,
    readonly port: number,
    readonly host = '127.0.0.1',
    private allowPrivateRelayTargets = isLocalListenHost(host),
    opts: RelayDosOpts = {}, // DoS 加固覆盖项；缺省即生产默认。位置在既有参数之后 → 不破坏 new RelayNode(id,onion,resolve,port,host)
    mixnet?: MixnetOpts, // Mixnet 模式（Phase 2C，opt-in）；不传 = 关 = 同步转发，行为与历史完全一致。位置在 opts 之后 → 不破坏既有调用
  ) {
    this.idPub = hexToBytes(addressToPublicKeyHex(id));
    if (mixnet) {
      this.mix = {
        delayMeanMs: mixnet.delayMeanMs ?? DEFAULT_DELAY_MEAN_MS,
        maxDelayMs: mixnet.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
        maxHeldCells: mixnet.maxHeldCells ?? MIXNET_MAX_HELD_CELLS,
      };
    }
    this.dos = {
      idleMs: opts.idleMs ?? CIRCUIT_IDLE_MS,
      maxAgeMs: opts.maxAgeMs ?? CIRCUIT_MAX_AGE_MS,
      sweepMs: opts.sweepMs ?? SWEEP_INTERVAL_MS,
      cellRate: opts.cellRate ?? CELL_RATE,
      cellBurst: opts.cellBurst ?? CELL_BURST,
      floodWindowMs: opts.floodWindowMs ?? CELL_FLOOD_WINDOW_MS,
      floodKill: opts.floodKill ?? CELL_FLOOD_KILL,
      connectTimeoutMs: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      maxPerConn: opts.maxPerConn ?? MAX_CIRCUITS_PER_CONN,
      maxPerIp: opts.maxPerIp ?? MAX_CIRCUITS_PER_IP,
    };
    this.wss = new WebSocketServer({ host, port, maxPayload: CELL_WS_MAX_PAYLOAD });
    // 取 ws 升级请求的 remoteAddress 作来源 IP，钉到 CellLink 上供每-IP 配额用（拿不到则 undefined → 该连接不计入 IP 配额）。
    this.wss.on('connection', (ws, req) => this.wrap(ws, req?.socket?.remoteAddress));
    // 周期清扫：回收空闲 > idleMs 或寿命 > maxAgeMs 的电路。unref → 不阻止进程退出。
    this.sweepTimer = setInterval(() => this.sweep(), this.dos.sweepMs);
    this.sweepTimer.unref?.();
  }

  /** 空闲/超龄电路清扫：遍历电路表，回收僵尸电路（半开、被遗弃、超长寿）。 */
  private sweep(): void {
    const now = Date.now();
    for (const c of this.table.all()) {
      // HiddenService 建好的引入点电路是长期注册态：描述符会继续发布这些 intro 信息，但服务端
      // 当前不会在收到 DESTROY 后自动重建/重发布。若被普通 idle/max-age 清扫，客户端会拿到陈旧 intro
      // 而无法接入。因此 introByCirc 注册的电路不参与通用 DoS 清扫；它们仍会在链路关闭、显式 DESTROY、
      // shutdown 等正常路径中清理登记。
      if (this.introByCirc.has(c)) continue;
      if (now - c.lastSeen > this.dos.idleMs) this.destroyCircuit(c, undefined, 'idle');
      else if (now - c.createdAt > this.dos.maxAgeMs) this.destroyCircuit(c, undefined, 'max-age');
    }
  }

  onExit(h: ExitHandler): void {
    this.exitHandler = h;
  }
  /** Mixnet 观察钩子：本跳作终点每丢弃一个 CMD_DROP 掩护 cell 触发一次（仅度量/自测；不改变“静默丢弃”语义）。 */
  onDrop(h: () => void): void {
    this.dropHandler = h;
  }
  /** 设置出口策略（允许作出口连到哪些 host:port）。不设 = deny-all。 */
  setExitPolicy(p: ExitPolicy): void {
    this.exitPolicy = p;
  }
  get circuits(): number {
    return this.table.size;
  }
  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const c of this.table.all()) this.destroyCircuit(c, undefined, 'shutdown', true);
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  // 把一条 ws 包成 CellLink 并挂消息分发。出站(CONNECTING)时先缓冲、open 后补发。
  // ip：入站连接传 ws 升级请求的 remoteAddress（每-IP 配额用）；出站(EXTEND 拨下一跳)不传 → undefined，不计入 IP 配额。
  private wrap(ws: WebSocket, ip?: string): CellLink {
    const outbox: CellMsg[] = [];
    const link: CellLink = {
      lid: LID++,
      ip,
      send: (m) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeCell(m));
        else if (ws.readyState === WebSocket.CONNECTING) outbox.push(m);
      },
      close: () => ws.close(),
      isOpen: () => ws.readyState === WebSocket.OPEN,
    };
    ws.on('open', () => {
      for (const m of outbox) ws.send(encodeCell(m));
      outbox.length = 0;
    });
    ws.on('message', (d) => {
      const m = decodeCell(String(d));
      if (m) this.onCell(link, m);
    });
    ws.on('close', () => this.cleanupLink(link));
    ws.on('error', () => this.cleanupLink(link));
    return link;
  }

  private cleanupLink(link: CellLink): void {
    for (const circ of this.table.all()) {
      if (circ.prevConn === link || circ.nextConn === link) this.destroyCircuit(circ, link, 'link-closed');
    }
  }

  private destroyCircuit(circ: RelayCircuit, source?: CellLink, reason = 'destroy', closePrev = false): void {
    // 幂等：本电路可能经多条路径(链路清理/拼接对递归/超时)被重复销毁；仅当它仍在表中时才走一遍清理 + 记账，
    // 否则 perConn 计数会被多减。以“仍按 prevCirc 指向本电路”作在表判据。
    const live = this.table.byPrev(circ.prevCirc) === circ;
    this.table.remove(circ);
    if (live) {
      const n = (this.perConn.get(circ.prevConn) ?? 1) - 1; // 该客户端连接的电路计数自减
      if (n <= 0) this.perConn.delete(circ.prevConn);
      else this.perConn.set(circ.prevConn, n);
      const ip = circ.prevConn.ip; // 该 IP 的电路计数自减（与 CREATE 处递增对称；同一 live 守卫保证幂等不多减）
      if (ip !== undefined) {
        const m = (this.perIp.get(ip) ?? 1) - 1;
        if (m <= 0) this.perIp.delete(ip);
        else this.perIp.set(ip, m);
      }
    }
    if (circ.extendTimer) {
      clearTimeout(circ.extendTimer); // EXTEND 连接超时计时器（若在途）随电路销毁清除
      circ.extendTimer = undefined;
    }
    if (circ.mixTimers && circ.mixTimers.size > 0) {
      // Mixnet：本电路尚“扣在手里”的延迟 cell 一律取消（不在 teardown 后再发出），并归还全局 heldCells 计数。
      for (const t of circ.mixTimers) clearTimeout(t);
      this.heldCells -= circ.mixTimers.size;
      if (this.heldCells < 0) this.heldCells = 0; // 防御性兜底
      circ.mixTimers.clear();
    }
    this.streams.get(circ)?.destroy();
    this.streams.delete(circ);
    this.hsReasm.delete(circ); // 清理在途 HS 请求重组态（描述符存储 hsdescs 不动——跨电路存活）
    // 引入点/会合点登记摘除。
    const ak = this.introByCirc.get(circ);
    if (ak !== undefined) {
      if (this.introTable.get(ak) === circ) this.introTable.delete(ak);
      this.introByCirc.delete(circ);
    }
    const ck = this.rdvByCirc.get(circ);
    if (ck !== undefined) {
      if (this.rdvTable.get(ck) === circ) this.rdvTable.delete(ck);
      this.rdvByCirc.delete(circ);
    }
    // 拼接对：一端塌了，连带销毁对端电路（e2e 通道已断），并解开双向链接。
    const peer = this.splice.get(circ);
    if (peer) {
      this.splice.delete(circ);
      if (this.splice.get(peer) === circ) {
        this.splice.delete(peer);
        this.destroyCircuit(peer, undefined, 'splice-peer-gone');
      }
    }
    if (circ.nextConn && circ.nextCirc) {
      if (source !== circ.nextConn) circ.nextConn.send({ t: 'DESTROY', c: circ.nextCirc, r: reason });
      circ.nextConn.close();
    }
    if (source !== circ.prevConn) circ.prevConn.send({ t: 'DESTROY', c: circ.prevCirc, r: reason });
    if (closePrev) circ.prevConn.close();
  }

  /**
   * Mixnet 转发整形：把“要在 conn 上发出 msg”这一动作，按本中继配置同步发或延迟发。
   * - mixnet 关（this.mix===null）→ 立即 conn.send（与历史行为逐字节一致，零开销）。
   * - mixnet 开 → 采样一个指数延迟（均值/上限按 opts），setTimeout 到点再发；把该 timer 记到 circ.mixTimers
   *   + 计入全局 heldCells（拆电路时统一 clear+归还）。若全局扣留数已达 maxHeldCells → 直接丢弃该 cell（不入队、不延迟），
   *   作抗内存兜底（入流已被 2A cell 限速约束，正常永不触顶）。
   * 仅用于**转发/后向**路径（中间跳转下一跳、后向套层送回 prev）；CREATE/CREATED/DESTROY 等控制 cell 不走此路（不延迟）。
   */
  private mixSend(circ: RelayCircuit, conn: CellLink, msg: CellMsg): void {
    if (!this.mix) {
      conn.send(msg);
      return;
    }
    if (this.heldCells >= this.mix.maxHeldCells) return; // 扣留已满 → 丢该 cell（兜底，不再延迟入队）
    const delay = sampleExpMs(this.mix.delayMeanMs, this.mix.maxDelayMs);
    if (!circ.mixTimers) circ.mixTimers = new Set();
    const timer = setTimeout(() => {
      circ.mixTimers?.delete(timer); // 先摘除自身（destroyCircuit 据 size 归还计数，避免双减）
      this.heldCells--;
      if (this.heldCells < 0) this.heldCells = 0;
      if (conn.isOpen()) conn.send(msg);
    }, delay);
    timer.unref?.(); // 不阻止进程退出
    circ.mixTimers.add(timer);
    this.heldCells++;
  }

  private onCell(link: CellLink, m: CellMsg): void {
    switch (m.t) {
      case 'CREATE': {
        if (this.table.byPrev(m.c)) {
          link.send({ t: 'DESTROY', c: m.c, r: 'duplicate-circuit' });
          return;
        }
        if (this.table.size >= MAX_CIRCUITS) {
          link.send({ t: 'DESTROY', c: m.c, r: 'overloaded' });
          return;
        }
        // 每连接电路上限（宽松；防单连接独吞全局额度。中继间链路天然多路复用 → 阈值留得很高）。
        if ((this.perConn.get(link) ?? 0) >= this.dos.maxPerConn) {
          link.send({ t: 'DESTROY', c: m.c, r: 'per-conn-limit' });
          return;
        }
        // 每来源 IP 电路上限（聚合该 IP 全部连接；封住“一个 IP 多开几条连接绕过每连接上限”）。
        // 仅对带 ip 的入站连接生效；出站/未知 ip(undefined)的链路（如 EXTEND 拨下一跳）不计入、不受限。
        if (link.ip !== undefined && (this.perIp.get(link.ip) ?? 0) >= this.dos.maxPerIp) {
          link.send({ t: 'DESTROY', c: m.c, r: 'per-ip-limit' });
          return;
        }
        // 直接握手：建立“客户端↔本跳”的密钥（本跳是某客户端电路的这一跳）。
        const r = ntorServer(this.idPub, this.onion, hexToBytes(m.x));
        if (!r) {
          link.send({ t: 'DESTROY', c: m.c, r: 'ntor-fail' });
          return;
        }
        const now = Date.now();
        const circ: RelayCircuit = {
          prevConn: link,
          prevCirc: m.c,
          keys: r.keys,
          fwdReplay: newAntiReplay(), // 前向滑动窗口防重放（首个 n=0 被接受、重复/太老/越界丢；接受 Mixnet 重排的乱序 cell）
          bwdBase: makeBwdBase(randomBytes(3)),
          bwdLocal: 0,
          createdAt: now,
          lastSeen: now,
          cellTokens: this.dos.cellBurst, // 满桶起步
          cellRefillAt: now,
          cellDropped: 0,
          cellDropWindowAt: now,
        };
        if (!this.table.add(circ)) {
          link.send({ t: 'DESTROY', c: m.c, r: 'duplicate-circuit' });
          return;
        }
        this.perConn.set(link, (this.perConn.get(link) ?? 0) + 1); // 记账：该连接 +1 条电路
        if (link.ip !== undefined) this.perIp.set(link.ip, (this.perIp.get(link.ip) ?? 0) + 1); // 记账：该 IP +1 条电路
        link.send({ t: 'CREATED', c: m.c, y: bytesToHex(r.serverEph), a: bytesToHex(r.auth) });
        return;
      }
      case 'CREATED': {
        // 下一跳对我们(代客户端)发的 CREATE 的应答 → 包成后向 EXTENDED 还给客户端。
        const circ = this.table.byNext(m.c);
        if (!circ || circ.nextConn !== link) return;
        circ.lastSeen = Date.now();
        if (circ.extendTimer) {
          clearTimeout(circ.extendTimer); // 下一跳已建立 → 取消 EXTEND 连接超时
          circ.extendTimer = undefined;
        }
        const data = new Uint8Array(64);
        data.set(hexToBytes(m.y), 0); // Y(32)
        data.set(hexToBytes(m.a), 32); // AUTH(32)
        const { n, body } = originateBackward(circ, CMD_EXTENDED, data);
        circ.prevConn.send({ t: 'RELAY', c: circ.prevCirc, d: 'b', n, b: bytesToHex(body) });
        return;
      }
      case 'RELAY': {
        if (m.d === 'f') {
          const circ = this.table.byPrev(m.c);
          if (!circ || circ.prevConn !== link) return;
          const now = Date.now();
          circ.lastSeen = now; // 有活动 → 刷新空闲计时（清扫不回收活跃电路）
          // 每电路前向 cell 限速（令牌桶）。无令牌 → 丢该 cell 并计数；窗口内丢弃过多 = 洪泛 → 销毁电路。
          if (!takeCellToken(circ, now, this.dos.cellRate, this.dos.cellBurst)) {
            if (now - circ.cellDropWindowAt > this.dos.floodWindowMs) {
              circ.cellDropWindowAt = now; // 新窗口，丢弃计数归零
              circ.cellDropped = 0;
            }
            if (++circ.cellDropped >= this.dos.floodKill) this.destroyCircuit(circ, undefined, 'flood');
            return; // 丢弃这一 cell（不转发、不处理）
          }
          const act = relayForward(circ, hexToBytes(m.b), m.n);
          if (act.kind === 'drop') return;
          if (act.kind === 'forward') {
            // Mixnet：转发到下一跳的前向 cell 经 mixSend 整形（mixnet 关时即同步发，零行为变化）。
            if (circ.nextConn && circ.nextCirc)
              this.mixSend(circ, circ.nextConn, { t: 'RELAY', c: circ.nextCirc, d: 'f', n: m.n, b: bytesToHex(act.body) });
            return;
          }
          // act.kind === 'self'：是给我的命令（本跳是终点/出口）
          // Mixnet 掩护 cell：本跳是终点且剥出 CMD_DROP → **静默丢弃**。不投递给出口 TCP/exitHandler/HSDir/会合/app，也不回任何后向。
          // （中间跳永远走不到这里：CMD_DROP 对中间跳是深层密文 → relayForward 判 forward 盲转发，看不出是 drop。）
          if (act.cmd === CMD_DROP) {
            this.dropHandler?.(); // 仅观察（度量/自测）；丢弃语义不变（不投递、不回应）
            return;
          }
          if (act.cmd === CMD_EXTEND) this.handleExtend(circ, act.data);
          else if (act.cmd === CMD_BEGIN) this.handleBegin(circ, act.data);
          else if (act.cmd === CMD_DATA) {
            const s = this.streams.get(circ);
            if (s) s.write(Buffer.from(act.data)); // 流模式：写到出口 TCP
            else if (this.exitHandler) this.exitHandler(act.data, (resp) => this.sendBackward(circ, CMD_DATA, resp)); // 数据报/echo 模式
          } else if (act.cmd === CMD_END) {
            this.streams.get(circ)?.end();
            this.streams.delete(circ);
          } else if (act.cmd === CMD_HS_PUBLISH || act.cmd === CMD_HS_FETCH) {
            this.handleHsRequest(circ, act.cmd, act.data);
          } else if (act.cmd === CMD_ESTABLISH_INTRO) this.handleEstablishIntro(circ, act.data);
          else if (act.cmd === CMD_INTRODUCE1) this.handleIntroduce1(circ, act.data);
          else if (act.cmd === CMD_ESTABLISH_RENDEZVOUS) this.handleEstablishRendezvous(circ, act.data);
          else if (act.cmd === CMD_RENDEZVOUS1) this.handleRendezvous1(circ, act.data);
          else if (act.cmd === CMD_RDV_DATA) this.handleRdvData(circ, act.data);
          return;
        }
        // 后向：来自下一跳，加本跳一层送回 prev
        const circ = this.table.byNext(m.c);
        if (!circ || circ.nextConn !== link) return;
        circ.lastSeen = Date.now(); // 后向活动也刷新空闲计时
        const body = relayAddBackwardLayer(circ, hexToBytes(m.b), m.n);
        if (!body) return;
        // Mixnet：后向 cell 套本跳层后经 mixSend 整形（双向均混延迟；mixnet 关时即同步发）。
        this.mixSend(circ, circ.prevConn, { t: 'RELAY', c: circ.prevCirc, d: 'b', n: m.n, b: bytesToHex(body) });
        return;
      }
      case 'DESTROY': {
        const byPrev = this.table.byPrev(m.c);
        if (byPrev && byPrev.prevConn === link) {
          this.destroyCircuit(byPrev, link, m.r);
          return;
        }
        const byNext = this.table.byNext(m.c);
        if (byNext && byNext.nextConn === link) this.destroyCircuit(byNext, link, m.r);
        return;
      }
    }
  }

  private dialRelay(host: string, port: number, cb: (ws: WebSocket | null) => void): void {
    // SSRF 守卫 + CF 隧道 wss/按主机名约定统一收在 resolveRelayWsUrl（与可达性探测 RelayReachability.probe 复用同一口径）。
    resolveRelayWsUrl(host, port, this.allowPrivateRelayTargets, (target) => {
      cb(target ? new WebSocket(target, { maxPayload: CELL_WS_MAX_PAYLOAD }) : null);
    });
  }

  // EXTEND 数据 = nextHopId(32) ‖ clientEphX(32)。拨号下一跳、铸 nextCirc、转发 CREATE。
  private handleExtend(circ: RelayCircuit, data: Uint8Array): void {
    if (data.length < 64) return;
    if (circ.nextConn || circ.nextCirc) {
      this.destroyCircuit(circ, undefined, 'already-extended');
      return;
    }
    const nextId = '0x' + bytesToHex(data.subarray(0, 32));
    const x = bytesToHex(data.subarray(32, 64));
    const at = this.resolve(nextId);
    if (!at) {
      this.destroyCircuit(circ, undefined, 'unknown-relay');
      return;
    }
    this.dialRelay(at.host, at.port, (ws) => {
      if (!ws) {
        this.destroyCircuit(circ, undefined, 'blocked-relay-target');
        return;
      }
      if (this.table.byPrev(circ.prevCirc) !== circ || circ.nextConn || circ.nextCirc) {
        ws.close();
        return;
      }
      const next = this.wrap(ws);
      const nextCirc = mintCirc();
      if (!this.table.linkNext(circ, next, nextCirc)) {
        next.close();
        this.destroyCircuit(circ, undefined, 'extend-failed');
        return;
      }
      next.send({ t: 'CREATE', c: nextCirc, x }); // 缓冲到 open 后发
      // 连接超时：下一跳若是黑洞（既不 open 也不 error，TCP 永挂），到点没收到 CREATED 就拆电路 + 关 ws，
      // 避免半开电路无限占用。CREATED 到达（CREATED 分支）或任何销毁路径都会 clearTimeout 本计时器。
      const timer = setTimeout(() => {
        if (this.table.byNext(nextCirc) === circ && circ.extendTimer === timer) this.destroyCircuit(circ, undefined, 'extend-timeout');
      }, this.dos.connectTimeoutMs);
      timer.unref?.();
      circ.extendTimer = timer;
    });
  }

  // BEGIN 数据 = UTF8 "host:port"。按出口策略拨号 TCP，连通后回 CONNECTED(0)、桥接双向字节流。
  private handleBegin(circ: RelayCircuit, data: Uint8Array): void {
    if (this.streams.has(circ)) return; // v1 每电路 1 条流
    const target = new TextDecoder().decode(data);
    const i = target.lastIndexOf(':');
    const host = i > 0 ? target.slice(0, i) : '';
    const port = Number(target.slice(i + 1));
    if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535 || !this.exitPolicy(host, port)) {
      this.sendBackward(circ, CMD_CONNECTED, Uint8Array.of(1)); // 拒绝/非法
      return;
    }
    const sock = connect(port, host);
    sock.on('connect', () => {
      this.streams.set(circ, sock);
      this.sendBackward(circ, CMD_CONNECTED, Uint8Array.of(0));
    });
    sock.on('data', (buf: Buffer) => {
      for (let o = 0; o < buf.length; o += CELL_DATA_LEN)
        this.sendBackward(circ, CMD_DATA, new Uint8Array(buf.subarray(o, o + CELL_DATA_LEN)));
    });
    sock.on('close', () => {
      if (this.streams.has(circ)) this.sendBackward(circ, CMD_END, new Uint8Array(0));
      this.streams.delete(circ);
    });
    sock.on('error', () => {
      if (this.streams.has(circ)) this.sendBackward(circ, CMD_END, new Uint8Array(0));
      else this.sendBackward(circ, CMD_CONNECTED, Uint8Array.of(1)); // 连接失败
      this.streams.delete(circ);
    });
  }

  // ---- HSDir：描述符 DHT 的发布/取回（本跳=终点时处理）----

  // 删除所有已过期描述符（插入前调用，顺带回收内存）。
  private pruneHsdescs(): void {
    const now = Date.now();
    for (const [id, e] of this.hsdescs) if (e.exp <= now) this.hsdescs.delete(id);
  }

  // 把一个面向本跳的 HS 请求 cell 喂进分帧重组器；攒齐整条请求后分派 publish/fetch。
  private handleHsRequest(circ: RelayCircuit, cmd: number, data: Uint8Array): void {
    let cur = this.hsReasm.get(circ);
    // 新请求 / 命令切换 → 起新重组器（一条电路同一时刻只跟一个 HS 请求）。
    if (!cur || cur.cmd !== cmd) {
      cur = { cmd, reasm: new FrameReassembler(MAX_HS_REQ_BYTES) };
      this.hsReasm.set(circ, cur);
    }
    if (!cur.reasm.push(data)) {
      // 帧非法（首块缺长度前缀 / 超上限 / 净荷溢出）→ 丢弃在途态 + END 收尾，不销毁电路（保守）。
      this.hsReasm.delete(circ);
      this.sendBackward(circ, CMD_HS_END, new Uint8Array(0));
      return;
    }
    if (!cur.reasm.complete) return; // 还没收齐，等后续 cell
    const msg = cur.reasm.take();
    this.hsReasm.delete(circ);
    if (!msg) {
      this.sendBackward(circ, CMD_HS_END, new Uint8Array(0));
      return;
    }
    if (cmd === CMD_HS_PUBLISH) this.handleHsPublish(circ, msg);
    else this.handleHsFetch(circ, msg);
  }

  // 发布：msg = descIdHex(64 ascii) ‖ descriptorJSON(utf8)。
  // 三重校验：① 描述符盲签名自洽（verifyDescriptorPublishable，不需 A；也校验 rev 是合法非负整数）；
  //          ② descIdHex === descriptorId(ap,tp)（把存储键钉死到被签名的盲公钥 → 不能越键写入）；
  //          ③ 同周期防回滚：仅当 desc.rev **严格高于**已存条目的 rev 才接受（HSDir 只留每个 descId 见过的最高 rev）。
  // 通过 → 存/替换（带 TTL）+ 回 RESP("OK") 再 END；失败/被回滚拒 → 仅 END（无 OK = 失败）。
  private handleHsPublish(circ: RelayCircuit, msg: Uint8Array): void {
    const fail = () => this.sendBackward(circ, CMD_HS_END, new Uint8Array(0));
    if (msg.length < 64) return fail();
    const descIdHex = new TextDecoder().decode(msg.subarray(0, 64));
    const json = new TextDecoder().decode(msg.subarray(64));
    let desc: Descriptor;
    try {
      desc = JSON.parse(json) as Descriptor;
    } catch {
      return fail();
    }
    if (!verifyDescriptorPublishable(desc)) return fail();
    // descId 必须等于由**被签名的** ap+tp 算出的 id（绑定存储键 ↔ 盲身份）。
    let boundId: string;
    try {
      boundId = descriptorId(hexToBytes(desc.ap), desc.tp);
    } catch {
      return fail();
    }
    if (descIdHex !== boundId) return fail();
    this.pruneHsdescs();
    const existing = this.hsdescs.get(descIdHex);
    // 防回滚：rev 被签名覆盖（伪造必败验签）→ 已存 rev ≥ 新 rev 即拒，旧描述符无法压制/覆盖更新版。
    if (existing && existing.rev >= desc.rev) return fail();
    if (!existing && this.hsdescs.size >= MAX_HSDESCS) return fail(); // 满 + 非更新 → 拒
    this.hsdescs.set(descIdHex, { json, exp: Date.now() + 2 * PERIOD_LEN * 1000, rev: desc.rev });
    this.sendBackward(circ, CMD_HS_RESP, utf8ToBytes('OK'));
    this.sendBackward(circ, CMD_HS_END, new Uint8Array(0));
  }

  // 取回：msg = descIdHex(64 ascii)。命中且未过期 → RESP(JSON 分帧) + END；未命中/过期 → 仅 END。
  private handleHsFetch(circ: RelayCircuit, msg: Uint8Array): void {
    const descIdHex = new TextDecoder().decode(msg.subarray(0, 64));
    const e = this.hsdescs.get(descIdHex);
    if (e && e.exp > Date.now()) {
      for (const cell of encodeFramed(utf8ToBytes(e.json))) this.sendBackward(circ, CMD_HS_RESP, cell);
    } else if (e) {
      this.hsdescs.delete(descIdHex); // 顺手清掉过期条目
    }
    this.sendBackward(circ, CMD_HS_END, new Uint8Array(0));
  }

  // ---- 引入点（IP）：服务挂电路候命；客户端经此投递 INTRODUCE（本节点看不懂信封）----

  // 服务在本节点登记一个引入点。data = authKey(32)。authKey 仅作“在本 IP 寻址该服务”的不透明句柄，
  // 本节点不解读、不验证其与任何身份的关系（服务的认证来自端到端 ntor，IP 无须也无权介入）。
  // 同一电路只能登记一次；authKey 已被别的活电路占用 → 拒（防抢占既有服务的引入槽）。
  private handleEstablishIntro(circ: RelayCircuit, data: Uint8Array): void {
    if (data.length !== 32) return; // 畸形 → 丢（不回应，保守）
    if (this.introByCirc.has(circ) || this.rdvByCirc.has(circ) || this.splice.has(circ)) return; // 该电路已另有角色
    const authKeyHex = bytesToHex(data);
    const existing = this.introTable.get(authKeyHex);
    if (existing && existing !== circ) return; // 句柄被占（不同电路）→ 拒，避免劫持
    this.introTable.set(authKeyHex, circ);
    this.introByCirc.set(circ, authKeyHex);
    this.sendBackward(circ, CMD_INTRO_ESTABLISHED, new Uint8Array(0));
  }

  // 客户端→IP：data = authKey(32) ‖ 引入盲信封(rest)。据 authKey 找到服务的引入电路，把 rest 原样后向转给服务。
  // 本节点对 rest 一无所知（单向 DH 信封，只有服务能解）→ 纯路由。无匹配 → 静默丢（不暴露“该服务是否在线”给探测者）。
  private handleIntroduce1(circ: RelayCircuit, data: Uint8Array): void {
    if (data.length < 32) return;
    const authKeyHex = bytesToHex(data.subarray(0, 32));
    const serviceCirc = this.introTable.get(authKeyHex);
    if (!serviceCirc) return; // 无此引入点 → 丢
    this.sendBackward(serviceCirc, CMD_INTRODUCE2, data.subarray(32));
  }

  // ---- 会合点（RP）：客户端占槽留 cookie；服务报到后本节点拼接两条电路，之后透传不透明 e2e 密文 ----

  // 客户端在本节点登记一个会合槽。data = cookie(20)。cookie 是客户端随机生成的一次性约定，
  // 服务稍后用同一 cookie 报到 → 本节点据此把“客户端会合电路”与“服务会合电路”配对。
  private handleEstablishRendezvous(circ: RelayCircuit, data: Uint8Array): void {
    if (data.length !== RDV_COOKIE_LEN) return;
    if (this.introByCirc.has(circ) || this.rdvByCirc.has(circ) || this.splice.has(circ)) return;
    const cookieHex = bytesToHex(data);
    const existing = this.rdvTable.get(cookieHex);
    if (existing && existing !== circ) return; // cookie 撞槽 → 拒
    this.rdvTable.set(cookieHex, circ);
    this.rdvByCirc.set(circ, cookieHex);
    this.sendBackward(circ, CMD_RENDEZVOUS_ESTABLISHED, new Uint8Array(0));
  }

  // 服务→RP：data = cookie(20) ‖ serverEph(32)‖auth(32)(rest)。据 cookie 找到客户端的会合电路并**拼接**，
  // 然后把 rest（服务的 ntor 应答）后向转给客户端（CMD_RENDEZVOUS2）。拼接后两电路互为对端，CMD_RDV_DATA 双向透传。
  private handleRendezvous1(circ: RelayCircuit, data: Uint8Array): void {
    if (data.length < RDV_COOKIE_LEN) return;
    if (this.introByCirc.has(circ) || this.rdvByCirc.has(circ) || this.splice.has(circ)) return; // 服务的会合电路须“干净”
    const cookieHex = bytesToHex(data.subarray(0, RDV_COOKIE_LEN));
    const clientCirc = this.rdvTable.get(cookieHex);
    if (!clientCirc) return; // 无此会合槽（或已被消费）→ 丢
    if (clientCirc === circ || this.splice.has(clientCirc)) return; // 同一电路自拼 / 客户端槽已被拼 → 拒
    // 消费 cookie：一次性，防第二个 RENDEZVOUS1 重复拼接同一客户端槽（拼接完整性）。
    this.rdvTable.delete(cookieHex);
    this.rdvByCirc.delete(clientCirc);
    // 双向拼接：服务电路 ↔ 客户端电路。
    this.splice.set(circ, clientCirc);
    this.splice.set(clientCirc, circ);
    // 把服务的 ntor 应答交付客户端。
    this.sendBackward(clientCirc, CMD_RENDEZVOUS2, data.subarray(RDV_COOKIE_LEN));
  }

  // 拼接任一端→对端：透传不透明 e2e 密文。本节点解不开（密文用双方 ntor 派生的密钥封死）→ 纯转发。
  private handleRdvData(circ: RelayCircuit, data: Uint8Array): void {
    const peer = this.splice.get(circ);
    if (!peer) return; // 未拼接 → 丢
    this.sendBackward(peer, CMD_RDV_DATA, data);
  }

  private sendBackward(circ: RelayCircuit, cmd: number, data: Uint8Array): void {
    const { n, body } = originateBackward(circ, cmd, data);
    circ.prevConn.send({ t: 'RELAY', c: circ.prevCirc, d: 'b', n, b: bytesToHex(body) });
  }
}
