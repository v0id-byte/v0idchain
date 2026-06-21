// P2P 线协议（WebSocket，JSON 文本帧）。对齐 packages/node/src/p2p.ts 的 P2PMessage。
// 轻客户端只需**出站** HELLO / QUERY_ALL / QUERY_LATEST / TX，并**入站**解析 BLOCKS；
// 节点握手时还会向我们发 HELLO / QUERY_LATEST / QUERY_PEERS —— 一律安全忽略（我们不提供链服务）。
import Foundation

enum OutgoingMessage {
    case hello(address: String, height: Int, listen: String)
    case queryAll
    case queryLatest
    case queryPeers
    case tx(Transaction)

    func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        switch self {
        case let .hello(address, height, listen):
            return try encoder.encode(Hello(type: "HELLO", address: address, height: height, listen: listen))
        case .queryAll:
            return try encoder.encode(TypeOnly(type: "QUERY_ALL"))
        case .queryLatest:
            return try encoder.encode(TypeOnly(type: "QUERY_LATEST"))
        case .queryPeers:
            return try encoder.encode(TypeOnly(type: "QUERY_PEERS"))
        case let .tx(tx):
            return try encoder.encode(TxMessage(type: "TX", tx: tx))
        }
    }

    private struct TypeOnly: Encodable { let type: String }
    private struct Hello: Encodable { let type: String; let address: String; let height: Int; let listen: String }
    private struct TxMessage: Encodable { let type: String; let tx: Transaction }
}

/// 入站解析：先取 type，再按需取负载。
enum IncomingMessage {
    case blocks([Block])
    case blocksChunk([Block], from: Int, total: Int)   // 分块同步：服务端把大链拆成多片发来
    case peers([String])       // PEERS 消息：节点告知的其他可连地址
    case blocksError(String)   // BLOCKS 消息收到但 JSON 解码失败
    case other(String)

    static func parse(_ data: Data) -> IncomingMessage? {
        let decoder = JSONDecoder()
        guard let env = try? decoder.decode(Envelope.self, from: data) else { return nil }
        switch env.type {
        case "BLOCKS":
            do {
                let m = try decoder.decode(BlocksMessage.self, from: data)
                if let from = m.from, let total = m.total {
                    return .blocksChunk(m.blocks, from: from, total: total)
                }
                return .blocks(m.blocks)
            } catch {
                return .blocksError("BLOCKS 解码失败：\(error.localizedDescription)")
            }
        case "PEERS":
            let m = try? decoder.decode(PeersMessage.self, from: data)
            return .peers(m?.peers ?? [])
        default:
            return .other(env.type)
        }
    }

    private struct Envelope: Decodable { let type: String }
    private struct BlocksMessage: Decodable { let blocks: [Block]; let from: Int?; let total: Int? }
    private struct PeersMessage: Decodable { let peers: [String] }
}
