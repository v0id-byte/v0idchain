// 密码学原语：hex 编解码、SHA-256、ed25519 验签、Merkle 根、难度位数。
// 对应 packages/core/src/crypto.ts —— 哈希/序列化必须逐字节一致。
import Foundation
import CryptoKit

public enum Hex {
    /// 字节 → 小写 hex
    public static func encode<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        var s = ""
        s.reserveCapacity(64)
        for b in bytes { s += String(format: "%02x", b) }
        return s
    }

    public static func encode(_ data: Data) -> String { encode(Array(data)) }

    /// hex → 字节。非法 hex（奇数长度 / 非 hex 字符）返回 nil。
    public static func decode(_ hex: String) -> [UInt8]? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 2)
        func nibble(_ c: UInt8) -> UInt8? {
            switch c {
            case 0x30...0x39: return c - 0x30          // 0-9
            case 0x61...0x66: return c - 0x61 + 10     // a-f
            case 0x41...0x46: return c - 0x41 + 10     // A-F
            default: return nil
            }
        }
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    public static func decodeData(_ hex: String) -> Data? {
        guard let b = decode(hex) else { return nil }
        return Data(b)
    }
}

public enum Crypto {
    /// 对字符串的 UTF-8 字节做 SHA-256，返回小写 hex。全协议所有哈希都是它。
    public static func sha256Hex(_ s: String) -> String {
        Hex.encode(SHA256.hash(data: Data(s.utf8)))
    }

    /// ed25519 验签：签名 / 消息 / 公钥均为 hex。任一解码失败或验签失败返回 false。
    /// 网络用 @noble 的 zip215:false 严格验签；CryptoKit 的 isValidSignature 同走 RFC 8032，
    /// 对正常生成的签名结论一致（金标准向量交叉验证已确认）。
    public static func verify(signatureHex: String, messageHex: String, publicKeyHex: String) -> Bool {
        guard
            let sig = Hex.decodeData(signatureHex),
            let msg = Hex.decodeData(messageHex),
            let pub = Hex.decodeData(publicKeyHex),
            let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pub)
        else { return false }
        return key.isValidSignature(sig, for: msg)
    }

    /// 地址是否合法：'0x' + 64 个小写 hex（= ed25519 公钥）。
    public static func isValidAddress(_ address: String) -> Bool {
        guard address.hasPrefix("0x") else { return false }
        let hex = address.dropFirst(2)
        guard hex.count == 64 else { return false }
        return hex.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    /// 一个 64-hex（256-bit）哈希的前导 0 比特数（bit 粒度，对应 leadingZeroBits）。
    public static func leadingZeroBits(_ hashHex: String) -> Int {
        var bits = 0
        for ch in hashHex {
            guard let n = ch.hexDigitValue else { break }
            if n == 0 { bits += 4; continue }
            // n 是 4-bit 值；统计其高位的零个数
            var v = n
            var lead = 4
            while v > 0 { v >>= 1; lead -= 1 }
            bits += lead
            break
        }
        return bits
    }

    /// 是否满足难度：hash 前导 0 比特数 ≥ difficulty。
    public static func meetsDifficulty(_ hashHex: String, _ difficulty: Int) -> Bool {
        leadingZeroBits(hashHex) >= difficulty
    }

    /// 交易 Merkle 根：两两 sha256Hex(a+b) 逐层归并，奇数复制末尾；空集 → sha256Hex("")。
    public static func merkleRoot(_ txids: [String]) -> String {
        if txids.isEmpty { return sha256Hex("") }
        var layer = txids
        while layer.count > 1 {
            var next = [String]()
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
