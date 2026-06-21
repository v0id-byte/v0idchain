// 链上抢红包：共识级托管 + 条件支付。对应 packages/core/src/redpacket.ts（纯函数）+ blockchain.ts（状态机）。
// 三种操作（建在普通交易 + memo 上）：
//   发红包 RED   ：转给托管地址（to==RED_ESCROW）amount=总额，memo `RED|<份数>|<r|e>`。
//   抢红包 CLAIM ：amount=0，memo `CLAIM|<红包id>`。随机源 = 该 CLAIM 所在区块 hash（抢前不可预测）。
//   退款   REFUND：amount=0，memo `REFUND|<红包id>`。仅发起人、且过 RED_EXPIRY 块后取回剩余。
// ⚠️ CLAIM/REFUND 的余额变更由共识从托管池支付 → 客户端 computeState 必须复刻同一套 applyTx（见 Chain.swift），
//    否则抢/退过红包的地址余额会与全网漂移。
import Foundation

public enum RedMode: String { case random = "r", equal = "e" }

public struct RedPacketView: Identifiable, Equatable {
    public let id: String          // 创建交易 txid
    public let creator: String
    public let total: Int
    public let count: Int
    public let mode: RedMode
    public var remaining: Int
    public var remainingCount: Int
    public let createHeight: Int
    public var claims: [Claim]
    public var refunded: Bool
    public var done: Bool           // 抢完或已退款

    public struct Claim: Equatable { public let who: String; public let amount: Int; public let height: Int }
}

public enum RedPacket {
    public struct Meta { public let count: Int; public let mode: RedMode }

    /// 解析 RED|<份数>|<r|e>；非法返回 nil。
    public static func parseCreate(_ memo: String) -> Meta? {
        guard memo.hasPrefix(Config.redPrefix) else { return nil }
        let rest = String(memo.dropFirst(Config.redPrefix.count))
        guard let sep = rest.firstIndex(of: "|") else { return nil }
        guard let count = Int(rest[..<sep]), count >= 1, count <= Config.maxRedCount else { return nil }
        guard let mode = RedMode(rawValue: String(rest[rest.index(after: sep)...])) else { return nil }
        return Meta(count: count, mode: mode)
    }

    /// CLAIM|<id> → id（须像 64-hex txid）；否则 nil。
    public static func parseClaimId(_ memo: String) -> String? { idAfter(Config.claimPrefix, memo) }
    /// REFUND|<id> → id；否则 nil。
    public static func parseRefundId(_ memo: String) -> String? { idAfter(Config.refundPrefix, memo) }

    private static func idAfter(_ prefix: String, _ memo: String) -> String? {
        guard memo.hasPrefix(prefix) else { return nil }
        let id = String(memo.dropFirst(prefix.count))
        guard id.count == 64, id.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
        return id
    }

    /// “amount=0 也合法”的红包操作（CLAIM/REFUND）。
    public static func isZeroAmountOp(_ memo: String) -> Bool {
        memo.hasPrefix(Config.claimPrefix) || memo.hasPrefix(Config.refundPrefix)
    }

    /// 拼手气随机源：区块 hash + CLAIM txid 一起哈希 → 确定性、各端一致、抢前不可预测。
    public static func redSeed(blockHash: String, claimTxid: String) -> String {
        Crypto.sha256Hex(blockHash + claimTxid)
    }

    /// 一次领取的金额（整数，共识关键 —— 必须与全网算出同一结果）。
    public static func computeShare(remaining: Int, remainingCount: Int, mode: RedMode, seedHex: String) -> Int {
        if remainingCount <= 1 { return remaining }
        if mode == .equal { return remaining / remainingCount }
        let maxShare = remaining - (remainingCount - 1)
        let upper = max(1, min((2 * remaining) / remainingCount, maxShare))
        let seed = Int(UInt64(seedHex.prefix(12), radix: 16) ?? 0)   // 48-bit
        return 1 + (seed % upper)
    }

    /// 校验“发红包”入参；返回 (memo, total) 或错误。
    public static func makeRedPacket(total: Int, count: Int, mode: RedMode) -> (memo: String?, error: String?) {
        guard total >= 1 else { return (nil, "红包总额必须是正整数") }
        guard count >= 1, count <= Config.maxRedCount else { return (nil, "份数需 1~\(Config.maxRedCount)") }
        guard total >= count else { return (nil, "总额需 ≥ 份数（每份至少 1）：\(total) < \(count)") }
        return ("\(Config.redPrefix)\(count)|\(mode.rawValue)", nil)
    }

    /// 扫整条链还原所有红包及领取记录（只读展示用；与共识同源 computeShare → 展示额 = 链上实际入账）。
    public static func parseRedPackets(_ chain: [Block]) -> [RedPacketView] {
        var pools = [String: RedPacketView]()
        for b in chain {
            for tx in b.transactions {
                let m = tx.memo
                if m.isEmpty { continue }
                if tx.to == Config.redEscrowAddress, let red = parseCreate(m), tx.amount >= red.count {
                    pools[tx.txid] = RedPacketView(id: tx.txid, creator: tx.from, total: tx.amount, count: red.count,
                                                   mode: red.mode, remaining: tx.amount, remainingCount: red.count,
                                                   createHeight: b.index, claims: [], refunded: false, done: false)
                    continue
                }
                if let id = parseClaimId(m), var p = pools[id],
                   !p.done, p.remainingCount > 0, tx.from != p.creator, !p.claims.contains(where: { $0.who == tx.from }) {
                    let share = computeShare(remaining: p.remaining, remainingCount: p.remainingCount,
                                             mode: p.mode, seedHex: redSeed(blockHash: b.hash, claimTxid: tx.txid))
                    p.claims.append(.init(who: tx.from, amount: share, height: b.index))
                    p.remaining -= share
                    p.remainingCount -= 1
                    if p.remainingCount == 0 { p.done = true }
                    pools[id] = p
                    continue
                }
                if let id = parseRefundId(m), var p = pools[id], !p.done, tx.from == p.creator, p.remaining > 0 {
                    p.refunded = true; p.remaining = 0; p.remainingCount = 0; p.done = true
                    pools[id] = p
                }
            }
        }
        return pools.values.sorted { $0.createHeight > $1.createHeight }
    }
}
