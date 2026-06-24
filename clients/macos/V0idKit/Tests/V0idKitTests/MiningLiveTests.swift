// 端到端挖矿：用 V0idKit 真连一个运行中的节点 → 同步创世 → 组块 → 搜 nonce → 广播 →
// 确认**节点接受**（把我们的块当作链顶服务回来），且矿工得到出块奖励。
// 默认跳过；需设环境变量启用（只对本地一次性 dev 节点跑，切勿对公网种子发测试块）：
//   V0ID_LIVE_MINE_WS   例如 ws://127.0.0.1:6055
//
// 运行（见 scripts 注释）：
//   corepack pnpm exec tsx packages/cli/src/index.ts start --name e2e-mine --p2p-port 6055 --api-port 7055
//   V0ID_LIVE_MINE_WS=ws://127.0.0.1:6055 swift test --filter MiningLiveTests
import XCTest
@testable import V0idKit

final class MiningLiveTests: XCTestCase {
    func testLiveSoloMine() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let ws = env["V0ID_LIVE_MINE_WS"] else {
            throw XCTSkip("未设 V0ID_LIVE_MINE_WS，跳过端到端挖矿测试")
        }
        // 确定性矿工地址 → shell 可独立用 /balance?address= 复核。
        let miner = try Wallet(seed: Data(repeating: 0xBB, count: 32))
        print("MINER=\(miner.address)")

        let client = NodeClient(bootstrap: [ws], myAddress: miner.address, maxPeers: 4)
        await client.start()

        enum Stage { case syncing, awaitingAccept, done }
        var stage = Stage.syncing
        var minedHash = ""

        try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await ev in client.events {
                    guard case .chain(let blocks) = ev else { continue }
                    switch stage {
                    case .syncing:
                        guard let tip = blocks.last else { continue }   // 至少拿到创世
                        let template = Mining.buildTemplate(chain: blocks, miner: miner.address)
                        print("⛏️ 组块 #\(template.index) 难度 \(template.difficulty)（接在 #\(tip.index) 之后），搜 nonce…")
                        guard let block = await Mining.search(template: template) else { return false }
                        minedHash = block.hash
                        print("✅ 挖到 #\(block.index) hash=\(block.hash.prefix(16))… nonce=\(block.nonce)")
                        XCTAssertEqual(block.calcHash(), block.hash, "封入 hash 必须等于重算")
                        XCTAssertTrue(Crypto.meetsDifficulty(block.hash, template.difficulty), "必须满足难度")
                        stage = .awaitingAccept
                        try await client.broadcastBlock(block)
                        print("➤ 已把区块广播给节点，等它接受并作为链顶服务回来…")
                    case .awaitingAccept:
                        // 节点接受的唯一证据：它把我们的块当链顶**服务回来**（节点没在挖 → 高度增长只能来自我们）。
                        guard let mineBlock = blocks.first(where: { $0.hash == minedHash }) else { continue }
                        XCTAssertEqual(mineBlock.miner, miner.address, "出块矿工应为我们")
                        let cb = mineBlock.transactions.first
                        XCTAssertTrue(cb?.isCoinbase == true, "首笔应为 coinbase")
                        XCTAssertEqual(cb?.to, miner.address, "coinbase 收款应为矿工")
                        XCTAssertEqual(cb?.amount, Config.blockReward, "空块奖励 = BLOCK_REWARD")
                        let bal = Chain.computeState(blocks).balance(miner.address)
                        XCTAssertEqual(bal, Config.blockReward, "矿工应得到出块奖励")
                        print("🎉 节点已接受我们的块（链高 \(blocks.count - 1)），矿工余额 \(bal) \(Config.symbol)")
                        stage = .done
                        return true
                    case .done:
                        break
                    }
                }
                return false
            }
            group.addTask {
                try await Task.sleep(nanoseconds: 60_000_000_000)   // 60s 兜底
                return false
            }
            let ok = try await group.next() ?? false
            group.cancelAll()
            XCTAssertTrue(ok, "端到端挖矿超时：节点是否在运行、是否未开 --mine？")
        }
        await client.stop()
    }

    // phase 2：挖一个**含转账交易**的块，证明节点 validateChain 接受、收款方到账、矿工收手续费。
    // 流程：攒钱（挖空块给 A 到余额≥2）→ A 转 1 给 B（fee 1）→ 选包 → 挖含该交易的块 → 广播 → 确认 B 到账。
    func testLiveMineWithTransaction() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let ws = env["V0ID_LIVE_MINE_WS"] else {
            throw XCTSkip("未设 V0ID_LIVE_MINE_WS，跳过 phase2 端到端测试")
        }
        let a = try Wallet(seed: Data(repeating: 0xBB, count: 32))   // 矿工 + 发送方
        let b = try Wallet(seed: Data(repeating: 0xCC, count: 32))   // 收款方
        print("SENDER=\(a.address)")
        print("RECIPIENT=\(b.address)")
        let need = 2   // A 需 ≥2 才能发 amount1 + fee1

        let client = NodeClient(bootstrap: [ws], myAddress: a.address, maxPeers: 4)
        await client.start()

        enum Phase { case funding, awaitingTx, done }
        var phase = Phase.funding
        var pendingHash: String?      // 已广播、等节点确认的块
        var transfer: Transaction?
        var bStart: Int?
        var minedEmpty = 0

        try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await ev in client.events {
                    guard case .chain(let chain) = ev else { continue }
                    let st = Chain.computeState(chain)
                    if bStart == nil { bStart = st.balance(b.address) }
                    if let ph = pendingHash {   // 等上一块被节点确认后才继续
                        if chain.contains(where: { $0.hash == ph }) { pendingHash = nil } else { continue }
                    }
                    switch phase {
                    case .funding:
                        if st.balance(a.address) >= need {
                            let t = try TxBuilder.transfer(wallet: a, to: b.address, amount: 1,
                                                           nonce: st.nonce(a.address), fee: 1)
                            transfer = t
                            let sel = Mining.selectTxs(chain: chain, mempool: [t])
                            XCTAssertEqual(sel.count, 1, "转账应被选入")
                            let tmpl = Mining.buildTemplate(chain: chain, miner: a.address, extraTxs: sel)
                            guard let blk = await Mining.search(template: tmpl) else { return false }
                            XCTAssertEqual(blk.transactions.count, 2, "块应含 coinbase + 1 转账")
                            XCTAssertEqual(blk.transactions[0].amount, Config.blockReward + 1, "coinbase = 奖励 + 手续费")
                            pendingHash = blk.hash
                            phase = .awaitingTx
                            try await client.broadcastBlock(blk)
                            print("➤ 广播含交易的块 #\(blk.index)")
                        } else {
                            guard minedEmpty < 8 else { XCTFail("攒钱超过 8 块仍不够"); return false }
                            let tmpl = Mining.buildTemplate(chain: chain, miner: a.address)
                            guard let blk = await Mining.search(template: tmpl) else { return false }
                            pendingHash = blk.hash
                            minedEmpty += 1
                            try await client.broadcastBlock(blk)
                            print("⛏️ 攒钱块 #\(blk.index)（A 余额 \(st.balance(a.address))/\(need)）")
                        }
                    case .awaitingTx:
                        if let t = transfer,
                           chain.contains(where: { $0.transactions.contains { $0.txid == t.txid } }) {
                            let bBal = st.balance(b.address)
                            XCTAssertEqual(bBal, (bStart ?? 0) + 1, "B 应收到转账 1")
                            print("🎉 含交易的块被节点接受；B 余额 \(bBal) \(Config.symbol)")
                            phase = .done
                            return true
                        }
                    case .done:
                        break
                    }
                }
                return false
            }
            group.addTask {
                try await Task.sleep(nanoseconds: 120_000_000_000)   // 120s 兜底（多轮挖矿 + 5s 心跳确认）
                return false
            }
            let ok = try await group.next() ?? false
            group.cancelAll()
            XCTAssertTrue(ok, "phase2 端到端超时")
        }
        await client.stop()
    }
}
