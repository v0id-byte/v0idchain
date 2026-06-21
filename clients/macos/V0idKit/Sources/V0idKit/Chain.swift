// 链状态：重放整条链算余额 / nonce / 已销毁；消息解析；区块浏览器检索；可选完整性自检。
// 对应 packages/core 的 blockchain.computeState + messages + packages/web api 的 explorer 逻辑。
import Foundation

public struct ChainState {
    public var balances: [String: Int]
    public var nonces: [String: Int]

    public init(balances: [String: Int] = [:], nonces: [String: Int] = [:]) {
        self.balances = balances
        self.nonces = nonces
    }

    public func balance(_ address: String) -> Int { balances[address] ?? 0 }
    public func nonce(_ address: String) -> Int { nonces[address] ?? 0 }
    /// 全网已销毁（烧进虚空）总额 = NULL_ADDRESS 的累计入账。
    public var burned: Int { balances[Config.nullAddress] ?? 0 }
}

/// 链上消息（amount 0 + burn>0 + memo 正文）。对应 messages.ts 的 ChainMessage。
public struct ChainMessage: Identifiable, Equatable {
    public let txid: String
    public let from: String
    public let to: String
    public let text: String
    public let burn: Int
    public let timestamp: Int
    public let height: Int
    public var id: String { txid }
}

/// 红包里的一条领取记录。
public struct RedPacketClaim: Identifiable, Equatable {
    public let who: String
    public let amount: Int
    public let height: Int
    public var id: String { who }
}

/// 链上红包只读视图（扫链重放，与共识同源）。
public struct RedPacketView: Identifiable, Equatable {
    public let id: String
    public let creator: String
    public let total: Int
    public let count: Int
    public let mode: String        // "r" = 拼手气, "e" = 均分
    public var remaining: Int
    public var remainingCount: Int
    public let createHeight: Int
    public var claims: [RedPacketClaim]
    public var refunded: Bool
    public var done: Bool
    public var isRandom: Bool { mode == "r" }
}

/// 浏览器里一条交易的引用（带其所在区块高度）。
public struct TxRef: Identifiable, Equatable {
    public let tx: Transaction
    public let blockIndex: Int
    public var id: String { tx.txid + "@\(blockIndex)" }
}

public enum SearchResult: Equatable {
    case address(address: String, balance: Int, history: [TxRef])
    case tx(TxRef)
    case block(Block)
    case none
}

public enum Chain {
    // ---- 状态：重放整条链（CLIENT-PROTOCOL §4），无服务端 ----
    public static func computeState(_ chain: [Block]) -> ChainState {
        var balances = [String: Int]()
        var nonces = [String: Int]()
        func credit(_ addr: String, _ amt: Int) { balances[addr, default: 0] += amt }

        for block in chain {
            for tx in block.transactions {
                if !tx.isCoinbase {
                    let burn = tx.burn ?? 0
                    credit(tx.from, -(tx.amount + tx.fee + burn))   // 发送方付 金额 + 手续费 + 销毁额
                    if burn > 0 { credit(Config.nullAddress, burn) } // 销毁额记入虚空（守恒、= 全网已烧毁）
                    nonces[tx.from, default: 0] += 1
                }
                credit(tx.to, tx.amount)                            // 收款方实收（消息为 0）
            }
        }
        return ChainState(balances: balances, nonces: nonces)
    }

    /// 你下一笔交易该用的 nonce = 已上链 nonce + 已广播但未打包的待发笔数（pending）。
    public static func nextNonce(_ chain: [Block], address: String, pending: Int = 0) -> Int {
        computeState(chain).nonce(address) + pending
    }

    // ---- 消息（messages.ts）----
    public static func isMessageTx(_ tx: Transaction) -> Bool { tx.amount == 0 && (tx.burn ?? 0) > 0 }

    /// 扫整条链，把所有消息交易还原成消息列表（最新在前）。
    public static func parseMessages(_ chain: [Block]) -> [ChainMessage] {
        var out = [ChainMessage]()
        for b in chain {
            for tx in b.transactions where isMessageTx(tx) {
                out.append(ChainMessage(txid: tx.txid, from: tx.from, to: tx.to,
                                        text: tx.memo, burn: tx.burn ?? 0,
                                        timestamp: tx.timestamp, height: b.index))
            }
        }
        return out.sorted { $0.timestamp > $1.timestamp }
    }

    /// 收件箱（to = 我）与发件箱（from = 我）。
    public static func inbox(_ chain: [Block], address: String) -> [ChainMessage] {
        parseMessages(chain).filter { $0.to == address }
    }
    public static func outbox(_ chain: [Block], address: String) -> [ChainMessage] {
        parseMessages(chain).filter { $0.from == address }
    }

    /// 链上出现过的全部地址（作为 from 或 to），用于「新人发现」。排除虚空地址。
    public static func collectAddresses(_ chain: [Block]) -> Set<String> {
        var set = Set<String>()
        for b in chain {
            for tx in b.transactions {
                if tx.from != Config.nullAddress { set.insert(tx.from) }
                if tx.to != Config.nullAddress { set.insert(tx.to) }
            }
        }
        return set
    }

    // ---- 区块浏览器（web/api.ts 的 explorer）----
    /// 某地址的余额（仅按 amount，与 explorer 一致）+ 进出历史（最新在前，含 coinbase 收入）。
    public static func addressHistory(_ chain: [Block], _ address: String) -> (balance: Int, history: [TxRef]) {
        var balance = 0
        var history = [TxRef]()
        for b in chain {
            for tx in b.transactions {
                if tx.to == address { balance += tx.amount }
                if tx.from == address { balance -= tx.amount + tx.fee + (tx.burn ?? 0) }
                if tx.to == address || tx.from == address {
                    history.append(TxRef(tx: tx, blockIndex: b.index))
                }
            }
        }
        return (balance, history.reversed())
    }

    public static func findTx(_ chain: [Block], _ txid: String) -> TxRef? {
        for b in chain {
            if let tx = b.transactions.first(where: { $0.txid == txid }) {
                return TxRef(tx: tx, blockIndex: b.index)
            }
        }
        return nil
    }

    public static func findBlock(_ chain: [Block], _ query: String) -> Block? {
        if let n = Int(query), query.allSatisfy({ $0.isNumber }) {
            return chain.first { $0.index == n }
        }
        return chain.first { $0.hash == query || $0.hash.hasPrefix(query) }
    }

    /// 自动判别查询类型：0x地址 / 64hex-txid / 区块#或hash。
    public static func search(_ chain: [Block], _ raw: String) -> SearchResult {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return .none }
        if Crypto.isValidAddress(q) {
            let (bal, hist) = addressHistory(chain, q)
            return .address(address: q, balance: bal, history: hist)
        }
        if q.count == 64, q.allSatisfy({ $0.isHexDigit }) {
            if let ref = findTx(chain, q) { return .tx(ref) }
        }
        if let b = findBlock(chain, q) { return .block(b) }
        return .none
    }

    // ---- 红包（对应 packages/core/src/redpacket.ts）----

    /// 拼手气份额计算（全整数，与共识同源）。
    static func computeShare(remaining: Int, remainingCount: Int, mode: String, seedHex: String) -> Int {
        if remainingCount <= 1 { return remaining }
        if mode == "e" { return remaining / remainingCount }
        let maxShare = remaining - (remainingCount - 1)
        let upper = max(1, min((2 * remaining) / remainingCount, maxShare))
        let seed = Int(UInt64(String(seedHex.prefix(12)), radix: 16) ?? 0)
        return 1 + (seed % upper)
    }

    /// 扫整条链还原所有红包及其领取记录（只读展示，最新在前）。
    public static func parseRedPackets(_ chain: [Block]) -> [RedPacketView] {
        var pools = [String: RedPacketView]()
        for b in chain {
            for tx in b.transactions {
                let m = tx.memo
                if m.isEmpty { continue }
                // 发红包
                if tx.to == Config.redEscrowAddress && m.hasPrefix(Config.redPrefix) {
                    let rest = String(m.dropFirst(Config.redPrefix.count))
                    let parts = rest.split(separator: "|", maxSplits: 1)
                    guard parts.count == 2,
                          let count = Int(parts[0]),
                          count >= 1, count <= Config.maxRedCount,
                          (parts[1] == "r" || parts[1] == "e"),
                          tx.amount >= count else { continue }
                    pools[tx.txid] = RedPacketView(
                        id: tx.txid, creator: tx.from,
                        total: tx.amount, count: count, mode: String(parts[1]),
                        remaining: tx.amount, remainingCount: count,
                        createHeight: b.index, claims: [], refunded: false, done: false)
                    continue
                }
                // 抢红包
                if m.hasPrefix(Config.claimPrefix) {
                    let claimId = String(m.dropFirst(Config.claimPrefix.count))
                    guard claimId.count == 64, claimId.allSatisfy({ $0.isHexDigit }),
                          var p = pools[claimId],
                          !p.done, p.remainingCount > 0,
                          tx.from != p.creator,
                          !p.claims.contains(where: { $0.who == tx.from }) else { continue }
                    let seed = Crypto.sha256Hex(b.hash + tx.txid)
                    let share = computeShare(remaining: p.remaining, remainingCount: p.remainingCount, mode: p.mode, seedHex: seed)
                    p.claims.append(RedPacketClaim(who: tx.from, amount: share, height: b.index))
                    p.remaining -= share
                    p.remainingCount -= 1
                    if p.remainingCount == 0 { p.done = true }
                    pools[claimId] = p
                    continue
                }
                // 退款
                if m.hasPrefix(Config.refundPrefix) {
                    let refundId = String(m.dropFirst(Config.refundPrefix.count))
                    guard var p = pools[refundId],
                          !p.done, tx.from == p.creator, p.remaining > 0 else { continue }
                    p.refunded = true; p.remaining = 0; p.remainingCount = 0; p.done = true
                    pools[refundId] = p
                }
            }
        }
        return pools.values.sorted { $0.createHeight > $1.createHeight }
    }

    // ---- 可选：轻量完整性自检（不含难度重定向引擎，保持简单可靠）----
    /// 重算每块 hash + prevHash 链接 + 每笔 txid + merkleRoot + 非 coinbase 验签。
    /// 不校验自适应难度（那需重定向算法）。返回首个问题描述，nil = 通过。
    public static func integrityCheck(_ chain: [Block]) -> String? {
        guard !chain.isEmpty else { return "空链" }
        for (i, b) in chain.enumerated() {
            if b.calcHash() != b.hash { return "#\(i) 区块 hash 被篡改" }
            if i > 0 && b.prevHash != chain[i - 1].hash { return "#\(i) prevHash 不匹配" }
            if Crypto.merkleRoot(b.transactions.map { $0.txid }) != b.merkleRoot {
                return "#\(i) merkleRoot 不匹配"
            }
            for tx in b.transactions where !tx.selfValid() {
                return "#\(i) 交易自洽性失败 (\(String(tx.txid.prefix(10)))…)"
            }
        }
        return nil
    }
}
