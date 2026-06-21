// 端到端加密私信：ed25519 → x25519 → ECDH 共享密钥 → XChaCha20-Poly1305 认证加密。
// 必须与 packages/core/src/crypto.ts（@noble/curves + @noble/ciphers）逐字节互通，否则全网解不开。
// 自检向量见 CLIENT-PROTOCOL §8.6 / §9（EncryptionTests 用同一组向量对齐）。
//
// 依赖拆解（零新依赖）：
//   • x25519 标量乘 + IETF ChaCha20-Poly1305 → Apple CryptoKit（系统框架）。
//   • ed25519 公钥 → Montgomery u 坐标的域运算 → 本文件内 radix-2^16 GF(2^255-19)
//     （TweetNaCl 风格的经典实现，公有领域；见 THIRD-PARTY-NOTICES）。
//   • HChaCha20 子密钥派生（XChaCha 的前半段）→ 本文件手写。
import Foundation
import CryptoKit

public enum Encryption {
    // ---- 对外 API ----

    public static func isEncryptedMemo(_ memo: String) -> Bool { memo.hasPrefix(Config.encPrefix) }

    /// 加密一段明文给收件人（用发送方自己的种子私钥）。返回 `ENC|<hex>`，直接当 memo 上链。失败返回 nil。
    public static func encryptMemo(_ plaintext: String, recipientAddress: String, senderSeed: Data) -> String? {
        guard let key = sharedKey(mySeed: senderSeed, otherAddress: recipientAddress) else { return nil }
        var nonce = [UInt8](repeating: 0, count: 24)
        for i in 0..<24 { nonce[i] = UInt8.random(in: 0...255) }
        guard let sealed = try? aeadSeal(plaintext: Array(plaintext.utf8), key: key, xnonce: nonce) else { return nil }
        return Config.encPrefix + Hex.encode(nonce + sealed)
    }

    /// 解密一条 `ENC|` 私信。otherPartyAddress = 对方地址（我是收件人→填发件人；我是发件人→填收件人）。
    /// 失败（非本人 / 被篡改 / 格式坏）返回 nil。ECDH 对称 → 发件人也能解自己发的。
    public static func decryptMemo(_ memo: String, otherPartyAddress: String, mySeed: Data) -> String? {
        guard memo.hasPrefix(Config.encPrefix) else { return nil }
        guard let blob = Hex.decode(String(memo.dropFirst(Config.encPrefix.count))), blob.count >= 24 + 16 else { return nil }
        let nonce = Array(blob[0..<24])
        let ctTag = Array(blob[24...])
        guard let key = sharedKey(mySeed: mySeed, otherAddress: otherPartyAddress),
              let pt = try? aeadOpen(ctTag: ctTag, key: key, xnonce: nonce) else { return nil }
        return String(decoding: pt, as: UTF8.self)
    }

    // ---- 共享密钥：我的 ed25519 种子 × 对方地址(ed25519 公钥) → 32 字节对称密钥 ----
    static func sharedKey(mySeed: Data, otherAddress: String) -> [UInt8]? {
        let pubHex = otherAddress.hasPrefix("0x") ? String(otherAddress.dropFirst(2)) : otherAddress
        guard let otherPub = Hex.decode(pubHex), otherPub.count == 32 else { return nil }
        let xPriv = x25519PrivFromSeed(Array(mySeed))            // clamp(sha512(seed)[:32])
        let otherU = montgomeryUFromEdPub(otherPub)             // ed25519 公钥 → Montgomery u
        guard
            let priv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(xPriv)),
            let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(otherU)),
            let secret = try? priv.sharedSecretFromKeyAgreement(with: pub)
        else { return nil }
        return secret.withUnsafeBytes { Array($0) }              // 原始 x25519 ECDH 结果（32 字节，无 KDF）
    }

    /// ed25519 私钥种子 → x25519 私钥标量 = clamp(SHA-512(seed)[0:32])。
    static func x25519PrivFromSeed(_ seed: [UInt8]) -> [UInt8] {
        var h = Array(SHA512.hash(data: Data(seed)).prefix(32))
        h[0] &= 248
        h[31] &= 127
        h[31] |= 64
        return h
    }

    /// ed25519 公钥(32B) → Montgomery u = (1+y)/(1-y) mod p，编码为 32 字节小端。
    static func montgomeryUFromEdPub(_ pub: [UInt8]) -> [UInt8] {
        let y = GF.unpack(pub)                 // 取低 255 位作为 y（清掉 x 符号位）
        let onePlusY = GF.add(GF.one, y)
        let oneMinusY = GF.sub(GF.one, y)
        let inv = GF.inv(oneMinusY)
        let u = GF.mul(onePlusY, inv)
        return GF.pack(u)
    }

    // ---- XChaCha20-Poly1305 = HChaCha20 派生子密钥 + IETF ChaCha20-Poly1305 ----
    static func aeadSeal(plaintext: [UInt8], key: [UInt8], xnonce: [UInt8]) throws -> [UInt8] {
        let (subkey, ietf) = xchachaSetup(key: key, xnonce: xnonce)
        let box = try ChaChaPoly.seal(Data(plaintext),
                                      using: SymmetricKey(data: Data(subkey)),
                                      nonce: try ChaChaPoly.Nonce(data: Data(ietf)))
        return Array(box.ciphertext) + Array(box.tag)            // 密文 ‖ 16 字节 tag（noble 格式）
    }

    static func aeadOpen(ctTag: [UInt8], key: [UInt8], xnonce: [UInt8]) throws -> [UInt8] {
        let (subkey, ietf) = xchachaSetup(key: key, xnonce: xnonce)
        let ct = Array(ctTag[0..<(ctTag.count - 16)])
        let tag = Array(ctTag[(ctTag.count - 16)...])
        let box = try ChaChaPoly.SealedBox(nonce: try ChaChaPoly.Nonce(data: Data(ietf)),
                                           ciphertext: Data(ct), tag: Data(tag))
        return Array(try ChaChaPoly.open(box, using: SymmetricKey(data: Data(subkey))))
    }

    /// 子密钥 = HChaCha20(key, xnonce[0:16])；IETF nonce = 0x00000000 ‖ xnonce[16:24]（12 字节）。
    private static func xchachaSetup(key: [UInt8], xnonce: [UInt8]) -> (subkey: [UInt8], ietf: [UInt8]) {
        let subkey = hchacha20(key: key, nonce16: Array(xnonce[0..<16]))
        var ietf = [UInt8](repeating: 0, count: 12)
        for i in 0..<8 { ietf[4 + i] = xnonce[16 + i] }
        return (subkey, ietf)
    }

    // ---- HChaCha20：从 256-bit key + 128-bit nonce 派生 256-bit 子密钥 ----
    static func hchacha20(key: [UInt8], nonce16: [UInt8]) -> [UInt8] {
        func le32(_ b: [UInt8], _ o: Int) -> UInt32 {
            UInt32(b[o]) | (UInt32(b[o + 1]) << 8) | (UInt32(b[o + 2]) << 16) | (UInt32(b[o + 3]) << 24)
        }
        var s = [UInt32](repeating: 0, count: 16)
        s[0] = 0x6170_7865; s[1] = 0x3320_646e; s[2] = 0x7962_2d32; s[3] = 0x6b20_6574
        for i in 0..<8 { s[4 + i] = le32(key, i * 4) }
        for i in 0..<4 { s[12 + i] = le32(nonce16, i * 4) }
        func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 { (x << n) | (x >> (32 - n)) }
        func qr(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
            s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 16)
            s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 12)
            s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 8)
            s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 7)
        }
        for _ in 0..<10 {
            qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
            qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
        }
        var out = [UInt8](repeating: 0, count: 32)
        func put(_ v: UInt32, _ o: Int) {
            out[o] = UInt8(v & 0xff); out[o + 1] = UInt8((v >> 8) & 0xff)
            out[o + 2] = UInt8((v >> 16) & 0xff); out[o + 3] = UInt8((v >> 24) & 0xff)
        }
        put(s[0], 0); put(s[1], 4); put(s[2], 8); put(s[3], 12)
        put(s[12], 16); put(s[13], 20); put(s[14], 24); put(s[15], 28)
        return out
    }
}

// ---- GF(2^255-19) 有限域：radix-2^16（16 个 Int64 limb）经典实现（TweetNaCl 风格，公有领域）----
// 仅用于把 ed25519 公钥转 Montgomery u 坐标（一次模逆 + 两次乘）。已用金标准向量逐字节验证。
enum GF {
    typealias Elem = [Int64]   // 16 个 limb，radix 2^16
    static let one: Elem = { var g = Elem(repeating: 0, count: 16); g[0] = 1; return g }()

    static func add(_ a: Elem, _ b: Elem) -> Elem { (0..<16).map { a[$0] + b[$0] } }
    static func sub(_ a: Elem, _ b: Elem) -> Elem { (0..<16).map { a[$0] - b[$0] } }

    /// 进位归一（把每个 limb 收回 16 位，2^256 ≡ 38 折叠到低位）。
    static func carry(_ o: inout Elem) {
        var c: Int64 = 0
        for i in 0..<16 {
            o[i] += 1 << 16
            c = o[i] >> 16
            if i < 15 { o[i + 1] += c - 1 } else { o[0] += 38 * (c - 1) }
            o[i] -= c << 16
        }
    }

    static func mul(_ a: Elem, _ b: Elem) -> Elem {
        var t = [Int64](repeating: 0, count: 31)
        for i in 0..<16 { for j in 0..<16 { t[i + j] += a[i] * b[j] } }
        for i in 0..<15 { t[i] += 38 * t[i + 16] }
        var o = Array(t[0..<16])
        carry(&o); carry(&o)
        return o
    }

    static func sq(_ a: Elem) -> Elem { mul(a, a) }

    /// 模逆：a^(p-2)，p-2 的位模式即 TweetNaCl inv25519 的循环（除 bit 2 / 4 外都乘 a）。
    static func inv(_ i: Elem) -> Elem {
        var c = i
        for a in stride(from: 253, through: 0, by: -1) {
            c = sq(c)
            if a != 2 && a != 4 { c = mul(c, i) }
        }
        return c
    }

    /// 32 字节小端 → 域元素（清掉最高位，作为 y 坐标）。
    static func unpack(_ n: [UInt8]) -> Elem {
        var o = Elem(repeating: 0, count: 16)
        for i in 0..<16 { o[i] = Int64(n[2 * i]) + (Int64(n[2 * i + 1]) << 8) }
        o[15] &= 0x7fff
        return o
    }

    /// 域元素 → 32 字节小端（完全约简到 [0, p)）。
    static func pack(_ n: Elem) -> [UInt8] {
        var t = n
        carry(&t); carry(&t); carry(&t)
        for _ in 0..<2 {
            var m = Elem(repeating: 0, count: 16)
            m[0] = t[0] - 0xffed
            for i in 1..<15 {
                m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1)
                m[i - 1] &= 0xffff
            }
            m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1)
            let b = (m[15] >> 16) & 1
            m[14] &= 0xffff
            if (1 - b) == 1 { t = m }   // 未下溢（t ≥ p）→ 用减去 p 后的 m
        }
        var o = [UInt8](repeating: 0, count: 32)
        for i in 0..<16 {
            o[2 * i] = UInt8(t[i] & 0xff)
            o[2 * i + 1] = UInt8((t[i] >> 8) & 0xff)
        }
        return o
    }
}
