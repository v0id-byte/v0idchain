package com.v0id.wallet.core

private val HEX = "0123456789abcdef".toCharArray()

/** 字节数组 → 小写 hex（全协议哈希/签名/公钥统一小写）。 */
fun ByteArray.toHex(): String {
    val out = CharArray(size * 2)
    for (i in indices) {
        val v = this[i].toInt() and 0xff
        out[i * 2] = HEX[v ushr 4]
        out[i * 2 + 1] = HEX[v and 0x0f]
    }
    return String(out)
}

/** hex → 字节数组。容忍可选的 0x 前缀（地址/私钥常带；txid 不带）。 */
fun String.hexToBytes(): ByteArray {
    val s = if (startsWith("0x") || startsWith("0X")) substring(2) else this
    require(s.length % 2 == 0) { "hex 长度必须为偶数：${s.length}" }
    val out = ByteArray(s.length / 2)
    for (i in out.indices) {
        val hi = Character.digit(s[i * 2], 16)
        val lo = Character.digit(s[i * 2 + 1], 16)
        require(hi >= 0 && lo >= 0) { "非法 hex 字符" }
        out[i] = ((hi shl 4) or lo).toByte()
    }
    return out
}
