// P2P 轻客户端连接池：从种子引导 → 发现对等节点（QUERY_PEERS）→ 同时连多个节点（随机挑选）。
// 协议见 CLIENT-PROTOCOL §6，与 packages/node/src/p2p.ts 完全一致（JSON 文本帧）。
//
// 为什么连多个：只连种子一个节点会把整网负载全压在种子机上、且单点故障。连上一批节点后：
//   • 整链只向**其中一个**节点 QUERY_ALL（按需，落后才拉）→ 大幅降低种子负担；
//   • 交易广播给**所有**连接 → 传播更快、更稳；
//   • 任一节点掉线自动补连其它已知节点。
// 我们是纯出站叶子节点：不开 WS 服务器，对节点发来的 QUERY_LATEST / HELLO / QUERY_PEERS 一概忽略，
// 但会消费 PEERS 来发现更多节点。
import Foundation

public enum NodeEvent: Sendable {
    case chain([Block])   // 最新整链快照（可算余额）
    case peers(Int)       // 当前已连接的节点数（0 = 未连接）
    case error(String)
}

public actor NodeClient {
    private static let maxFrame = 64 * 1024 * 1024
    private static let heartbeat: UInt64 = 5_000_000_000
    private static let maintainEvery: UInt64 = 4_000_000_000
    private static let retryCooldown: TimeInterval = 15   // 连不上的地址冷却多久再重试（避免每 4s 抽风式重拨）

    private let bootstrap: [String]
    private let myAddress: String
    private let maxPeers: Int

    private var running = false
    private var chain: [Block] = []
    private var known = Set<String>()                 // 已知可连地址（种子 + 发现的；均为规范化 ws://host:port）
    private var conns = [String: Connection]()        // 当前连接（含在途）
    private var retryAfter = [String: Date]()         // 连不上的地址：此刻之前不重试
    private var lastPeers = -1                         // 上次上报的“已建立”连接数（去重，杜绝闪烁）
    private var maintainTask: Task<Void, Never>?
    private let session: URLSession

    private let continuation: AsyncStream<NodeEvent>.Continuation
    public nonisolated let events: AsyncStream<NodeEvent>

    private struct Connection {
        let task: URLSessionWebSocketTask
        var recv: Task<Void, Never>?
        var beat: Task<Void, Never>?
        var open = false        // 是否已成功收到过消息（= 真正建立）。peers 只数 open，避免在途/死链造成闪烁。
    }

    public init(bootstrap: [String], myAddress: String, maxPeers: Int = 6) {
        self.bootstrap = bootstrap
        self.myAddress = myAddress
        self.maxPeers = maxPeers
        self.session = URLSession(configuration: .default)
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
        lastPeers = -1
    }

    /// 广播一笔已签名交易给**所有已建立**的连接。无可用连接则抛错。
    public func broadcast(_ tx: Transaction) throws {
        let live = conns.values.filter { $0.open }
        guard !live.isEmpty else { throw NodeError.notConnected }
        for c in live { Self.rawSend(c.task, .tx(tx)) }
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
            if tick % 10 == 0 { savePeers() }   // ~40s（10 × 4s）定期落盘
            try? await Task.sleep(nanoseconds: Self.maintainEvery)
        }
    }

    private func savePeers() {
        let urls = known.filter { url in
            guard let u = URL(string: url), let h = u.host else { return false }
            return !Self.isPrivateOrLocalHost(h)  // 只持久化公网地址（环回/私网/链路本地/ULA 一律排除）
        }
        UserDefaults.standard.set(Array(urls), forKey: "v0id-known-peers")
    }

    /// host 是否为环回/私网/链路本地/ULA（gossip 学来的命中则丢弃，防 LAN MITM）。
    /// 对齐节点端 isPublicWsUrl 的「只放行全局单播」策略（packages/node/src/p2p.ts）。
    static func isPrivateOrLocalHost(_ rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if let pct = host.firstIndex(of: "%") { host = String(host[..<pct]) }
        if host.isEmpty || host == "localhost" { return true }
        if host.contains(":") {
            // IPv6：只放行全局单播 2000::/3；其余（::1 / fe80 / fc,fd / ::ffff: 等）拒
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
        let task = session.webSocketTask(with: u)
        task.maximumMessageSize = Self.maxFrame
        conns[url] = Connection(task: task, recv: nil, beat: nil)
        task.resume()
        // 握手：自报家门 + 问最新块 + 问它认识谁。整链不在此拉——按需（落后时）只向一个节点 QUERY_ALL。
        Self.rawSend(task, .hello(address: myAddress, height: max(0, chain.count - 1), listen: "macos-light"))
        Self.rawSend(task, .queryLatest)
        Self.rawSend(task, .queryPeers)
        if chain.isEmpty { Self.rawSend(task, .queryAll) }   // 冷启动：向首批节点要整链（拿到即停）
        conns[url]?.recv = Task { [weak self] in await self?.receiveLoop(url, task) }
        conns[url]?.beat = Task { [weak self] in await self?.beatLoop(url, task) }
        // 不在此 emitPeers：只有真正收到消息（open）才计数，避免在途/死链闪烁。
    }

    private func disconnect(_ url: String) {
        guard let c = conns.removeValue(forKey: url) else { return }
        c.recv?.cancel()
        c.beat?.cancel()
        c.task.cancel(with: .goingAway, reason: nil)
        if !c.open {
            // 从未连上 → 冷却，避免每个 maintain tick 都对死地址重拨（churn）。
            retryAfter[url] = Date().addingTimeInterval(Self.retryCooldown)
        } else {
            retryAfter[url] = nil   // 曾连上、只是掉了 → 允许尽快重连
        }
        emitPeers()
    }

    private func receiveLoop(_ url: String, _ task: URLSessionWebSocketTask) async {
        while running && !Task.isCancelled {
            do {
                let msg = try await task.receive()
                if conns[url]?.open == false {
                    conns[url]?.open = true     // 首次收到消息 = 真正建立
                    retryAfter[url] = nil
                    emitPeers()
                }
                let text: String
                switch msg {
                case .string(let s): text = s
                case .data(let d): text = String(decoding: d, as: UTF8.self)
                @unknown default: continue
                }
                handle(text, from: task)
            } catch {
                if running { disconnect(url) }   // 掉线 → 移除，maintainLoop 会补连其它节点
                return
            }
        }
    }

    private func beatLoop(_ url: String, _ task: URLSessionWebSocketTask) async {
        while running && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: Self.heartbeat)
            if Task.isCancelled { return }
            Self.rawSend(task, .queryLatest)   // 心跳：探最新块（落后才会触发整链补拉）
        }
    }

    // ---- 收消息 ----
    private func handle(_ text: String, from task: URLSessionWebSocketTask) {
        guard let data = text.data(using: .utf8),
              let env = try? JSONDecoder().decode(TypeEnvelope.self, from: data) else { return }
        switch env.type {
        case "BLOCKS":
            guard let payload = try? JSONDecoder().decode(BlocksEnvelope.self, from: data) else { return }
            handleBlocks(payload.blocks, from: task)
        case "PEERS":
            guard let payload = try? JSONDecoder().decode(PeersEnvelope.self, from: data) else { return }
            handlePeers(payload.peers)
        default:
            break   // HELLO / QUERY_* 等：叶子节点不回应
        }
    }

    private func handleBlocks(_ blocks: [Block], from task: URLSessionWebSocketTask) {
        guard let first = blocks.first else { return }
        if first.index == 0 {
            // 整链（QUERY_ALL 回应）：更长则采纳（信任所连节点，符合规范 MVP）。
            if blocks.count > chain.count {
                chain = blocks
                emitChain()
            }
        } else {
            // 增量 / 探测：能干净接到链顶则追加；否则若对方更高 → 只向该节点补拉整链。
            var changed = false
            for nb in blocks {
                if nb.index == chain.count && nb.prevHash == chain.last?.hash {
                    chain.append(nb); changed = true
                } else if nb.index >= chain.count {
                    Self.rawSend(task, .queryAll)
                    break
                }
            }
            if changed { emitChain() }
        }
    }

    private func handlePeers(_ urls: [String]) {
        var added = false
        for raw in urls {
            guard let url = Self.normalize(raw) else { continue }
            // 丢弃私网/环回/链路本地 peer：否则 LAN MITM 投递 PEERS 帧即可把自己（如 ws://10.0.0.5:6001）
            // 注入 known 并被自动连接（此前 handlePeers 完全不过滤，仅 savePeers 持久化时才挡 localhost/127）。
            if let h = URL(string: url)?.host, Self.isPrivateOrLocalHost(h) { continue }
            if !known.contains(url) { known.insert(url); added = true }
        }
        if added { fillConnections() }
    }

    private func emitChain() { continuation.yield(.chain(chain)) }

    /// 只数“已建立”的连接，且仅在数字变化时上报 → 杜绝在途/死链反复触发的闪烁。
    private func emitPeers() {
        let n = conns.values.filter { $0.open }.count
        guard n != lastPeers else { return }
        lastPeers = n
        continuation.yield(.peers(n))
    }

    /// 规范化地址为 ws://host:port（去 path/尾斜杠、小写 scheme+host）→ 同一节点的不同写法去重，避免重复连接 + 重复广播。
    private nonisolated static func normalize(_ raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespaces)
        guard let u = URL(string: t), let scheme = u.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss", let host = u.host?.lowercased() else { return nil }
        let port = u.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    // ---- 发送（无需 actor 状态，nonisolated）----
    private nonisolated static func rawSend(_ task: URLSessionWebSocketTask, _ msg: OutMsg) {
        guard let data = try? JSONEncoder().encode(msg) else { return }
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
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

private enum OutMsg: Encodable {
    case hello(address: String, height: Int, listen: String)
    case queryAll
    case queryLatest
    case queryPeers
    case tx(Transaction)

    enum CodingKeys: String, CodingKey { case type, address, height, listen, tx }

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
        }
    }
}
