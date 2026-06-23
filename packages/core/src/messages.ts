// 链上消息：完全建在“消息交易”（amount 0 + burn>0 + memo 正文）之上。
// 任何节点扫一遍链，就能把这些交易还原成消息列表 —— 消息随链全网同步、永久可查，零中心化服务器。
// 收件箱 = to 是我的消息；发件箱 = from 是我的消息。memo 即正文，无需任何前缀。
import type { Block } from './block.js';
import { NULL_ADDRESS, RED_PREFIX, CLAIM_PREFIX, REFUND_PREFIX } from './config.js';
import { PET_PREFIX, PETX_PREFIX } from './pets.js';
import { FISH_PREFIX } from './fishing.js';
import { LAND_PREFIX, ZONE_PREFIX, PLANT_PREFIX, HARVEST_PREFIX, CROPX_PREFIX } from './farm.js';

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

/**
 * 某 memo 是否属于“协议层约定”（崽/红包/钓鱼/农场等建在 memo 上的子系统），而非真人私信正文。
 * 这些子系统也会发出 `amount=0 + burn>0` 形态的交易（如孵崽 `PET|`、铸渔获 `FISH|`、买地 `LAND|`/种植 `PLANT|` 都是自转烧币），
 * 与链上消息的形态撞型 → 不排除的话会被 parseMessages 误收进收件箱。集中在此判定，便于以后新增子系统时一处维护。
 *
 * ⚠️ 刻意**不含** `ENC|`（端到端加密私信，本就是私信正文，必须留在收件箱）与 `NAME|`（抢注是 burn=0 的自转，
 * 形态上压根不是消息，isMessageTx 已天然排除，无需也不该在此列）。
 */
export function isProtocolMemo(memo: string): boolean {
  return (
    memo.startsWith(PET_PREFIX) ||
    memo.startsWith(PETX_PREFIX) ||
    memo.startsWith(RED_PREFIX) ||
    memo.startsWith(CLAIM_PREFIX) ||
    memo.startsWith(REFUND_PREFIX) ||
    memo.startsWith(FISH_PREFIX) ||
    memo.startsWith(LAND_PREFIX) ||
    memo.startsWith(ZONE_PREFIX) ||
    memo.startsWith(PLANT_PREFIX) ||
    memo.startsWith(HARVEST_PREFIX) ||
    memo.startsWith(CROPX_PREFIX)
  );
}

/** 扫整条链，把所有消息交易还原成消息列表（最新在前）。协议层 memo（PET/RED/FISH…）不算私信，跳过。 */
export function parseMessages(chain: Block[]): ChainMessage[] {
  const out: ChainMessage[] = [];
  for (const b of chain) {
    for (const tx of b.transactions) {
      if (!isMessageTx(tx)) continue;
      if (isProtocolMemo(tx.memo)) continue;
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
