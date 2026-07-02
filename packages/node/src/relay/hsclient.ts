// 隐藏服务客户端（Phase 2B-c）：只知 .v0id 地址 → 取描述符 → 经会合点(RP)与服务建端到端匿名通道。
// 客户端全程匿名（不签名、不暴露身份/IP）；服务也不暴露 IP（双方只各自看到 RP，互不知对方网络位置）。
//
// 流程（详见 docs/HS-PROTOCOL.md）：
//   1. 取回并解析描述符 → 引入点列表 + 服务静态 onion 公钥 B。
//   2. 建一条到 RP 的 3 跳电路、留一个随机 cookie(20)，await RENDEZVOUS_ESTABLISHED；电路常开。
//   3. ntorClientStart(A=服务身份公钥, B) → 客户端 ntor 临时公钥 X；把 {rpRelayId,cookie,X} 用 B 密封成
//      INTRODUCE 信封；建一条到引入点的 3 跳电路、发 INTRODUCE1(authKey‖信封)。
//   4. 在 RP 电路上 await RENDEZVOUS2(serverEph‖auth)；ntorClientFinish → 端到端密钥 keys。返回 RdvChannel。
import {
  ntorClientStart,
  ntorClientFinish,
  type CircuitKeys,
  hexToBytes,
  bytesToHex,
  decodeV0idAddress,
  timePeriod,
  blindPublic,
  descriptorId,
  parseDescriptor,
  responsibleHsDirs,
  HSDIR_REPLICAS,
  type Descriptor,
  type IntroPoint,
  introduceSeal,
  encodeIntroducePayload,
  rdvSeal,
  rdvOpen,
  CMD_INTRODUCE1,
  CMD_ESTABLISH_RENDEZVOUS,
  CMD_RENDEZVOUS_ESTABLISHED,
  CMD_RENDEZVOUS2,
  CMD_RDV_DATA,
  RDV_COOKIE_LEN,
  MAX_CELL_CTR,
} from '@v0idchain/core';
import { randomBytes } from 'node:crypto';
import { CircuitClient } from './client.js';
import { type AntiReplayState, newAntiReplay, accept } from './antireplay.js';

const HS_FETCH_TIMEOUT_MS = 6_000; // 单个 HSDir 取描述符超时（短 → 失败快切下一个/重试；CF 抖动容错靠多 HSDir + 整轮重试）
const RDV_TIMEOUT_MS = 12_000; // 单次会合 await RENDEZVOUS2 超时（短 → 失败快，由 connectHs 的顶层重试再来一次）
const FETCH_ROUNDS = 1; // 单次尝试内扫一遍 HSDir 即可；整体取不到由 connectHs 顶层重试覆盖（换新电路重扫）

/** 选路：给定“终点跳”的中继地址，建一条以它为终点的 3 跳电路（guard/middle 由实现挑）。 */
export type BuildCircuit = (exitRelayId: string) => Promise<CircuitClient>;
/** 中继目录：返回当前可用中继地址列表（用于选 RP / 定位 HSDir）。 */
export type RelayDirectory = () => string[];

/**
 * 端到端会合通道：握手后双方各持一套 CircuitKeys，应用字节 AEAD 封死后经 RP 透传（RP 解不开）。
 * 方向由构造时的 (sendKey, recvKey) 决定——客户端 send=encForward/recv=encBackward；服务镜像。
 * 各方向独立单调计数器（绝不重用 nonce）。收端用滑动窗口防重放去重：拦真重放/太老 ctr，接受窗口内乱序 ctr
 * （底层 cell 通道在 Mixnet 下会被逐跳延迟重排 → 必须用窗口而非严格单调，否则被重排到后面的合法 e2e cell 会被误丢）。
 */
export class RdvChannel {
  private sendCtr = 0;
  private recvReplay: AntiReplayState = newAntiReplay();
  private dataCb: ((b: Uint8Array) => void) | null = null;
  private queue: Uint8Array[] = [];
  private closeCb: (() => void) | null = null;
  private closed = false;

  constructor(
    private circ: CircuitClient,
    private sendKey: Uint8Array, // 本端发送方向流加密密钥
    private recvKey: Uint8Array, // 本端接收方向流加密密钥
  ) {
    circ.onRdv(CMD_RDV_DATA, (data) => this.onCell(data));
    circ.onRdvDestroy(() => {
      this.closed = true;
      this.closeCb?.();
    });
  }

  private onCell(data: Uint8Array): void {
    const opened = rdvOpen(this.recvKey, data);
    if (!opened) return; // RP 篡改 / 错密钥 → 丢
    if (!accept(this.recvReplay, opened.ctr)) return; // 仅 AEAD 合法后推进窗口：重放/太老 → 丢；窗口内乱序 → 接受
    if (this.dataCb) this.dataCb(opened.bytes);
    else this.queue.push(opened.bytes);
  }

  /** 端到端发送一段字节（单 cell；大消息请调用方分片，每片 ≤ ~440B 留封装余量）。 */
  send(bytes: Uint8Array): void {
    if (this.closed || this.sendCtr >= MAX_CELL_CTR) return;
    const cell = rdvSeal(this.sendKey, this.sendCtr++, bytes);
    this.circ.sendToTerminus(CMD_RDV_DATA, cell);
  }
  /** 注册端到端接收回调（晚注册不丢——队列补发）。 */
  onData(cb: (b: Uint8Array) => void): void {
    this.dataCb = cb;
    for (const b of this.queue.splice(0)) cb(b);
  }
  /** 摘除数据回调 → 后续 cell 重新入队（缓冲）。付费墙握手读完控制帧后调用，把信道无损交还给随后的字节桥接。 */
  detachData(): void {
    this.dataCb = null;
  }
  /** 通道关闭（底层电路被销毁）通知。 */
  onClose(cb: () => void): void {
    this.closeCb = cb;
    if (this.closed) cb();
  }
  /** 主动关闭（销毁底层 RP 电路）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.circ.close();
    this.closeCb?.();
  }
}

/**
 * 连接一个隐藏服务。成功 → 返回端到端 RdvChannel；任一步失败（描述符取不到/解不开、握手认证失败）→ 抛错。
 * @param addr 目标 .v0id 地址（客户端唯一需要知道的东西）。
 * @param build 选路器：以给定中继为终点建 3 跳电路。
 * @param dir 中继目录。
 * @param now 时间源（默认 Date.now/1000，单测可注入固定 TP）。
 */
export async function connectHiddenService(
  addr: string,
  build: BuildCircuit,
  dir: RelayDirectory,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<{ channel: RdvChannel; price?: number }> {
  const A = decodeV0idAddress(addr);
  if (!A) throw new Error('非法 .v0id 地址');
  const TP = timePeriod(now());
  const descId = descriptorId(blindPublic(A, TP), TP);
  const relays = dir();

  // 1. 从某个负责的 HSDir 取回并解析描述符。
  const hsdirs = responsibleHsDirs(descId, relays, HSDIR_REPLICAS);
  let desc: Descriptor | null = null;
  let inner: ReturnType<typeof parseDescriptor> | null = null;
  // CF 隧道下建路/取回会偶发抖动：每个 HSDir 单独 try（建路失败即跳下一个，不再让一条死路把整次取描述符带崩），
  // 且整轮重试 FETCH_ROUNDS 次（描述符确已发布，偶发取不到时多扫一轮即得）。
  for (let round = 0; round < FETCH_ROUNDS && !desc; round++) {
    for (const hsdirId of hsdirs) {
      if (desc) break;
      let c: CircuitClient;
      try {
        c = await build(hsdirId);
      } catch {
        continue; // 建路到此 HSDir 失败（CF 抖动）→ 试下一个
      }
      let json: string | null = null;
      try {
        json = await withTimeout(c.hsFetch(descId), HS_FETCH_TIMEOUT_MS, null);
      } catch {
        json = null;
      } finally {
        c.close();
      }
      if (!json) continue;
      try {
        const candidate = JSON.parse(json) as Descriptor;
        if (candidate.tp !== TP || descriptorId(hexToBytes(candidate.ap), candidate.tp) !== descId) continue;
        const parsed = parseDescriptor(addr, candidate);
        if (!parsed || parsed.introPoints.length === 0) continue;
        desc = candidate;
        inner = parsed;
      } catch {
        continue;
      }
    }
  }
  if (!desc || !inner) throw new Error('取不到描述符（服务未发布 / 地址错误）');
  const serviceOnionPub = hexToBytes(inner.serviceOnionPubHex);

  // 2. 选一个**能建通**的 RP（会合点）并占会合槽：优先非引入点中继（路径多样性），逐个试直到 build 成功。
  //    小中继集 + 链上目录污染下，非引入点中继可能全是死的 → 回退到“引入点中继亦可当 RP”（不同电路、不同角色，功能无碍）。
  //    死中继的 build 在客户端可达性缓存暖后会**秒失败**，故逐个试代价很小。
  const cookie = randomBytes(RDV_COOKIE_LEN);
  let rpCirc: CircuitClient | null = null;
  let rpRelayId = '';
  const rpCandidates = rpOrder(relays, inner.introPoints);
  for (const cand of rpCandidates) {
    try {
      rpCirc = await build(cand);
      rpRelayId = cand;
      break;
    } catch {
      // dead relay → try next
    }
  }
  if (!rpCirc) throw new Error('无可用会合点（RP 均不可达）');
  const introCircs: CircuitClient[] = [];
  try {
    rpCirc.enterRdvMode();
    // 先挂好 RENDEZVOUS2 等待器（服务可能在我们发完 INTRODUCE1 后很快回来）。
    const rdv2Promise = new Promise<Uint8Array>((res) => rpCirc.onRdv(CMD_RENDEZVOUS2, (d) => res(d)));
    await rpCirc.sendAwaitRdv(CMD_ESTABLISH_RENDEZVOUS, cookie, CMD_RENDEZVOUS_ESTABLISHED);

    // 3. ntor 起手 + 密封 INTRODUCE 信封（仅一次）；向**所有**引入点各发一份 INTRODUCE1。
    //    同一 ntorEph → 服务侧按 clientNtorEph 去重，只处理一次（不会多建 RP 电路）；只要任一条引入路径活着即可把
    //    INTRODUCE 投达服务 → 容某条引入电路经 CF 掉线。旧版只用 introPoints[0]，那条死了就整体超时失败。
    const ntor = ntorClientStart();
    const rpPubHex = rpRelayId.startsWith('0x') ? rpRelayId.slice(2) : rpRelayId;
    const introPlaintext = encodeIntroducePayload(rpPubHex, cookie, ntor.ephPublic);
    const sealed = introduceSeal(serviceOnionPub, introPlaintext);
    for (const ip of inner.introPoints) {
      let ic: CircuitClient;
      try {
        ic = await build(ip.relayId);
      } catch {
        continue; // 此引入点不可达（CF 抖动）→ 试下一个
      }
      const authKey = hexToBytes(ip.authKeyHex);
      // INTRODUCE1 data = authKey(32) ‖ ephPub(32) ‖ ct。引入点据 authKey 寻址服务、原样转 rest（看不懂信封）。
      const intro1 = new Uint8Array(authKey.length + sealed.ephPub.length + sealed.ct.length);
      intro1.set(authKey, 0);
      intro1.set(sealed.ephPub, authKey.length);
      intro1.set(sealed.ct, authKey.length + sealed.ephPub.length);
      ic.enterRdvMode();
      ic.sendToTerminus(CMD_INTRODUCE1, intro1);
      introCircs.push(ic);
    }
    if (introCircs.length === 0) throw new Error('无可用引入点（均不可达）');

    // 4. await RENDEZVOUS2(serverEph‖auth)，完成 ntor → 端到端密钥。引入电路用完即弃。
    const r2 = await withTimeout(rdv2Promise, RDV_TIMEOUT_MS);
    for (const ic of introCircs) ic.close(); // 引入只需投递一次，之后不再需要引入电路
    if (r2.length < 64) throw new Error('RENDEZVOUS2 应答过短');
    const serverEph = r2.subarray(0, 32);
    const auth = r2.subarray(32, 64);
    const keys = ntorClientFinish(ntor, A, serviceOnionPub, serverEph, auth);
    if (!keys) {
      rpCirc.close();
      throw new Error('会合 ntor 认证失败（服务身份未通过）');
    }
    // 客户端：发用 encForward，收用 encBackward（与中继侧 forward=客户端→服务 一致）。
    // price 来自已验签的描述符内层（缺省=免费站点）→ 上层据此决定是否先跑付费墙握手。
    return { channel: new RdvChannel(rpCirc, keys.encForward, keys.encBackward), price: inner.price };
  } catch (err) {
    for (const ic of introCircs) ic.close();
    rpCirc.close();
    throw err;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutValue: T): Promise<T>;
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutValue?: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const hasTimeoutValue = arguments.length >= 3;
  const timeout = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (hasTimeoutValue) resolve(timeoutValue as T);
      else reject(new Error('隐藏服务请求超时'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 选 RP：从目录里挑一个**不是**任何引入点、也不是已知 HSDir 角色冲突的中继（简化：避开引入点 relayId）。
// 选不到独立中继时退而求其次取第一个（小网测试容忍）。
// RP 候选**顺序**：优先非引入点中继（路径多样性 / RP≠intro），其后引入点中继兜底（小中继集下非引入点可能全是死中继）。
// 各组内洗牌打散；调用方逐个 build 直到通。绝不只返回一个——单点选中死中继就会让整次会合失败。
function rpOrder(relays: string[], introPoints: IntroPoint[]): string[] {
  const introIds = new Set(introPoints.map((ip) => ip.relayId));
  const nonIntro: string[] = [];
  const intro: string[] = [];
  for (const id of relays) (introIds.has(id) ? intro : nonIntro).push(id);
  return [...shuffleIds(nonIntro), ...shuffleIds(intro)];
}

function shuffleIds(arr: string[]): string[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type { CircuitKeys };
