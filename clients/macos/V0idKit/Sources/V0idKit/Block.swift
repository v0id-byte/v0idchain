// 区块：结构 + 哈希。对应 packages/core/src/block.ts。
import Foundation

public struct Block: Codable, Equatable, Identifiable, Sendable {
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

    /// 区块哈希：覆盖头部所有字段。对应 calcBlockHash。
    public func calcHash() -> String {
        Crypto.sha256Hex(JSONStringify.array([
            .int(index),
            .int(timestamp),
            .string(prevHash),
            .string(merkleRoot),
            .int(difficulty),
            .int(nonce),
            .string(miner),
        ]))
    }
}
