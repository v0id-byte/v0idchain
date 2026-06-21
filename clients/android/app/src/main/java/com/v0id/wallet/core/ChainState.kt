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

/**
 * 重放整条链得到余额/nonce（§4）。对每块每笔，按顺序：
 *   若 from != NULL_ADDRESS： balance[from] -= amount+fee+(burn||0)；若 burn>0 → balance[NULL] += burn；nonce[from] += 1
 *   balance[to] += amount
 */
fun computeState(chain: List<Block>): ChainState {
    val balances = HashMap<String, Long>()
    val nonces = HashMap<String, Long>()
    fun credit(addr: String, amt: Long) { balances[addr] = (balances[addr] ?: 0L) + amt }

    for (block in chain) {
        for (tx in block.transactions) {
            if (tx.from != NULL_ADDRESS) {
                val burn = tx.burn ?: 0L
                credit(tx.from, -(tx.amount + tx.fee + burn))
                if (burn > 0L) credit(NULL_ADDRESS, burn)
                nonces[tx.from] = (nonces[tx.from] ?: 0L) + 1L
            }
            credit(tx.to, tx.amount)
        }
    }
    return ChainState(balances, nonces)
}
