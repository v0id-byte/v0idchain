package com.v0id.wallet.core

/**
 * 集市：完全建在“转账 + memo”之上，不改共识（余额走普通转账，本文件只做 memo 解析/构造）。
 * 上架 = 自转 1 币 memo `MKT|<价格>|<标题>`；购买 = 付款给卖家 memo `BUY|<上架txid>`；撤单 = memo `DEL|<上架txid>`。
 * 对应 packages/core/src/market.ts —— 解析规则必须一致。
 */
data class Listing(
    val id: String,          // 上架交易 txid
    val title: String,
    val price: Long,
    val seller: String,
    val timestamp: Long,
    val delisted: Boolean,
    val sold: Boolean,
    val soldBy: String?,
)

fun buildListMemo(price: Long, title: String): String = "$MKT_PREFIX$price|$title"

/** 校验“上架”入参；返回 memo 或错误。 */
fun makeListing(price: Long, title: String): Pair<String?, String?> {
    if (price <= 0L) return null to "价格必须是正整数"
    val t = title.trim()
    if (t.isEmpty() || t.codePointCount(0, t.length) > MAX_TITLE) return null to "标题需 1~$MAX_TITLE 字"
    val memo = buildListMemo(price, t)
    if (memo.codePointCount(0, memo.length) > MAX_MEMO) return null to "标题过长"
    return memo to null
}

/** 扫整条链，把 MKT/BUY/DEL memo 还原成商品列表（最新在前）。 */
fun parseMarket(chain: List<Block>): List<Listing> {
    val listings = HashMap<String, Listing>()
    val delisted = HashSet<String>()
    val sold = HashMap<String, String>()   // listingId → buyer

    for (b in chain) {
        for (tx in b.transactions) {
            val m = tx.memo
            if (m.isEmpty()) continue

            if (m.startsWith(MKT_PREFIX) && tx.from == tx.to) {
                // 上架必须“自转”，防止把别人的付款误判成上架
                val rest = m.substring(MKT_PREFIX.length)
                val sep = rest.indexOf('|')
                if (sep < 0) continue
                val price = rest.substring(0, sep).toLongOrNull() ?: continue
                val title = rest.substring(sep + 1)
                if (price <= 0L || title.isEmpty()) continue
                listings[tx.txid] = Listing(
                    id = tx.txid, title = title, price = price, seller = tx.from,
                    timestamp = tx.timestamp, delisted = false, sold = false, soldBy = null,
                )
            } else if (m.startsWith(DEL_PREFIX)) {
                val id = m.substring(DEL_PREFIX.length)
                val l = listings[id]
                if (l != null && tx.from == l.seller) delisted.add(id)   // 只有卖家本人能撤
            } else if (m.startsWith(BUY_PREFIX)) {
                val id = m.substring(BUY_PREFIX.length)
                val l = listings[id]
                // 购买需付给卖家且金额 ≥ 标价；首笔有效购买为准
                if (l != null && tx.to == l.seller && tx.amount >= l.price && sold[id] == null) {
                    sold[id] = tx.from
                }
            }
        }
    }

    return listings.values
        .map { l ->
            l.copy(delisted = delisted.contains(l.id), sold = sold[l.id] != null, soldBy = sold[l.id])
        }
        .sortedByDescending { it.timestamp }
}
