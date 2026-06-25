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
  /** 通道关闭（底层电路被销毁）通知。 */
  onClose(cb: () => void): void {
    this.closeCb = cb;
    if (this.closed) cb();
  }
  /** 主动关闭（销毁底层 RP 电路）。 */
  close(): void {
    this.closed = true;
    this.circ.close();
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
): Promise<RdvChannel> {
  const A = decodeV0idAddress(addr);
  if (!A) throw new Error('非法 .v0id 地址');
  const TP = timePeriod(now());
  const descId = descriptorId(blindPublic(A, TP), TP);
  const relays = dir();

  // 1. 从某个负责的 HSDir 取回并解析描述符。
  const hsdirs = responsibleHsDirs(descId, relays, 3);
  let desc: Descriptor | null = null;
  for (const hsdirId of hsdirs) {
    const c = await build(hsdirId);
    let json: string | null = null;
    try {
      json = await c.hsFetch(descId);
    } finally {
      c.close();
    }
    if (json) {
      try {
        desc = JSON.parse(json) as Descriptor;
      } catch {
        desc = null;
      }
      if (desc) break;
    }
  }
  if (!desc) throw new Error('取不到描述符（服务未发布 / 地址错误）');
  const inner = parseDescriptor(addr, desc);
  if (!inner || inner.introPoints.length === 0) throw new Error('描述符解析失败 / 无引入点');
  const serviceOnionPub = hexToBytes(inner.serviceOnionPubHex);

  // 2. 建到 RP 的电路、占会合槽（cookie），await RENDEZVOUS_ESTABLISHED；电路常开。
  const rpRelayId = pickRp(relays, inner.introPoints);
  const cookie = randomBytes(RDV_COOKIE_LEN);
  const rpCirc = await build(rpRelayId);
  rpCirc.enterRdvMode();
  // 先挂好 RENDEZVOUS2 等待器（服务可能在我们发完 INTRODUCE1 后很快回来）。
  const rdv2Promise = new Promise<Uint8Array>((res) => rpCirc.onRdv(CMD_RENDEZVOUS2, (d) => res(d)));
  await rpCirc.sendAwaitRdv(CMD_ESTABLISH_RENDEZVOUS, cookie, CMD_RENDEZVOUS_ESTABLISHED);

  // 3. ntor 客户端起手；密封 INTRODUCE 信封；经引入点发 INTRODUCE1。
  const ntor = ntorClientStart();
  const rpPubHex = rpRelayId.startsWith('0x') ? rpRelayId.slice(2) : rpRelayId;
  const introPlaintext = encodeIntroducePayload(rpPubHex, cookie, ntor.ephPublic);
  const ip = inner.introPoints[0];
  const sealed = introduceSeal(serviceOnionPub, introPlaintext);
  const authKey = hexToBytes(ip.authKeyHex);
  // INTRODUCE1 data = authKey(32) ‖ ephPub(32) ‖ ct。引入点据 authKey 寻址服务、原样转 rest（看不懂信封）。
  const intro1 = new Uint8Array(authKey.length + sealed.ephPub.length + sealed.ct.length);
  intro1.set(authKey, 0);
  intro1.set(sealed.ephPub, authKey.length);
  intro1.set(sealed.ct, authKey.length + sealed.ephPub.length);
  const ipCirc = await build(ip.relayId);
  ipCirc.enterRdvMode();
  ipCirc.sendToTerminus(CMD_INTRODUCE1, intro1);

  // 4. await RENDEZVOUS2(serverEph‖auth)，完成 ntor → 端到端密钥。引入点电路用完即弃。
  const r2 = await rdv2Promise;
  ipCirc.close(); // 引入只需投递一次，之后不再需要引入电路
  if (r2.length < 64) throw new Error('RENDEZVOUS2 应答过短');
  const serverEph = r2.subarray(0, 32);
  const auth = r2.subarray(32, 64);
  const keys = ntorClientFinish(ntor, A, serviceOnionPub, serverEph, auth);
  if (!keys) {
    rpCirc.close();
    throw new Error('会合 ntor 认证失败（服务身份未通过）');
  }
  // 客户端：发用 encForward，收用 encBackward（与中继侧 forward=客户端→服务 一致）。
  return new RdvChannel(rpCirc, keys.encForward, keys.encBackward);
}

// 选 RP：从目录里挑一个**不是**任何引入点、也不是已知 HSDir 角色冲突的中继（简化：避开引入点 relayId）。
// 选不到独立中继时退而求其次取第一个（小网测试容忍）。
function pickRp(relays: string[], introPoints: IntroPoint[]): string {
  const introIds = new Set(introPoints.map((ip) => ip.relayId));
  const candidates = relays.filter((id) => !introIds.has(id));
  const pool = candidates.length > 0 ? candidates : relays;
  return pool[Math.floor(Math.random() * pool.length)];
}

export type { CircuitKeys };
