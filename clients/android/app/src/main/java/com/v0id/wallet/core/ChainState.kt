package com.v0id.wallet.core

/** 重放全链算出的状态：余额表 + nonce 表（CLIENT-PROTOCOL §4）。 */
data class ChainState(
    val balances: Map<String, Long>,
    val nonces: Map<String, Long>,
) {
    fun balanceOf(address: String): Long = balances[address] ?: 0L
    fun nonceOf(address: String): Long = nonces[address] ?: 0L
    /** 全网已烧进虚空的 $V0ID 总额。 */
    val burned: Long get() = balances[NULL_ADDRESS] ?: 0L
}

/** 红包托管池（重放时的临时状态）。 */
private data class RedPool(var remaining: Long, var remainingCount: Int, val mode: RedMode)

/**
 * 重放整条链得到余额/nonce（§4）。复刻 blockchain.ts 的 computeState + applyTx：余额/nonce + 红包托管状态机。
 * ⚠️ 红包 CLAIM/REFUND 的入账来自托管池（不是本交易的 amount），必须按同一套派发公式重放，
 *    否则抢/退过红包的地址余额会与全网漂移。链由所连节点保证合法 → 这里只“应用”，不再校验。
 */
fun computeState(chain: List<Block>): ChainState {
    val balances = HashMap<String, Long>()
    val nonces = HashMap<String, Long>()
    val pools = HashMap<String, RedPool>()
    fun credit(addr: String, amt: Long) { balances[addr] = (balances[addr] ?: 0L) + amt }
    fun bump(addr: String) { nonces[addr] = (nonces[addr] ?: 0L) + 1L }

    for (block in chain) {
        for (tx in block.transactions) {
            if (tx.isCoinbase()) { credit(tx.to, tx.amount); continue }   // 矿工/预挖收款，无 nonce
            val m = tx.memo

            // 发红包：转给托管地址 → 锁总额、开池。余额效果 = 普通转账到托管，额外开池。
            if (tx.to == RED_ESCROW_ADDRESS && m.startsWith(RED_PREFIX)) {
                val meta = parseRedCreate(m)
                if (meta != null && tx.amount >= meta.count) {
                    credit(tx.from, -(tx.amount + tx.fee))
                    credit(RED_ESCROW_ADDRESS, tx.amount)
                    pools[tx.txid] = RedPool(tx.amount, meta.count, meta.mode)
                    bump(tx.from)
                    continue
                }
            }
            // 抢红包：从托管派一份（拼手气随机额由所在区块 hash 决定）
            if (m.startsWith(CLAIM_PREFIX) && tx.amount == 0L) {
                val id = parseClaimId(m)
                val p = if (id != null) pools[id] else null
                if (p != null) {
                    val share = computeShare(p.remaining, p.remainingCount, p.mode, redSeed(block.hash, tx.txid))
                    credit(tx.from, share - tx.fee)        // 收到 share、付出 fee
                    credit(RED_ESCROW_ADDRESS, -share)
                    p.remaining -= share
                    p.remainingCount -= 1
                    bump(tx.from)
                    continue
                }
            }
            // 退款：发起人取回剩余
            if (m.startsWith(REFUND_PREFIX) && tx.amount == 0L) {
                val id = parseRefundId(m)
                val p = if (id != null) pools[id] else null
                if (p != null) {
                    val amt = p.remaining
                    credit(tx.from, amt - tx.fee)
                    credit(RED_ESCROW_ADDRESS, -amt)
                    p.remaining = 0
                    p.remainingCount = 0
                    bump(tx.from)
                    continue
                }
            }

            // 普通交易（转账/消息/昵称/集市）
            val burn = tx.burn ?: 0L
            credit(tx.from, -(tx.amount + tx.fee + burn))   // 发送方付 金额 + 手续费 + 销毁额
            credit(tx.to, tx.amount)                        // 收款方实收（消息为 0）
            if (burn > 0L) credit(NULL_ADDRESS, burn)       // 销毁额记入虚空（守恒、= 全网已烧毁）
            bump(tx.from)
        }
    }
    return ChainState(balances, nonces)
}
