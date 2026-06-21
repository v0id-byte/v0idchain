// CLIENT-PROTOCOL §9 金标准向量自检：与 packages/core 逐字节对齐的硬证据。
//
// 对齐顺序（规范要求）：ADDRESS → PREIMAGE → TXID → SIGNATURE。
// 前三步要求**逐字节相等**；SIGNATURE 步因 CryptoKit 的 ed25519 是随机化（hedged nonce），
// 无法复现金标准里那串固定签名 —— 改用**验签等价**判定（用户已确认采用此方案）：
//   (1) 我新签出的签名能被金标准公钥验过（→ 全网会接受我的交易）；
//   (2) 金标准里那串固定签名也能被我的验签器验过（→ 我的验签器 ≡ 网络验签器）。
// 二者皆绿即“与全网兼容”，与 byte-equal 的目标等价。
import XCTest
@testable import V0idKit

final class GoldVectorTests: XCTestCase {
    let privHex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
    let pubHex  = "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
    let address = "0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
    let to = "0x" + String(repeating: "ab", count: 32)
    let ts = 1_700_000_000_000

    func wallet() throws -> Wallet {
        try Wallet(seed: Data(Hex.decode(privHex)!))
    }

    // 步骤 1：ADDRESS（公钥派生）
    func testAddress() throws {
        let w = try wallet()
        XCTAssertEqual(w.publicKeyHex, pubHex, "PUB_HEX 不一致")
        XCTAssertEqual(w.address, address, "ADDRESS 不一致")
    }

    // 步骤 2：PREIMAGE（最易错的一步，必须逐字节一致）
    func testTransferPreimage() throws {
        let pre = TxBuilder.preimage(from: address, to: to, amount: 100, fee: 1,
                                     nonce: 0, timestamp: ts, memo: "hi 🍜", burn: nil)
        XCTAssertEqual(pre,
            "[\"0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664\",\"0xabababababababababababababababababababababababababababababababab\",100,1,0,1700000000000,\"hi 🍜\"]")
    }

    func testMessagePreimage() throws {
        // 消息：amount 0，burn=5 → 末尾追加 burn，8 元素
        let pre = TxBuilder.preimage(from: address, to: to, amount: 0, fee: 1,
                                     nonce: 1, timestamp: ts, memo: "gm", burn: 5)
        XCTAssertEqual(pre,
            "[\"0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664\",\"0xabababababababababababababababababababababababababababababababab\",0,1,1,1700000000000,\"gm\",5]")
    }

    // 步骤 3：TXID
    func testTransferTxid() {
        let id = TxBuilder.txid(from: address, to: to, amount: 100, fee: 1,
                                nonce: 0, timestamp: ts, memo: "hi 🍜", burn: nil)
        XCTAssertEqual(id, "da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932")
    }

    func testMessageTxid() {
        let id = TxBuilder.txid(from: address, to: to, amount: 0, fee: 1,
                                nonce: 1, timestamp: ts, memo: "gm", burn: 5)
        XCTAssertEqual(id, "bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06")
    }

    // 步骤 4：SIGNATURE（验签等价）
    func testSignatureNetworkCompatible() throws {
        let w = try wallet()
        let goldTransferTxid = "da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932"
        let goldTransferSig = "dab11981063113c8b5fff5f8fcaad3d9c0a49879f7cca8a9dcee16be1171b17ea8919217ab87c077f320e3ea0eaca8a31c49467dc5df6c3e28b9ba689fc07108"

        // (1) 我新签出的签名能被金标准公钥验过 → 全网会接受
        let mySig = try w.sign(txidHex: goldTransferTxid)
        XCTAssertTrue(Crypto.verify(signatureHex: mySig, messageHex: goldTransferTxid, publicKeyHex: pubHex),
                      "我的签名无法被验过 —— 交易会被全网丢弃")

        // (2) 金标准固定签名能被我的验签器验过 → 我的验签器 ≡ 网络验签器
        XCTAssertTrue(Crypto.verify(signatureHex: goldTransferSig, messageHex: goldTransferTxid, publicKeyHex: pubHex),
                      "我的验签器拒绝了金标准签名 —— 与网络验签器不一致")

        // 消息向量同样检查
        let goldMsgTxid = "bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06"
        let goldMsgSig = "817ccc45061524d52b8f1fc41f0b3542498993679c5e73a9497f60421dd0f7c19ea1837de981dedcd20301e2ea0d2076c029a6249c0e9b832f24962ae7972104"
        XCTAssertTrue(Crypto.verify(signatureHex: goldMsgSig, messageHex: goldMsgTxid, publicKeyHex: pubHex))
        let myMsgSig = try w.sign(txidHex: goldMsgTxid)
        XCTAssertTrue(Crypto.verify(signatureHex: myMsgSig, messageHex: goldMsgTxid, publicKeyHex: pubHex))

        // 验签器应拒绝错配（消息签名配转账 txid 必须失败）
        XCTAssertFalse(Crypto.verify(signatureHex: goldMsgSig, messageHex: goldTransferTxid, publicKeyHex: pubHex))
    }

    // 转义自检：JSON.stringify(["x\"y\nz\t🎲"]) == 字面
    func testEscaping() {
        let s = JSONStringify.array([.string("x\"y\nz\t🎲")])
        XCTAssertEqual(s, "[\"x\\\"y\\nz\\t🎲\"]")
    }

    // 端到端：用钱包工厂签出一笔完整交易，自洽性校验应通过
    func testEndToEndTransferSelfValid() throws {
        let w = try wallet()
        let tx = try TxBuilder.transfer(wallet: w, to: to, amount: 100, nonce: 0, memo: "hi 🍜", fee: 1, timestamp: ts)
        XCTAssertEqual(tx.txid, "da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932")
        XCTAssertTrue(tx.selfValid())
    }

    func testEndToEndMessageSelfValid() throws {
        let w = try wallet()
        let tx = try TxBuilder.message(wallet: w, to: to, text: "gm", nonce: 1, burn: 5, fee: 1, timestamp: ts)
        XCTAssertEqual(tx.txid, "bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06")
        XCTAssertTrue(tx.isMessage)
        XCTAssertTrue(tx.selfValid())
    }
}
