// 链上数据模型：与 packages/core 的 wire JSON 对齐。
// 注意：这些 Codable 仅用于 WebSocket 收发解析 —— 节点只读字段、与键序无关。
// txid 的字节级序列化**另由** CanonicalJSON/TxBuilder 负责（绝不依赖 JSONEncoder 的输出）。
import Foundation

public struct Transaction: Codable, Identifiable, Hashable {
    public var from: String
    public var to: String
    public var amount: Int
    public var fee: Int
    public var nonce: Int
    public var timestamp: Int
    public var memo: String
    public var burn: Int?        // 仅消息交易 >0；普通转账省略（nil → 不进 wire JSON、不进 txid）
    public var signature: String
    public var txid: String

    public var id: String { txid }

    public var burnAmount: Int { burn ?? 0 }
    public var isCoinbase: Bool { from == Crypto.nullAddress }
    /// 链上消息：不转币（amount 0）但销毁了币（burn>0）。coinbase/创世天然不满足。
    public var isMessage: Bool { amount == 0 && burnAmount > 0 }

    public init(
        from: String, to: String, amount: Int, fee: Int, nonce: Int,
        timestamp: Int, memo: String, burn: Int?, signature: String, txid: String
    ) {
        self.from = from; self.to = to; self.amount = amount; self.fee = fee
        self.nonce = nonce; self.timestamp = timestamp; self.memo = memo
        self.burn = burn; self.signature = signature; self.txid = txid
    }
}

public struct Block: Codable, Identifiable, Hashable {
    public var index: Int
    public var timestamp: Int
    public var prevHash: String
    public var transactions: [Transaction]
    public var merkleRoot: String
    public var difficulty: Int
    public var nonce: Int
    public var miner: String
    public var hash: String

    public var id: Int { index }
}

public extension Transaction {
    /// 单笔交易自洽性校验（金额 / txid 匹配内容 / 签名）。不含余额 / nonce 顺序（那依赖整链状态）。
    /// 对应 packages/core 的 verifyTransaction。轻客户端可选用（trustless 进阶）。
    func selfValid() -> Bool {
        let b = burnAmount
        guard amount >= 0, b >= 0, fee >= 0 else { return false }
        // 空操作（amount0 且 burn0）一律拒；例外：红包 CLAIM/REFUND 的入账由共识从托管池支付。
        let zeroOk = memo.hasPrefix(Config.claimPrefix) || memo.hasPrefix(Config.refundPrefix)
        if amount == 0 && b == 0 && !zeroOk { return false }
        if memo.unicodeScalars.count > Config.maxMemo { return false }   // 按码点计数
        let recomputed = TxBuilder.txid(from: from, to: to, amount: amount, fee: fee,
                                        nonce: nonce, timestamp: timestamp, memo: memo, burn: b)
        guard recomputed == txid else { return false }
        if isCoinbase { return fee == 0 && b == 0 && amount > 0 }
        if fee < Config.minFee { return false }
        let pubHex = from.hasPrefix("0x") ? String(from.dropFirst(2)) : from
        return Crypto.verify(signatureHex: signature, messageHex: txid, publicKeyHex: pubHex)
    }
}

/// 链上消息（由消息交易还原）。
public struct ChainMessage: Identifiable, Hashable {
    public var txid: String
    public var from: String
    public var to: String
    public var text: String
    public var burn: Int
    public var timestamp: Int
    public var height: Int

    public var id: String { txid }
}
