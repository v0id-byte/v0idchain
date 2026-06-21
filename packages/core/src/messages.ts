// 链上消息：完全建在“消息交易”（amount 0 + burn>0 + memo 正文）之上。
// 任何节点扫一遍链，就能把这些交易还原成消息列表 —— 消息随链全网同步、永久可查，零中心化服务器。
// 收件箱 = to 是我的消息；发件箱 = from 是我的消息。memo 即正文，无需任何前缀。
import type { Block } from './block.js';
import { NULL_ADDRESS } from './config.js';

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

/** 扫整条链，把所有消息交易还原成消息列表（最新在前） */
export function parseMessages(chain: Block[]): ChainMessage[] {
  const out: ChainMessage[] = [];
  for (const b of chain) {
    for (const tx of b.transactions) {
      if (!isMessageTx(tx)) continue;
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
