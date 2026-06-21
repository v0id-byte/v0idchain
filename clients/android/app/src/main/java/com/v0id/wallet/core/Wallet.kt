package com.v0id.wallet.core

import java.security.SecureRandom

/**
 * 钱包 = 一对 ed25519 密钥 + 派生地址。
 * 私钥 = 32 字节种子；公钥 = 由种子派生的 32 字节；地址 = '0x' + 公钥 hex。
 */
class Wallet(val seed: ByteArray) {
    init { require(seed.size == 32) { "私钥种子必须是 32 字节" } }

    val publicKey: ByteArray = Ed25519.publicKeyFromSeed(seed)
    val address: String = "0x" + publicKey.toHex()
    val privateKeyHex: String get() = seed.toHex()

    companion object {
        /** 随机生成新钱包（32 字节 CSPRNG 种子）。 */
        fun generate(): Wallet {
            val seed = ByteArray(32)
            SecureRandom().nextBytes(seed)
            return Wallet(seed)
        }

        /** 从 64-hex 私钥导入（容忍 0x 前缀、首尾空白）。 */
        fun fromPrivateKeyHex(hex: String): Wallet {
            val clean = hex.trim().removePrefix("0x").removePrefix("0X")
            require(clean.length == 64 && clean.all { it.isHex() }) {
                "私钥必须是 64 个 hex 字符（32 字节）"
            }
            return Wallet(clean.hexToBytes())
        }

        private fun Char.isHex(): Boolean =
            this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'
    }
}
