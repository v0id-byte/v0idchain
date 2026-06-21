package com.v0id.wallet.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 新功能金标准向量自检：端到端加密私信（CLIENT-PROTOCOL §8.6）+ 昵称 / 集市 / 红包解析与红包托管状态机。
 * 加密向量必须与 packages/core（@noble）逐字节一致；红包余额必须与 blockchain.ts 的 applyTx（= ChainState.computeState）一致。
 * 纯 JVM，`./gradlew :app:testDebugUnitTest`，无需模拟器。
 */
class FeatureVectorTest {
    // §8.6 固定向量：A 种子 01..20，B 种子 21..40
    private val aSeedHex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
    private val bSeedHex = "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40"
    private val aAddr = "0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
    private val bAddr = "0xe7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0"
    private val sharedGold = "22dd9afeb5878d76b7b7eba66e349a1a00858963745f1b92b78a1741e9ccf249"

    private fun seed(hex: String): ByteArray = hex.hexToBytes()

    // ───── 加密：四步对齐（地址 → x25519 中间值 → 共享密钥 → 密文 memo）─────

    @Test
    fun x25519PrivFromSeed() {
        val p = Encryption.x25519PrivFromSeed(seed(aSeedHex))
        assertEquals("70788f1a0cea001a2631dae5d05dbd062008d5b30f50b9e29beb2a7822289044", p.toHex())
    }

    @Test
    fun edToMontgomeryPub() {
        val bPub = bAddr.substring(2).hexToBytes()
        val u = Encryption.montgomeryUFromEdPub(bPub)
        assertEquals("577faef0060dfd00c039272bc6fe7c42689ce16db47b6fc2aa41d19819ffa936", u.toHex())
    }

    @Test
    fun sharedKeySymmetric() {
        val kAB = Encryption.sharedKey(seed(aSeedHex), bAddr)!!
        val kBA = Encryption.sharedKey(seed(bSeedHex), aAddr)!!
        assertEquals("共享密钥与金标准不一致", sharedGold, kAB.toHex())
        assertEquals("ECDH 不对称", sharedGold, kBA.toHex())
    }

    @Test
    fun hchacha20Subkey() {
        val key = sharedGold.hexToBytes()
        val subkey = Encryption.hchacha20(key, "aa".repeat(16).hexToBytes())
        assertEquals("0d14854b974a920d7653f283dfc2be9919c77f731fd185f7ecba6bfa3fc2a81e", subkey.toHex())
    }

    @Test
    fun fixedNonceCiphertextMatchesGolden() {
        // 固定 nonce=aa×24、明文 "hi 🔐" → memo 必须等于 §8.6 金标准
        val key = sharedGold.hexToBytes()
        val nonce = "aa".repeat(24).hexToBytes()
        val sealed = Encryption.aeadSeal("hi 🔐".toByteArray(Charsets.UTF_8), key, nonce)
        assertEquals("6359b5d168414e050a885e42c9dc6eabf98ecbaea44fa9", sealed.toHex())
        val memo = ENC_PREFIX + (nonce + sealed).toHex()
        assertEquals(
            "ENC|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6359b5d168414e050a885e42c9dc6eabf98ecbaea44fa9",
            memo,
        )
    }

    @Test
    fun encryptDecryptRoundTrip() {
        // A 加密给 B（随机 nonce）→ B 解出、A 也能解自己发的（ECDH 对称）；外人解不开。
        val memo = Encryption.encryptMemo("约你 9 点食堂见 🍜", bAddr, seed(aSeedHex))
        assertNotNull(memo)
        assertTrue(Encryption.isEncryptedMemo(memo!!))
        assertEquals("约你 9 点食堂见 🍜", Encryption.decryptMemo(memo, aAddr, seed(bSeedHex)))
        assertEquals("约你 9 点食堂见 🍜", Encryption.decryptMemo(memo, bAddr, seed(aSeedHex)))
        // 第三方（随机钥）解不开
        val eve = Wallet.generate()
        assertNull(Encryption.decryptMemo(memo, aAddr, eve.seed))
    }

    // ───── 昵称：先到先得 + 显示名 ─────

    @Test
    fun namesRegistry() {
        val x = Wallet.generate()
        val y = Wallet.generate()
        val claimAlice = signTransaction(x, x.address, 1L, 0L, "NAME|Alice", 1L, 0L)
        val yAlice = signTransaction(y, y.address, 1L, 0L, "NAME|alice", 1L, 0L)
        val yBob = signTransaction(y, y.address, 1L, 1L, "NAME|bob", 1L, 0L)
        val reg = parseNames(listOf(block(listOf(claimAlice, yAlice, yBob))))
        assertEquals("读端应小写规范化", "alice", reg.nameFor(x.address))
        assertEquals("先到先得：X 永久拥有 alice", x.address, reg.nameToOwner["alice"])
        assertEquals("Y 抢 alice 失败、改名 bob", "bob", reg.nameFor(y.address))
        assertFalse(isValidName("treasury"))   // 保留名
        assertNull(makeNameClaim("Bad Name!").first)
    }

    // ───── 集市：上架 / 购买 ─────

    @Test
    fun marketParse() {
        val x = Wallet.generate()
        val y = Wallet.generate()
        val sell = signTransaction(x, x.address, 1L, 0L, "MKT|20|复习笔记", 1L, 0L)
        val buy = signTransaction(y, x.address, 20L, 0L, "BUY|${sell.txid}", 1L, 0L)
        val market = parseMarket(listOf(block(listOf(sell, buy))))
        assertEquals(1, market.size)
        assertEquals("复习笔记", market[0].title)
        assertEquals(20L, market[0].price)
        assertTrue(market[0].sold)
        assertEquals(y.address, market[0].soldBy)
    }

    // ───── 红包：托管状态机 + 余额守恒（computeState 与 parseRedPackets 同源 computeShare）─────

    @Test
    fun redPacketEscrowAndBalances() {
        val x = Wallet.generate()
        val y = Wallet.generate()
        val z = Wallet.generate()
        val mint = coinbase(x.address, 1000L, 0L)
        val red = signTransaction(x, RED_ESCROW_ADDRESS, 100L, 0L, "RED|2|r", 1L, 0L)
        val claimY = signTransaction(y, y.address, 0L, 0L, "CLAIM|${red.txid}", 1L, 0L)
        val claimZ = signTransaction(z, z.address, 0L, 0L, "CLAIM|${red.txid}", 1L, 0L)

        val chain = listOf(
            block(listOf(mint), hash = "00aa"),
            block(listOf(red), hash = "00bb"),
            block(listOf(claimY), hash = "00cc"),
            block(listOf(claimZ), hash = "00dd"),
        )
        val st = computeState(chain)
        assertEquals("全部抢完后托管必须清零", 0L, st.balanceOf(RED_ESCROW_ADDRESS))
        assertEquals("发起人付 总额+手续费", 1000L - 100L - 1L, st.balanceOf(x.address))
        assertEquals(
            "两份之和 = 总额（各扣 1 手续费）",
            100L,
            st.balanceOf(y.address) + 1L + st.balanceOf(z.address) + 1L,
        )

        val views = parseRedPackets(chain)
        assertEquals(1, views.size)
        assertTrue(views[0].done)
        assertEquals(0L, views[0].remaining)
        assertEquals(2, views[0].claims.size)
        // 展示额必须与 computeState 实际入账逐一致（同源 computeShare）
        val claimedY = views[0].claims.first { it.who == y.address }.amount
        assertEquals(claimedY - 1L, st.balanceOf(y.address))
    }

    @Test
    fun redPacketRefund() {
        val x = Wallet.generate()
        val mint = coinbase(x.address, 1000L, 0L)
        val red = signTransaction(x, RED_ESCROW_ADDRESS, 100L, 0L, "RED|5|e", 1L, 0L)
        val refund = signTransaction(x, x.address, 0L, 1L, "REFUND|${red.txid}", 1L, 0L)
        val st = computeState(
            listOf(
                block(listOf(mint), hash = "00aa"),
                block(listOf(red), hash = "00bb"),
                block(listOf(refund), hash = "00cc"),
            ),
        )
        assertEquals(0L, st.balanceOf(RED_ESCROW_ADDRESS))
        assertEquals("退款取回全部，仅净付两笔手续费", 1000L - 1L - 1L, st.balanceOf(x.address))
        assertTrue(parseRedPackets(listOf(block(listOf(mint)), block(listOf(red)), block(listOf(refund))))[0].refunded)
    }

    @Test
    fun computeShareBounds() {
        // 拼手气：每份 ∈ [1, 上界]，最后一份拿走剩余
        assertEquals(50L, computeShare(50L, 1, RedMode.RANDOM, "ffffffffffff"))
        val s = computeShare(100L, 3, RedMode.RANDOM, "000000000000")
        assertTrue(s >= 1L)
        assertEquals(30L, computeShare(90L, 3, RedMode.EQUAL, ""))
    }

    // ───── 测试辅助：构造区块 / coinbase（解析与状态机不校验签名/PoW，可用占位字段）─────

    private fun block(txs: List<Transaction>, hash: String = "00"): Block =
        Block(
            index = 0L, timestamp = 0L, prevHash = "", transactions = txs, merkleRoot = "",
            difficulty = 0L, nonce = 0L, miner = NULL_ADDRESS, hash = hash,
        )

    private fun coinbase(to: String, amount: Long, index: Long): Transaction {
        val id = computeTxid(NULL_ADDRESS, to, amount, 0L, index, 0L, "", null)
        return Transaction(NULL_ADDRESS, to, amount, 0L, index, 0L, "", null, "", id)
    }
}
