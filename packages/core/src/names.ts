// 链上昵称（全网唯一抢注，先到先得）：完全建在“自转 + memo”之上，不改共识。
// 抢注 = 自转 1 币 memo `NAME|<名字>`；任何节点扫一遍链就能还原出 名字↔地址 注册表。
// 关键：抢注交易在旧节点眼里只是一笔合法自转 → 不造成软分叉，全网照收；只有要“显示”名字的客户端才需本解析。
import type { Block } from './block.js';
import { MAX_MEMO } from './config.js';

export const NAME_PREFIX = 'NAME|';
export const MAX_NAME = 20;
// 1~20 位小写字母/数字/下划线/连字符；不以 0x 开头（避免与地址混淆）。统一小写防同形冒充。
const NAME_RE = /^[a-z0-9_-]{1,20}$/;

/** 保留名：禁止抢注，防止冒充“央行/官方/系统”等权威身份做钓鱼。isValidName 拒绝 → 抢注与解析两端都挡住。 */
export const RESERVED_NAMES = new Set([
  'treasury', 'official', 'admin', 'system', 'null', 'v0id', 'v0idchain', 'genesis', 'coinbase',
]);

/** 合法昵称：字符集 + 不以 0x 开头 + 非保留名。入参应已小写（makeNameClaim/parseNames 都先规范化）。 */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && !name.startsWith('0x') && !RESERVED_NAMES.has(name);
}

export function buildNameMemo(name: string): string {
  return `${NAME_PREFIX}${name}`;
}

/** 校验并规范化（转小写）抢注名；返回 memo 或错误 */
export function makeNameClaim(name: string): { ok: boolean; memo?: string; error?: string } {
  const n = name.trim().toLowerCase();
  if (RESERVED_NAMES.has(n)) return { ok: false, error: `“${n}” 是保留名，禁止抢注` };
  if (!isValidName(n)) return { ok: false, error: '昵称需 1~20 位 小写字母/数字/_/-，且不以 0x 开头' };
  const memo = buildNameMemo(n);
  if ([...memo].length > MAX_MEMO) return { ok: false, error: '昵称过长' };
  return { ok: true, memo };
}

export interface NameRegistry {
  nameToOwner: Map<string, string>; // 名字 → 首位抢到者地址（永久绑定，先到先得）
  addressToName: Map<string, string>; // 地址 → 其当前显示名（= 它最近一次成功拥有的名字）
}

/**
 * 扫整条链还原昵称注册表。规则：
 * - 先到先得：某名字的**第一笔**合法抢注（按链序：区块序 + 块内交易序）胜出，之后别的地址再抢同名一律无效。
 * - 显示名：一个地址的当前显示名 = 它最近一次成功拥有的名字（同一地址可改名）。
 * 纯函数（只依赖链）→ reorg 安全；同块内多笔按交易数组顺序定胜负，确定性。
 */
export function parseNames(chain: Block[]): NameRegistry {
  const nameToOwner = new Map<string, string>();
  const addressToName = new Map<string, string>();
  for (const b of chain) {
    for (const tx of b.transactions) {
      const m = tx.memo;
      if (!m || !m.startsWith(NAME_PREFIX)) continue;
      if (tx.from !== tx.to) continue; // 抢注必须是“自转”，防止把别人的付款误判成抢注
      if ((tx.burn ?? 0) > 0) continue; // 排除“自发消息”（amount0+burn）——抢注是自转、非消息，避免双重归类
      // 读端规范化（trim+小写）与写端 makeNameClaim / lookupName 对齐：NAME|Alice 与 NAME|alice 解析为同一名字，
      // 不再出现“大写抢注上链却被静默丢弃、白付手续费”的写读不一致。
      const name = m.slice(NAME_PREFIX.length).trim().toLowerCase();
      if (!isValidName(name)) continue;
      const owner = nameToOwner.get(name);
      if (owner !== undefined && owner !== tx.from) continue; // 已被别人抢走 → 忽略
      if (owner === undefined) nameToOwner.set(name, tx.from); // 第一笔抢注者永久拥有
      addressToName.set(tx.from, name); // 本人最新一次抢注 → 成为其显示名
    }
  }
  return { nameToOwner, addressToName };
}

/** 地址 → 显示名（没有则 undefined） */
export function resolveAddressName(reg: NameRegistry, address: string): string | undefined {
  return reg.addressToName.get(address);
}

/** 名字 → 拥有者地址（没有则 undefined） */
export function lookupName(reg: NameRegistry, name: string): string | undefined {
  return reg.nameToOwner.get(name.trim().toLowerCase());
}

/** 把注册表转成可 JSON 序列化的纯对象（给 API / 仪表盘） */
export function registryToJSON(reg: NameRegistry): {
  nameToOwner: Record<string, string>;
  addressToName: Record<string, string>;
} {
  return {
    nameToOwner: Object.fromEntries(reg.nameToOwner),
    addressToName: Object.fromEntries(reg.addressToName),
  };
}
