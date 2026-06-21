// 交易：转账（带手续费）/ 消息（amount 0 + burn>0 + memo）/ coinbase / 创世。
// 对应 packages/core/src/transaction.ts —— txid 预映像与签名必须逐字节一致。
import Foundation

public struct Transaction: Codable, Equatable, Identifiable, Sendable {
    public var from: String        // 发送方地址（= 公钥）；coinbase / 创世为 NULL_ADDRESS
    public var to: String          // 接收方地址
    public var amount: Int         // 转账金额（收款方实收）；链上消息为 0
    public var fee: Int            // 手续费（gas），归打包矿工；coinbase / 创世为 0
    public var nonce: Int          // 发送方自增计数，防重放
    public var timestamp: Int      // 毫秒 epoch
    public var memo: String        // 备注 / 消息正文
    public var burn: Int?          // 销毁进虚空的 $V0ID（消息用）；普通转账省略(=0)。仅 >0 时计入 txid
    public var signature: String   // ed25519 签名 hex；coinbase / 创世为空串
    public var txid: String        // = sha256(规范化预映像)

    public var id: String { txid }

    public init(from: String, to: String, amount: Int, fee: Int, nonce: Int,
                timestamp: Int, memo: String, burn: Int?, signature: String, txid: String) {
        self.from = from; self.to = to; self.amount = amount; self.fee = fee
        self.nonce = nonce; self.timestamp = timestamp; self.memo = memo
        self.burn = burn; self.signature = signature; self.txid = txid
    }

    /// 是否 coinbase / 创世（from = 空地址）。
    public var isCoinbase: Bool { from == Config.nullAddress }

    /// 是否“链上消息”：不转币（amount 0）但销毁了币（burn>0）。
    public var isMessage: Bool { amount == 0 && (burn ?? 0) > 0 }

    /// 实际销毁额（burn ?? 0）。
    public var burnAmount: Int { burn ?? 0 }
}

public enum TxBuilder {
    /// 参与签名 / txid 计算的规范化预映像 → 哈希。burn 仅在 >0 时追加（保证历史转账逐字节不变）。
    /// 等价于 packages/core 的 payloadHash。
    public static func preimage(from: String, to: String, amount: Int, fee: Int,
                                nonce: Int, timestamp: Int, memo: String, burn: Int?) -> String {
        var fields: [JSONValue] = [
            .string(from), .string(to), .int(amount), .int(fee),
            .int(nonce), .int(timestamp), .string(memo),
        ]
        if let b = burn, b > 0 { fields.append(.int(b)) }
        return JSONStringify.array(fields)
    }

    public static func txid(from: String, to: String, amount: Int, fee: Int,
                            nonce: Int, timestamp: Int, memo: String, burn: Int?) -> String {
        Crypto.sha256Hex(preimage(from: from, to: to, amount: amount, fee: fee,
                                  nonce: nonce, timestamp: timestamp, memo: memo, burn: burn))
    }

    /// 普通转账：由钱包本地签名。fee 默认最低 MIN_FEE。
    public static func transfer(wallet: Wallet, to: String, amount: Int, nonce: Int,
                                memo: String = "", fee: Int = Config.minFee,
                                timestamp: Int = nowMillis()) throws -> Transaction {
        let id = txid(from: wallet.address, to: to, amount: amount, fee: fee,
                      nonce: nonce, timestamp: timestamp, memo: memo, burn: nil)
        let sig = try wallet.sign(txidHex: id)
        return Transaction(from: wallet.address, to: to, amount: amount, fee: fee,
                           nonce: nonce, timestamp: timestamp, memo: memo,
                           burn: nil, signature: sig, txid: id)
    }

    /// 链上消息：amount 恒 0，burn = 烧进虚空的 $V0ID（默认 MESSAGE_BURN），memo = 正文，另付 fee。
    public static func message(wallet: Wallet, to: String, text: String, nonce: Int,
                               burn: Int = Config.messageBurn, fee: Int = Config.minFee,
                               timestamp: Int = nowMillis()) throws -> Transaction {
        let id = txid(from: wallet.address, to: to, amount: 0, fee: fee,
                      nonce: nonce, timestamp: timestamp, memo: text, burn: burn)
        let sig = try wallet.sign(txidHex: id)
        return Transaction(from: wallet.address, to: to, amount: 0, fee: fee,
                           nonce: nonce, timestamp: timestamp, memo: text,
                           burn: burn, signature: sig, txid: id)
    }

    public static func nowMillis() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
}

public extension Transaction {
    /// 单笔交易自洽性校验（金额 / txid 匹配内容 / 签名）。不含余额 / nonce 顺序（那依赖整链状态）。
    /// 对应 packages/core 的 verifyTransaction。轻客户端可选用（trustless 进阶）。
    func selfValid() -> Bool {
        let b = burn ?? 0
        guard amount >= 0, b >= 0, fee >= 0 else { return false }
        // 空操作（amount0 且 burn0）一律拒；例外：红包 CLAIM/REFUND 的入账由共识从托管池支付。
        let zeroOk = memo.hasPrefix(Config.claimPrefix) || memo.hasPrefix(Config.refundPrefix)
        if amount == 0 && b == 0 && !zeroOk { return false }
        if memo.unicodeScalars.count > Config.maxMemo { return false }   // 按码点计数
        let recomputed = TxBuilder.txid(from: from, to: to, amount: amount, fee: fee,
                                        nonce: nonce, timestamp: timestamp, memo: memo, burn: burn)
        guard recomputed == txid else { return false }
        if isCoinbase { return fee == 0 && b == 0 && amount > 0 }
        if fee < Config.minFee { return false }
        let pubHex = from.hasPrefix("0x") ? String(from.dropFirst(2)) : from
        return Crypto.verify(signatureHex: signature, messageHex: txid, publicKeyHex: pubHex)
    }
}
