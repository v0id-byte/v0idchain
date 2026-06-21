package com.v0id.wallet.core

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

/**
 * RFC 8032 ed25519（标准 / 纯 Ed25519，无 context）。
 * 直接用 BouncyCastle 低层 crypto 类，不注册 JCE Provider，避免与 Android 内置的旧版 BC 冲突。
 *
 * 关键：32 字节种子（=私钥的 rawRepresentation）→ 公钥 的派生与 @noble/ed25519、CryptoKit 一致；
 * 签名/派生都是确定性的，故与参考实现逐字节一致（见 §9 金标准向量自检）。
 */
object Ed25519 {
    /** 32 字节种子 → 32 字节公钥（RFC8032 派生）。 */
    fun publicKeyFromSeed(seed: ByteArray): ByteArray {
        require(seed.size == 32) { "种子必须是 32 字节，实际 ${seed.size}" }
        return Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
    }

    /** 对 message（任意字节）用种子签名，返回 64 字节签名。 */
    fun sign(message: ByteArray, seed: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(seed, 0))
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    /** 验签：signature(64) / message / publicKey(32)。 */
    fun verify(signature: ByteArray, message: ByteArray, publicKey: ByteArray): Boolean =
        try {
            val signer = Ed25519Signer()
            signer.init(false, Ed25519PublicKeyParameters(publicKey, 0))
            signer.update(message, 0, message.size)
            signer.verifySignature(signature)
        } catch (_: Exception) {
            false
        }
}
