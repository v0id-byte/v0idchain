package com.v0id.wallet.core

import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.math.ec.rfc7748.X25519
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 端到端加密私信：ed25519 → x25519 → ECDH 共享密钥 → XChaCha20-Poly1305 认证加密。
 * 必须与 packages/core/src/crypto.ts（@noble/curves + @noble/ciphers）逐字节互通，否则全网解不开。
 * 自检向量见 CLIENT-PROTOCOL §8.6 / §9（GoldVectorTest 用同一组向量对齐）。
 *
 * 依赖拆解（零新依赖，bcprov 已是依赖）：
 *   • x25519 标量乘 → BouncyCastle X25519（rfc7748）。
 *   • IETF ChaCha20-Poly1305 → BouncyCastle ChaCha20Poly1305。
 *   • ed25519 公钥 → Montgomery u 坐标的域运算 → java.math.BigInteger（mod p=2^255-19）。
 *   • HChaCha20 子密钥派生（XChaCha 的前半段）→ 本文件手写。
 */
object Encryption {
    // p = 2^255 - 19（GF 域素数）
    private val P: BigInteger = BigInteger.TWO.pow(255).subtract(BigInteger.valueOf(19))

    // ───── 对外 API ─────

    fun isEncryptedMemo(memo: String): Boolean = memo.startsWith(ENC_PREFIX)

    /** 加密一段明文给收件人（用发送方自己的种子私钥）。返回 `ENC|<hex>`，直接当 memo 上链。失败返回 null。 */
    fun encryptMemo(plaintext: String, recipientAddress: String, senderSeed: ByteArray): String? {
        val key = sharedKey(senderSeed, recipientAddress) ?: return null
        val nonce = ByteArray(24).also { SecureRandom().nextBytes(it) }
        val sealed = try {
            aeadSeal(plaintext.toByteArray(Charsets.UTF_8), key, nonce)
        } catch (_: Exception) {
            return null
        }
        return ENC_PREFIX + (nonce + sealed).toHex()
    }

    /**
     * 解密一条 `ENC|` 私信。otherPartyAddress = 对方地址（我是收件人→填发件人；我是发件人→填收件人）。
     * 失败（非本人 / 被篡改 / 格式坏）返回 null。ECDH 对称 → 发件人也能解自己发的。
     */
    fun decryptMemo(memo: String, otherPartyAddress: String, mySeed: ByteArray): String? {
        if (!memo.startsWith(ENC_PREFIX)) return null
        val blob = try {
            memo.substring(ENC_PREFIX.length).hexToBytes()
        } catch (_: Exception) {
            return null
        }
        if (blob.size < 24 + 16) return null
        val nonce = blob.copyOfRange(0, 24)
        val ctTag = blob.copyOfRange(24, blob.size)
        val key = sharedKey(mySeed, otherPartyAddress) ?: return null
        return try {
            String(aeadOpen(ctTag, key, nonce), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    // ───── 共享密钥：我的 ed25519 种子 × 对方地址(ed25519 公钥) → 32 字节对称密钥 ─────
    fun sharedKey(mySeed: ByteArray, otherAddress: String): ByteArray? {
        val pubHex = if (otherAddress.startsWith("0x")) otherAddress.substring(2) else otherAddress
        val otherPub = try {
            pubHex.hexToBytes()
        } catch (_: Exception) {
            return null
        }
        if (otherPub.size != 32) return null
        val xPriv = x25519PrivFromSeed(mySeed)            // clamp(sha512(seed)[:32])
        val otherU = montgomeryUFromEdPub(otherPub)       // ed25519 公钥 → Montgomery u
        val out = ByteArray(32)
        // X25519 内部会再 clamp（幂等），传入已 clamp 的私钥结果不变；输出 = 原始 ECDH 32 字节，无 KDF。
        X25519.calculateAgreement(xPriv, 0, otherU, 0, out, 0)
        return out
    }

    /** ed25519 私钥种子 → x25519 私钥标量 = clamp(SHA-512(seed)[0:32])。 */
    fun x25519PrivFromSeed(seed: ByteArray): ByteArray {
        val h = MessageDigest.getInstance("SHA-512").digest(seed).copyOfRange(0, 32)
        h[0] = (h[0].toInt() and 248).toByte()
        h[31] = (h[31].toInt() and 127).toByte()
        h[31] = (h[31].toInt() or 64).toByte()
        return h
    }

    /** ed25519 公钥(32B) → Montgomery u = (1+y)/(1-y) mod p，编码为 32 字节小端。 */
    fun montgomeryUFromEdPub(pub: ByteArray): ByteArray {
        // y = 小端(pub)，清掉最高位（符号位 bit255）后 mod p
        val yBytes = pub.copyOf()
        yBytes[31] = (yBytes[31].toInt() and 0x7f).toByte()
        val y = leToBigInteger(yBytes).mod(P)
        val onePlusY = BigInteger.ONE.add(y).mod(P)
        val oneMinusY = BigInteger.ONE.subtract(y).mod(P)
        val inv = oneMinusY.modInverse(P)
        val u = onePlusY.multiply(inv).mod(P)
        return bigIntegerToLe(u, 32)
    }

    // ───── XChaCha20-Poly1305 = HChaCha20 派生子密钥 + IETF ChaCha20-Poly1305 ─────
    fun aeadSeal(plaintext: ByteArray, key: ByteArray, xnonce: ByteArray): ByteArray {
        val (subkey, ietf) = xchachaSetup(key, xnonce)
        val cipher = ChaCha20Poly1305()
        cipher.init(true, AEADParameters(KeyParameter(subkey), 128, ietf))
        val out = ByteArray(cipher.getOutputSize(plaintext.size))
        val len = cipher.processBytes(plaintext, 0, plaintext.size, out, 0)
        cipher.doFinal(out, len)
        return out  // 密文 ‖ 16 字节 tag（noble 格式）
    }

    fun aeadOpen(ctTag: ByteArray, key: ByteArray, xnonce: ByteArray): ByteArray {
        val (subkey, ietf) = xchachaSetup(key, xnonce)
        val cipher = ChaCha20Poly1305()
        cipher.init(false, AEADParameters(KeyParameter(subkey), 128, ietf))
        val out = ByteArray(cipher.getOutputSize(ctTag.size))
        val len = cipher.processBytes(ctTag, 0, ctTag.size, out, 0)
        cipher.doFinal(out, len)  // tag 不符会抛异常
        return out
    }

    /** 子密钥 = HChaCha20(key, xnonce[0:16])；IETF nonce = 0x00000000 ‖ xnonce[16:24]（12 字节）。 */
    private fun xchachaSetup(key: ByteArray, xnonce: ByteArray): Pair<ByteArray, ByteArray> {
        val subkey = hchacha20(key, xnonce.copyOfRange(0, 16))
        val ietf = ByteArray(12)
        for (i in 0 until 8) ietf[4 + i] = xnonce[16 + i]
        return subkey to ietf
    }

    // ───── HChaCha20：从 256-bit key + 128-bit nonce 派生 256-bit 子密钥 ─────
    fun hchacha20(key: ByteArray, nonce16: ByteArray): ByteArray {
        fun le32(b: ByteArray, o: Int): Int =
            (b[o].toInt() and 0xff) or
                ((b[o + 1].toInt() and 0xff) shl 8) or
                ((b[o + 2].toInt() and 0xff) shl 16) or
                ((b[o + 3].toInt() and 0xff) shl 24)

        val s = IntArray(16)
        s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574
        for (i in 0 until 8) s[4 + i] = le32(key, i * 4)
        for (i in 0 until 4) s[12 + i] = le32(nonce16, i * 4)

        fun rotl(x: Int, n: Int): Int = (x shl n) or (x ushr (32 - n))
        fun qr(a: Int, b: Int, c: Int, d: Int) {
            s[a] += s[b]; s[d] = rotl(s[d] xor s[a], 16)
            s[c] += s[d]; s[b] = rotl(s[b] xor s[c], 12)
            s[a] += s[b]; s[d] = rotl(s[d] xor s[a], 8)
            s[c] += s[d]; s[b] = rotl(s[b] xor s[c], 7)
        }
        repeat(10) {
            qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
            qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
        }
        val out = ByteArray(32)
        fun put(v: Int, o: Int) {
            out[o] = (v and 0xff).toByte()
            out[o + 1] = ((v ushr 8) and 0xff).toByte()
            out[o + 2] = ((v ushr 16) and 0xff).toByte()
            out[o + 3] = ((v ushr 24) and 0xff).toByte()
        }
        put(s[0], 0); put(s[1], 4); put(s[2], 8); put(s[3], 12)
        put(s[12], 16); put(s[13], 20); put(s[14], 24); put(s[15], 28)
        return out
    }

    // ───── 小端 ↔ BigInteger（BigInteger 是大端，需翻转字节序）─────
    private fun leToBigInteger(le: ByteArray): BigInteger {
        val be = ByteArray(le.size)
        for (i in le.indices) be[i] = le[le.size - 1 - i]
        return BigInteger(1, be)  // 1 = 正号，避免最高位被当符号
    }

    private fun bigIntegerToLe(v: BigInteger, len: Int): ByteArray {
        val out = ByteArray(len)
        var x = v
        val mask = BigInteger.valueOf(0xff)
        for (i in 0 until len) {
            out[i] = x.and(mask).toInt().toByte()
            x = x.shiftRight(8)
        }
        return out
    }
}
