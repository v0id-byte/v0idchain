// 隐藏服务宿主（Phase 2B-c）：在若干引入点中继上挂电路候命、发布描述符；收到 INTRODUCE2 后另建到 RP 的
// 电路完成端到端 ntor 握手，把 RdvChannel 交给业务回调。服务全程不暴露自身 IP（客户端只看到描述符 + RP）。
//
// 服务持有：① hs 身份种子 seed（→ .v0id 地址 / 盲签描述符）；② 一对静态 onion 密钥（rendezvous ntor 的服务静态钥，
// 公钥写进描述符 serviceOnionPubHex）。注意这两把钥**不同**：seed 是 ed25519 身份（绑进 ntor 转录的 A），
// onion 是 x25519 静态钥（ntor 的 B / INTRODUCE 信封的封钥）——与每跳中继的“身份钥 vs onion 钥”分离同理。
import {
  identityPub,
  encodeV0idAddress,
  timePeriod,
  blindPublic,
  descriptorId,
  buildDescriptor,
  responsibleHsDirs,
  HSDIR_REPLICAS,
  type OnionKeypair,
  type IntroPoint,
  ntorServer,
  hexToBytes,
  bytesToHex,
  introduceOpen,
  decodeIntroducePayload,
  CMD_ESTABLISH_INTRO,
  CMD_INTRO_ESTABLISHED,
  CMD_INTRODUCE2,
  CMD_RENDEZVOUS1,
  CMD_DROP,
} from '@v0idchain/core';
import { randomBytes } from 'node:crypto';
import { CircuitClient } from './client.js';
import { RdvChannel, type BuildCircuit, type RelayDirectory } from './hsclient.js';

const MAX_RDV_CIRCS = 256; // 单服务并发会合电路上限（抗内存/FD 耗尽）
const INTRO_BUILD_ROUNDS = 3; // 建引入点的最多扫描轮数：冷启动可达性缓存收敛期，前几轮判负死中继后，后几轮在干净集上稳建
const INTRO_REPLAY_TTL = 5 * 60 * 1000; // INTRODUCE 防重放窗口(ms)
const MAX_SEEN_INTROS = 4096; // 防重放表上限（超则逐出最旧）
const HS_PERIOD_LEN_SEC = 24 * 60 * 60;
const REPUBLISH_SLOP_MS = 1_000;

/** 业务回调：与某客户端的端到端通道就绪时调用一次（每个成功会合一个 channel）。 */
export type RendezvousHandler = (channel: RdvChannel) => void;

export interface HiddenServiceOptions {
  seed: Uint8Array; // hs 身份种子（32B）
  onion: OnionKeypair; // 服务静态 onion 密钥（rendezvous ntor 的 B；公钥进描述符）
  build: BuildCircuit; // 选路器：以给定中继为终点建 3 跳电路
  dir: RelayDirectory; // 中继目录
  handler: RendezvousHandler; // 会合就绪回调
  numIntros?: number; // 引入点数量（默认 3）
  now?: () => number; // 时间源（默认 Date.now/1000）
}

export class HiddenService {
  readonly address: string;
  private seed: Uint8Array;
  private onion: OnionKeypair;
  private build: BuildCircuit;
  private dir: RelayDirectory;
  private handler: RendezvousHandler;
  private numIntros: number;
  private now: () => number;
  private A: Uint8Array;
  // 已建立的引入电路（常开，监听后向 INTRODUCE2）。引入点 relayId → {circ, authKey}。
  private intros: { relayId: string; authKey: Uint8Array; circ: CircuitClient }[] = [];
  private rpCircs = new Set<CircuitClient>(); // 各次会合到 RP 的电路（常开承载 e2e）；会合电路销毁即自动移除
  private seenIntros = new Map<string, number>(); // 防重放：clientNtorEph hex → 首见时刻(ms)，保持插入序便于逐出最旧
  private started = false;
  private stopped = false;
  private republishTimer: ReturnType<typeof setTimeout> | null = null;
  // 引入电路保活：CF 隧道等会把空闲的长寿 WebSocket 电路掐断，引入点遂摘除本服务的登记 → 客户端 INTRODUCE 无人接。
  // 定期向每条引入电路的终点发一个 CMD_DROP 掩护 cell（终点静默丢弃，零协议改动），保持电路 + 沿途 CF 隧道常活。
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // 描述符修订号源：必须**严格递增**（HSDir 防回滚只收 rev 更高者）。否则服务重启后换了新引入点(authKey)、却用
  // 同一 rev 重发 → HSDir 拒收、续供旧描述符(旧 authKey) → 客户端 INTRODUCE 投不到本服务。用墙钟 ms 作底（跨重启天然更高）。
  private lastRev = 0;

  constructor(opts: HiddenServiceOptions) {
    this.seed = opts.seed;
    this.onion = opts.onion;
    this.build = opts.build;
    this.dir = opts.dir;
    this.handler = opts.handler;
    this.numIntros = opts.numIntros ?? 3;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.A = identityPub(this.seed);
    this.address = encodeV0idAddress(this.A);
  }

  /** 启动：建引入点电路 + 发布描述符。返回时服务已可被连接（至少 1 个引入点 + 1 个 HSDir 成功）。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    try {
      // 1. 选引入点中继：在所有中继里**随机顺序逐个试**，建电路 + 登记，**跳过建路失败的候选**，直到攒够 numIntros 个。
      //    链上目录含无法注销的死中继污染（见 hsbridge）→ 必须容忍单个候选失败，否则随机撞上一个死中继整个服务就起不来。
      //    **多轮**：冷启动时选路可达性缓存尚在收敛（每次失败的 build 会判负坏转发器），单轮可能在收敛完成前就把好中继试废 →
      //    再扫几轮，靠前几轮把死中继判负后，后几轮在干净的可达集上稳稳建成。健康网络下第一轮即满 numIntros，多余轮自然跳过。
      for (let round = 0; round < INTRO_BUILD_ROUNDS && this.intros.length < this.numIntros; round++) {
        for (const relayId of shuffle(this.dir())) {
          if (this.intros.length >= this.numIntros) break;
          if (this.intros.some((it) => it.relayId === relayId)) continue; // 已在此中继建过引入点 → 不重复
          try {
            const authKey = randomBytes(32); // 仅作“在此 IP 寻址本服务”的句柄（不参与端到端认证）
            const circ = await this.build(relayId);
            circ.enterRdvMode();
            circ.onRdv(CMD_INTRODUCE2, (data) => this.onIntroduce2(data));
            await circ.sendAwaitRdv(CMD_ESTABLISH_INTRO, authKey, CMD_INTRO_ESTABLISHED);
            this.intros.push({ relayId, authKey, circ });
          } catch {
            // 这个候选中继建不了引入电路（死中继/被防火墙挡/瞬断）→ 跳过试下一个
          }
        }
      }
      if (this.intros.length === 0) throw new Error('未能建立任何引入点');

      // 2. 构造描述符（引入点 = 各引入电路的 {relayId, relayOnionPub, authKey}）+ 发布到负责的 HSDir。
      await this.publishDescriptors();
      this.scheduleRepublish();
      this.startIntroKeepalive();
    } catch (err) {
      this.stop();
      this.started = false;
      throw err;
    }
  }

  private async publishDescriptors(): Promise<void> {
    const currentTP = timePeriod(this.now());
    const periods = [currentTP, currentTP + 1];
    let publishedCurrent = false;
    for (const TP of periods) {
      if ((await this.publishDescriptor(TP)) > 0 && TP === currentTP) publishedCurrent = true;
    }
    if (!publishedCurrent) throw new Error('描述符发布失败（无 HSDir 接受）');
  }

  private async publishDescriptor(TP: number): Promise<number> {
    const relays = this.dir();
    const introPoints: IntroPoint[] = this.intros.map((it) => ({
      relayId: it.relayId,
      relayOnionPubHex: onionPubOf(relays, it.relayId), // 见下：测试经 dirOnion 提供；缺省占位（IP 的 onion 公钥客户端无需用）
      authKeyHex: bytesToHex(it.authKey),
    }));
    const desc = buildDescriptor(this.seed, TP, introPoints, bytesToHex(this.onion.pub), this.nextRev());
    const json = JSON.stringify(desc);
    const descId = descriptorId(blindPublic(this.A, TP), TP);
    const hsdirs = responsibleHsDirs(descId, relays, HSDIR_REPLICAS);
    let publishOk = 0;
    for (const hsdirId of hsdirs) {
      try {
        const c = await this.build(hsdirId); // 死 HSDir 建路会抛 → 跳过靠其余 HSDir（与引入点同款容错）
        try {
          const ok = await c.hsPublish(descId, json);
          if (ok) {
            publishOk++;
            console.log(`[hs-publish] OK hsdir=${hsdirId} descId=${descId}`);
          } else {
            console.error(`[hs-publish] REJECTED hsdir=${hsdirId} descId=${descId} (hsPublish returned false)`);
          }
        } finally {
          c.close();
        }
      } catch (e) {
        // DEBUG-C: 旧版 try-catch 全吞，加日志暴露失败原因
        console.error(`[hs-publish] build-fail hsdir=${hsdirId} descId=${descId} err=${(e as Error).message ?? e}`);
      }
    }
    return publishOk;
  }

  /** 严格递增的描述符修订号：以墙钟 ms 为底（跨重启天然更高 → 重启后换了新 authKey 的描述符必被 HSDir 接受、替换旧的），
   *  同进程内多次发布也保证 +1 严格递增（同 ms 不撞）。 */
  private nextRev(): number {
    const r = Math.max(Date.now(), this.lastRev + 1);
    this.lastRev = r;
    return r;
  }

  private scheduleRepublish(): void {
    if (this.republishTimer) clearTimeout(this.republishTimer);
    const nowSec = this.now();
    const nextBoundarySec = (timePeriod(nowSec) + 1) * HS_PERIOD_LEN_SEC;
    const delayMs = Math.max(1_000, (nextBoundarySec - nowSec) * 1000 + REPUBLISH_SLOP_MS);
    this.republishTimer = setTimeout(() => {
      this.publishDescriptors()
        .catch(() => undefined)
        .finally(() => {
          if (!this.stopped) this.scheduleRepublish();
        });
    }, delayMs);
  }

  /** 引入电路保活：每 25s 给每条引入电路终点发一个 CMD_DROP 掩护 cell（终点静默丢弃），保持长寿电路 + 沿途 CF 隧道常活，
   *  防止 CF 等代理把空闲 WebSocket 掐断后引入点摘除登记、致 INTRODUCE 无人接收。 */
  private startIntroKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (this.stopped) return;
      for (const it of this.intros) {
        try {
          it.circ.sendToTerminus(CMD_DROP, new Uint8Array(0));
        } catch {
          // 单条电路发送失败不影响其它（电路或已死，靠下次 republish 重建）。
        }
      }
    }, 25_000);
    this.keepaliveTimer.unref?.();
  }

  // 收到 INTRODUCE2（沿某引入电路后向到达）：解开信封 → ntorServer → 建到 RP 的电路 → RENDEZVOUS1 报到 → 交付 channel。
  private async onIntroduce2(data: Uint8Array): Promise<void> {
    if (this.stopped) return;
    // data = ephPub(32) ‖ ct（引入点已剥掉 authKey）。
    if (data.length < 32) return;
    const ephPub = data.subarray(0, 32);
    const ct = data.subarray(32);
    const plaintext = introduceOpen(this.onion, ephPub, ct);
    if (!plaintext) return; // 非本服务信封 / 被篡改 → 丢
    const payload = decodeIntroducePayload(plaintext);
    if (!payload) return;
    const { rpPubHex, cookie, clientNtorEph } = payload;
    // 防重放：同一客户端 ntor 临时钥只受理一次（重放的 INTRODUCE1 字节相同 → clientNtorEph 相同），
    // 否则半可信引入点重放一条 INTRODUCE1 即可逼服务反复建 RP 电路（DoS 放大）。
    const introKey = bytesToHex(clientNtorEph);
    const nowMs = Date.now();
    for (const [k, t] of this.seenIntros) if (nowMs - t > INTRO_REPLAY_TTL) this.seenIntros.delete(k);
    if (this.seenIntros.has(introKey)) return; // 重放 → 丢，不做任何昂贵动作
    if (this.seenIntros.size >= MAX_SEEN_INTROS) {
      const oldest = this.seenIntros.keys().next().value; // 表满 → 逐出最旧
      if (oldest !== undefined) this.seenIntros.delete(oldest);
    }
    this.seenIntros.set(introKey, nowMs);
    // 服务侧 ntor：A=身份公钥（绑进转录），B=静态 onion 钥，X=客户端临时公钥 → (Y, auth, keys)。
    const res = ntorServer(this.A, this.onion, clientNtorEph);
    if (!res) return; // 客户端 X 畸形 → 丢
    if (this.rpCircs.size >= MAX_RDV_CIRCS) return; // 并发会合已达上限 → 拒绝（抗资源耗尽）
    const rpRelayId = '0x' + rpPubHex;
    let rpCirc: CircuitClient;
    try {
      rpCirc = await this.build(rpRelayId);
    } catch {
      return; // RP 不可达 → 放弃本次会合
    }
    if (this.stopped) {
      rpCirc.close();
      return;
    }
    rpCirc.enterRdvMode();
    this.rpCircs.add(rpCirc);
    rpCirc.onRdvDestroy(() => this.rpCircs.delete(rpCirc)); // 会合电路死亡 → 移除，不再积累
    // RENDEZVOUS1 = cookie(20) ‖ serverEph(32) ‖ auth(32)。RP 据 cookie 拼接，并把 serverEph‖auth 转给客户端。
    const rdv1 = new Uint8Array(cookie.length + 64);
    rdv1.set(cookie, 0);
    rdv1.set(res.serverEph, cookie.length);
    rdv1.set(res.auth, cookie.length + 32);
    rpCirc.sendToTerminus(CMD_RENDEZVOUS1, rdv1);
    // 服务侧：发用 encBackward，收用 encForward（镜像客户端）。即刻把 channel 交给业务（发送会缓冲在 cell 通道里）。
    const channel = new RdvChannel(rpCirc, res.keys.encBackward, res.keys.encForward);
    channel.onClose(() => this.rpCircs.delete(rpCirc)); // 本地 channel.close() 也释放并发配额
    this.handler(channel);
  }

  /** 停止：销毁所有引入电路与会合电路（描述符在 HSDir 上靠 TTL 自然过期）。 */
  stop(): void {
    this.stopped = true;
    if (this.republishTimer) clearTimeout(this.republishTimer);
    this.republishTimer = null;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    for (const it of this.intros) it.circ.close();
    for (const c of this.rpCircs) c.close();
    this.intros = [];
    this.rpCircs.clear();
    this.seenIntros.clear();
  }
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

// 占位：本实现的描述符里 IP 的 onion 公钥字段对“连接”不是必需（客户端用 authKey 寻址 IP、用 serviceOnionPub 封信封）。
// 真实部署应从链上目录取 IP 的 okey；这里目录仅给 host:port，故填 0（不影响 2B-c 连通性，仅是描述符里的元数据）。
function onionPubOf(_relays: string[], _relayId: string): string {
  return '00'.repeat(32);
}
