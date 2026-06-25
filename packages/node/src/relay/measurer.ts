// 中继激励——链下「度量者」（bandwidth-authority 的最小诚实实现）。Phase 3A-2/3/4。
//
// 设计取向（与 PRD 严格一致，务必理解清楚再改）：
//   · 度量 = **仅存活性/可达性**（liveness/reachability ONLY）。每个 epoch 通过**穿过该中继建一条短测试电路**
//     并做一次 DATA 往返来探测——证明它「真的在转发 cell」而非只是 TCP 接受连接。**不测带宽**。
//   · 这是一个**中心化、可信、诚实**的度量者：它单方面决定谁在线、该发多少奖励、该不该罚没。
//     去信任化（多度量者投票/质押度量者）是后续工作，这里如实写明其中心化属性。
//   · 本文件**全部是链下逻辑**，不进共识状态机：computeReward/decideSlashes 是纯函数，
//     measurer 的探测/签名/落盘是 IO。链如何校验 SLASH（只认 MEASURER_ADDRESS + parseSlash 范围）见 staking.ts/blockchain.ts。
//
// 关键约束（来自已合入的 #13 共识，不可违反）：
//   · STAKING_ACTIVATION_HEIGHT=16000：STAKE/UNSTAKE/SLASH 仅在高度≥16000 生效；**奖励是普通转账 → 任何高度可用**。
//   · MEASURER_ADDRESS 是固定常量，其**私钥不在仓库**。度量者从钱包文件加载签名密钥；只有
//     加载到的钱包 .address === MEASURER_ADDRESS，链才会接受其 SLASH。故本地无法落地一笔成功的链上 SLASH
//     （没有匹配该常量的私钥）——我们测 SLASH 的**决策逻辑 + 交易成形 + 非度量者被拒**，链上接受属部署期。
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getPublicKey,
  publicKeyToAddress,
  generateOnionKeypair,
  utf8ToBytes,
  sign,
  verify,
  addressToPublicKeyHex,
  EPOCH_BLOCKS,
  ROLE_REWARD_MULT,
  REWARD_EPOCH_POOL,
  SLASH_AFTER_EPOCHS,
  SLASH_FRACTION,
  BOOTSTRAP_BONUS_UNTIL_HEIGHT,
  BOOTSTRAP_BONUS_MULT,
  type StakeRole,
  type StakePool,
} from '@v0idchain/core';
import { RelayNode, type RelayResolver } from './relaynode.js';
import { CircuitClient, type HopSpec } from './client.js';

/** 一个待探测的中继（来自链上目录 node.relays() 的子集）。 */
export interface ProbeTarget {
  id: string; // 中继钱包地址（= 链上身份 / relayId）
  onionPubHex: string; // 64-hex onion 公钥（ntor 静态密钥 B）
  host: string;
  port: number;
}

/**
 * 一次度量证明（attestation）：度量者断言「第 epoch 周期里，中继 relayId 的可达率为 uptime」。
 * 由度量者 ed25519 私钥对规范化 payload 签名 → 任何人可用 MEASURER_ADDRESS 公钥验签、确认确系度量者所发。
 * uptime ∈ [0,1] = K 次探测里成功的比例。online = uptime > 0（本 epoch 至少通了一次）。
 */
export interface Attestation {
  epoch: number; // 周期号（= floor(height / EPOCH_BLOCKS)）
  relayId: string; // 被度量中继地址
  uptime: number; // 可达率 [0,1]
  online: boolean; // 本 epoch 是否在线（uptime > 0）
  probes: number; // 本 epoch 探测总次数 K
  ok: number; // 其中成功次数
  ts: number; // 度量者本地时间戳（仅审计参考，不进签名跨实现稳定性问题 → 见 attestationPayload）
  sig?: string; // 度量者签名 hex（覆盖 attestationPayload 的字段）
}

/**
 * attestation 的**规范化签名 payload**（决定签什么）：只含跨实现可复现的字段，
 * 顺序固定。**不含 ts**（本地时钟，不进签名以免破坏可复现性）。
 */
export function attestationPayload(a: Pick<Attestation, 'epoch' | 'relayId' | 'uptime' | 'online' | 'probes' | 'ok'>): string {
  // uptime 用定点 6 位小数串，避免浮点 JSON 序列化在不同实现间的细微差异。
  const uptimeFixed = a.uptime.toFixed(6);
  return JSON.stringify([a.epoch, a.relayId, uptimeFixed, a.online, a.probes, a.ok]);
}
const payloadToHex = (s: string) => Buffer.from(utf8ToBytes(s)).toString('hex');

/** 用度量者私钥签一份 attestation（写回 .sig 字段并返回）。 */
export function signAttestation(a: Attestation, measurerPriv: Uint8Array): Attestation {
  a.sig = sign(payloadToHex(attestationPayload(a)), measurerPriv);
  return a;
}

/** 验签一份 attestation：用度量者地址（= 公钥）验。无 sig 或被篡改 → false。 */
export function verifyAttestation(a: Attestation, measurerAddress: string): boolean {
  if (!a.sig) return false;
  const pubHex = addressToPublicKeyHex(measurerAddress);
  return verify(a.sig, payloadToHex(attestationPayload(a)), pubHex);
}

// ---- 纯函数：奖励计算（链下，可单测） ----

/** 早期引导奖励倍率：BOOTSTRAP_BONUS_UNTIL_HEIGHT 之前为 BOOTSTRAP_BONUS_MULT，之后为 1。 */
export function bootstrapBonus(height: number): number {
  return height < BOOTSTRAP_BONUS_UNTIL_HEIGHT ? BOOTSTRAP_BONUS_MULT : 1;
}

/** 一条中继本 epoch 应得的奖励（链下计算，供 reward-epoch 预览/发放）。 */
export interface RewardLine {
  relayId: string; // 收款中继地址（= staker，奖励直接转给它）
  role: StakeRole; // 角色（决定倍率）
  uptime: number; // 本 epoch 可达率
  weight: number; // 归一化前权重 = uptime × ROLE_REWARD_MULT[role] × bootstrapBonus(height)
  amount: number; // 实发整数币 = floor(REWARD_EPOCH_POOL × weight / Σweights)
}

/**
 * 按 attestations + 质押池计算本 epoch 每个中继的奖励额。
 *   weight_i = uptime_i × ROLE_REWARD_MULT[role_i] × bootstrapBonus(height)
 *   amount_i = floor(REWARD_EPOCH_POOL × weight_i / Σ weights)
 * **奖励池上限**：Σ amount_i ≤ REWARD_EPOCH_POOL（floor 向下取整，故恒不超池；余数留在国库，不强行配发）。
 * 只有「有有效质押（在 stakes 里、未赎回）且本 epoch online 且 uptime>0」的中继参与分配。
 *
 * 注：bootstrapBonus 是所有权重的**公因子**，在归一化比值里会被约掉——
 * 即它**不改变中继之间的相对份额**，仅影响绝对池（绝对池本就被 REWARD_EPOCH_POOL 钉死）。
 * 仍在公式里显式保留，以①忠实匹配 PRD 给定公式；②让 weight 字段对人类可读（看出引导期翻倍意图）；
 * ③未来若把池设为「按 weight 绝对计价而非归一化」时无需改调用方。
 *
 * @param attestations 本 epoch 的度量证明（每中继一条；非本 epoch 的会被忽略）
 * @param stakes 当前链上质押池（id→pool），用于查角色 + 过滤「有有效质押」
 * @param height 当前链高（决定引导期倍率）
 * @param epoch 结算哪个 epoch（只采该 epoch 的 attestation）
 */
export function computeReward(
  attestations: Attestation[],
  stakes: Map<string, StakePool>,
  height: number,
  epoch: number,
): RewardLine[] {
  // staker 地址 → 其角色（取该 staker 名下**未赎回**质押中倍率最高的角色；一个中继通常只押一个角色）。
  const roleOf = new Map<string, StakeRole>();
  for (const p of stakes.values()) {
    if (p.withdrawn) continue;
    const cur = roleOf.get(p.staker);
    if (!cur || ROLE_REWARD_MULT[p.role] > ROLE_REWARD_MULT[cur]) roleOf.set(p.staker, p.role);
  }
  const bonus = bootstrapBonus(height);
  // 先算每条中继的权重（仅 online & 有质押 & uptime>0 者）
  const pre: { relayId: string; role: StakeRole; uptime: number; weight: number }[] = [];
  let totalWeight = 0;
  for (const a of attestations) {
    if (a.epoch !== epoch) continue; // 只结算指定 epoch
    if (!a.online || a.uptime <= 0) continue; // 掉线/零可达不发奖
    const role = roleOf.get(a.relayId);
    if (!role) continue; // 无有效质押的中继不参与奖励分配
    const weight = a.uptime * ROLE_REWARD_MULT[role] * bonus;
    if (weight <= 0) continue;
    pre.push({ relayId: a.relayId, role, uptime: a.uptime, weight });
    totalWeight += weight;
  }
  if (totalWeight <= 0) return [];
  // 归一化到有限池，floor 取整（保证 Σ ≤ 池；不做余数再分配，剩余留国库——保守不超发）。
  // **保留 amount===0 的行**（权重太小、归一化后向下取整到 0）：让预览表完整、weight 可核对；
  // 真发放时由调用方（reward-epoch --send）过滤 amount>0 再成形转账，不发 0 币空转账。
  return pre.map((x) => ({
    relayId: x.relayId,
    role: x.role,
    uptime: x.uptime,
    weight: x.weight,
    amount: Math.floor((REWARD_EPOCH_POOL * x.weight) / totalWeight),
  }));
}

// ---- 纯函数：罚没决策（链下，可单测） ----

/** 每个 stakeId 的连续掉线计数历史（度量者持久化的状态）。 */
export type OfflineHistory = Record<string, number>; // stakeId → 连续掉线 epoch 数

/** 一笔待发的罚没决策。 */
export interface SlashDecision {
  stakeId: string; // 被罚质押池 id（= STAKE 交易 txid）
  staker: string; // 质押人地址（= 中继身份，仅供展示/日志）
  role: StakeRole;
  consecutiveOffline: number; // 触发时的连续掉线 epoch 数
  remaining: number; // 罚没前剩余本金（= amount - slashed）
  amount: number; // 本次罚没额 = floor(SLASH_FRACTION × remaining)
}

/**
 * 按「连续掉线历史 + 质押池」决定本轮该罚没谁、罚多少（保守、仅惩罚持续掉线）。
 *   触发条件：consecutiveOffline ≥ SLASH_AFTER_EPOCHS（默认 3，连续 3 个 epoch 探测不通才罚）。
 *   罚没额  ：amount = floor(SLASH_FRACTION × remaining)，remaining = pool.amount - pool.slashed（剩余本金）。
 * 只罚「在质押池里、未赎回、且剩余本金 > 0」的；amount 计算为 0 的（剩余太小）不产出（无意义空 SLASH）。
 * 这是**链下裁决**：链侧对 SLASH 额另有「至多剩余本金」的封顶（见 applyTx），故即便这里偏大也不会超额。
 */
export function decideSlashes(history: OfflineHistory, stakes: Map<string, StakePool>): SlashDecision[] {
  const out: SlashDecision[] = [];
  for (const [stakeId, consecutiveOffline] of Object.entries(history)) {
    if (consecutiveOffline < SLASH_AFTER_EPOCHS) continue; // 未达连续掉线阈值，不罚
    const p = stakes.get(stakeId);
    if (!p || p.withdrawn) continue; // 池不存在或已赎回，无可罚
    const remaining = p.amount - p.slashed;
    if (remaining <= 0) continue; // 已罚没殆尽
    const amount = Math.floor(SLASH_FRACTION * remaining);
    if (amount <= 0) continue; // 剩余太小，floor 后为 0 → 不产出空 SLASH
    out.push({ stakeId, staker: p.staker, role: p.role, consecutiveOffline, remaining, amount });
  }
  return out;
}

/**
 * 根据本 epoch 的在线情况，**滚动更新**连续掉线计数历史（纯函数，便于单测）：
 *   · 在该 epoch online 的 stakeId → 计数清零（一次通了就重新计）。
 *   · 掉线（或本 epoch 无 attestation）的、且仍在质押池里未赎回的 stakeId → 计数 +1。
 *   · 已赎回/已退出质押池的 stakeId → 从历史里移除（不再追踪）。
 * @param prev 旧历史
 * @param onlineStakeIds 本 epoch 判定为 online 的 stakeId 集合
 * @param stakes 当前质押池（决定谁仍需追踪）
 */
export function updateOfflineHistory(
  prev: OfflineHistory,
  onlineStakeIds: Set<string>,
  stakes: Map<string, StakePool>,
): OfflineHistory {
  const next: OfflineHistory = {};
  for (const [stakeId, p] of stakes) {
    if (p.withdrawn) continue; // 已赎回 → 不再追踪
    if (onlineStakeIds.has(stakeId)) {
      next[stakeId] = 0; // 本 epoch 在线 → 清零
    } else {
      next[stakeId] = (prev[stakeId] ?? 0) + 1; // 掉线 → 累加
    }
  }
  return next;
}

// ---- 探测：穿过目标中继建短测试电路 + DATA 往返（liveness） ----

/**
 * 探测一个中继是否「真的在转发 cell」：建一条 2 跳测试电路 **target(第 1 跳) → sink(出口)**，
 * 经 target 转发一次 DATA 往返并校验回显。成功 = target 完成了 ntor 握手 + 真实转发了 cell（而非仅 TCP 接受）。
 *
 * 拓扑取舍（关键，改前务必看懂）：把 target 放第 1 跳、另起一个 prober 自控的 sink 作出口——
 *   ① 中继处理 CMD_DATA 终点回显**只在自身挂了 exitHandler 时**才发生（见 relaynode CMD_DATA 分支）；
 *      生产中继默认 deny-all、无 exitHandler → 若把 target 当出口直接探，DATA 会被静默丢弃、误判掉线。
 *      故必须把回显终点放在 **prober 自控的 sink** 上（sink 只回显、绝不暴露公网出口）。
 *   ② EXTEND 时下一跳的 host:port 由**转发方中继用自己的 resolver 解析**（EXTEND 数据只带 nextHopId）。
 *      因此 target→sink 这一跳要成立，**target 的目录里必须能解析到 sink**。本地测试用共享 resolver 天然满足；
 *      生产部署里，度量者应把其 sink 作为一个**上链中继**发布（或置于各中继目录已含的已知地址），
 *      使被探中继能拨到它。这是「中心化度量者」的固有部署前提，如实写明、不藏着掖着。
 *
 * @param target 被探测中继（含 onion 公钥 + cell 入口 host:port）
 * @param sink prober 自控的出口中继规格（HopSpec）；其 RelayNode 须由各 target 可解析（见上 ②）
 * @param timeoutMs 单次探测整体超时
 */
export async function probeOnce(target: ProbeTarget, sink: HopSpec, timeoutMs = 4000): Promise<boolean> {
  const client = new CircuitClient();
  const withTimeout = <T>(p: Promise<T>, label: string) =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('探测超时: ' + label)), timeoutMs))]);
  try {
    const hop0: HopSpec = { id: target.id, onionPub: Buffer.from(target.onionPubHex, 'hex'), host: target.host, port: target.port };
    await withTimeout(client.connect(hop0), 'connect target'); // 与 target 握手（第 1 跳，证明 ntor + 接受电路）
    await withTimeout(client.extend(sink), 'extend sink'); // 经 target 延伸到 sink 出口（证明 target 转发 EXTEND/CREATE）
    const nonce = randomBytes(6).toString('hex');
    const payload = utf8ToBytes('PROBE:' + nonce);
    const reply = await withTimeout(client.sendData(payload), 'sendData'); // 经 target 往返一次 DATA（证明双向转发 cell）
    return new TextDecoder().decode(reply) === 'ECHO:PROBE:' + nonce; // 回显吻合 = target 真在转发
  } catch {
    return false; // 任何失败（连不上/握手失败/不转发/超时）= 本次探测不通
  } finally {
    client.close();
  }
}

/** 度量者持久化状态（落 0600 JSON）。 */
export interface MeasurerState {
  measurerAddress: string; // 加载到的钱包地址（应 === MEASURER_ADDRESS，否则链不接受其 SLASH）
  lastEpoch: number; // 最近一次完成度量的 epoch
  attestations: Attestation[]; // 最近一次度量的全部 attestation（已签名）
  offlineHistory: OfflineHistory; // stakeId → 连续掉线 epoch 数（喂 decideSlashes）
}

/**
 * 度量者守护：每个 epoch（EPOCH_BLOCKS 块）对每个中继探测 K 次 → 出 attestation + 滚动掉线历史，落盘。
 * **中心化诚实实现**：单进程、单签名密钥；其判断即权威。它不改链，只产出可供 reward-epoch/slash-epoch 消费的证明与历史。
 *
 * 用法（CLI v0id measure 接线，见 cli/src/index.ts）：
 *   const m = new Measurer({ dataDir, measurerPriv, measurerAddress, probesPerEpoch: 3 });
 *   每到一个新 epoch 边界，拿到 { targets, stakes, height, epoch } 调 m.runEpoch(...)。
 */
export interface MeasurerOpts {
  dataDir: string; // 度量者数据目录（state.json 落这里，0600）
  measurerPriv: Uint8Array; // 度量者签名私钥（从钱包文件加载）
  measurerAddress: string; // 度量者地址（= 钱包 .address）
  probesPerEpoch?: number; // 每中继每 epoch 探测次数 K（默认 3）
  probeTimeoutMs?: number; // 单次探测超时（默认 4000）
}

export class Measurer {
  private readonly stateFile: string;
  private readonly probesPerEpoch: number;
  private readonly probeTimeoutMs: number;
  private state: MeasurerState;

  constructor(private readonly opts: MeasurerOpts) {
    this.stateFile = join(opts.dataDir, 'measurer-state.json');
    this.probesPerEpoch = Math.max(1, opts.probesPerEpoch ?? 3);
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 4000;
    this.state = this.load();
  }

  /** 当前持久化状态（只读视图）。 */
  get current(): MeasurerState {
    return this.state;
  }

  private load(): MeasurerState {
    if (existsSync(this.stateFile)) {
      try {
        const data = JSON.parse(readFileSync(this.stateFile, 'utf8')) as MeasurerState;
        // 兜底字段，旧文件缺省安全
        return {
          measurerAddress: data.measurerAddress ?? this.opts.measurerAddress,
          lastEpoch: data.lastEpoch ?? -1,
          attestations: Array.isArray(data.attestations) ? data.attestations : [],
          offlineHistory: data.offlineHistory ?? {},
        };
      } catch {
        /* 损坏 → 从空状态重建（度量历史非账本，丢了重新积累即可） */
      }
    }
    return { measurerAddress: this.opts.measurerAddress, lastEpoch: -1, attestations: [], offlineHistory: {} };
  }

  /** 0600 落盘（含签名私钥派生地址，但不含私钥本身；与钱包文件同等收紧权限）。 */
  private persist(): void {
    mkdirSync(this.opts.dataDir, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.stateFile, 0o600);
    } catch {
      /* 只读介质/无权限：尽力而为 */
    }
  }

  /**
   * 跑完一个 epoch 的度量：对每个 target 探测 K 次 → 算 uptime/online → 签 attestation；
   * 再用「online 的 stakeId 集合」滚动更新连续掉线历史；落盘。返回本 epoch 的 attestation 列表。
   *
   * @param targets 本 epoch 要探测的中继（来自链上目录）
   * @param sink prober 自控的出口中继 HopSpec（回显）；其 RelayNode 的 resolver 须能拨到所有 target，且各 target 能解析到它（见 probeOnce ②）
   * @param stakes 当前链上质押池（relayId→role 映射 + 掉线追踪范围）
   * @param height 当前链高（保留用于审计上下文；本 epoch 度量本身与高度无关，奖励/引导倍率在 computeReward 侧按高度算）
   * @param epoch 本周期号
   */
  async runEpoch(
    targets: ProbeTarget[],
    sink: HopSpec,
    stakes: Map<string, StakePool>,
    height: number,
    epoch: number,
  ): Promise<Attestation[]> {
    void height; // 仅文档化：度量（探测）与链高无关；高度在 computeReward 决定引导倍率，不在此处消费
    // staker 地址 → 其**未赎回**质押的 stakeId 列表（用于把「中继 online」映射回「stakeId online」做掉线追踪）。
    const stakeIdsOf = new Map<string, string[]>();
    for (const [id, p] of stakes) {
      if (p.withdrawn) continue;
      const arr = stakeIdsOf.get(p.staker) ?? [];
      arr.push(id);
      stakeIdsOf.set(p.staker, arr);
    }

    const attestations: Attestation[] = [];
    const onlineStakeIds = new Set<string>();
    for (const t of targets) {
      let ok = 0;
      for (let i = 0; i < this.probesPerEpoch; i++) {
        if (await probeOnce(t, sink, this.probeTimeoutMs)) ok++;
      }
      const uptime = ok / this.probesPerEpoch;
      const online = ok > 0;
      const a: Attestation = { epoch, relayId: t.id, uptime, online, probes: this.probesPerEpoch, ok, ts: Date.now() };
      signAttestation(a, this.opts.measurerPriv);
      attestations.push(a);
      if (online) for (const sid of stakeIdsOf.get(t.id) ?? []) onlineStakeIds.add(sid);
    }

    this.state.attestations = attestations;
    this.state.lastEpoch = epoch;
    this.state.offlineHistory = updateOfflineHistory(this.state.offlineHistory, onlineStakeIds, stakes);
    this.persist();
    return attestations;
  }
}

/**
 * 起一个 prober 自控的「出口 sink」中继：仅在 prober 进程内监听，出口策略只回显（绝不暴露公网出口）。
 * 返回 { sink: HopSpec, node: RelayNode }；探测完务必 node.close()。resolver 须能解析所有待探 target + sink 自身。
 */
export function makeProbeSink(resolver: RelayResolver, port: number, host = '127.0.0.1'): { sink: HopSpec; node: RelayNode } {
  const sk = randomBytes(32);
  const id = publicKeyToAddress(getPublicKey(sk));
  const onion = generateOnionKeypair();
  // allowPrivateRelayTargets 取 host 默认（本地回环 → true），让 sink 能被 target EXTEND 到本地。
  const node = new RelayNode(id, onion, resolver, port, host);
  // 出口处理：把收到的 DATA 原样回显成 'ECHO:<明文>'，供 probeOnce 校验往返。
  node.onExit((data, reply) => reply(utf8ToBytes('ECHO:' + new TextDecoder().decode(data))));
  const sink: HopSpec = { id, onionPub: onion.pub, host, port };
  return { sink, node };
}

// 让 EPOCH_BLOCKS 等常量在本模块内「被使用」一次，避免某些 lint 把仅类型/文档用途的 import 当未用（实际 runEpoch 的调用方按 EPOCH_BLOCKS 切 epoch）。
export const MEASURER_EPOCH_BLOCKS = EPOCH_BLOCKS;
