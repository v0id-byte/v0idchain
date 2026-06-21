// 链状态：重放整条链自算余额/nonce（CLIENT-PROTOCOL §4，无服务端）、还原链上消息、区块浏览检索。
// 对齐 packages/core 的 blockchain.computeState / messages.parseMessages 与 web 的 api.ts 检索。
import Foundation

public struct ChainState {
    public private(set) var balances: [String: Int] = [:]
    public private(set) var nonces: [String: Int] = [:]

    /// 重放链：对每块每笔交易按 §4 规则累计余额与 nonce + 红包托管状态机。
    /// ⚠️ 红包 CLAIM/REFUND 的入账来自托管池（不是本交易的 amount），必须按同一套派发公式重放，
    ///    否则抢/退过红包的地址余额会与全网漂移。链由所连节点保证合法 → 这里只“应用”，不再校验。
    ///    复刻 packages/core 的 computeState + applyTx（与 macOS Chain.computeState 一致）。
    public init(chain: [Block]) {
        struct Pool { var remaining: Int; var remainingCount: Int; var mode: RedMode }
        var pools = [String: Pool]()

        for block in chain {
            for tx in block.transactions {
                if tx.isCoinbase {                                  // 矿工/预挖收款，无 nonce
                    balances[tx.to, default: 0] += tx.amount
                    continue
                }
                let m = tx.memo

                // 发红包：转给托管地址 → 锁总额、开池。余额效果 = 普通转账到托管，额外开池。
                if tx.to == Config.redEscrowAddress, m.hasPrefix(Config.redPrefix),
                   let meta = RedPacket.parseCreate(m), tx.amount >= meta.count {
                    balances[tx.from, default: 0] -= (tx.amount + tx.fee)
                    balances[Config.redEscrowAddress, default: 0] += tx.amount
                    pools[tx.txid] = Pool(remaining: tx.amount, remainingCount: meta.count, mode: meta.mode)
                    nonces[tx.from, default: 0] += 1
                    continue
                }
                // 抢红包：从托管派一份（拼手气随机额由所在区块 hash 决定）
                if m.hasPrefix(Config.claimPrefix), tx.amount == 0,
                   let id = RedPacket.parseClaimId(m), var p = pools[id] {
                    let share = RedPacket.computeShare(remaining: p.remaining, remainingCount: p.remainingCount,
                                                       mode: p.mode,
                                                       seedHex: RedPacket.redSeed(blockHash: block.hash, claimTxid: tx.txid))
                    balances[tx.from, default: 0] += (share - tx.fee)       // 收到 share、付出 fee
                    balances[Config.redEscrowAddress, default: 0] -= share
                    p.remaining -= share; p.remainingCount -= 1
                    pools[id] = p
                    nonces[tx.from, default: 0] += 1
                    continue
                }
                // 退款：发起人取回剩余
                if m.hasPrefix(Config.refundPrefix), tx.amount == 0,
                   let id = RedPacket.parseRefundId(m), var p = pools[id] {
                    let amt = p.remaining
                    balances[tx.from, default: 0] += (amt - tx.fee)
                    balances[Config.redEscrowAddress, default: 0] -= amt
                    p.remaining = 0; p.remainingCount = 0
                    pools[id] = p
                    nonces[tx.from, default: 0] += 1
                    continue
                }

                // 普通交易（转账/消息/昵称/集市）
                let burn = tx.burnAmount
                balances[tx.from, default: 0] -= (tx.amount + tx.fee + burn) // 发送方付 金额+手续费+销毁额
                if burn > 0 { balances[Crypto.nullAddress, default: 0] += burn } // 销毁额记入虚空（守恒）
                nonces[tx.from, default: 0] += 1
                balances[tx.to, default: 0] += tx.amount // 收款方实收（消息为 0）
            }
        }
    }

    public func balance(of address: String) -> Int { balances[address] ?? 0 }
    /// 某地址已上链交易数 = 下一笔“已确认”应使用的 nonce（未计入本地待打包的 pending）。
    public func confirmedNonce(of address: String) -> Int { nonces[address] ?? 0 }

    /// 全网已烧进虚空的 $V0ID 总额（🔥）。
    public var totalBurned: Int { balances[Crypto.nullAddress] ?? 0 }
}

// MARK: - 链上消息

public enum Messages {
    /// 扫整条链，把所有消息交易还原成消息列表（最新在前）。
    public static func parse(_ chain: [Block]) -> [ChainMessage] {
        var out: [ChainMessage] = []
        for b in chain {
            for tx in b.transactions where tx.isMessage {
                out.append(ChainMessage(
                    txid: tx.txid, from: tx.from, to: tx.to, text: tx.memo,
                    burn: tx.burnAmount, timestamp: tx.timestamp, height: b.index))
            }
        }
        return out.sorted { $0.timestamp > $1.timestamp }
    }

    /// 收件箱（发给我的）/ 发件箱（我发的）。
    public static func inbox(_ chain: [Block], address: String) -> [ChainMessage] {
        parse(chain).filter { $0.to == address }
    }
    public static func outbox(_ chain: [Block], address: String) -> [ChainMessage] {
        parse(chain).filter { $0.from == address }
    }
}

// MARK: - 区块浏览器：纯客户端检索（数据都在已拉取的链里）

public struct TxRef: Identifiable, Hashable {
    public let tx: Transaction
    public let blockIndex: Int
    public var id: String { tx.txid }

    public init(tx: Transaction, blockIndex: Int) {
        self.tx = tx
        self.blockIndex = blockIndex
    }
}

public enum Explorer {
    /// 某地址余额 + 进出历史（含 coinbase 收入），最新在前。对齐 web api.ts addressHistory。
    public static func addressHistory(_ chain: [Block], _ address: String) -> (balance: Int, history: [TxRef]) {
        var balance = 0
        var history: [TxRef] = []
        for b in chain {
            for tx in b.transactions {
                if tx.to == address { balance += tx.amount }
                if tx.from == address { balance -= (tx.amount + tx.fee + tx.burnAmount) }
                if tx.to == address || tx.from == address { history.append(TxRef(tx: tx, blockIndex: b.index)) }
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
        if let n = Int(query) { return chain.first { $0.index == n } }
        return chain.first { $0.hash == query || $0.hash.hasPrefix(query) }
    }

    public enum Result {
        case address(address: String, balance: Int, history: [TxRef])
        case tx(TxRef)
        case block(Block)
        case none
    }

    /// 自动判别查询类型：0x地址 / 64hex-txid / 区块#或hash。对齐 web api.ts search。
    public static func search(_ chain: [Block], _ raw: String) -> Result {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return .none }
        if isAddress(q) {
            let (balance, history) = addressHistory(chain, q)
            return .address(address: q, balance: balance, history: history)
        }
        if isHash(q), let ref = findTx(chain, q) { return .tx(ref) }
        if let block = findBlock(chain, q) { return .block(block) }
        return .none
    }

    private static func isAddress(_ q: String) -> Bool {
        q.hasPrefix("0x") && q.count == 66 && q.dropFirst(2).allSatisfy { $0.isHexDigit }
    }
    private static func isHash(_ q: String) -> Bool {
        q.count == 64 && q.allSatisfy { $0.isHexDigit }
    }
}

// MARK: - 新成员发现

/// “新成员”事件：某地址在链上的首次出现（首笔上链），按高度倒序（最新在前）。
public struct Newcomer: Identifiable, Equatable {
    public let address: String
    public let height: Int
    public var id: String { address }

    public init(address: String, height: Int) {
        self.address = address
        self.height = height
    }
}

public extension Explorer {
    /// 新成员：每个地址按“首次上链高度”倒序（最新在前）。排除虚空 / 托管地址。
    /// 对齐 macOS Chain.newcomers。
    static func newcomers(_ chain: [Block], limit: Int = 25) -> [Newcomer] {
        var firstSeen = [String: Int]()
        for b in chain {
            for tx in b.transactions {
                for addr in [tx.from, tx.to] where addr != Config.nullAddress && addr != Config.redEscrowAddress {
                    if firstSeen[addr] == nil { firstSeen[addr] = b.index }
                }
            }
        }
        return firstSeen.map { Newcomer(address: $0.key, height: $0.value) }
            .sorted { $0.height > $1.height }
            .prefix(limit).map { $0 }
    }
}
