// 钱包：一对 ed25519 密钥 + 派生地址。对应 packages/core/src/wallet.ts。
// 私钥 = 32 字节种子（CryptoKit 的 rawRepresentation）；公钥 = publicKey.rawRepresentation（32 字节）。
import Foundation
import CryptoKit

public struct Wallet {
    /// 32 字节私钥种子
    public let privateKey: Data
    /// 32 字节公钥
    public let publicKey: Data
    /// 地址 = "0x" + 公钥小写 hex
    public let address: String

    private let signingKey: Curve25519.Signing.PrivateKey

    public init(seed: Data) throws {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        self.signingKey = key
        self.privateKey = key.rawRepresentation
        self.publicKey = key.publicKey.rawRepresentation
        self.address = "0x" + Hex.encode(self.publicKey)
    }

    /// 随机生成一个新钱包
    public static func generate() -> Wallet {
        // CryptoKit 随机生成 32 字节种子；rawRepresentation 即为该种子。
        let key = Curve25519.Signing.PrivateKey()
        return try! Wallet(seed: key.rawRepresentation)
    }

    /// 从 64-hex 私钥还原钱包。非法 hex / 长度不符 → 抛错。
    public static func fromPrivateKeyHex(_ hex: String) throws -> Wallet {
        let trimmed = hex.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let bytes = Hex.decode(trimmed), bytes.count == 32 else {
            throw WalletError.invalidPrivateKey
        }
        return try Wallet(seed: Data(bytes))
    }

    public var privateKeyHex: String { Hex.encode(privateKey) }
    public var publicKeyHex: String { Hex.encode(publicKey) }

    /// 对 txid（64-hex）签名：把 txid 解码成 32 字节作为待签消息，ed25519 签名 → 小写 hex（128 字符）。
    /// 见 CLIENT-PROTOCOL §3.3。CryptoKit 的签名是随机化（hedged nonce）的 —— 仍是合法 RFC 8032 签名，
    /// 网络严格验签照样通过，只是不会复现金标准里那串固定签名 hex（详见 README / 金标准测试）。
    public func sign(txidHex: String) throws -> String {
        guard let msg = Hex.decodeData(txidHex) else { throw WalletError.invalidTxid }
        let sig = try signingKey.signature(for: msg)
        return Hex.encode(sig)
    }
}

public enum WalletError: Error, LocalizedError {
    case invalidPrivateKey
    case invalidTxid

    public var errorDescription: String? {
        switch self {
        case .invalidPrivateKey: return "私钥无效：需要 64 个十六进制字符（32 字节）"
        case .invalidTxid: return "txid 无效"
        }
    }
}
