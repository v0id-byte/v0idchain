package com.v0id.wallet.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CLIENT-PROTOCOL §9 金标准向量自检（纯 JVM，`./gradlew :app:testDebugUnitTest`，无需模拟器）。
 * core 只依赖 BouncyCastle + java.security，可在宿主 JVM 直接运行。
 */
class GoldVectorTest {

    @Test
    fun escapeSelfCheck() {
        // JSON.stringify(["x\"y\nz\t🎲"]) 必须逐字节一致
        assertEquals(GoldVectors.ESCAPE_EXPECTED, JsonStringify.array(listOf(GoldVectors.ESCAPE_INPUT)))
    }

    @Test
    fun goldVectorsAllGreen() {
        val r = runSelfTest()
        // 逐步断言（错在哪步一目了然）
        assertEquals("PUB_HEX", GoldVectors.PUB_HEX, r.pub.first)
        assertEquals("TRANSFER PREIMAGE", GoldVectors.TRANSFER_PREIMAGE, r.transferPreimage.first)
        assertEquals("TRANSFER TXID", GoldVectors.TRANSFER_TXID, r.transferTxid.first)
        assertEquals("TRANSFER SIGNATURE", GoldVectors.TRANSFER_SIG, r.transferSig.first)
        assertEquals("MESSAGE PREIMAGE", GoldVectors.MESSAGE_PREIMAGE, r.messagePreimage.first)
        assertEquals("MESSAGE TXID", GoldVectors.MESSAGE_TXID, r.messageTxid.first)
        assertEquals("MESSAGE SIGNATURE", GoldVectors.MESSAGE_SIG, r.messageSig.first)
        assertTrue("所有向量应全绿", r.allGreen)
    }

    @Test
    fun addressDerivation() {
        val w = Wallet.fromPrivateKeyHex(GoldVectors.SEED_HEX)
        assertEquals(GoldVectors.PUB_HEX, w.publicKey.toHex())
        assertEquals(GoldVectors.ADDRESS, w.address)
    }

    /** 验证 App 实际使用的生产代码路径（signTransaction / signMessage）也复现金标准向量。 */
    @Test
    fun productionFactoryPath() {
        val w = Wallet.fromPrivateKeyHex(GoldVectors.SEED_HEX)

        val tx = signTransaction(w, GoldVectors.TO, 100L, 0L, "hi 🍜", 1L, GoldVectors.TS)
        assertEquals(GoldVectors.TRANSFER_TXID, tx.txid)
        assertEquals(GoldVectors.TRANSFER_SIG, tx.signature)
        assertTrue("自验签", Ed25519.verify(tx.signature.hexToBytes(), tx.txid.hexToBytes(), w.publicKey))

        val msg = signMessage(w, GoldVectors.TO, "gm", 1L, 5L, 1L, GoldVectors.TS)
        assertEquals(GoldVectors.MESSAGE_TXID, msg.txid)
        assertEquals(GoldVectors.MESSAGE_SIG, msg.signature)
        assertTrue(msg.isMessage())
    }

    /** 中文与控制字符混排的 memo 也要与 JS 一致（不破坏共识）。 */
    @Test
    fun chineseAndControlCharsInMemo() {
        // 仅验证序列化稳定可逆地工作；具体期望由 escapeSelfCheck 锁定的转义规则保证。
        val s = JsonStringify.array(listOf("中文/emoji🎲 与\t制表"))
        assertTrue(s.startsWith("[\"中文/emoji🎲 与\\t制表\"]"))
    }
}
