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
import type { GuardManager } from './guards.js';

// RdvChannel.send 是“单 cell”发送（不自动分片）：cell data ≤ CELL_DATA_LEN(485)，
// rdvSeal 额外占 8(ctr)+16(tag)=24B，故净荷上限 ≈461B。取 400B 留足余量，与 hsclient 注释一致。
const RDV_CHUNK = 400;

/** hsclient/hsservice 所需的一对接线依赖：选路器 + 中继名录。 */
export interface HsDeps {
  buildCircuit: BuildCircuit;
  directory: RelayDirectory;
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
  const buildCircuit: BuildCircuit = async (exitRelayId: string) => {
    const all = dir();
    const exit = all.find((d) => d.address === exitRelayId);
    if (!exit) throw new Error(`目录里没有终点中继 ${exitRelayId}`);
    const others = all.filter((d) => d.address !== exitRelayId);
    if (others.length < 2) throw new Error('链上中继不足 3 个，暂无法建路');

    // 选一个守卫作 hop0：用守卫管理器时只允许从持久钉住集里选（exclude=exit ∪ 本次已试失败的守卫）。
    // 若钉住守卫全在冷却/被排除/不在目录，返回 undefined 并失败；绝不退回目录随机入口。
    const pickGuard = (failed: Set<string>): RelayDescriptor | undefined => {
      if (!guardManager) return shuffle(others.filter((d) => !failed.has(d.address)))[0] ?? shuffle(others)[0];
      const gid = guardManager.currentGuard(all, new Set([exitRelayId, ...failed]));
      return gid ? all.find((d) => d.address === gid) : undefined;
    };

    // hop0（守卫）连接失败 → 标记不可达 + 换钉住的备份守卫重试。最多 sampleSize 次（把钉住集都试一遍）。
    // 无守卫管理器时不重试（保持原“随机一次”语义）。中段/出口选择不变（仍随机）。
    const maxGuardAttempts = guardManager ? guardManager.size : 1;
    const failed = new Set<string>();
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxGuardAttempts; attempt++) {
      const guard = pickGuard(failed);
      if (!guard || failed.has(guard.address)) break; // 选不出钉住的新守卫（全失败/冷却/被排除）→ 停
      const c = new CircuitClient();
      try {
        await c.connect(hopOf(guard)); // hop0：唯一可触发“守卫不可达 → 换备份”的步骤
      } catch (e) {
        lastErr = e;
        guardManager?.markUnreachable(guard.address); // 冷却该守卫，下次 currentGuard 跳过它
        failed.add(guard.address);
        c.close();
        continue; // 换守卫重试
      }
      // hop0 已通：middle = 除 guard、exit 外随机一个独立中继；再 EXTEND 到 middle、exit。
      const middlePool = all.filter((d) => d.address !== guard.address && d.address !== exitRelayId);
      if (middlePool.length < 1) {
        c.close();
        throw new Error('链上中继不足 3 个，暂无法建路');
      }
      const middle = middlePool[Math.floor(Math.random() * middlePool.length)];
      await c.extend(hopOf(middle));
      await c.extend(hopOf(exit));
      return c;
    }
    throw lastErr ?? new Error('守卫均不可达，建路失败');
  };
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

// 整个会合连接（取描述符 → 占 RP 槽 → INTRODUCE → 等 RENDEZVOUS2）的总超时。
// connectHiddenService 内部不设超时（依赖调用方兜），守护场景必须封顶：否则一个“描述符在、但握手永不完成”的
// 半死服务会让 SOCKS 连接无限挂起（既不回成功也不回失败）。30s 给多跳多电路握手留足，又保证 curl 终会收到拒绝。
const HS_CONNECT_TIMEOUT_MS = 30000;

/**
 * 经 SOCKS5 的 .v0id 分支调用：连一个隐藏服务并返回端到端通道（与 connectHiddenService 同语义，封顶总超时）。
 * 超时即抛错（上层回 SOCKS 失败）——杜绝半死服务把 SOCKS 连接吊死。
 */
export function connectHs(addr: string, deps: HsDeps): Promise<RdvChannel> {
  const connect = connectHiddenService(addr, deps.buildCircuit, deps.directory);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('隐藏服务连接超时')), HS_CONNECT_TIMEOUT_MS);
  });
  return Promise.race([connect, timeout]).finally(() => clearTimeout(timer));
}

export interface ServeHiddenServiceOptions {
  dataDir: string; // hs 身份种子持久化目录（<dataDir>/hs.json）
  target: { host: string; port: number }; // 隐藏服务背后的本机 TCP 落地（每个会合通道连一次它）
  deps: HsDeps; // 选路器 + 名录
  numIntros?: number; // 引入点数量（默认 3）
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
): Promise<{ address: string; stop: () => void }> {
  const { seed, onion } = loadOrCreateHsIdentity(opts.dataDir);
  const handler: RendezvousHandler = (channel) => {
    // 每个成功会合 → 连一次本机落地；连不上就关通道（服务进程没在监听 target）。
    const sock = connect(opts.target.port, opts.target.host);
    sock.on('connect', () => bridgeChannelToSocket(channel, sock));
    sock.on('error', (e) => {
      opts.onError?.(e);
      channel.close();
      sock.destroy();
    });
  };
  const svc = new HiddenService({
    seed,
    onion,
    build: opts.deps.buildCircuit,
    dir: opts.deps.directory,
    handler,
    numIntros: opts.numIntros,
  });
  await svc.start();
  return { address: svc.address, stop: () => svc.stop() };
}

/** 从 <dataDir>/hs.json 读回 hs 身份（种子 + 服务 onion 私钥）；不存在则生成并落盘（0600）。 */
function loadOrCreateHsIdentity(dataDir: string): { seed: Uint8Array; onion: OnionKeypair } {
  const file = join(dataDir, 'hs.json');
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
