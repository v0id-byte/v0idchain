package com.v0id.wallet.core

/** 链上消息（由消息交易还原）。 */
data class ChainMessage(
    val txid: String,
    val from: String,   // 发件人
    val to: String,     // 收件人
    val text: String,   // 正文（= 交易 memo）
    val burn: Long,     // 这条消息烧掉的 $V0ID
    val timestamp: Long,
    val height: Long,   // 所在区块高度
)

/** 扫整条链，把所有消息交易还原成消息列表（最新在前）。 */
fun parseMessages(chain: List<Block>): List<ChainMessage> {
    val out = ArrayList<ChainMessage>()
    for (block in chain) {
        for (tx in block.transactions) {
            if (!tx.isMessage()) continue
            out.add(
                ChainMessage(
                    txid = tx.txid,
                    from = tx.from,
                    to = tx.to,
                    text = tx.memo,
                    burn = tx.burn ?: 0L,
                    timestamp = tx.timestamp,
                    height = block.index,
                ),
            )
        }
    }
    out.sortByDescending { it.timestamp }
    return out
}

/** 链上出现过的全部地址（作为 from 或 to），排除虚空 / 红包托管地址。用于“新地址首次上链”发现。 */
fun collectAddresses(chain: List<Block>): Set<String> {
    val set = LinkedHashSet<String>()
    for (block in chain) {
        for (tx in block.transactions) {
            if (tx.from != NULL_ADDRESS && tx.from != RED_ESCROW_ADDRESS) set.add(tx.from)
            if (tx.to != NULL_ADDRESS && tx.to != RED_ESCROW_ADDRESS) set.add(tx.to)
        }
    }
    return set
}
