// 密码学原语：SHA-256 + ed25519（CryptoKit），地址派生，难度位计数，Merkle 根。
// 对齐 packages/core/src/crypto.ts。
import Foundation
import CryptoKit

public enum Crypto {
    /// 空地址（虚空/销毁 + coinbase 的 from）：'0x' + 64 个 '0'。
    public static let nullAddress = "0x" + String(repeating: "0", count: 64)

    /// 对字符串的 UTF-8 字节做 SHA-256，返回小写 hex。全协议所有哈希都是它。
    public static func sha256Hex(_ s: String) -> String {
        Hex.encode(Data(SHA256.hash(data: Data(s.utf8))))
    }

    /// 由 32 字节私钥种子推出 32 字节公钥（CryptoKit = 标准 RFC8032）。
    public static func publicKey(fromPrivateKey seed: Data) throws -> Data {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        return key.publicKey.rawRepresentation
    }

    /// 地址 = '0x' + 公钥 hex（32 字节 → 64 hex 字符）。
    public static func address(fromPublicKey pub: Data) -> String {
        "0x" + Hex.encode(pub)
    }

    /// 从地址取回公钥 hex（地址本身内含公钥）。
    public static func publicKeyHex(fromAddress address: String) -> String {
        address.hasPrefix("0x") ? String(address.dropFirst(2)) : address
    }

    /// 地址是否合法：'0x' + 64 个小写 hex。
    public static func isValidAddress(_ address: String) -> Bool {
        guard address.hasPrefix("0x") else { return false }
        let body = address.dropFirst(2)
        guard body.count == 64 else { return false }
        return body.allSatisfy { $0.isHexDigitLowercase }
    }

    /// 对一段 hex 消息用私钥签名，返回 64 字节签名的小写 hex（128 字符）。
    /// ⚠️ CryptoKit 的 ed25519 采用 RFC8032 hedged（随机化 nonce）签名 —— 同一消息每次签名字节不同，
    /// 但都是合法签名、都能通过验签，因此**全网照常接受**（节点验签与 nonce 推导方式无关）。
    /// 这意味着无法逐字节复现 §9 金标准里那条确定性 SIGNATURE；详见 README。
    public static func sign(messageHex: String, privateKey seed: Data) throws -> String {
        guard let msg = Hex.decode(messageHex) else { throw V0idError.invalidHex(messageHex) }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        let sig = try key.signature(for: msg)
        return Hex.encode(sig)
    }

    /// 验签：签名 / 消息 / 公钥均为 hex。
    public static func verify(signatureHex: String, messageHex: String, publicKeyHex: String) -> Bool {
        guard
            let sig = Hex.decode(signatureHex),
            let msg = Hex.decode(messageHex),
            let pub = Hex.decode(publicKeyHex),
            let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub)
        else { return false }
        return key.isValidSignature(sig, for: msg)
    }

    /// 一个 hex 哈希的前导 0 比特数（注意是 bit，不是 hex 位）。对齐 leadingZeroBits。
    public static func leadingZeroBits(_ hashHex: String) -> Int {
        var bits = 0
        for ch in hashHex {
            guard let n = ch.hexDigitValue else { break }
            if n == 0 { bits += 4; continue }
            // n 是 4-bit 值：前导零个数 = 3 - floor(log2(n))
            var v = n, lead = 0
            while v < 8 { lead += 1; v <<= 1 }
            bits += lead
            break
        }
        return bits
    }

    /// 交易 Merkle 根：两两 sha256Hex(a+b) 逐层归并，奇数复制末尾；空集 → sha256Hex("")。
    public static func merkleRoot(_ txids: [String]) -> String {
        if txids.isEmpty { return sha256Hex("") }
        var layer = txids
        while layer.count > 1 {
            var next: [String] = []
            var i = 0
            while i < layer.count {
                let a = layer[i]
                let b = i + 1 < layer.count ? layer[i + 1] : a
                next.append(sha256Hex(a + b))
                i += 2
            }
            layer = next
        }
        return layer[0]
    }
}

public enum V0idError: Error, LocalizedError {
    case invalidHex(String)
    case invalidPrivateKey
    case invalidAddress(String)

    public var errorDescription: String? {
        switch self {
        case .invalidHex(let s): return "非法 hex：\(s)"
        case .invalidPrivateKey: return "私钥无效（须为 64 个 hex 字符 = 32 字节）"
        case .invalidAddress(let a): return "地址无效：\(a)"
        }
    }
}

private extension Character {
    var isHexDigitLowercase: Bool {
        ("0"..."9").contains(self) || ("a"..."f").contains(self)
    }
}
