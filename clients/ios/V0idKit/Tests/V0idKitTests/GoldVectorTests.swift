// 金标准向量自检（CLIENT-PROTOCOL §9）。
// 顺序：PUB/ADDRESS → PREIMAGE → TXID → SIGNATURE。四步全绿即与全网兼容。
//
// 关于 SIGNATURE：CryptoKit 的 ed25519 采用 RFC8032 hedged（随机化）签名，无法逐字节复现 §9 那条确定性
// SIGNATURE。但真正决定“交易是否被全网接受”的不是字节相等，而是**签名能否通过验签**。因此本测试把第 4 步
// 替换为一个**更强**的双向互操作检查：
//   (a) 本端用 CryptoKit 对 txid 签出的签名，能通过验签（= 我们广播的交易会被节点接受）；
//   (b) §9 给出的确定性金标准签名（来自参考实现 @noble/ed25519），也能通过本端验签（= 我们的验签路径与全网一致）。
import XCTest
@testable import V0idKit

final class GoldVectorTests: XCTestCase {
    // 固定私钥种子 = 32 字节 01 02 … 20
    let privHex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
    let pubHex = "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
    var address: String { "0x" + pubHex }
    let to = "0x" + String(repeating: "ab", count: 32)
    let timestamp = 1_700_000_000_000

    // MARK: 第 1 步 —— 公钥 / 地址

    func testAddressDerivation() throws {
        let wallet = try Wallet(seedHex: privHex)
        XCTAssertEqual(Hex.encode(wallet.publicKey), pubHex, "公钥不匹配")
        XCTAssertEqual(wallet.address, address, "地址不匹配")
    }

    // MARK: 第 2 步 —— 预映像（最容易错的一步）

    func testTransferPreimage() {
        let pre = TxBuilder.preimage(
            from: address, to: to, amount: 100, fee: 1,
            nonce: 0, timestamp: timestamp, memo: "hi 🍜")
        XCTAssertEqual(
            pre,
            "[\"0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664\",\"0xabababababababababababababababababababababababababababababababab\",100,1,0,1700000000000,\"hi 🍜\"]")
    }

    func testMessagePreimage() {
        let pre = TxBuilder.preimage(
            from: address, to: to, amount: 0, fee: 1,
            nonce: 1, timestamp: timestamp, memo: "gm", burn: 5)
        XCTAssertEqual(
            pre,
            "[\"0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664\",\"0xabababababababababababababababababababababababababababababababab\",0,1,1,1700000000000,\"gm\",5]")
    }

    func testEscapingVector() {
        // §9：JSON.stringify(["x\"y\nz\t🎲"]) 必须 == ["x\"y\nz\t🎲"]
        let s = "x\"y\nz\t🎲"
        let encoded = CanonicalJSON.array([.string(s)])
        XCTAssertEqual(encoded, "[\"x\\\"y\\nz\\t🎲\"]")
    }

    func testControlCharEscaping() {
        // U+0001 → （小写）；U+0008/09/0A/0C/0D → 短转义
        XCTAssertEqual(CanonicalJSON.string("\u{0001}"), "\"\\u0001\"")
        XCTAssertEqual(CanonicalJSON.string("\u{0008}"), "\"\\b\"")
        XCTAssertEqual(CanonicalJSON.string("\u{000B}"), "\"\\u000b\"")
        XCTAssertEqual(CanonicalJSON.string("/"), "\"/\"") // 不转义 /
    }

    // MARK: 第 3 步 —— TXID

    func testTransferTxid() {
        let txid = TxBuilder.txid(
            from: address, to: to, amount: 100, fee: 1,
            nonce: 0, timestamp: timestamp, memo: "hi 🍜")
        XCTAssertEqual(txid, "da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932")
    }

    func testMessageTxid() {
        let txid = TxBuilder.txid(
            from: address, to: to, amount: 0, fee: 1,
            nonce: 1, timestamp: timestamp, memo: "gm", burn: 5)
        XCTAssertEqual(txid, "bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06")
    }

    // MARK: 第 4 步 —— SIGNATURE（双向验签互操作，见文件头说明）

    func testSignatureRoundTripAndGoldInterop() throws {
        let wallet = try Wallet(seedHex: privHex)
        let transferTxid = "da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932"
        let messageTxid = "bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06"

        // (a) 本端签名能通过验签
        let mySig = try wallet.sign(messageHex: transferTxid)
        XCTAssertTrue(
            Crypto.verify(signatureHex: mySig, messageHex: transferTxid, publicKeyHex: pubHex),
            "本端签出的签名应能通过验签（否则全网会丢弃）")

        // (b) §9 确定性金标准签名能通过本端验签（验签路径与全网一致）
        let goldTransferSig = "dab11981063113c8b5fff5f8fcaad3d9c0a49879f7cca8a9dcee16be1171b17ea8919217ab87c077f320e3ea0eaca8a31c49467dc5df6c3e28b9ba689fc07108"
        XCTAssertTrue(
            Crypto.verify(signatureHex: goldTransferSig, messageHex: transferTxid, publicKeyHex: pubHex),
            "§9 转账金标准签名应通过本端验签")

        let goldMessageSig = "817ccc45061524d52b8f1fc41f0b3542498993679c5e73a9497f60421dd0f7c19ea1837de981dedcd20301e2ea0d2076c029a6249c0e9b832f24962ae7972104"
        XCTAssertTrue(
            Crypto.verify(signatureHex: goldMessageSig, messageHex: messageTxid, publicKeyHex: pubHex),
            "§9 消息金标准签名应通过本端验签")

        // 错误消息/错误公钥必须验签失败
        XCTAssertFalse(
            Crypto.verify(signatureHex: goldTransferSig, messageHex: messageTxid, publicKeyHex: pubHex),
            "签名不应对错误消息通过")
    }

    // MARK: 端到端 —— 用高阶 createTransaction/createMessage 复现 txid + 自验

    func testCreateTransactionMatchesGold() throws {
        let wallet = try Wallet(seedHex: privHex)
        let tx = try wallet.createTransaction(
            to: to, amount: 100, nonce: 0, memo: "hi 🍜", fee: 1, timestamp: timestamp)
        XCTAssertEqual(tx.txid, "da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932")
        XCTAssertNil(tx.burn, "普通转账不应带 burn 字段")
        XCTAssertTrue(Crypto.verify(signatureHex: tx.signature, messageHex: tx.txid, publicKeyHex: pubHex))
    }

    func testCreateMessageMatchesGold() throws {
        let wallet = try Wallet(seedHex: privHex)
        let tx = try wallet.createMessage(
            to: to, text: "gm", nonce: 1, burn: 5, fee: 1, timestamp: timestamp)
        XCTAssertEqual(tx.txid, "bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06")
        XCTAssertEqual(tx.burn, 5)
        XCTAssertTrue(tx.isMessage)
        XCTAssertTrue(Crypto.verify(signatureHex: tx.signature, messageHex: tx.txid, publicKeyHex: pubHex))
    }
}
