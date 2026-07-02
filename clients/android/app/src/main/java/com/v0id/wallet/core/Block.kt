package com.v0id.wallet.core

/** 区块结构（与 packages/core 一致）。轻客户端只读取，不出块。 */
data class Block(
    val index: Long,
    val timestamp: Long,
    val prevHash: String,
    val transactions: List<Transaction>,
    val merkleRoot: String,
    val difficulty: Long,
    val nonce: Long,
    val miner: String,
    val hash: String,
)

/** 区块哈希：覆盖头部所有字段，与 packages/core/src/block.ts 的 calcBlockHash 逐字节一致。
 *  交易通过 merkleRoot 间接承诺。用于本地缓存/收到的新块的完整性校验。 */
fun Block.calcHash(): String =
    sha256Hex(JsonStringify.array(listOf(index, timestamp, prevHash, merkleRoot, difficulty, nonce, miner)))

/** 校验一段区块能接到 afterIndex/tipHash 指定的链尾上：高度连续 + prevHash 衔接 + 逐块哈希自洽。
 *  tipHash 为空串＝从创世块开始验（不查第一块的 prevHash）。用于本地缓存读回校验，也用于收到的新块。 */
fun verifyChainLink(blocks: List<Block>, afterIndex: Long, tipHash: String): Boolean {
    var prevIndex = afterIndex
    var prevHash = tipHash
    for (b in blocks) {
        if (b.index != prevIndex + 1) return false
        if (prevHash.isNotEmpty() && b.prevHash != prevHash) return false
        if (b.calcHash() != b.hash) return false
        prevIndex = b.index
        prevHash = b.hash
    }
    return true
}
