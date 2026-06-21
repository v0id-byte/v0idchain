// Hex 编解码：与 @noble/hashes `bytesToHex` / `hexToBytes` 同义（全小写）。
import Foundation

public enum Hex {
    /// 字节 → 小写 hex
    public static func encode(_ bytes: Data) -> String {
        var s = String()
        s.reserveCapacity(bytes.count * 2)
        for b in bytes {
            s.append(hexDigits[Int(b >> 4)])
            s.append(hexDigits[Int(b & 0x0f)])
        }
        return s
    }

    public static func encode<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        encode(Data(bytes))
    }

    /// 小写/大写 hex → 字节。长度须为偶数且仅含 hex 字符，否则返回 nil。
    public static func decode(_ hex: String) -> Data? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data()
        out.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            out.append((hi << 4) | lo)
            i += 2
        }
        return out
    }

    private static let hexDigits = Array("0123456789abcdef")

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30          // 0-9
        case 0x61...0x66: return c - 0x61 + 10     // a-f
        case 0x41...0x46: return c - 0x41 + 10     // A-F
        default: return nil
        }
    }
}
