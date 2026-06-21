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
