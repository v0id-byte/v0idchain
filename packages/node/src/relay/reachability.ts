// 中继可达性探测缓存（选路加速）：链上中继目录会**永久**累积无法注销的死中继（早下线 / 端口被防火墙挡 /
// 本机自测发的私网 host）。光靠建路时撞超时再换路，每条电路都要为每个被选中的死中继付一次 ~6s 黑洞超时 → 浏览慢到不可用。
// 这里用一次性 WS 探测把“host 公网但实际连不通”的死中继也识别出来并**缓存**，选路只从已知可达集里挑 → 暖缓存下建路秒级完成。
//
// 设计：纯 best-effort 提示，不是共识——探测失败只是“暂时别选它”，TTL 到期会重探，死中继复活后自动回归。
// 冷缓存（从未探测过的中继）一律**当可达放行**，保证首次仍可用（只是首建会顺带 await 一次并行探测，~5s）。
import { WebSocket } from 'ws';
import type { RelayDescriptor } from '@v0idchain/core';
import { resolveRelayWsUrl } from './relaynode.js';

interface Entry {
  ok: boolean;
  at: number;
}

/** 单次探测封顶（死端口黑洞 → 到点判不可达）。须 > 正常 WS 建连 RTT 数倍。 */
const PROBE_TIMEOUT_MS = 5000;
/** 缓存有效期：到期重探（中继可能下线/复活）。 */
const TTL_MS = 3 * 60 * 1000;

export class RelayReachability {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<boolean>>();
  // 「已证转发」集合：实测**成功当过 middle**（guard→middle→exit 三跳建成）的中继 = 真转发器，永不被 markBad 判负。
  // 这把 markBad 的歧义（middle→exit 失败时怪 middle 还是 exit？）化解掉：已证转发的 AWS 骨干不会被“exit 其实死了”误伤，
  // 而从没成功转发过的死中继（hairpin/旧版）照常被判负剔除 → 选路稳稳收敛到能转发的骨干。
  private proven = new Set<string>();

  /**
   * @param allowPrivateHosts 探测时是否放行私网/回环 host。生产默认 **false**：链上目录里的私网/回环描述符
   *   （如残留的 127.0.0.1 死中继）一律不探测——否则会从用户机器对内网 / 云元数据地址（169.254.169.254）发起
   *   周期性 WS Upgrade（SSRF）。仅本机绑回环的自测（relay/host 全 127.0.0.1）才传 true。判定与 dialRelay 同走
   *   resolveRelayWsUrl，SSRF 口径只有一处。
   */
  constructor(private readonly allowPrivateHosts = false) {}

  /**
   * 探测一个中继的 cell 端点：开一个 WS（443→wss，与拨号同款），open=可达，error/超时=不可达。即开即关，不收发任何 cell。
   * 连接目标经 resolveRelayWsUrl 解析并施加 **SSRF 守卫**（与 dialRelay 复用同一口径）：非 allowPrivateHosts 时，
   * 描述符里的私网/回环 host（如残留 127.0.0.1 死中继、或解析到内网的恶意主机名）→ **直接判不可达，绝不真的去连**。
   */
  private probe(d: RelayDescriptor): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      let ws: WebSocket | undefined;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws?.terminate();
        } catch {
          /* ignore */
        }
        resolve(ok);
      };
      // 计时器在解析之前就起，连 DNS 解析 + 建连一起封顶（慢 DNS / 死端口黑洞 → 到点判不可达）。
      const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
      resolveRelayWsUrl(d.host, d.port, this.allowPrivateHosts, (target) => {
        if (done) return; // 已超时落定
        if (!target) {
          finish(false); // SSRF 守卫拒连（私网/回环 host）→ 判不可达，不发起任何对内网的连接
          return;
        }
        try {
          ws = new WebSocket(target, { maxPayload: 1 << 12 });
          ws.on('open', () => finish(true));
          ws.on('error', () => finish(false));
        } catch {
          finish(false);
        }
      });
    });
  }

  private fresh(addr: string, now: number): Entry | undefined {
    const e = this.cache.get(addr);
    return e && now - e.at < TTL_MS ? e : undefined;
  }

  /**
   * 把某中继**判负**（建路时实测它当 middle 转发失败：连得上但**转不动**，如 hairpin NAT / 防火墙只放行入站 / 旧版 link-closed）。
   * 仅对**未被证实能转发**的中继生效（proven 集里的骨干免疫，避免“exit 其实死了”时误伤好 middle）。判负进缓存，TTL 内被 knownUsable 剔除，到期重探恢复。
   * @returns 是否真的判负了（proven 中继返回 false，调用方据此知道没动它）。
   */
  markBad(addr: string): boolean {
    if (this.proven.has(addr)) return false;
    this.cache.set(addr, { ok: false, at: Date.now() });
    return true;
  }

  /** 把某中继标为**已证转发**（成功当过 middle）：永久免疫 markBad，并即时置为可达（撤销此前任何误判负）。 */
  markProvenForwarder(addr: string): void {
    this.proven.add(addr);
    this.cache.set(addr, { ok: true, at: Date.now() });
  }

  /** 当前已知可达中继数（建路侧判负前查它，保证判负不把可达集压到 < 下限 → 永远留得下一条可建之路）。 */
  usableCount(relays: RelayDescriptor[]): number {
    return this.knownUsable(relays).length;
  }

  /** 并行探测一组中继里所有“缓存缺失/过期”的项（已 fresh 的跳过；并发去重）。结果写缓存。最长 ~PROBE_TIMEOUT_MS。 */
  async refresh(relays: RelayDescriptor[]): Promise<void> {
    const now = Date.now();
    await Promise.all(
      relays.map(async (d) => {
        if (this.fresh(d.address, now)) return;
        let p = this.inflight.get(d.address);
        if (!p) {
          const startedAt = Date.now(); // 记录探测发起时刻，落缓存时据此识别探测期间是否有更新的权威写入
          // 落缓存只在探测**发起者**这一处做（不是每个 await 者）：仅当探测期间没有更“新”的写入
          // （markBad / markProvenForwarder，其 at > startedAt）才写——否则一个早于 markBad 发起、晚于它返回的
          // 陈旧探测会把“连得上但转不动”的判负覆盖回 ok:true，让死中继瞬间复活、建路反复重撞。
          p = this.probe(d)
            .then((ok) => {
              const cur = this.cache.get(d.address);
              if (!cur || cur.at <= startedAt) this.cache.set(d.address, { ok, at: Date.now() });
              return ok;
            })
            .finally(() => this.inflight.delete(d.address));
          this.inflight.set(d.address, p);
        }
        await p;
      }),
    );
  }

  /** 当前已知可达子集（同步，纯读缓存）：探测过且可达 → 留；探测过且不可达 → 去；从未探测（冷）→ 当可达放行。 */
  knownUsable(relays: RelayDescriptor[]): RelayDescriptor[] {
    const now = Date.now();
    return relays.filter((d) => {
      const e = this.fresh(d.address, now);
      return e ? e.ok : true;
    });
  }
}
