// 新功能金标准向量自检：端到端加密私信（CLIENT-PROTOCOL §8.6）+ 昵称 / 集市 / 红包解析与红包托管状态机。
// 加密向量必须与 packages/core（@noble）逐字节一致；红包余额必须与 blockchain.ts 的 applyTx 一致。
// （注：此环境 `swift test` 的构建驱动会崩，故权威验证走 scripts/selfcheck.sh；本测试与 macOS 端等价、留作对照。）
import XCTest
@testable import V0idKit

final class FeatureVectorTests: XCTestCase {
    // §8.6 固定向量：A 种子 01..20，B 种子 21..40
    let aSeedHex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
    let bSeedHex = "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40"
    let aAddr = "0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
    let bAddr = "0xe7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0"
    let sharedGold = "22dd9afeb5878d76b7b7eba66e349a1a00858963745f1b92b78a1741e9ccf249"

    func data(_ hex: String) -> Data { Hex.decode(hex)! }
    func bytes(_ hex: String) -> [UInt8] { Array(Hex.decode(hex)!) }
    func rep(_ s: String, _ n: Int) -> String { String(repeating: s, count: n) }

    // ---- 加密：四步对齐（地址 → x25519 中间值 → 共享密钥 → 密文 memo）----
    func testX25519PrivFromSeed() {
        let p = Encryption.x25519PrivFromSeed(bytes(aSeedHex))
        XCTAssertEqual(Hex.encode(p), "70788f1a0cea001a2631dae5d05dbd062008d5b30f50b9e29beb2a7822289044")
    }

    func testEdToMontgomeryPub() {
        let u = Encryption.montgomeryUFromEdPub(bytes(String(bAddr.dropFirst(2))))
        XCTAssertEqual(Hex.encode(u), "577faef0060dfd00c039272bc6fe7c42689ce16db47b6fc2aa41d19819ffa936")
    }

    func testSharedKeySymmetric() {
        let kAB = Encryption.sharedKey(mySeed: data(aSeedHex), otherAddress: bAddr)
        let kBA = Encryption.sharedKey(mySeed: data(bSeedHex), otherAddress: aAddr)
        XCTAssertEqual(kAB.map { Hex.encode($0) }, sharedGold, "共享密钥与金标准不一致")
        XCTAssertEqual(kBA.map { Hex.encode($0) }, sharedGold, "ECDH 不对称")
    }

    func testHChaCha20Subkey() {
        let subkey = Encryption.hchacha20(key: bytes(sharedGold), nonce16: bytes(rep("aa", 16)))
        XCTAssertEqual(Hex.encode(subkey), "0d14854b974a920d7653f283dfc2be9919c77f731fd185f7ecba6bfa3fc2a81e")
    }

    func testFixedNonceCiphertextMatchesGolden() throws {
        let sealed = try Encryption.aeadSeal(plaintext: Array("hi 🔐".utf8), key: bytes(sharedGold), xnonce: bytes(rep("aa", 24)))
        XCTAssertEqual(Hex.encode(sealed), "6359b5d168414e050a885e42c9dc6eabf98ecbaea44fa9")
        let memo = Config.encPrefix + Hex.encode(bytes(rep("aa", 24)) + sealed)
        XCTAssertEqual(memo,
            "ENC|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6359b5d168414e050a885e42c9dc6eabf98ecbaea44fa9")
    }

    func testEncryptDecryptRoundTrip() {
        let memo = Encryption.encryptMemo("约你 9 点食堂见 🍜", recipientAddress: bAddr, senderSeed: data(aSeedHex))
        XCTAssertNotNil(memo)
        XCTAssertTrue(Encryption.isEncryptedMemo(memo!))
        XCTAssertEqual(Encryption.decryptMemo(memo!, otherPartyAddress: aAddr, mySeed: data(bSeedHex)), "约你 9 点食堂见 🍜")
        XCTAssertEqual(Encryption.decryptMemo(memo!, otherPartyAddress: bAddr, mySeed: data(aSeedHex)), "约你 9 点食堂见 🍜")
        let eve = Wallet.generate()
        XCTAssertNil(Encryption.decryptMemo(memo!, otherPartyAddress: aAddr, mySeed: eve.privateKey))
    }

    // ---- 昵称：先到先得 + 显示名 ----
    func testNamesRegistry() throws {
        let x = Wallet.generate(), y = Wallet.generate()
        let claimAlice = try x.createTransaction(to: x.address, amount: 1, nonce: 0, memo: "NAME|Alice", fee: 1)
        let yAlice = try y.createTransaction(to: y.address, amount: 1, nonce: 0, memo: "NAME|alice", fee: 1)
        let yBob = try y.createTransaction(to: y.address, amount: 1, nonce: 1, memo: "NAME|bob", fee: 1)
        let reg = Names.parseNames([block([claimAlice, yAlice, yBob])])
        XCTAssertEqual(reg.name(for: x.address), "alice", "读端应小写规范化")
        XCTAssertEqual(reg.nameToOwner["alice"], x.address, "先到先得：X 永久拥有 alice")
        XCTAssertEqual(reg.name(for: y.address), "bob", "Y 抢 alice 失败、改名 bob")
        XCTAssertFalse(Names.isValidName("treasury"))
        XCTAssertNil(Names.makeNameClaim("Bad Name!").memo)
    }

    // ---- 集市：上架 / 购买 ----
    func testMarketParse() throws {
        let x = Wallet.generate(), y = Wallet.generate()
        let sell = try x.createTransaction(to: x.address, amount: 1, nonce: 0, memo: "MKT|20|复习笔记", fee: 1)
        let buy = try y.createTransaction(to: x.address, amount: 20, nonce: 0, memo: "BUY|\(sell.txid)", fee: 1)
        let market = Market.parseMarket([block([sell, buy])])
        XCTAssertEqual(market.count, 1)
        XCTAssertEqual(market[0].title, "复习笔记")
        XCTAssertEqual(market[0].price, 20)
        XCTAssertTrue(market[0].sold)
        XCTAssertEqual(market[0].soldBy, y.address)
    }

    // ---- 红包：托管状态机 + 余额守恒（ChainState 与 parseRedPackets 同源 computeShare）----
    func testRedPacketEscrowAndBalances() throws {
        let x = Wallet.generate(), y = Wallet.generate(), z = Wallet.generate()
        let mint = coinbase(to: x.address, amount: 1000, index: 0)
        let red = try x.createTransaction(to: Config.redEscrowAddress, amount: 100, nonce: 0, memo: "RED|2|r", fee: 1)
        let claimY = try y.createTransaction(to: y.address, amount: 0, nonce: 0, memo: "CLAIM|\(red.txid)", fee: 1)
        let claimZ = try z.createTransaction(to: z.address, amount: 0, nonce: 0, memo: "CLAIM|\(red.txid)", fee: 1)

        let chain = [
            block([mint], hash: "00aa"), block([red], hash: "00bb"),
            block([claimY], hash: "00cc"), block([claimZ], hash: "00dd"),
        ]
        let st = ChainState(chain: chain)
        XCTAssertEqual(st.balance(of: Config.redEscrowAddress), 0, "全部抢完后托管必须清零")
        XCTAssertEqual(st.balance(of: x.address), 1000 - 100 - 1, "发起人付 总额+手续费")
        XCTAssertEqual(st.balance(of: y.address) + 1 + st.balance(of: z.address) + 1, 100, "两份之和 = 总额")

        let views = RedPacket.parseRedPackets(chain)
        XCTAssertEqual(views.count, 1)
        XCTAssertTrue(views[0].done)
        XCTAssertEqual(views[0].remaining, 0)
        XCTAssertEqual(views[0].claims.count, 2)
        let claimedY = views[0].claims.first { $0.who == y.address }!.amount
        XCTAssertEqual(st.balance(of: y.address), claimedY - 1)
    }

    func testRedPacketRefund() throws {
        let x = Wallet.generate()
        let mint = coinbase(to: x.address, amount: 1000, index: 0)
        let red = try x.createTransaction(to: Config.redEscrowAddress, amount: 100, nonce: 0, memo: "RED|5|e", fee: 1)
        let refund = try x.createTransaction(to: x.address, amount: 0, nonce: 1, memo: "REFUND|\(red.txid)", fee: 1)
        let st = ChainState(chain: [block([mint], hash: "00aa"), block([red], hash: "00bb"), block([refund], hash: "00cc")])
        XCTAssertEqual(st.balance(of: Config.redEscrowAddress), 0)
        XCTAssertEqual(st.balance(of: x.address), 1000 - 1 - 1, "退款取回全部，仅净付两笔手续费")
        XCTAssertTrue(RedPacket.parseRedPackets([block([mint]), block([red]), block([refund])])[0].refunded)
    }

    func testComputeShareBounds() {
        XCTAssertEqual(RedPacket.computeShare(remaining: 50, remainingCount: 1, mode: .random, seedHex: "ffffffffffff"), 50)
        let s = RedPacket.computeShare(remaining: 100, remainingCount: 3, mode: .random, seedHex: "000000000000")
        XCTAssertGreaterThanOrEqual(s, 1)
        XCTAssertEqual(RedPacket.computeShare(remaining: 90, remainingCount: 3, mode: .equal, seedHex: ""), 30)
    }

    // ---- 测试辅助：构造区块 / coinbase（解析与状态机不校验签名/PoW，可用占位字段）----
    func block(_ txs: [Transaction], hash: String = "00") -> Block {
        Block(index: 0, timestamp: 0, prevHash: "", transactions: txs, merkleRoot: "",
              difficulty: 0, nonce: 0, miner: Config.nullAddress, hash: hash)
    }

    func coinbase(to: String, amount: Int, index: Int) -> Transaction {
        let id = TxBuilder.txid(from: Config.nullAddress, to: to, amount: amount, fee: 0,
                                nonce: index, timestamp: 0, memo: "")
        return Transaction(from: Config.nullAddress, to: to, amount: amount, fee: 0, nonce: index,
                           timestamp: 0, memo: "", burn: nil, signature: "", txid: id)
    }
}
