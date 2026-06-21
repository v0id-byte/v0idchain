// 金标准向量自检（无需 Xcode）：直接用 swiftc 编译 V0idKit 源码 + 本文件即可跑。
//   见 ../../scripts/selfcheck.sh
// 与 Tests/V0idKitTests/GoldVectorTests.swift 等价，但不依赖 XCTest / SwiftPM
// （某些仅装了 Command Line Tools 的机器上 `swift test` 的构建驱动会缺 framework 而挂掉）。
import Foundation

var failures = 0
func check(_ cond: Bool, _ name: String, _ extra: String = "") {
    if cond { print("  ✅ \(name)") }
    else { print("  ❌ \(name) \(extra)"); failures += 1 }
}

let privHex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
let pubHex  = "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
let address = "0x" + pubHex
let to = "0x" + String(repeating: "ab", count: 32)
let ts = 1_700_000_000_000

print("Step 1 — PUB / ADDRESS")
let w = try! Wallet(seedHex: privHex)
check(Hex.encode(w.publicKey) == pubHex, "publicKey == gold", Hex.encode(w.publicKey))
check(w.address == address, "address == gold")

print("Step 2 — PREIMAGE")
let pre1 = TxBuilder.preimage(from: address, to: to, amount: 100, fee: 1, nonce: 0, timestamp: ts, memo: "hi 🍜")
let goldPre1 = "[\"0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664\",\"0xabababababababababababababababababababababababababababababababab\",100,1,0,1700000000000,\"hi 🍜\"]"
check(pre1 == goldPre1, "transfer preimage", pre1)
let pre2 = TxBuilder.preimage(from: address, to: to, amount: 0, fee: 1, nonce: 1, timestamp: ts, memo: "gm", burn: 5)
let goldPre2 = "[\"0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664\",\"0xabababababababababababababababababababababababababababababababab\",0,1,1,1700000000000,\"gm\",5]"
check(pre2 == goldPre2, "message preimage", pre2)
check(CanonicalJSON.array([.string("x\"y\nz\t🎲")]) == "[\"x\\\"y\\nz\\t🎲\"]", "escaping vector")
check(CanonicalJSON.string("\u{0001}") == "\"\\u0001\"", "control U+0001")
check(CanonicalJSON.string("\u{000B}") == "\"\\u000b\"", "control U+000B")
check(CanonicalJSON.string("/") == "\"/\"", "slash not escaped")

print("Step 3 — TXID")
let txid1 = TxBuilder.txid(from: address, to: to, amount: 100, fee: 1, nonce: 0, timestamp: ts, memo: "hi 🍜")
check(txid1 == "da4527a9715dd7e9d098f6615b588ceb051401d9e6846125feb7bdd1c4362932", "transfer txid", txid1)
let txid2 = TxBuilder.txid(from: address, to: to, amount: 0, fee: 1, nonce: 1, timestamp: ts, memo: "gm", burn: 5)
check(txid2 == "bb451006fa4c197f7944346de8f24e9712c8d1fd90e47abf52f8b9fa2b52cd06", "message txid", txid2)

print("Step 4 — SIGNATURE (CryptoKit 随机化签名 → 双向验签互操作)")
let mySig = try! w.sign(messageHex: txid1)
check(Crypto.verify(signatureHex: mySig, messageHex: txid1, publicKeyHex: pubHex), "my sig verifies")
let goldSig1 = "dab11981063113c8b5fff5f8fcaad3d9c0a49879f7cca8a9dcee16be1171b17ea8919217ab87c077f320e3ea0eaca8a31c49467dc5df6c3e28b9ba689fc07108"
check(Crypto.verify(signatureHex: goldSig1, messageHex: txid1, publicKeyHex: pubHex), "gold transfer sig verifies")
let goldSig2 = "817ccc45061524d52b8f1fc41f0b3542498993679c5e73a9497f60421dd0f7c19ea1837de981dedcd20301e2ea0d2076c029a6249c0e9b832f24962ae7972104"
check(Crypto.verify(signatureHex: goldSig2, messageHex: txid2, publicKeyHex: pubHex), "gold message sig verifies")
check(!Crypto.verify(signatureHex: goldSig1, messageHex: txid2, publicKeyHex: pubHex), "wrong-message rejected")

print("Step 5 — high-level create*")
let tx1 = try! w.createTransaction(to: to, amount: 100, nonce: 0, memo: "hi 🍜", fee: 1, timestamp: ts)
check(tx1.txid == txid1 && tx1.burn == nil && Crypto.verify(signatureHex: tx1.signature, messageHex: tx1.txid, publicKeyHex: pubHex), "createTransaction")
let tx2 = try! w.createMessage(to: to, text: "gm", nonce: 1, burn: 5, fee: 1, timestamp: ts)
check(tx2.txid == txid2 && tx2.burn == 5 && tx2.isMessage && Crypto.verify(signatureHex: tx2.signature, messageHex: tx2.txid, publicKeyHex: pubHex), "createMessage")

print("Step 6 — 端到端加密私信（CLIENT-PROTOCOL §8.6 金标准向量）")
let encA = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
let encB = "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40"
let encAAddr = "0x79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
let encBAddr = "0xe7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0"
let encShared = "22dd9afeb5878d76b7b7eba66e349a1a00858963745f1b92b78a1741e9ccf249"
func encRep(_ s: String, _ n: Int) -> String { String(repeating: s, count: n) }
check(Hex.encode(Encryption.x25519PrivFromSeed(Array(Hex.decode(encA)!))) == "70788f1a0cea001a2631dae5d05dbd062008d5b30f50b9e29beb2a7822289044", "x25519 私钥 = clamp(sha512(seed))")
check(Hex.encode(Encryption.montgomeryUFromEdPub(Array(Hex.decode(String(encBAddr.dropFirst(2)))!))) == "577faef0060dfd00c039272bc6fe7c42689ce16db47b6fc2aa41d19819ffa936", "ed25519 公钥 → Montgomery u")
let encKAB = Encryption.sharedKey(mySeed: Hex.decode(encA)!, otherAddress: encBAddr)
let encKBA = Encryption.sharedKey(mySeed: Hex.decode(encB)!, otherAddress: encAAddr)
check(encKAB.map { Hex.encode($0) } == encShared, "共享密钥 A→B == 金标准", encKAB.map { Hex.encode($0) } ?? "nil")
check(encKBA.map { Hex.encode($0) } == encShared, "共享密钥 B→A（ECDH 对称）")
check(Hex.encode(Encryption.hchacha20(key: Array(Hex.decode(encShared)!), nonce16: Array(Hex.decode(encRep("aa", 16))!))) == "0d14854b974a920d7653f283dfc2be9919c77f731fd185f7ecba6bfa3fc2a81e", "HChaCha20 子密钥")
let encSealed = try! Encryption.aeadSeal(plaintext: Array("hi 🔐".utf8), key: Array(Hex.decode(encShared)!), xnonce: Array(Hex.decode(encRep("aa", 24))!))
check(Hex.encode(encSealed) == "6359b5d168414e050a885e42c9dc6eabf98ecbaea44fa9", "固定 nonce=aa×24 密文 == 金标准")
let encMemo = Config.encPrefix + Hex.encode(Array(Hex.decode(encRep("aa", 24))!) + encSealed)
check(encMemo == "ENC|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6359b5d168414e050a885e42c9dc6eabf98ecbaea44fa9", "完整 memo == 金标准")
let encLive = Encryption.encryptMemo("约你 9 点食堂见 🍜", recipientAddress: encBAddr, senderSeed: Hex.decode(encA)!)!
check(Encryption.decryptMemo(encLive, otherPartyAddress: encAAddr, mySeed: Hex.decode(encB)!) == "约你 9 点食堂见 🍜", "B 解出 A 发来的")
check(Encryption.decryptMemo(encLive, otherPartyAddress: encBAddr, mySeed: Hex.decode(encA)!) == "约你 9 点食堂见 🍜", "A 也能解自己发的（对称）")
check(Encryption.decryptMemo(encLive, otherPartyAddress: encAAddr, mySeed: Wallet.generate().privateKey) == nil, "第三方解不开")

print(failures == 0 ? "\nALL GREEN ✅  (与 packages/core 逐字节兼容)" : "\n\(failures) FAILURE(S) ❌")
exit(failures == 0 ? 0 : 1)
