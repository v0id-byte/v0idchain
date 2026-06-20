// 集市：完全建在“转账 + memo”之上，不改共识。
// 上架 = 自转 1 币 memo `MKT|<价格>|<标题>`；购买 = 付款给卖家 memo `BUY|<上架txid>`；撤单 = memo `DEL|<上架txid>`。
// 任何节点扫一遍链就能把这些 memo 还原成商品列表 —— 商品随链全网同步、永久可查，零中心化服务器。
import type { Block } from './block.js';
import { MAX_MEMO } from './config.js';

export const MKT_PREFIX = 'MKT|';
export const BUY_PREFIX = 'BUY|';
export const DEL_PREFIX = 'DEL|';
export const MAX_TITLE = 100;

export interface Listing {
  id: string; // 上架交易的 txid
  title: string;
  price: number;
  seller: string;
  timestamp: number;
  delisted: boolean;
  sold: boolean;
  soldBy?: string;
}

export function buildListMemo(price: number, title: string): string {
  return `${MKT_PREFIX}${price}|${title}`;
}

/** 校验“上架”入参；返回 memo 或错误 */
export function makeListing(price: number, title: string): { ok: boolean; memo?: string; error?: string } {
  if (!Number.isInteger(price) || price <= 0) return { ok: false, error: '价格必须是正整数' };
  if (!title || [...title].length > MAX_TITLE) return { ok: false, error: `标题需 1~${MAX_TITLE} 字` };
  const memo = buildListMemo(price, title);
  if ([...memo].length > MAX_MEMO) return { ok: false, error: '标题过长' };
  return { ok: true, memo };
}

/** 扫整条链，把 MKT/BUY/DEL memo 还原成商品列表（最新在前） */
export function parseMarket(chain: Block[]): Listing[] {
  const listings = new Map<string, Listing>();
  const delisted = new Set<string>();
  const sold = new Map<string, string>(); // listingId → buyer

  for (const b of chain) {
    for (const tx of b.transactions) {
      const m = tx.memo;
      if (!m) continue;

      if (m.startsWith(MKT_PREFIX) && tx.from === tx.to) {
        // 上架必须是“自转”，防止把别人的付款误判成上架
        const rest = m.slice(MKT_PREFIX.length);
        const sep = rest.indexOf('|');
        if (sep < 0) continue;
        const price = Number(rest.slice(0, sep));
        const title = rest.slice(sep + 1);
        if (!Number.isInteger(price) || price <= 0 || !title) continue;
        listings.set(tx.txid, {
          id: tx.txid, title, price, seller: tx.from, timestamp: tx.timestamp, delisted: false, sold: false,
        });
      } else if (m.startsWith(DEL_PREFIX)) {
        const id = m.slice(DEL_PREFIX.length);
        const l = listings.get(id);
        if (l && tx.from === l.seller) delisted.add(id); // 只有卖家本人能撤
      } else if (m.startsWith(BUY_PREFIX)) {
        const id = m.slice(BUY_PREFIX.length);
        const l = listings.get(id);
        // 购买需付给卖家且金额 ≥ 标价；首笔有效购买为准（链序保证购买在上架之后）
        if (l && tx.to === l.seller && tx.amount >= l.price && !sold.has(id)) sold.set(id, tx.from);
      }
    }
  }

  const out: Listing[] = [];
  for (const l of listings.values()) {
    l.delisted = delisted.has(l.id);
    const buyer = sold.get(l.id);
    if (buyer) {
      l.sold = true;
      l.soldBy = buyer;
    }
    out.push(l);
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}
