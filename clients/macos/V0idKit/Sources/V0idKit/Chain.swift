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
    public let text: String          // 原始 memo（加密私信为 `ENC|<密文>`，由 UI 用钱包解密）
    public let burn: Int
    public let timestamp: Int
    public let height: Int
    /// 是否端到端加密私信（memo 以 `ENC|` 开头）。
    public var encrypted: Bool { text.hasPrefix(Config.encPrefix) }
    public var id: String { txid }
}

/// “新成员”事件：某地址在链上的首次出现（首笔上链），按高度倒序（最新在前）。
public struct Newcomer: Identifiable, Equatable {
    public let address: String
    public let height: Int
    public var id: String { address }
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
    // 复刻 blockchain.ts 的 computeState + applyTx：余额/nonce + 红包托管状态机。
    // ⚠️ 红包 CLAIM/REFUND 的入账来自托管池（不是本交易的 amount），必须按同一套派发公式重放，
    //    否则抢/退过红包的地址余额会与全网漂移。链由所连节点保证合法 → 这里只“应用”，不再校验。
    public static func computeState(_ chain: [Block]) -> ChainState {
        var balances = [String: Int]()
        var nonces = [String: Int]()
        struct Pool { var remaining: Int; var remainingCount: Int; var mode: RedMode }
        var pools = [String: Pool]()
        func credit(_ addr: String, _ amt: Int) { balances[addr, default: 0] += amt }
        func bump(_ addr: String) { nonces[addr, default: 0] += 1 }

        for block in chain {
            for tx in block.transactions {
                if tx.isCoinbase { credit(tx.to, tx.amount); continue }   // 矿工/预挖收款，无 nonce
                let m = tx.memo

                // 发红包：转给托管地址 → 锁总额、开池。余额效果 = 普通转账到托管，额外开池。
                if tx.to == Config.redEscrowAddress, m.hasPrefix(Config.redPrefix),
                   let meta = RedPacket.parseCreate(m), tx.amount >= meta.count {
                    credit(tx.from, -(tx.amount + tx.fee))
                    credit(Config.redEscrowAddress, tx.amount)
                    pools[tx.txid] = Pool(remaining: tx.amount, remainingCount: meta.count, mode: meta.mode)
                    bump(tx.from)
                    continue
                }
                // 抢红包：从托管派一份（拼手气随机额由所在区块 hash 决定）
                if m.hasPrefix(Config.claimPrefix), tx.amount == 0,
                   let id = RedPacket.parseClaimId(m), var p = pools[id] {
                    let share = RedPacket.computeShare(remaining: p.remaining, remainingCount: p.remainingCount,
                                                       mode: p.mode,
                                                       seedHex: RedPacket.redSeed(blockHash: block.hash, claimTxid: tx.txid))
                    credit(tx.from, share - tx.fee)            // 收到 share、付出 fee
                    credit(Config.redEscrowAddress, -share)
                    p.remaining -= share; p.remainingCount -= 1
                    pools[id] = p
                    bump(tx.from)
                    continue
                }
                // 退款：发起人取回剩余
                if m.hasPrefix(Config.refundPrefix), tx.amount == 0,
                   let id = RedPacket.parseRefundId(m), var p = pools[id] {
                    let amt = p.remaining
                    credit(tx.from, amt - tx.fee)
                    credit(Config.redEscrowAddress, -amt)
                    p.remaining = 0; p.remainingCount = 0
                    pools[id] = p
                    bump(tx.from)
                    continue
                }

                // 普通交易（转账/消息/昵称/集市）
                let burn = tx.burn ?? 0
                credit(tx.from, -(tx.amount + tx.fee + burn))   // 发送方付 金额 + 手续费 + 销毁额
                credit(tx.to, tx.amount)                        // 收款方实收（消息为 0）
                if burn > 0 { credit(Config.nullAddress, burn) } // 销毁额记入虚空（守恒、= 全网已烧毁）
                bump(tx.from)
            }
        }
        return ChainState(balances: balances, nonces: nonces)
    }

    /// 新成员：每个地址按“首次上链高度”倒序（最新在前）。排除虚空 / 托管地址。
    public static func newcomers(_ chain: [Block], limit: Int = 25) -> [Newcomer] {
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
