// 链状态：重放整条链自算余额/nonce（CLIENT-PROTOCOL §4，无服务端）、还原链上消息、区块浏览检索。
// 对齐 packages/core 的 blockchain.computeState / messages.parseMessages 与 web 的 api.ts 检索。
import Foundation

public struct ChainState {
    public private(set) var balances: [String: Int] = [:]
    public private(set) var nonces: [String: Int] = [:]

    /// 重放链：对每块每笔交易按 §4 规则累计余额与 nonce。
    public init(chain: [Block]) {
        for block in chain {
            for tx in block.transactions {
                if tx.from != Crypto.nullAddress {
                    let burn = tx.burnAmount
                    balances[tx.from, default: 0] -= (tx.amount + tx.fee + burn) // 发送方付 金额+手续费+销毁额
                    if burn > 0 { balances[Crypto.nullAddress, default: 0] += burn } // 销毁额记入虚空（守恒）
                    nonces[tx.from, default: 0] += 1
                }
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
