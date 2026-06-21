package com.v0id.wallet.core

/**
 * 链上抢红包：共识级托管 + 条件支付。对应 packages/core/src/redpacket.ts（纯函数）+ blockchain.ts（状态机）。
 * 三种操作（建在普通交易 + memo 上）：
 *   发红包 RED   ：转给托管地址（to==RED_ESCROW）amount=总额，memo `RED|<份数>|<r|e>`。
 *   抢红包 CLAIM ：amount=0，memo `CLAIM|<红包id>`。随机源 = 该 CLAIM 所在区块 hash（抢前不可预测）。
 *   退款   REFUND：amount=0，memo `REFUND|<红包id>`。仅发起人、且过 RED_EXPIRY 块后取回剩余。
 * ⚠️ CLAIM/REFUND 的余额变更由共识从托管池支付 → 客户端 computeState 必须复刻同一套 applyTx（见 ChainState.kt），
 *    否则抢/退过红包的地址余额会与全网漂移。
 */
enum class RedMode(val raw: String) {
    RANDOM("r"), EQUAL("e");

    companion object {
        fun fromRaw(s: String): RedMode? = entries.firstOrNull { it.raw == s }
    }
}

/** 红包的一次领取记录。 */
data class RedClaim(val who: String, val amount: Long, val height: Long)

/** 红包视图（只读展示用）。 */
data class RedPacketView(
    val id: String,          // 创建交易 txid
    val creator: String,
    val total: Long,
    val count: Int,
    val mode: RedMode,
    val remaining: Long,
    val remainingCount: Int,
    val createHeight: Long,
    val claims: List<RedClaim>,
    val refunded: Boolean,
    val done: Boolean,       // 抢完或已退款
)

/** RED|<份数>|<r|e> 的解析结果。 */
data class RedMeta(val count: Int, val mode: RedMode)

/** 解析 RED|<份数>|<r|e>；非法返回 null。 */
fun parseRedCreate(memo: String): RedMeta? {
    if (!memo.startsWith(RED_PREFIX)) return null
    val rest = memo.substring(RED_PREFIX.length)
    val sep = rest.indexOf('|')
    if (sep < 0) return null
    val count = rest.substring(0, sep).toIntOrNull() ?: return null
    if (count < 1 || count > MAX_RED_COUNT) return null
    val mode = RedMode.fromRaw(rest.substring(sep + 1)) ?: return null
    return RedMeta(count, mode)
}

/** CLAIM|<id> → id（须像 64-hex 小写 txid）；否则 null。 */
fun parseClaimId(memo: String): String? = idAfter(CLAIM_PREFIX, memo)

/** REFUND|<id> → id；否则 null。 */
fun parseRefundId(memo: String): String? = idAfter(REFUND_PREFIX, memo)

private fun idAfter(prefix: String, memo: String): String? {
    if (!memo.startsWith(prefix)) return null
    val id = memo.substring(prefix.length)
    if (id.length != 64) return null
    if (!id.all { it in '0'..'9' || it in 'a'..'f' }) return null
    return id
}

/** “amount=0 也合法”的红包操作（CLAIM/REFUND）。 */
fun isZeroAmountOp(memo: String): Boolean =
    memo.startsWith(CLAIM_PREFIX) || memo.startsWith(REFUND_PREFIX)

/** 拼手气随机源：区块 hash + CLAIM txid 一起哈希 → 确定性、各端一致、抢前不可预测。 */
fun redSeed(blockHash: String, claimTxid: String): String = sha256Hex(blockHash + claimTxid)

/** 一次领取的金额（整数，共识关键 —— 必须与全网算出同一结果）。 */
fun computeShare(remaining: Long, remainingCount: Int, mode: RedMode, seedHex: String): Long {
    if (remainingCount <= 1) return remaining
    if (mode == RedMode.EQUAL) return remaining / remainingCount
    val maxShare = remaining - (remainingCount - 1)
    val upper = maxOf(1L, minOf((2 * remaining) / remainingCount, maxShare))
    // 48-bit 随机源：取 seedHex 前 12 个 hex 字符。
    val seed = seedHex.take(12).toLongOrNull(16) ?: 0L
    return 1 + (seed % upper)
}

/** 校验“发红包”入参；返回 (memo, total) 或错误。 */
fun makeRedPacket(total: Long, count: Int, mode: RedMode): Pair<String?, String?> {
    if (total < 1L) return null to "红包总额必须是正整数"
    if (count < 1 || count > MAX_RED_COUNT) return null to "份数需 1~$MAX_RED_COUNT"
    if (total < count) return null to "总额需 ≥ 份数（每份至少 1）：$total < $count"
    return "$RED_PREFIX$count|${mode.raw}" to null
}

/** 扫整条链还原所有红包及领取记录（只读展示用；与共识同源 computeShare → 展示额 = 链上实际入账）。 */
fun parseRedPackets(chain: List<Block>): List<RedPacketView> {
    val pools = HashMap<String, RedPacketView>()
    for (b in chain) {
        for (tx in b.transactions) {
            val m = tx.memo
            if (m.isEmpty()) continue

            if (tx.to == RED_ESCROW_ADDRESS) {
                val red = parseRedCreate(m)
                if (red != null && tx.amount >= red.count) {
                    pools[tx.txid] = RedPacketView(
                        id = tx.txid, creator = tx.from, total = tx.amount, count = red.count,
                        mode = red.mode, remaining = tx.amount, remainingCount = red.count,
                        createHeight = b.index, claims = emptyList(), refunded = false, done = false,
                    )
                    continue
                }
            }

            val claimId = parseClaimId(m)
            if (claimId != null) {
                val p = pools[claimId]
                if (p != null && !p.done && p.remainingCount > 0 && tx.from != p.creator &&
                    p.claims.none { it.who == tx.from }
                ) {
                    val share = computeShare(
                        p.remaining, p.remainingCount, p.mode,
                        redSeed(b.hash, tx.txid),
                    )
                    val newRemainingCount = p.remainingCount - 1
                    pools[claimId] = p.copy(
                        claims = p.claims + RedClaim(tx.from, share, b.index),
                        remaining = p.remaining - share,
                        remainingCount = newRemainingCount,
                        done = newRemainingCount == 0,
                    )
                    continue
                }
            }

            val refundId = parseRefundId(m)
            if (refundId != null) {
                val p = pools[refundId]
                if (p != null && !p.done && tx.from == p.creator && p.remaining > 0) {
                    pools[refundId] = p.copy(refunded = true, remaining = 0, remainingCount = 0, done = true)
                }
            }
        }
    }
    return pools.values.sortedByDescending { it.createHeight }
}
