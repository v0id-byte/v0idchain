package com.v0id.wallet.core

/**
 * CLIENT-PROTOCOL §9 金标准向量自检。
 * 复现顺序：PUB_HEX → PREIMAGE → TXID → SIGNATURE，四步全绿即与全网兼容。
 * App 启动诊断页与 JVM 单测（GoldVectorTest）共用本对象，确保展示的与被测的是同一条代码路径。
 */
object GoldVectors {
    const val SEED_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
    const val PUB_HEX = "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
    const val ADDRESS = "0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
    const val TO = "0xabababababababababababababababababababababababababababababababab"
    const val TS = 1_700_000_000_000L

    // 转账：amount=100, fee=1, nonce=0, memo="hi 🍜"
    const val TRANSFER_PREIMAGE =
        "[\"0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664\",\"0xabababababababababababababababababababababababababababababababab\",100,1,0,1700000000000,\"hi 🍜\"]"
    const val TRANSFER_TXID =
        "da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932"
    const val TRANSFER_SIG =
        "dab11981063113c8b5fff5f8fcaad3d9c0a49879f7cca8a9dcee16be1171b17ea8919217ab87c077f320e3ea0eaca8a31c49467dc5df6c3e28b9ba689fc07108"

    // 消息：amount=0, fee=1, nonce=1, memo="gm", burn=5
    const val MESSAGE_PREIMAGE =
        "[\"0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664\",\"0xabababababababababababababababababababababababababababababababab\",0,1,1,1700000000000,\"gm\",5]"
    const val MESSAGE_TXID =
        "bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06"
    const val MESSAGE_SIG =
        "817ccc45061524d52b8f1fc41f0b3542498993679c5e73a9497f60421dd0f7c19ea1837de981dedcd20301e2ea0d2076c029a6249c0e9b832f24962ae7972104"

    // §9 转义自检：JSON.stringify(["x\"y\nz\t🎲"]) 必须逐字节等于此串。
    val ESCAPE_INPUT = "x\"y\nz\t🎲"   // x " y \n z \t 🎲
    const val ESCAPE_EXPECTED = "[\"x\\\"y\\nz\\t🎲\"]"
}

/** 自检结果：每步一对（实际值 + 是否匹配），便于在 UI 逐行展示绿/红。 */
data class SelfTestResult(
    val pub: Pair<String, Boolean>,
    val transferPreimage: Pair<String, Boolean>,
    val transferTxid: Pair<String, Boolean>,
    val transferSig: Pair<String, Boolean>,
    val messagePreimage: Pair<String, Boolean>,
    val messageTxid: Pair<String, Boolean>,
    val messageSig: Pair<String, Boolean>,
    val escape: Pair<String, Boolean>,
) {
    val allGreen: Boolean
        get() = pub.second && transferPreimage.second && transferTxid.second && transferSig.second &&
            messagePreimage.second && messageTxid.second && messageSig.second && escape.second
}

/** 跑一遍 §9 全部向量。走的是 App 真实使用的同一套 core 函数。 */
fun runSelfTest(): SelfTestResult {
    val wallet = Wallet.fromPrivateKeyHex(GoldVectors.SEED_HEX)
    val pub = wallet.publicKey.toHex()

    // 转账
    val tPre = JsonStringify.array(listOf(GoldVectors.ADDRESS, GoldVectors.TO, 100L, 1L, 0L, GoldVectors.TS, "hi 🍜"))
    val tTxid = sha256Hex(tPre)
    val tSig = Ed25519.sign(tTxid.hexToBytes(), wallet.seed).toHex()

    // 消息
    val mPre = JsonStringify.array(listOf(GoldVectors.ADDRESS, GoldVectors.TO, 0L, 1L, 1L, GoldVectors.TS, "gm", 5L))
    val mTxid = sha256Hex(mPre)
    val mSig = Ed25519.sign(mTxid.hexToBytes(), wallet.seed).toHex()

    val esc = JsonStringify.array(listOf(GoldVectors.ESCAPE_INPUT))

    return SelfTestResult(
        pub = pub to (pub == GoldVectors.PUB_HEX),
        transferPreimage = tPre to (tPre == GoldVectors.TRANSFER_PREIMAGE),
        transferTxid = tTxid to (tTxid == GoldVectors.TRANSFER_TXID),
        transferSig = tSig to (tSig == GoldVectors.TRANSFER_SIG),
        messagePreimage = mPre to (mPre == GoldVectors.MESSAGE_PREIMAGE),
        messageTxid = mTxid to (mTxid == GoldVectors.MESSAGE_TXID),
        messageSig = mSig to (mSig == GoldVectors.MESSAGE_SIG),
        escape = esc to (esc == GoldVectors.ESCAPE_EXPECTED),
    )
}
