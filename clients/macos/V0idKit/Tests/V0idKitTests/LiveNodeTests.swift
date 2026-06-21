// 端到端：用 V0idKit 的 NodeClient 真连一个运行中的节点，同步 → 转账 → 发消息 → 等打包 → 验证到账。
// 默认跳过；需设环境变量启用（只对本地 dev 节点跑，切勿对公网种子发测试垃圾）：
//   V0ID_LIVE_WS    例如 ws://127.0.0.1:6001
//   V0ID_LIVE_PRIV  一个**已有余额**的私钥 hex（本地 dev 用 node1 的挖矿钱包 .data/node1/wallet.json）
//
// 运行：
//   corepack pnpm dev:node1        # 另一个终端，先让它挖几个块攒余额
//   V0ID_LIVE_WS=ws://127.0.0.1:6001 V0ID_LIVE_PRIV=<priv> swift test --filter LiveNodeTests
import XCTest
@testable import V0idKit

final class LiveNodeTests: XCTestCase {
    func testLiveTransferAndMessage() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let ws = env["V0ID_LIVE_WS"], let priv = env["V0ID_LIVE_PRIV"] else {
            throw XCTSkip("未设 V0ID_LIVE_WS / V0ID_LIVE_PRIV，跳过端到端测试")
        }
        let sender = try Wallet.fromPrivateKeyHex(priv)
        // 固定收件人（种子 0xAA…），地址确定 → shell 可独立用 `v0id inbox <addr>` 复核。
        let recipient = try Wallet(seed: Data(repeating: 0xAA, count: 32))
        print("SENDER=\(sender.address)")
        print("RECIPIENT=\(recipient.address)")

        let transferAmount = 1
        let fee = 1
        let burn = 5
        let need = transferAmount + fee + burn + fee   // 转账(amount+fee) + 消息(burn+fee)
        let stamp = TxBuilder.nowMillis()
        let marker = "macOS 轻客户端端到端 ✅ \(stamp)"   // 唯一正文，便于在收件箱里精确认出本次

        let client = NodeClient(bootstrap: [ws], myAddress: sender.address, maxPeers: 4)
        await client.start()

        enum Stage { case awaitingFunds, broadcast, awaitingInclusion, done }
        var stage = Stage.awaitingFunds
        var transferTxid = ""
        var messageTxid = ""

        try await withThrowingTaskGroup(of: Bool.self) { group in
            // 主逻辑：消费链快照，推进状态机
            group.addTask {
                for await ev in client.events {
                    guard case .chain(let blocks) = ev else { continue }
                    let st = Chain.computeState(blocks)
                    switch stage {
                    case .awaitingFunds:
                        let bal = st.balance(sender.address)
                        print("… 同步中：链高 \(blocks.count - 1)，sender 余额 \(bal)/\(need)")
                        if bal >= need {
                            let n0 = st.nonce(sender.address)
                            let transfer = try TxBuilder.transfer(wallet: sender, to: recipient.address,
                                                                  amount: transferAmount, nonce: n0, memo: "e2e", fee: fee)
                            let message = try TxBuilder.message(wallet: sender, to: recipient.address,
                                                                text: marker, nonce: n0 + 1, burn: burn, fee: fee)
                            transferTxid = transfer.txid
                            messageTxid = message.txid
                            try await client.broadcast(transfer)
                            try await client.broadcast(message)
                            print("➤ 已广播 transfer=\(transfer.txid.prefix(12))… message=\(message.txid.prefix(12))…")
                            stage = .awaitingInclusion
                        }
                    case .awaitingInclusion:
                        let onChain = Set(blocks.flatMap { $0.transactions.map { $0.txid } })
                        if onChain.contains(transferTxid) && onChain.contains(messageTxid) {
                            // 转账到账
                            let recvBal = st.balance(recipient.address)
                            XCTAssertGreaterThanOrEqual(recvBal, transferAmount, "收款方余额未到账")
                            // 消息进收件箱（to = recipient），且正是本次的那条
                            let inbox = Chain.inbox(blocks, address: recipient.address)
                            XCTAssertTrue(inbox.contains { $0.txid == messageTxid && $0.text == marker },
                                          "消息未出现在收件人收件箱")
                            print("✅ 链上确认：transfer + message 均已打包，收件箱含本条消息")
                            stage = .done
                            return true
                        }
                    case .broadcast, .done:
                        break
                    }
                }
                return false
            }
            // 超时兜底（90s）
            group.addTask {
                try await Task.sleep(nanoseconds: 90_000_000_000)
                return false
            }
            let ok = try await group.next() ?? false
            group.cancelAll()
            XCTAssertTrue(ok, "端到端超时：未在 90s 内完成同步/打包确认（节点是否在挖矿、余额是否够？）")
        }
        await client.stop()
    }
}
