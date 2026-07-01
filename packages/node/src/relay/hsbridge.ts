// 隐藏服务守护桥接（Phase 2B-d）：把已建好的 rendezvous 层（hsclient/hsservice）接进运行中的节点与 SOCKS5 前端，
// 让“普通 curl --socks5-hostname … <地址>.v0id” 这种用法真正打到一个本机托管的隐藏服务上。
//
// 本文件只做三件“接线”事，不碰任何协议/密码学：
//   1. makeHsDeps(dir)：把链上中继目录快照（RelayDescriptor[]，自带 host/port/onionPubHex）适配成 hsclient/hsservice
//      想要的 { buildCircuit(exitRelayId), directory }——选 2 个随机不重复中继做 guard/middle，再 EXTEND 到指定终点跳。
//   2. bridgeChannelToSocket(channel, sock)：把一个端到端 RdvChannel 与一条 TCP socket 双向桥接（分片、双向 close）。
//      SOCKS5 的 .v0id 分支与服务侧的 TCP 落地都复用它。
//   3. serveHiddenService(opts)：包一层 HiddenService，每个进来的 rendezvous 通道 → 连本机 target host:port → 互通字节。
//      hs 身份种子持久化到 <dataDir>/hs.json（0600，与 onion.json 同纪律），返回 .v0id 地址与 stop()。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  bytesToHex,
  hexToBytes,
  onionKeypairFromSecret,
  type OnionKeypair,
  type RelayDescriptor,
} from '@v0idchain/core';
import { CircuitClient, type HopSpec } from './client.js';
import { connectHiddenService, RdvChannel, type BuildCircuit, type RelayDirectory } from './hsclient.js';
import { HiddenService, type RendezvousHandler } from './hsservice.js';
import { runPaywallServer, type VoucherAcceptor } from './paywall.js';
import { RelayReachability } from './reachability.js';
import type { GuardManager } from './guards.js';

// RdvChannel.send 是“单 cell”发送（不自动分片）：cell data ≤ CELL_DATA_LEN(485)，
// rdvSeal 额外占 8(ctr)+16(tag)=24B，故净荷上限 ≈461B。取 400B 留足余量，与 hsclient 注释一致。
const RDV_CHUNK = 400;

// 选路鲁棒性（应对链上目录里**无法注销的死中继**污染）：
// MIDDLE_TRIES = 单个守卫下最多试几个不同 middle 后才换守卫（活中继集内必有可行路径，几次内即命中）。
// HOP_TIMEOUT_MS = 单跳 connect/EXTEND 的客户端封顶超时：死/被防火墙挡/hairpin 的中继会让该跳黑洞挂死，
//   超时即放弃换路（取值须 > 正常一跳 RTT 的数倍、又 < 守卫侧 10s extend-timeout，让客户端先放弃、快速换路）。
const MIDDLE_TRIES = 4;
const HOP_TIMEOUT_MS = 6000;

/** hsclient/hsservice 所需的一对接线依赖：选路器 + 中继名录。 */
export interface HsDeps {
  buildCircuit: BuildCircuit;
  directory: RelayDirectory;
}

/**
 * 私有/回环 IP 的中继（如浏览器守护进程注册的 127.0.0.1）本机 WS 探测通过，但外部 AWS 中继无法拨通对方的
 * localhost，进入 pool 会虚增 usableCount → markBad 误判良好中继。仅限电路构建过滤；directory() 仍返回全量。
 * 导出供 rolemanager.ts 的 SOCKS pickHops 复用同一份过滤逻辑（两处选路必须同款口径，避免各判各的漂移）。
 */
export function isRoutableHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  const p = host.split('.');
  if (p.length !== 4) return true; // IPv6 or hostname → keep
  const [a, b] = p.map(Number);
  return !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}

/**
 * 由“链上中继目录快照”造出 hsclient/hsservice 想要的 { buildCircuit, directory }。
 * @param dir 取当前中继描述符列表（每次调用都重新快照，自然跟随链增长；通常传 node.relays）。
 * @param guardManager 可选入口守卫管理器：传入则 hop0 用持久守卫（所有电路复用同一守卫，抗统计去匿名，见 guards.ts）；
 *                     不传则保持原行为（每条电路随机挑守卫）——既有 test/调用点不传 → 行为不变。
 * buildCircuit(exit)：选 guard（守卫管理器 or 随机）作 hop0 + 一个**≠guard、≠exit**的随机 middle，连守卫 + 两次 EXTEND 到 exit。
 * 选不出独立 guard/middle（目录 < 3）时抛错——与 CLI pickHops “链上中继不足”同语义，调用方决定如何提示。
 */
export function makeHsDeps(dir: () => RelayDescriptor[], guardManager?: GuardManager): HsDeps {
  const hopOf = (d: RelayDescriptor): HopSpec => ({
    id: d.address,
    onionPub: hexToBytes(d.onionPubHex),
    host: d.host,
    port: d.port,
  });
  // 可达性探测缓存：把链上目录里“host 公网但端口实际连不通”的死中继也识别并缓存，选路只从已知可达集挑（暖缓存秒级建路）。
  const reachability = new RelayReachability();
  // 后台周期预热：节点一起来就持续探测可达性，等用户托管/浏览时缓存已暖 → 选路直接命中可达集，
  // 免去冷启动“边建路边现探死中继”的数十秒。链未同步时 dir() 可能空/少，周期重探会随中继上链自然补全。
  const warm = () => reachability.refresh(dir()).catch(() => undefined);
  void warm();
  setInterval(warm, 60_000).unref?.();
  const buildCircuit: BuildCircuit = async (exitRelayId: string) => {
    // 链上目录会**永久**累积历史中继注册（latest-wins，无法注销）：含本机自测发布的 127.0.0.1、早下线 / 被防火墙挡的
    // 公网中继等纯污染。随机选路一旦撞上死中继，EXTEND 即被守卫秒拆(DESTROY)或拨号黑洞挂死 → 浏览失败。两道防线：
    // ① 主动探测 + 实测转发判负，缓存出”真能转发”的可达集（reachability：WS 探测剔连不通的，建路失败回灌剔转不动的）；
    // ② 可达集内仍可能有 hairpin/瞬断 → 逐个试 middle、坏的靠 HOP_TIMEOUT 快速放弃换下一个，直到拼出活电路。
    const pool = dir().filter((d) => isRoutableHost(d.host));
    await reachability.refresh(pool); // 探测可达性（暖缓存即时返回，冷缓存一次并行探测 ~5s）
    const all = reachability.knownUsable(pool);
    const exit = all.find((d) => d.address === exitRelayId);
    if (!exit) throw new Error(`终点中继 ${exitRelayId} 不可达或不在目录`);
    if (all.length < 3) throw new Error('链上可达中继不足 3 个，暂无法建路');

    // 选一个守卫作 hop0：用守卫管理器时只允许从持久钉住集里选（exclude=exit ∪ 本次已试失败的守卫）。
    // 若钉住守卫全在冷却/被排除/不在目录，返回 undefined 并失败；绝不退回目录随机入口。
    const pickGuard = (failed: Set<string>): RelayDescriptor | undefined => {
      if (!guardManager) return shuffle(all.filter((d) => d.address !== exitRelayId && !failed.has(d.address)))[0];
      const gid = guardManager.currentGuard(all, new Set([exitRelayId, ...failed]));
      return gid ? all.find((d) => d.address === gid) : undefined;
    };

    const maxGuardAttempts = guardManager ? guardManager.size : all.length;
    const failed = new Set<string>();
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxGuardAttempts; attempt++) {
      const guard = pickGuard(failed);
      if (!guard || failed.has(guard.address)) break; // 选不出新守卫（全失败/冷却/被排除）→ 停
      // 中段候选：除 guard、exit 外的可达中继，洗牌后逐个试。死/防火墙/hairpin 中继靠 HOP_TIMEOUT 快速放弃换下一个。
      const middles = shuffle(all.filter((d) => d.address !== guard.address && d.address !== exitRelayId));
      let guardDead = false;
      let exitFails = 0; // 「已证骨干」middle 仍到不了 exit 的次数 → 多次即判 exit 端点本身死（防火墙/下线），换守卫无益
      for (const middle of middles.slice(0, MIDDLE_TRIES)) {
        const c = new CircuitClient();
        try {
          await raceTimeout(c.connect(hopOf(guard)), HOP_TIMEOUT_MS, 'guard 连接超时'); // hop0：唯一能判定“守卫不可达”的步骤
        } catch (e) {
          lastErr = e;
          guardManager?.markUnreachable(guard.address); // 冷却该守卫，下次 currentGuard 跳过它
          failed.add(guard.address);
          c.close();
          guardDead = true;
          break; // 守卫连不上 → 换守卫（不再试别的 middle）
        }
        try {
          await raceTimeout(c.extend(hopOf(middle)), HOP_TIMEOUT_MS, 'middle EXTEND 超时');
        } catch (e) {
          if (reachability.usableCount(pool) > 3) reachability.markBad(middle.address); // 守卫连不到此 middle → 判负避开（实时计数保证留≥3）
          lastErr = e;
          c.close();
          continue;
        }
        try {
          await raceTimeout(c.extend(hopOf(exit)), HOP_TIMEOUT_MS, 'exit EXTEND 超时');
          reachability.markProvenForwarder(middle.address); // 这个 middle 实测能转发 → 列为骨干，永久免疫误判负
          return c; // ✅ 三跳建成
        } catch (e) {
          // middle 连得上但到不了 exit。**消歧**（关键修复）：若 middle 是**已证骨干**(能转发) → 问题在 exit 端点(死/被防火墙挡)，
          // 计 exitFails 但**绝不**误判负这个好 middle；否则 middle 自身可疑(连得上但转不动 hairpin/旧版) → 判负它。
          if (reachability.isProven(middle.address)) exitFails++;
          else if (reachability.usableCount(pool) > 3) reachability.markBad(middle.address);
          lastErr = e;
          c.close();
        }
      }
      // ≥2 个已证骨干 middle 都到不了这个 exit → 基本是 exit 端点死了 → 判负 exit（让上层快速换 HSDir/intro/RP），换守卫无益。
      if (exitFails >= 2) {
        if (reachability.usableCount(pool) > 3) reachability.markBad(exit.address);
        break;
      }
      if (!guardDead) failed.add(guard.address); // 这个守卫把 middle 都试遍仍不成 → 换守卫
    }
    throw lastErr ?? new Error('可达中继间均未能建成电路');
  };
  // 名录（供 HS 客户端挑 HSDir/intro/rdv 终点）：**必须返回链的稳定函数**——直接给整个链上目录，**绝不**按可达性过滤。
  // 关键：HSDir 的选择 responsibleHsDirs(descId, relays, 3) 是一致性哈希环，发布方(服务)与取回方(客户端)必须算出**同一组** HSDir，
  // 才能在同几台上发布/取回到描述符。可达性是**每节点/每时刻各异**的动态量，若用它过滤 directory()，两端算出的 HSDir 集就会错位
  // → 客户端去服务从没发布过的 HSDir 取 → 永远取不到描述符。死 HSDir 由 buildCircuit 的“exit 不可达即快速失败”+ 发布/取回循环
  // 的逐个跳过容错兜底（两端对同一组 HSDir 各自跳过其不可达者、在可达交集上汇合）。
  const directory: RelayDirectory = () => dir().map((d) => d.address);
  return { buildCircuit, directory };
}

/**
 * 把一个端到端 RdvChannel 与一条 TCP socket 双向桥接：socket→channel（按 RDV_CHUNK 分片）、channel→socket（原样写）。
 * 任一端关闭/出错 → 关另一端（幂等）。SOCKS5 的 .v0id 出站与服务侧 TCP 落地共用本函数。
 * @param leftover SOCKS 握手后已读出的隧道流开头字节（先于后续 socket 'data' 灌入通道）；服务侧无残留传 undefined。
 */
export function bridgeChannelToSocket(channel: RdvChannel, sock: Socket, leftover?: Uint8Array): void {
  let closed = false;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    channel.close();
    sock.destroy();
  };
  // socket→channel：RdvChannel.send 不分片，>461B 的 TCP 读必须切片成多个 cell（保序由底层前向单调 n 保证）。
  const feed = (d: Uint8Array) => {
    for (let o = 0; o < d.length; o += RDV_CHUNK) channel.send(d.subarray(o, o + RDV_CHUNK));
  };
  channel.onData((b) => {
    sock.write(Buffer.from(b));
  });
  channel.onClose(closeBoth);
  sock.on('data', (d: Buffer) => feed(new Uint8Array(d)));
  sock.on('close', closeBoth);
  sock.on('error', closeBoth);
  if (leftover && leftover.length) feed(leftover); // 残留必须在监听挂好后再灌，保证字节序
}

// 单次 connectHiddenService 尝试的封顶超时（短 → 失败快、好重试；其内部 fetch/rdv 各自更短）。
// 守护场景必须封顶：否则一个“描述符在、但握手永不完成”的半死服务会让 SOCKS 连接无限挂起。
const HS_ATTEMPT_TIMEOUT_MS = 18000;
// 整体尝试次数。CF 隧道下「取描述符 → 占 RP → INTRODUCE → 等 RENDEZVOUS2」这串多步、多电路操作单次成功率不高
// （每步本身大多能成，但串起来累积失败率高）；换一组新电路重来几次能把总成功率拉得很高。
const HS_CONNECT_ATTEMPTS = 4;

/**
 * 经 SOCKS5 的 .v0id 分支调用：连一个隐藏服务并返回端到端通道（与 connectHiddenService 同语义）。
 * 单次尝试封顶 HS_ATTEMPT_TIMEOUT_MS（杜绝半死服务吊死 SOCKS 连接），失败则换新电路重试至多 HS_CONNECT_ATTEMPTS 次
 * （多步会合经 CF 隧道偶发抖动 → 重来一次大概率即通）。全部失败才抛错（上层回 SOCKS 失败）。
 */
export async function connectHs(addr: string, deps: HsDeps): Promise<{ channel: RdvChannel; price?: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < HS_CONNECT_ATTEMPTS; attempt++) {
    try {
      return await withAttemptTimeout(
        connectHiddenService(addr, deps.buildCircuit, deps.directory),
        HS_ATTEMPT_TIMEOUT_MS,
      );
    } catch (e) {
      lastErr = e; // 本次（新电路）失败 → 重试
    }
  }
  throw lastErr ?? new Error('隐藏服务连接失败');
}

/**
 * 给一个 Promise 套封顶超时：到点抛 msg。**关键**：给原 promise 挂一个吞错的 .catch，
 * 这样 race 已超时落定后、那条慢 promise 稍后才 reject 时不会变成 unhandledRejection（建路时换路会留下被放弃的 connect/extend）。
 */
function raceTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  promise.catch(() => {}); // 吞掉“已放弃的慢 promise”的迟到 reject
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function withAttemptTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('隐藏服务连接尝试超时')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface ServeHiddenServiceOptions {
  dataDir: string; // hs 身份种子持久化目录
  identityKey?: string; // 身份文件名后缀：undefined=hs.json，其它=hs-{identityKey}.json（多服务各用独立身份）
  target: { host: string; port: number }; // 隐藏服务背后的本机 TCP 落地（每个会合通道连一次它）
  deps: HsDeps; // 选路器 + 名录
  numIntros?: number; // 引入点数量（默认 3）
  price?: number; // 可选：付费墙价格（$V0ID/连接）。设了则每条通道桥接到 target 前先跑付费墙握手（需 acceptor）
  acceptor?: VoucherAcceptor; // 券受理器（验签+防双花）；price 设了必须提供。operator==mint 时其 spentSerials 应与铸币厂兑现共享
  onError?: (err: unknown) => void; // 单个落地连接出错的可观察回调（默认吞掉）
}

/**
 * 托管一个隐藏服务：包一层 HiddenService，每条进来的 rendezvous 通道 → 连本机 target host:port → 双向桥接字节。
 * 这正是服务侧版本的“出口流桥接”（只是落地到本机回环而非任意目标）。返回 .v0id 地址（打印给用户）+ stop()。
 *
 * 身份持久化：hs 种子（→ 地址）与服务静态 onion 私钥都落 <dataDir>/hs.json(0600)，重启地址不变（与 onion.json 同纪律）。
 */
export async function serveHiddenService(
  opts: ServeHiddenServiceOptions,
): Promise<{ address: string; stop: () => void; getConnCount: () => number; getPaidCount: () => number }> {
  const identityFile = opts.identityKey ? `hs-${opts.identityKey}.json` : 'hs.json';
  const { seed, onion } = loadOrCreateHsIdentity(opts.dataDir, identityFile);
  let connCount = 0;
  let paidCount = 0;
  // 每个成功会合 → 连一次本机落地；连不上就关通道（服务进程没在监听 target）。
  const bridgeToTarget = (channel: RdvChannel, leftover?: Uint8Array) => {
    const sock = connect(opts.target.port, opts.target.host);
    sock.on('connect', () => {
      if (leftover && leftover.length) sock.write(Buffer.from(leftover)); // 付费握手后残留(A.1 正常空)→先写目标保字节序
      bridgeChannelToSocket(channel, sock);
    });
    sock.on('error', (e) => {
      opts.onError?.(e);
      channel.close();
      sock.destroy();
    });
  };
  const handler: RendezvousHandler = (channel) => {
    connCount++;
    if (opts.price && opts.price > 0 && opts.acceptor) {
      // 付费站点：桥接前先在隧道内跑付费墙握手（验券，放行全程链下、不等出块）。未付费 → 关通道，不连 target。
      runPaywallServer(channel, opts.price, opts.acceptor)
        .then((res) => {
          if (!res.paid) return void channel.close();
          paidCount++;
          bridgeToTarget(channel, res.leftover);
        })
        .catch(() => channel.close());
    } else {
      bridgeToTarget(channel);
    }
  };
  const svc = new HiddenService({
    seed,
    onion,
    build: opts.deps.buildCircuit,
    dir: opts.deps.directory,
    handler,
    numIntros: opts.numIntros,
    price: opts.price,
  });
  await svc.start();
  return { address: svc.address, stop: () => svc.stop(), getConnCount: () => connCount, getPaidCount: () => paidCount };
}

/** 从 <dataDir>/<filename> 读回 hs 身份（种子 + 服务 onion 私钥）；不存在则生成并落盘（0600）。 */
function loadOrCreateHsIdentity(dataDir: string, filename = 'hs.json'): { seed: Uint8Array; onion: OnionKeypair } {
  const file = join(dataDir, filename);
  if (existsSync(file)) {
    const { seed, onionSecret } = JSON.parse(readFileSync(file, 'utf8')) as { seed: string; onionSecret: string };
    return { seed: hexToBytes(seed), onion: onionKeypairFromSecret(hexToBytes(onionSecret)) };
  }
  mkdirSync(dataDir, { recursive: true });
  const seed = randomBytes(32); // hs 身份种子（→ ed25519 身份 / .v0id 地址）
  const onion = onionKeypairFromSecret(randomBytes(32)); // 服务静态 onion 私钥（rendezvous ntor 的 B）
  writeFileSync(file, JSON.stringify({ seed: bytesToHex(seed), onionSecret: bytesToHex(onion.secret) }), { mode: 0o600 });
  chmodSync(file, 0o600); // 兜底收紧权限（umask 影响时）
  return { seed, onion };
}

// Fisher-Yates 洗牌（不改原数组）。
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
