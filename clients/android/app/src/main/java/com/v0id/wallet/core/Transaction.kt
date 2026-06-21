package com.v0id.wallet.core

/**
 * 交易。字段顺序与 packages/core 完全一致。
 * burn 为 null 或 0 = 普通转账；burn>0 = 链上消息（amount 恒 0）。
 */
data class Transaction(
    val from: String,
    val to: String,
    val amount: Long,
    val fee: Long,
    val nonce: Long,
    val timestamp: Long,
    val memo: String,
    val burn: Long?,        // 仅 >0 时计入 txid → 历史交易哈希逐字节不变
    val signature: String,
    val txid: String,
)

/**
 * txid 预映像 → sha256（CLIENT-PROTOCOL §3.2）。
 * preimage = JSON.stringify([from,to,amount,fee,nonce,timestamp,memo])；若 burn>0 再追加 burn。
 */
fun computeTxid(
    from: String,
    to: String,
    amount: Long,
    fee: Long,
    nonce: Long,
    timestamp: Long,
    memo: String,
    burn: Long?,
): String {
    val fields = mutableListOf<Any>(from, to, amount, fee, nonce, timestamp, memo)
    if ((burn ?: 0L) > 0L) fields.add(burn!!)
    return sha256Hex(JsonStringify.array(fields))
}

/**
 * 普通转账：本地构造 + 签名（§3.3：对 txid 解码出的 32 字节做 ed25519 签名）。
 * timestamp 由调用方传入（App 用 System.currentTimeMillis()，测试用固定值）。
 */
fun signTransaction(
    wallet: Wallet,
    to: String,
    amount: Long,
    nonce: Long,
    memo: String,
    fee: Long,
    timestamp: Long,
): Transaction {
    val txid = computeTxid(wallet.address, to, amount, fee, nonce, timestamp, memo, null)
    val signature = Ed25519.sign(txid.hexToBytes(), wallet.seed).toHex()
    return Transaction(wallet.address, to, amount, fee, nonce, timestamp, memo, null, signature, txid)
}

/**
 * 链上消息：amount 恒 0，burn>0（默认 MESSAGE_BURN），memo = 正文，另付 fee 给矿工。
 */
fun signMessage(
    wallet: Wallet,
    to: String,
    text: String,
    nonce: Long,
    burn: Long,
    fee: Long,
    timestamp: Long,
): Transaction {
    val txid = computeTxid(wallet.address, to, 0L, fee, nonce, timestamp, text, burn)
    val signature = Ed25519.sign(txid.hexToBytes(), wallet.seed).toHex()
    return Transaction(wallet.address, to, 0L, fee, nonce, timestamp, text, burn, signature, txid)
}

fun Transaction.isCoinbase(): Boolean = from == NULL_ADDRESS

/** 是否“链上消息”：不转币（amount 0）但烧了币（burn>0）。 */
fun Transaction.isMessage(): Boolean = amount == 0L && (burn ?: 0L) > 0L
