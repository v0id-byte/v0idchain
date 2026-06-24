// 链上中继目录（洋葱网络的中继名录）：完全建在“自转 + memo”之上，不改共识——与昵称 names.ts 同款。
// 中继发布 = 自转 1 币 memo `RELAY|<okey>|<host:port>|<bw>|<stake>`；任何节点扫一遍链就能还原出
// 地址↔中继描述符 的名录。这套**替代了 Tor 的目录权威（dirauth）**：客户端回放链即得一致的全网中继视图，
// 无需信任任何中心目录服务器。
//
// 关键设计：
// - **latest-wins**（与昵称的 first-wins 不同）：每个地址发布**自己**的描述符，无命名空间争夺；
//   重发即更新（换 host / 轮换 onion 公钥）→ 取该地址最后一笔合法描述符。
// - **okey 无需链上单独证明归属**：描述符里的 onion 公钥由中继自报。若它谎报了别人的 okey，
//   也只是造出一个**无法完成 ntor 握手**的中继（它没有对应私钥 → 客户端 AUTH 校验失败、换中继），损人不利己、无害。
// - **不进 isProtocolMemo**：RELAY 是 burn=0 的自转，isMessageTx 天然排除，压根不是消息——与 NAME| 一致（见 messages.ts 注释）。
import type { Block } from './block.js';
import { MAX_MEMO } from './config.js';

export const RELAY_PREFIX = 'RELAY|';

// host:port —— v1 仅支持 IPv4 / 主机名（不含 ':' 的 host）；IPv6 留待后续。host 字符集保守，port 1~65535。
const HOST_RE = /^[a-z0-9.-]{1,255}$/i;
const ONION_KEY_RE = /^[0-9a-f]{64}$/; // 32 字节 x25519 公钥的 hex
const BW_RE = /^[0-9a-z]$/; // 单字符带宽档位提示（v1 仅信息性，供选路加权；默认 'm'）
const STAKE_RE = /^(0|[0-9a-f]{64})$/; // '0'=v1 暂无质押；否则引用一笔 stake 交易的 txid

/** 一个中继的链上描述符（parseRelays 还原出的结构）。 */
export interface RelayDescriptor {
  address: string; // 中继 ed25519 钱包地址（= 链上身份 / ntor 握手里的 relayId）
  onionPubHex: string; // 64-hex x25519 onion 公钥（ntor 静态密钥 B）
  host: string; // cell 入口主机
  port: number; // cell 入口端口（独立于共识 P2P 端口，见 relay/server.ts）
  bandwidth: string; // 单字符档位提示
  stakeTxid: string; // '0' 或 64-hex
}

/** 把字段拼成 memo 串。 */
export function buildRelayMemo(
  onionPubHex: string,
  host: string,
  port: number,
  bandwidth = 'm',
  stakeTxid = '0',
): string {
  return `${RELAY_PREFIX}${onionPubHex}|${host}:${port}|${bandwidth}|${stakeTxid}`;
}

/** 校验各字段；返回 memo 或错误（发布前用，对齐 makeNameClaim 风格）。 */
export function makeRelayClaim(
  onionPubHex: string,
  host: string,
  port: number,
  bandwidth = 'm',
  stakeTxid = '0',
): { ok: boolean; memo?: string; error?: string } {
  if (!ONION_KEY_RE.test(onionPubHex)) return { ok: false, error: 'onion 公钥须为 64 位小写 hex' };
  if (!HOST_RE.test(host) || host.includes(':')) return { ok: false, error: 'host 非法（v1 仅 IPv4/主机名）' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port 须为 1~65535' };
  if (!BW_RE.test(bandwidth)) return { ok: false, error: 'bandwidth 须为单个 [0-9a-z]' };
  if (!STAKE_RE.test(stakeTxid)) return { ok: false, error: "stake 须为 '0' 或 64-hex txid" };
  const memo = buildRelayMemo(onionPubHex, host, port, bandwidth, stakeTxid);
  if ([...memo].length > MAX_MEMO) return { ok: false, error: '描述符过长' };
  return { ok: true, memo };
}

/** 解析单条 memo → 描述符字段（不含 address，由调用方补 tx.from）。非法返回 null。 */
function parseRelayMemo(memo: string): Omit<RelayDescriptor, 'address'> | null {
  if (!memo.startsWith(RELAY_PREFIX)) return null;
  const parts = memo.slice(RELAY_PREFIX.length).split('|');
  if (parts.length !== 4) return null;
  const [onionPubHex, hostPort, bandwidth, stakeTxid] = parts;
  if (!ONION_KEY_RE.test(onionPubHex)) return null;
  if (!BW_RE.test(bandwidth)) return null;
  if (!STAKE_RE.test(stakeTxid)) return null;
  const colon = hostPort.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = hostPort.slice(0, colon);
  const port = Number(hostPort.slice(colon + 1));
  if (!HOST_RE.test(host) || host.includes(':')) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { onionPubHex, host, port, bandwidth, stakeTxid };
}

/**
 * 扫整条链还原中继名录。规则：
 * - 描述符必须是**自转**（tx.from === tx.to）且 burn=0 —— 自转的合法签名即证明发布者拥有该地址。
 * - **latest-wins**：同一地址的最后一笔合法描述符胜出（支持换 host / 轮换 onion 公钥）。
 * 纯函数（只依赖链）→ reorg 安全；同块内多笔按交易数组顺序，确定性。
 */
export function parseRelays(chain: Block[]): Map<string, RelayDescriptor> {
  const dir = new Map<string, RelayDescriptor>();
  for (const b of chain) {
    for (const tx of b.transactions) {
      const m = tx.memo;
      if (!m || !m.startsWith(RELAY_PREFIX)) continue;
      if (tx.from !== tx.to) continue; // 必须自转，防把别人付款误判成描述符
      if ((tx.burn ?? 0) > 0) continue; // 排除消息形态
      const d = parseRelayMemo(m);
      if (!d) continue;
      dir.set(tx.from, { address: tx.from, ...d }); // latest-wins：后者覆盖前者
    }
  }
  return dir;
}

/** 地址 → 描述符（无则 undefined）。 */
export function lookupRelay(dir: Map<string, RelayDescriptor>, address: string): RelayDescriptor | undefined {
  return dir.get(address);
}

/** 名录转可 JSON 序列化数组（给 API / 客户端选路）。 */
export function relaysToJSON(dir: Map<string, RelayDescriptor>): RelayDescriptor[] {
  return [...dir.values()];
}
