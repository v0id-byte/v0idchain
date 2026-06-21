package com.v0id.wallet.core

import java.security.MessageDigest

/** 空地址：coinbase / 创世 / 销毁（虚空）地址。客户端永不构造 coinbase/创世。 */
const val NULL_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000000"

/** 对一段字节做 SHA-256。 */
fun sha256(bytes: ByteArray): ByteArray =
    MessageDigest.getInstance("SHA-256").digest(bytes)

/** sha256Hex(s)：对字符串的 UTF-8 字节做 SHA-256，输出小写 hex（CLIENT-PROTOCOL §2）。 */
fun sha256Hex(s: String): String =
    sha256(s.toByteArray(Charsets.UTF_8)).toHex()

/** 地址合法性：'0x' + 64 个小写 hex（= ed25519 公钥）。 */
fun isValidAddress(address: String): Boolean =
    Regex("^0x[0-9a-f]{64}$").matches(address)

/** 从地址取回公钥 hex（地址内含公钥，验签直接用）。 */
fun addressToPublicKeyHex(address: String): String =
    if (address.startsWith("0x")) address.substring(2) else address
