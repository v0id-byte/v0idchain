// 链上消息：完全建在“消息交易”（amount 0 + burn>0 + memo 正文）之上。
// 任何节点扫一遍链，就能把这些交易还原成消息列表 —— 消息随链全网同步、永久可查，零中心化服务器。
// 收件箱 = to 是我的消息；发件箱 = from 是我的消息。memo 即正文，无需任何前缀。
import type { Block } from './block.js';
import {
  NULL_ADDRESS,
  RED_PREFIX,
  CLAIM_PREFIX,
  REFUND_PREFIX,
  STAKE_PREFIX,
  UNSTAKE_PREFIX,
  SLASH_PREFIX,
  IDCLAIM_PREFIX,
  IDRELEASE_PREFIX,
} from './config.js';
import {
  PET_PREFIX,
  PETX_PREFIX,
  PETBREED_PREFIX,
  PETEVO_PREFIX,
  PETFARM_PREFIX,
  PETUNSTATION_PREFIX,
  PET_BREED_COST,
  PET_EVO_COST,
  PETFARM_COST,
} from './pets.js';
import { FISH_PREFIX } from './fishing.js';
import {
  LAND_PREFIX,
  ZONE_PREFIX,
  PLANT_PREFIX,
  HARVEST_PREFIX,
  CROPX_PREFIX,
  ZONE_TYPES,
  CROPS,
  SEED_COST,
  ZONE_COST,
  HARVEST_BURN,
  type Crop,
} from './farm.js';
import { MINE_PREFIX, parseMineMemo, mineDiscoveryBurn, mineMaterialBurn } from './mining.js';

export interface ChainMessage {
  txid: string;
  from: string; // 发件人
  to: string; // 收件人
  text: string; // 正文（= 交易 memo）
  burn: number; // 这条消息烧掉的 $V0ID
  timestamp: number;
  height: number; // 所在区块高度
}

/** 一笔交易是否“链上消息”：不转币（amount 0）但销毁了币（burn>0）。coinbase/创世天然不满足，自动排除。 */
export function isMessageTx(tx: { amount: number; burn?: number }): boolean {
  return tx.amount === 0 && (tx.burn ?? 0) > 0;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 某笔交易是否属于“协议层约定”（崽/红包/钓鱼/农场/矿洞等建在 memo 上的子系统），而非真人私信正文。
 * 这些子系统也会发出 `amount=0 + burn>0` 形态的交易（如孵崽 `PET|`、铸渔获 `FISH|`、买地 `LAND|`/种植 `PLANT|` 都是自转烧币），
 * 与链上消息的形态撞型 → 不排除的话会被 parseMessages 误收进收件箱。消息防刷底线上线后，这个判定还多了一层
 * 经济含义：被排除的交易不受烧币下限约束，故此处按两类前缀区别对待：
 *
 * ① STAKE/UNSTAKE/SLASH/RED/CLAIM/REFUND/IDCLAIM/IDRELEASE：**共识层**（blockchain.ts redOpError）已原生
 *    校验合法性，篡改 burn/payload 的交易根本进不了链，`startsWith` 足够，不构成绕过消息门槛的风险。
 * ② PET/FISH/LAND/ZONE/PLANT/HARVEST/CROPX/MINE 系：共识层完全不管，合法性全靠各自 parseXxx(chain) 在
 *    展示层重放判定——纯 `startsWith` 会被“前缀相同、payload 塞垃圾”套壳绕过消息烧币下限（新增的经济边界），
 *    故逐一核对 payload 格式 + 该操作要求的精确/达标烧币额，**复用各模块导出的现成常量/函数**而非在此重复
 *    定义一套规则，避免与游戏模块演进脱节。
 *
 * ⚠️ 刻意**不含** `ENC|`（端到端加密私信，本就是私信正文，必须留在收件箱）与 `NAME|`（抢注是 burn=0 的自转，
 * 形态上压根不是消息，isMessageTx 已天然排除，无需也不该在此列）。
 */
export function isProtocolMemo(tx: { memo: string; burn?: number }): boolean {
  const { memo } = tx;
  const burn = tx.burn ?? 0;

  // ① 共识层已原生校验，不合法形态进不了链，startsWith 足够
  if (
    memo.startsWith(STAKE_PREFIX) ||
    memo.startsWith(UNSTAKE_PREFIX) ||
    memo.startsWith(SLASH_PREFIX) ||
    memo.startsWith(RED_PREFIX) ||
    memo.startsWith(CLAIM_PREFIX) ||
    memo.startsWith(REFUND_PREFIX) ||
    memo.startsWith(IDCLAIM_PREFIX) ||
    memo.startsWith(IDRELEASE_PREFIX)
  ) {
    return true;
  }

  // ② 仅应用层校验，逐一核对 payload + 烧币额，防「前缀相同+塞垃圾」绕过消息门槛
  if (memo === PET_PREFIX) return true; // 孵化：memo 精确、burn 只要求 >0（无固定值），无 payload 可塞
  if (memo === FISH_PREFIX) return true; // 铸渔获：同上
  if (memo === CROPX_PREFIX) return true; // 预留前缀（尚未实现转移逻辑），无已知格式，精确匹配最保守

  if (memo.startsWith(PETX_PREFIX)) return HEX64.test(memo.slice(PETX_PREFIX.length)); // 送崽：amount>0 不烧币，payload=petId
  if (memo.startsWith(PETUNSTATION_PREFIX)) return HEX64.test(memo.slice(PETUNSTATION_PREFIX.length)); // 召回：免费，payload=petId
  if (memo.startsWith(PETBREED_PREFIX)) {
    const parts = memo.slice(PETBREED_PREFIX.length).split('|');
    return parts.length === 2 && parts.every((p) => HEX64.test(p)) && burn === PET_BREED_COST;
  }
  if (memo.startsWith(PETEVO_PREFIX)) {
    return HEX64.test(memo.slice(PETEVO_PREFIX.length)) && burn === PET_EVO_COST;
  }
  if (memo.startsWith(PETFARM_PREFIX)) {
    const parts = memo.slice(PETFARM_PREFIX.length).split('|');
    return parts.length === 2 && parts.every((p) => HEX64.test(p)) && burn === PETFARM_COST;
  }
  if (memo.startsWith(LAND_PREFIX)) {
    // 地价随链上状态浮动（下限需重放 soldTotal/velocity 才能算出），此处无法精确核验金额；
    // 但 payload 收紧为纯数字已杜绝夹带任意字符串，真实地价下限仍由 parseFarm/共识层的经济防线把关。
    return /^\d+$/.test(memo.slice(LAND_PREFIX.length));
  }
  if (memo.startsWith(ZONE_PREFIX)) {
    const rest = memo.slice(ZONE_PREFIX.length);
    const sep = rest.indexOf('|');
    if (sep < 0) return false;
    const plotN = rest.slice(0, sep);
    const type = rest.slice(sep + 1);
    return /^\d+$/.test(plotN) && (ZONE_TYPES as readonly string[]).includes(type) && burn === ZONE_COST;
  }
  if (memo.startsWith(PLANT_PREFIX)) {
    const parts = memo.slice(PLANT_PREFIX.length).split('|');
    if (parts.length !== 3) return false;
    const [zoneId, crop, slot] = parts;
    if (!HEX64.test(zoneId) || !(CROPS as readonly string[]).includes(crop) || !/^\d+$/.test(slot)) return false;
    return burn === SEED_COST[crop as Crop];
  }
  if (memo.startsWith(HARVEST_PREFIX)) {
    return HEX64.test(memo.slice(HARVEST_PREFIX.length)) && burn === HARVEST_BURN;
  }
  if (memo.startsWith(MINE_PREFIX)) {
    const m = parseMineMemo(memo);
    if (!m) return false;
    const needed = m.type === 'discovery' ? mineDiscoveryBurn(m.depth, m.kind) : mineMaterialBurn(m.kind, m.count);
    return burn >= needed;
  }

  return false;
}

/** 是否“真实消息”（应受消息防刷底线约束，见 config.ts minMessageBurnFor）：amount=0+burn>0 且非协议层 memo。 */
export function isRealMessage(tx: { amount: number; burn?: number; memo: string }): boolean {
  return isMessageTx(tx) && !isProtocolMemo(tx);
}

/** 扫整条链，把所有消息交易还原成消息列表（最新在前）。协议层 memo（PET/RED/FISH…）不算私信，跳过。 */
export function parseMessages(chain: Block[]): ChainMessage[] {
  const out: ChainMessage[] = [];
  for (const b of chain) {
    for (const tx of b.transactions) {
      if (!isMessageTx(tx)) continue;
      if (isProtocolMemo(tx)) continue;
      out.push({
        txid: tx.txid,
        from: tx.from,
        to: tx.to,
        text: tx.memo,
        burn: tx.burn ?? 0,
        timestamp: tx.timestamp,
        height: b.index,
      });
    }
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/** 收集链上出现过的全部地址（作为 from 或 to），用于“新地址首次上链”发现。排除虚空地址。 */
export function collectAddresses(chain: Block[]): Set<string> {
  const set = new Set<string>();
  for (const b of chain) {
    for (const tx of b.transactions) {
      if (tx.from !== NULL_ADDRESS) set.add(tx.from);
      if (tx.to !== NULL_ADDRESS) set.add(tx.to);
    }
  }
  return set;
}
