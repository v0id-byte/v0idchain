// P2P 轻客户端连接池：从种子引导 → 发现对等节点（QUERY_PEERS）→ 同时连多个节点（随机挑选）。
// 协议见 CLIENT-PROTOCOL §6，与 packages/node/src/p2p.ts 完全一致（JSON 文本帧）。
//
// 传输层用 WebSocketConn（裸 POSIX socket），而非 URLSession / NWConnection：
// 后两者都会尊重系统 HTTP/SOCKS 代理（Clash/mihomo），把 ws:// 握手送进代理隧道，
// 代理不稳定时连接随即断开。裸 socket 直连内核 TCP 栈，绕过系统代理。详见 WebSocket.swift。
import Foundation

public enum NodeEvent: Sendable {
    case chain([Block])          // 最新整链快照（可算余额）
    case mempool([Transaction])  // 当前待打包交易池快照（供本机挖矿选包）
    case peers(Int)              // 当前已连接的节点数（0 = 未连接）
    case error(String)
}

public actor NodeClient {
    private static let heartbeat: UInt64 = 5_000_000_000
    private static let maintainEvery: UInt64 = 4_000_000_000
    private static let retryCooldown: TimeInterval = 15   // 连不上的地址冷却多久再重试

    private let bootstrap: [String]
    private let myAddress: String
    private let maxPeers: Int

    private var running = false
    private var chain: [Block] = []
    private var mempool = [String: Transaction]()     // txid → 待打包交易（从节点 TX 广播 / 同步学到）
    private static let maxMempool = 5_000             // 兜底上限，防恶意节点灌爆内存
    private var known = Set<String>()                 // 已知可连地址（规范化 ws://host:port）
    private var conns = [String: Conn]()              // 当前连接（含在途）
    private var retryAfter = [String: Date]()         // 连不上的地址：此刻之前不重试
    private var lastPeers = -1                         // 上次上报的“已建立”连接数（去重，杜绝闪烁）
    private var maintainTask: Task<Void, Never>?

    private let continuation: AsyncStream<NodeEvent>.Continuation
    public nonisolated let events: AsyncStream<NodeEvent>

    private final class Conn: @unchecked Sendable {
        let ws: WebSocketConn
        let listen: String      // 本条连接的 HELLO listen 值（每连接唯一，见 connect()）
        var beat: Task<Void, Never>?
        var open = false        // 是否已完成 WS 握手（= 真正建立）。peers 只数 open。
        init(_ ws: WebSocketConn, listen: String) { self.ws = ws; self.listen = listen }
    }

    public init(bootstrap: [String], myAddress: String, maxPeers: Int = 6) {
        self.bootstrap = bootstrap
        self.myAddress = myAddress
        self.maxPeers = maxPeers
        var cont: AsyncStream<NodeEvent>.Continuation!
        self.events = AsyncStream { cont = $0 }
        self.continuation = cont
    }

    // ---- 生命周期 ----
    public func start() {
        guard !running else { return }
        running = true
        for b in bootstrap { if let n = Self.normalize(b) { known.insert(n) } }
        // 加载上次保存的邻居——种子挂了重启也能找到已知节点（同 Bitcoin peers.dat）
        if let saved = UserDefaults.standard.stringArray(forKey: "v0id-known-peers") {
            for url in saved { if let n = Self.normalize(url) { known.insert(n) } }
        }
        maintainTask = Task { [weak self] in await self?.maintainLoop() }
    }

    public func stop() {
        savePeers()
        running = false
        maintainTask?.cancel()
        maintainTask = nil
        for url in Array(conns.keys) { disconnect(url) }
        chain = []
        mempool.removeAll()
        lastPeers = -1
    }

    /// 广播一笔已签名交易给**所有已建立**的连接。无可用连接则抛错。
    public func broadcast(_ tx: Transaction) throws {
        let live = conns.values.filter { $0.open }
        guard !live.isEmpty else { throw NodeError.notConnected }
        for c in live { Self.rawSend(c.ws, .tx(tx)) }
    }

    /// 广播一个本机挖出的区块给**所有已建立**的连接（节点 onBlocks 校验后接受续接块并向全网转播）。
    /// 无可用连接则抛错——块传不出去等于白挖。协议：`{type:"BLOCKS", blocks:[block]}`（不带 from/total）。
    public func broadcastBlock(_ block: Block) throws {
        let live = conns.values.filter { $0.open }
        guard !live.isEmpty else { throw NodeError.notConnected }
        for c in live { Self.rawSend(c.ws, .blocks([block])) }
    }

    /// 当前同步到的链（测试 / 调试）。
    public func snapshot() -> [Block] { chain }
    public func peerCount() -> Int { conns.values.filter { $0.open }.count }

    // ---- 连接维护：周期性把连接补到 maxPeers（随机挑已知节点，跳过冷却中的）----
    private func maintainLoop() async {
        var tick = 0
        while running && !Task.isCancelled {
            fillConnections()
            tick += 1
            if tick % 10 == 0 { savePeers() }   // ~40s 定期落盘
            try? await Task.sleep(nanoseconds: Self.maintainEvery)
        }
    }

    private func savePeers() {
        let urls = known.filter { url in
            guard let u = URL(string: url), let h = u.host else { return false }
            return !Self.isPrivateOrLocalHost(h)  // 只持久化公网地址
        }
        UserDefaults.standard.set(Array(urls), forKey: "v0id-known-peers")
    }

    /// host 是否为环回/私网/链路本地/ULA（gossip 学来的命中则丢弃，防 LAN MITM）。
    /// 对齐节点端 isPublicWsUrl 策略（packages/node/src/p2p.ts）。
    static func isPrivateOrLocalHost(_ rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if let pct = host.firstIndex(of: "%") { host = String(host[..<pct]) }
        if host.isEmpty || host == "localhost" { return true }
        if host.contains(":") {
            // IPv6：只放行全局单播 2000::/3；其余拒
            let firstSeg = host.hasPrefix("::") ? "0" : (host.split(separator: ":").first.map(String.init) ?? "")
            guard let f = Int(firstSeg, radix: 16), f >= 0x2000, f <= 0x3fff else { return true }
            return false
        }
        if host == "0.0.0.0" { return true }
        if host.hasPrefix("127.") || host.hasPrefix("10.") || host.hasPrefix("192.168.") || host.hasPrefix("169.254.") {
            return true
        }
        if host.hasPrefix("172.") {
            let parts = host.split(separator: ".")
            if parts.count >= 2, let second = Int(parts[1]), (16...31).contains(second) { return true }
        }
        return false
    }

    private func fillConnections() {
        let slots = maxPeers - conns.count
        guard slots > 0 else { return }
        let now = Date()
        let candidates = known.filter { url in
            conns[url] == nil && (retryAfter[url].map { $0 <= now } ?? true)
        }.shuffled()   // 随机 → 均摊负载
        for url in candidates.prefix(slots) { connect(url) }
    }

    private func connect(_ url: String) {
        guard running, conns[url] == nil, let u = URL(string: url) else { return }
        guard u.scheme == "ws", let host = u.host else { return }   // 仅 ws://（wss 需 TLS，留待生产化）
        let port = UInt16(u.port ?? 80)
        let ws = WebSocketConn(host: host, port: port)
        // listen 每条连接唯一：节点端用 listen 给连接判重（p2p.ts），共用常量会导致同一客户端
        // 新旧连接互相判重 → 被 close → 立即重连 → 永久抖动、整链拉不到。规范允许 listen 为任意串。
        let c = Conn(ws, listen: "macos-light-\(UUID().uuidString.prefix(8))")
        conns[url] = c
        ws.onOpen  = { [weak self] in Task { await self?.onOpen(url) } }
        ws.onText  = { [weak self] t in Task { await self?.onText(url, t) } }
        ws.onClose = { [weak self] err in Task { await self?.onClose(url, err) } }
        c.beat = Task { [weak self] in await self?.beatLoop(url) }
        ws.start()
    }

    /// WS 握手完成 = 真正建立：发应用层握手 + 计入 peers。
    private func onOpen(_ url: String) {
        guard let c = conns[url] else { return }
        c.open = true
        retryAfter[url] = nil
        Self.rawSend(c.ws, .hello(address: myAddress, height: max(0, chain.count - 1), listen: c.listen))
        Self.rawSend(c.ws, .queryLatest)
        Self.rawSend(c.ws, .queryPeers)
        if chain.isEmpty { Self.rawSend(c.ws, .queryAll) }   // 冷启动：要整链
        emitPeers()
    }

    private func onText(_ url: String, _ text: String) {
        guard let c = conns[url] else { return }
        handle(text, conn: c)
    }

    private func onClose(_ url: String, _ err: String?) {
        guard let c = conns[url] else { return }
        if !c.open, let err { continuation.yield(.error(err)) }   // 从未连上 → 报具体原因
        disconnect(url)
    }

    private func disconnect(_ url: String) {
        guard let c = conns.removeValue(forKey: url) else { return }
        c.beat?.cancel()
        c.ws.close()
        // 从未连上 → 冷却，避免对死地址 churn；曾连上只是掉了 → 允许尽快重连。
        retryAfter[url] = c.open ? nil : Date().addingTimeInterval(Self.retryCooldown)
        emitPeers()
    }

    private func beatLoop(_ url: String) async {
        while running && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: Self.heartbeat)
            if Task.isCancelled { return }
            guard let c = conns[url], c.open else { continue }
            Self.rawSend(c.ws, .queryLatest)   // 应用层心跳：探最新块（落后才触发整链补拉）+ 保活 NAT
        }
    }

    // ---- 收消息 ----
    private func handle(_ text: String, conn: Conn) {
        guard let data = text.data(using: .utf8),
              let env = try? JSONDecoder().decode(TypeEnvelope.self, from: data) else { return }
        switch env.type {
        case "BLOCKS":
            guard let payload = try? JSONDecoder().decode(BlocksEnvelope.self, from: data) else { return }
            handleBlocks(payload.blocks, conn: conn)
        case "PEERS":
            guard let payload = try? JSONDecoder().decode(PeersEnvelope.self, from: data) else { return }
            handlePeers(payload.peers)
        case "TX":
            guard let payload = try? JSONDecoder().decode(TxEnvelope.self, from: data) else { return }
            addToMempool(payload.tx)
        default:
            break   // HELLO / QUERY_* 等：叶子节点不回应
        }
    }

    /// 收一笔节点广播来的待打包交易进本地池（去重、基本自洽过滤、封顶）。选包时还会按链顶状态再校验。
    private func addToMempool(_ tx: Transaction) {
        guard mempool[tx.txid] == nil, mempool.count < Self.maxMempool, tx.selfValid() else { return }
        mempool[tx.txid] = tx
        continuation.yield(.mempool(Array(mempool.values)))
    }

    /// 这些区块里的交易已上链 → 移出待打包池（变化才上报）。
    private func removeMined(_ blocks: [Block]) {
        var changed = false
        for b in blocks { for tx in b.transactions where mempool.removeValue(forKey: tx.txid) != nil { changed = true } }
        if changed { continuation.yield(.mempool(Array(mempool.values))) }
    }

    private func handleBlocks(_ blocks: [Block], conn: Conn) {
        guard let first = blocks.first else { return }
        if first.index == 0 {
            // 整链（QUERY_ALL 回应）：更长则采纳（信任所连节点，符合规范 MVP）。
            if blocks.count > chain.count { chain = blocks; emitChain(); removeMined(blocks) }
        } else {
            // 增量 / 探测：能干净接到链顶则追加；否则若对方更高 → 只向该节点补拉整链。
            var changed = false
            for nb in blocks {
                if nb.index == chain.count && nb.prevHash == chain.last?.hash {
                    chain.append(nb); changed = true
                } else if nb.index >= chain.count {
                    Self.rawSend(conn.ws, .queryAll); break
                }
            }
            if changed { emitChain(); removeMined(blocks) }
        }
    }

    private func handlePeers(_ urls: [String]) {
        var added = false
        for raw in urls {
            guard let url = Self.normalize(raw) else { continue }
            // 丢弃私网/环回/链路本地 peer（防 LAN MITM 通过 PEERS 帧注入自己）。
            if let h = URL(string: url)?.host, Self.isPrivateOrLocalHost(h) { continue }
            if !known.contains(url) { known.insert(url); added = true }
        }
        if added { fillConnections() }
    }

    private func emitChain() { continuation.yield(.chain(chain)) }

    /// 只数“已建立”的连接，且仅在数字变化时上报 → 杜绝闪烁。
    private func emitPeers() {
        let n = conns.values.filter { $0.open }.count
        guard n != lastPeers else { return }
        lastPeers = n
        continuation.yield(.peers(n))
    }

    /// 规范化地址为 ws://host:port → 同一节点不同写法去重，避免重复连接 + 重复广播。
    private nonisolated static func normalize(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespaces)
        guard let u = URL(string: t), let scheme = u.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss", let host = u.host?.lowercased() else { return nil }
        let port = u.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    // ---- 发送 ----
    private nonisolated static func rawSend(_ ws: WebSocketConn, _ msg: OutMsg) {
        guard let data = try? JSONEncoder().encode(msg) else { return }
        ws.sendText(String(decoding: data, as: UTF8.self))
    }
}

public enum NodeError: Error, LocalizedError {
    case notConnected
    public var errorDescription: String? {
        switch self { case .notConnected: return "尚未连接到任何节点" }
    }
}

// ---- 线缆消息 ----
private struct TypeEnvelope: Decodable { let type: String }
private struct BlocksEnvelope: Decodable { let blocks: [Block] }
private struct PeersEnvelope: Decodable { let peers: [String] }
private struct TxEnvelope: Decodable { let tx: Transaction }

private enum OutMsg: Encodable {
    case hello(address: String, height: Int, listen: String)
    case queryAll
    case queryLatest
    case queryPeers
    case tx(Transaction)
    case blocks([Block])

    enum CodingKeys: String, CodingKey { case type, address, height, listen, tx, blocks }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .hello(let address, let height, let listen):
            try c.encode("HELLO", forKey: .type)
            try c.encode(address, forKey: .address)
            try c.encode(height, forKey: .height)
            try c.encode(listen, forKey: .listen)
        case .queryAll:    try c.encode("QUERY_ALL", forKey: .type)
        case .queryLatest: try c.encode("QUERY_LATEST", forKey: .type)
        case .queryPeers:  try c.encode("QUERY_PEERS", forKey: .type)
        case .tx(let tx):
            try c.encode("TX", forKey: .type)
            try c.encode(tx, forKey: .tx)
        case .blocks(let bs):
            try c.encode("BLOCKS", forKey: .type)
            try c.encode(bs, forKey: .blocks)
        }
    }
}
