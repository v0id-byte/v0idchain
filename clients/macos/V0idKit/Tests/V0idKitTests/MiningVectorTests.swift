// 挖矿一致性金标准：难度重定向 + coinbase txid + nonce 搜索，与 packages/core 逐位对齐。
// 向量由 scripts/gen-mining-vectors.ts 从 TS 参考实现生成。守住跨语言取整坑（JS Math.round）。
import XCTest
@testable import V0idKit

final class MiningVectorTests: XCTestCase {
    let miner = "0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
    let ts = 1_700_000_000_000

    // 占位区块：expectedDifficulty 只读 timestamp / difficulty 与数组位置。
    private func stub(_ timestamp: Int, _ difficulty: Int) -> Block {
        Block(index: 0, timestamp: timestamp, prevHash: "", transactions: [],
              merkleRoot: "", difficulty: difficulty, nonce: 0, miner: "", hash: "")
    }
    // 长 16 的链：仅 index 8 / 15 的时间戳参与 index=16 的重定向计算。
    private func chain16(base: Int, ts8: Int, ts15: Int) -> [Block] {
        (0..<16).map { i in stub(i == 8 ? ts8 : (i == 15 ? ts15 : i * 8000), base) }
    }

    // ---- 难度重定向（call index=16；prev=chain[15]，windowStart=chain[8]）----
    func testDifficultyRetarget() {
        let base = 1_000_000
        func d(_ baseDiff: Int, _ actual: Int) -> Int {
            Mining.expectedDifficulty(chain16(base: baseDiff, ts8: base, ts15: base + actual), index: 16)
        }
        XCTAssertEqual(d(20, 56_000), 20, "on-target → 不变")
        XCTAssertEqual(d(20, 14_000), 22, "4x 快 → +2")
        XCTAssertEqual(d(20, 28_000), 21, "2x 快 → +1")
        XCTAssertEqual(d(20, 112_000), 19, "2x 慢 → -1（关键：JS Math.round 语义）")
        XCTAssertEqual(d(20, 224_000), 18, "4x 慢 → -2")
        XCTAssertEqual(d(20, 7_000), 22, "8x 快 → 钳制 +2")
        XCTAssertEqual(d(9, 56_000_000), 8, "极慢 → -2 → 落到 MIN_DIFFICULTY 地板 8")
        XCTAssertEqual(d(20, 0), 22, "actual<=0 → +2")
    }

    func testDifficultyV2ActivationAndRetarget() {
        let activation = (0..<Config.powV2Height).map { i in stub(i * Config.targetBlockTimeMs, Config.genesisDifficulty) }
        let baseCompact = 520_159_231 // compact target for v1 16-bit difficulty
        XCTAssertEqual(Mining.expectedDifficulty(activation, index: Config.powV2Height), baseCompact)

        func d(_ actual: Int) -> Int {
            let idx = Config.powV2Height + Config.powV2RetargetInterval
            var c = (0..<idx).map { i in
                stub(i * Config.targetBlockTimeMs, i < Config.powV2Height ? Config.genesisDifficulty : baseCompact)
            }
            c[idx - Config.powV2RetargetInterval].timestamp = 1_000_000
            c[idx - 1].timestamp = 1_000_000 + actual
            return Mining.expectedDifficulty(c, index: idx)
        }
        let span = Config.powV2RetargetInterval * Config.targetBlockTimeMs
        XCTAssertEqual(d(span / Config.powV2MaxAdjustFactor), 507_510_720, "4x 快 → BTC-style compact target 加难")
        XCTAssertEqual(d(span), baseCompact, "准点 → compact target 不变")
        XCTAssertEqual(d(span * Config.powV2MaxAdjustFactor), 520_355_836, "4x 慢 → BTC-style compact target 降难")
    }

    // ---- 非重定向点 / 近创世 / 创世 → 沿用规则 ----
    func testDifficultyNonRetarget() {
        let c = chain16(base: 20, ts8: 1_000_000, ts15: 1_014_000)
        XCTAssertEqual(Mining.expectedDifficulty(c, index: 15), 20, "15%8≠0 → 沿用 prev")
        XCTAssertEqual(Mining.expectedDifficulty(c, index: 8), 20, "8-8<1（触创世）→ 沿用 prev")
        XCTAssertEqual(Mining.expectedDifficulty(c, index: 0), Config.genesisDifficulty, "index 0 → 创世难度")
    }

    // ---- coinbase txid（与 createCoinbase 的 payloadHash 逐字节一致）----
    func testCoinbaseTxid() {
        func id(_ index: Int, _ fees: Int) -> String {
            TxBuilder.coinbase(minerAddress: miner, blockIndex: index, fees: fees, timestamp: ts).txid
        }
        XCTAssertEqual(id(1, 0), "064421e9b2427a2606555c4a93fe8dd27ea436d45c2fb8367817c5d894e12ae9")
        XCTAssertEqual(id(1234, 0), "40545612f78fb9bbb46c47cf8d065d6e7137e17f4f4d06286a65beb4142467c7")
        XCTAssertEqual(id(1234, 7), "d229780415ed0f283fafffed15a442280916baa4ea8df9861af0f6fe6145732a")
        XCTAssertEqual(id(99999, 250), "c5ecc3d40898beb5e49571b6029bd102e53837bf039ec7275cdbdc0931d01767")
    }

    // coinbase 自洽：金额 = 奖励 + 手续费、fee/burn=0、空签名、txid 匹配内容。
    func testCoinbaseSelfValid() {
        let cb = TxBuilder.coinbase(minerAddress: miner, blockIndex: 1234, fees: 7, timestamp: ts)
        XCTAssertTrue(cb.isCoinbase)
        XCTAssertEqual(cb.amount, Config.blockReward + 7)
        XCTAssertEqual(cb.fee, 0)
        XCTAssertEqual(cb.signature, "")
        XCTAssertTrue(cb.selfValid(), "coinbase 必须自洽校验通过，否则全网拒收")
    }

    // ---- 选包：nonce 连号 / 手续费优先 / 跳过红包 / 余额门控 ----
    func testSelectTxs() throws {
        let a = try Wallet(seed: Data(repeating: 0xBB, count: 32))
        let b = "0x" + String(repeating: "cd", count: 32)
        // 一条链：coinbase 给 A 100（A nonce=0）。computeState 只读交易，区块其余字段随意。
        let cb = TxBuilder.coinbase(minerAddress: a.address, blockIndex: 0, fees: 99) // amount 100
        let blk = Block(index: 0, timestamp: ts, prevHash: "", transactions: [cb],
                        merkleRoot: Crypto.merkleRoot([cb.txid]), difficulty: 16, nonce: 0,
                        miner: a.address, hash: "00")
        let chain = [blk]
        XCTAssertEqual(Chain.computeState(chain).balance(a.address), 100)

        let t0 = try TxBuilder.transfer(wallet: a, to: b, amount: 10, nonce: 0, fee: 5, timestamp: ts)
        let t1 = try TxBuilder.transfer(wallet: a, to: b, amount: 10, nonce: 1, fee: 9, timestamp: ts)
        let t2 = try TxBuilder.transfer(wallet: a, to: b, amount: 10, nonce: 3, fee: 20, timestamp: ts) // nonce 空档
        let red = try TxBuilder.transfer(wallet: a, to: Config.redEscrowAddress, amount: 5, nonce: 0,
                                         memo: "RED|2|r", fee: 1, timestamp: ts)                          // 红包→跳过

        // 输入乱序；期望按 nonce 连号选入 t0,t1；t2 有空档、red 红包 → 排除。
        let sel = Mining.selectTxs(chain: chain, mempool: [t2, t1, t0, red])
        XCTAssertEqual(sel.map { $0.txid }, [t0.txid, t1.txid],
                       "应连号选入 t0,t1；t2(空档) 与 red(红包) 排除")
    }

    // ---- nonce 搜索：组模板 → 搜出满足难度的 hash（用低难度，快）----
    func testSearchFindsValidBlock() async {
        let tip = stub(ts, 12)                 // 单元素链；下一块难度沿用 12 bit（≈4096 次哈希）
        let template = Mining.buildTemplate(chain: [tip], miner: miner, nowMs: ts + 1)
        XCTAssertEqual(template.difficulty, 12)
        XCTAssertEqual(template.index, 1)
        XCTAssertEqual(template.prevHash, tip.hash)
        XCTAssertTrue(template.transactions.first?.isCoinbase == true)

        let found = await Mining.search(template: template, batch: 4096)
        let blk = try? XCTUnwrap(found)
        XCTAssertNotNil(blk, "应当能搜到满足 12-bit 难度的区块")
        if let b = blk {
            XCTAssertEqual(b.calcHash(), b.hash, "封入的 hash 必须等于重算 hash")
            XCTAssertTrue(Crypto.meetsDifficulty(b.hash, 12), "hash 必须满足难度")
            XCTAssertEqual(b.merkleRoot, Crypto.merkleRoot(b.transactions.map { $0.txid }))
        }
    }
}
