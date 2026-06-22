// 钱包：一对 ed25519 密钥 + 派生地址，并在本地构造/签名交易。
// 对齐 packages/core 的 wallet.ts / transaction.ts（createTransaction / createMessage）。
import Foundation
import CryptoKit

/// 交易预映像与 txid 的纯函数（CLIENT-PROTOCOL §3.2）。与签名/时间无关，便于金标准自检。
public enum TxBuilder {
    /// 默认链上消息销毁额（= core 的 MESSAGE_BURN）。
    public static let messageBurn = 5
    /// 最低手续费（= core 的 MIN_FEE）。
    public static let minFee = 1

    /// 规范化预映像：7 元素；若 burn>0 则在末尾追加（与历史逐字节一致的根基）。
    public static func preimage(
        from: String, to: String, amount: Int, fee: Int,
        nonce: Int, timestamp: Int, memo: String, burn: Int = 0
    ) -> String {
        var els: [CanonicalJSON.Element] = [
            .string(from), .string(to), .int(amount), .int(fee),
            .int(nonce), .int(timestamp), .string(memo),
        ]
        if burn > 0 { els.append(.int(burn)) }
        return CanonicalJSON.array(els)
    }

    /// txid = sha256Hex(preimage)。
    public static func txid(
        from: String, to: String, amount: Int, fee: Int,
        nonce: Int, timestamp: Int, memo: String, burn: Int = 0
    ) -> String {
        Crypto.sha256Hex(preimage(
            from: from, to: to, amount: amount, fee: fee,
            nonce: nonce, timestamp: timestamp, memo: memo, burn: burn))
    }
}

public struct Wallet: Equatable {
    public let privateKey: Data    // 32 字节种子
    public let publicKey: Data     // 32 字节
    public let address: String

    public init(seedHex: String) throws {
        guard let seed = Hex.decode(seedHex), seed.count == 32 else { throw V0idError.invalidPrivateKey }
        try self.init(seed: seed)
    }

    public init(seed: Data) throws {
        guard seed.count == 32 else { throw V0idError.invalidPrivateKey }
        // 经 CryptoKit 派生公钥，顺带校验 seed 合法
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        self.privateKey = seed
        self.publicKey = key.publicKey.rawRepresentation
        self.address = Crypto.address(fromPublicKey: key.publicKey.rawRepresentation)
    }

    /// 随机生成一个新钱包。
    public static func generate() -> Wallet {
        let key = Curve25519.Signing.PrivateKey()
        // rawRepresentation 即 32 字节种子；再走 init(seed:) 统一派生路径。
        // CryptoKit 刚生成的 key 必然是合法 32 字节，init(seed:) 不会抛错；用 do/catch 取代 try!，
        // 避免强制解包崩溃语义，并在理论上不可达的失败处给出清晰诊断（对齐 Android 的安全构造）。
        do {
            return try Wallet(seed: key.rawRepresentation)
        } catch {
            fatalError("unreachable: CryptoKit 生成的 32 字节种子未通过 Wallet(seed:) 校验：\(error)")
        }
    }

    public var privateKeyHex: String { Hex.encode(privateKey) }

    /// 对一段 hex 消息（=txid 解码后的 32 字节，由调用方先 hexDecode）签名 —— 见 Crypto.sign 的语义。
    public func sign(messageHex: String) throws -> String {
        try Crypto.sign(messageHex: messageHex, privateKey: privateKey)
    }

    /// 普通转账：本地构造 + 签名。timestamp 默认取当前毫秒（可注入以做确定性测试）。
    public func createTransaction(
        to: String, amount: Int, nonce: Int, memo: String = "",
        fee: Int = TxBuilder.minFee, timestamp: Int = nowMillis()
    ) throws -> Transaction {
        let txid = TxBuilder.txid(
            from: address, to: to, amount: amount, fee: fee,
            nonce: nonce, timestamp: timestamp, memo: memo)
        let signature = try sign(messageHex: txid)
        return Transaction(
            from: address, to: to, amount: amount, fee: fee, nonce: nonce,
            timestamp: timestamp, memo: memo, burn: nil, signature: signature, txid: txid)
    }

    /// 链上消息：amount 恒 0，burn 烧进虚空，memo = 正文。timestamp 默认当前毫秒。
    public func createMessage(
        to: String, text: String, nonce: Int,
        burn: Int = TxBuilder.messageBurn, fee: Int = TxBuilder.minFee, timestamp: Int = nowMillis()
    ) throws -> Transaction {
        let txid = TxBuilder.txid(
            from: address, to: to, amount: 0, fee: fee,
            nonce: nonce, timestamp: timestamp, memo: text, burn: burn)
        let signature = try sign(messageHex: txid)
        return Transaction(
            from: address, to: to, amount: 0, fee: fee, nonce: nonce,
            timestamp: timestamp, memo: text, burn: burn, signature: signature, txid: txid)
    }
}

/// 当前 epoch 毫秒（整数），与 JS `Date.now()` 同义。
public func nowMillis() -> Int {
    Int((Date().timeIntervalSince1970 * 1000).rounded())
}
