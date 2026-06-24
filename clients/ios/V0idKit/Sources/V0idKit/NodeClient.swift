// NodeClient：通过 WebSocket 连一个节点，拉全链、算余额/nonce、广播自己的交易、增量接收新块。
// CLIENT-PROTOCOL §6 最小流程。MVP 信任所连节点（不做整链 PoW 校验，见 §5「最省事」）。
//
// 设计为 @MainActor ObservableObject，SwiftUI 直接观察其 @Published 状态。
import Foundation
import Combine

@MainActor
public final class NodeClient: ObservableObject {
    public enum Status: Equatable {
        case disconnected
        case connecting
        case syncing      // 已连上，正在等/拉整链
        case connected    // 已追平，持续接收增量
    }

    // ---- 对外可观察状态 ----
    @Published public private(set) var status: Status = .disconnected
    @Published public private(set) var chain: [Block] = []
    @Published public private(set) var lastError: String?
    @Published public private(set) var connectionError: String?
    /// 已广播、但尚未在链上出现的本地交易（用于 nonce 推进与 UI 提示）。
    @Published public private(set) var pending: [Transaction] = []

    public var nodeURL: String
    /// 当前钱包地址（设置后状态计算才有意义）。
    public var address: String?

    private var ws: WebSocketConn?
    private var keepAlive: Timer?
    private var reconnectWork: DispatchWorkItem?
    private var manualClose = false
    private var generation = 0   // 每次 connect 自增，用于丢弃旧连接的回调
    private var syncingStart: Date?

    // ---- 分块同步缓冲（服务端把大链拆成 ≤500 块一片，iOS 累积后再 adopt）----
    private var chunkBuffer: [Block] = []
    private var chunkTotal: Int = 0

    // ---- 种子失效 fallback：gossip 学到的备用地址 + 连续失败计数 ----
    private var backupURLs: [String] = []
    private var failCount = 0
    private var connectURL: String   // 当次实际目标（正常=nodeURL；种子挂了=备用节点）

    public init(nodeURL: String) {
        self.nodeURL = nodeURL
        self.connectURL = nodeURL
        // 传输层用裸 POSIX socket（WebSocketConn），不用 URLSession：后者尊重系统 HTTP/SOCKS
        // 代理（Clash/mihomo），把 ws:// 握手送进代理隧道，代理一抖就断。裸 socket 直连内核
        // TCP 栈，绕过系统代理。详见 WebSocket.swift。
        self.backupURLs = UserDefaults.standard.stringArray(forKey: "v0id-peer-backup") ?? []
    }

    // MARK: - 派生状态

    public var height: Int { chain.isEmpty ? 0 : chain.count - 1 }
    public var state: ChainState { ChainState(chain: chain) }

    public func balance() -> Int {
        guard let address else { return 0 }
        return state.balance(of: address)
    }

    /// 下一笔交易应使用的 nonce = 已确认 nonce + 本地待打包（pending）笔数。
    public func nextNonce() -> Int {
        guard let address else { return 0 }
        let confirmed = state.confirmedNonce(of: address)
        let pendingMine = pending.filter { $0.from == address }.count
        return confirmed + pendingMine
    }

    public var totalBurned: Int { state.totalBurned }

    // MARK: - 连接

    /// 用户主动触发：重置 fallback 状态后重连。
    public func connect() {
        failCount = 0
        connectURL = nodeURL
        connectionError = nil
        doConnect()
    }

    /// 实际建立连接（connect() 和 scheduleReconnect() 共用；connectURL 已由调用方设置好）。
    private func doConnect() {
        disconnect(manual: false)   // 清掉旧连接但允许自动重连
        manualClose = false
        generation += 1
        let gen = generation
        // 容错：用户没写 scheme（如 "localhost:6001"）就补 ws://；scheme 不对则报错不连。
        guard let url = Self.normalizedWebSocketURL(connectURL), let host = url.host else {
            status = .disconnected
            let message = "节点地址无效（需 ws:// 或 wss://）：\(connectURL)"
            lastError = message
            connectionError = message
            return
        }
        // WebSocketConn 走裸 socket，目前仅支持 ws://（wss 需 TLS，留待生产化）。
        guard url.scheme == "ws" else {
            status = .disconnected
            let message = "暂仅支持 ws://（wss 待生产化）：\(connectURL)"
            lastError = message
            connectionError = message
            return
        }
        let port = UInt16(url.port ?? 80)
        status = .connecting
        lastError = nil
        // listen 每条连接唯一：节点端用 listen 给连接判重（p2p.ts），共用常量会导致同一客户端
        // 新旧连接互相判重 → 被 close → 立即重连 → 永久抖动、整链拉不到。规范允许 listen 为任意串。
        let listen = "ios-light-\(UUID().uuidString.prefix(8))"
        let conn = WebSocketConn(host: host, port: port)
        self.ws = conn
        conn.onOpen = { [weak self] in
            Task { @MainActor in
                guard let self, gen == self.generation else { return }
                // 握手：HELLO（height=0，listen 唯一——我们不被回拨）→ 要整条链 + 问邻居
                self.send(.hello(address: self.address ?? Crypto.nullAddress, height: 0, listen: listen))
                self.send(.queryAll)
                self.send(.queryPeers)
                self.status = .syncing
                self.syncingStart = Date()
            }
        }
        conn.onText = { [weak self] text in
            Task { @MainActor in
                guard let self, gen == self.generation else { return } // 旧连接的回调直接丢弃
                self.handle(text)
            }
        }
        conn.onClose = { [weak self] err in
            Task { @MainActor in
                guard let self, gen == self.generation else { return }
                let wasConnected = self.status == .connected
                if let err { self.lastError = err }
                if !wasConnected, let err {
                    self.connectionError = "连接 \(self.connectURL) 失败：\(err)"
                }
                self.status = .disconnected
                self.scheduleReconnect()
            }
        }
        conn.start()
        startKeepAlive()
    }

    /// 规范化节点地址 → 合法 ws/wss URL；无 scheme 补 `ws://`，scheme 非 ws/wss 则返回 nil。
    /// 纯函数（不碰实例/actor 状态）→ `nonisolated`，可从任意上下文调用。
    nonisolated static func normalizedWebSocketURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "ws://" + s }       // 没写 scheme → 默认明文 ws
        guard let url = URL(string: s),
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              url.host != nil
        else { return nil }
        return url
    }

    public func disconnect() { disconnect(manual: true) }

    private func disconnect(manual: Bool) {
        manualClose = manual
        reconnectWork?.cancel(); reconnectWork = nil
        keepAlive?.invalidate(); keepAlive = nil
        ws?.close()
        ws = nil
        chunkBuffer = []; chunkTotal = 0   // 旧连接的残片不要带入下一次同步
        if manual { status = .disconnected }
    }

    private func startKeepAlive() {
        keepAlive?.invalidate()
        keepAlive = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.status == .syncing {
                    if let start = self.syncingStart, Date().timeIntervalSince(start) > 30 {
                        self.connect()
                    } else {
                        self.send(.queryAll)
                    }
                } else {
                    self.send(.queryLatest)
                }
                // 应用层探测即保活；WebSocketConn 会自动回应服务端 ping（防 NAT 超时断连）。
            }
        }
    }

    private func scheduleReconnect() {
        guard !manualClose else { return }
        failCount += 1
        // 连续失败 3 次后开始轮询 backupURLs（种子挂了自动切到已知节点）
        if failCount > 3 && !backupURLs.isEmpty {
            connectURL = backupURLs[(failCount - 4) % backupURLs.count]
        } else {
            connectURL = nodeURL
        }
        reconnectWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.doConnect() }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }

    // MARK: - 收发

    private func send(_ msg: OutgoingMessage) {
        guard let ws else { return }
        do {
            let data = try msg.jsonData()
            ws.sendText(String(decoding: data, as: UTF8.self))
        } catch {
            lastError = "编码失败：\(error.localizedDescription)"
        }
    }

    private func handle(_ text: String) {
        let data = Data(text.utf8)
        guard let parsed = IncomingMessage.parse(data) else { return }
        switch parsed {
        case .blocks(let blocks):
            onBlocks(blocks)
        case .blocksChunk(let blocks, let from, let total):
            onBlocksChunk(blocks, from: from, total: total)
        case .blocksError(let msg):
            lastError = msg
        case .peers(let urls):
            learnPeers(urls)
        case .other:
            break // 节点的 HELLO/QUERY_* 等：忽略
        }
    }

    /// 累积分块同步的片段，收齐后交给 onBlocks() 统一处理。
    private func onBlocksChunk(_ blocks: [Block], from: Int, total: Int) {
        if from == 0 || chunkTotal != total {
            // 新的同步会话开始（或 total 变了说明链又长了）：重置缓冲。
            chunkBuffer = []
            chunkTotal = total
        }
        chunkBuffer.append(contentsOf: blocks)
        // 重置超时计时器，让 keepAlive 知道我们还在正常接收，不要触发重连。
        syncingStart = Date()
        if chunkBuffer.count >= chunkTotal {
            let full = chunkBuffer
            chunkBuffer = []
            chunkTotal = 0
            onBlocks(full)
        }
    }

    /// 合并收到的区块（信任节点）：整链快照直接采纳更长者；单块若正好接续链顶就追加，落后则补拉整链。
    private func onBlocks(_ blocks: [Block]) {
        guard let last = blocks.last else { return }
        if blocks.count >= 2 {
            // QUERY_ALL 的整链响应（或多块）：采纳更高/同高的节点视图
            if last.index >= height { adopt(blocks) }
        } else {
            if last.index == height + 1, last.prevHash == tipHash {
                chain.append(last)
                afterChainChanged()
            } else if last.index > height {
                send(.queryAll) // 落后不止一块（或分叉）→ 要整条链
            } else if last.index <= height, last.index < chain.count, chain[last.index].hash != last.hash {
                send(.queryAll) // 同高但 hash 不同（reorg）→ 重新同步
            }
        }
    }

    private var tipHash: String { chain.last?.hash ?? "" }

    private func adopt(_ blocks: [Block]) {
        chain = blocks
        afterChainChanged()
    }

    private func afterChainChanged() {
        status = .connected
        connectionError = nil
        failCount = 0      // 成功拿到链，重置 fallback 计数
        connectURL = nodeURL
        // 已上链的 pending 交易：从待打包集合移除
        if !pending.isEmpty {
            let onChain = Set(chain.flatMap { $0.transactions.map(\.txid) })
            pending.removeAll { onChain.contains($0.txid) }
        }
    }

    /// 把节点 gossip 来的对等地址加入备用池并持久化（过滤掉私网/localhost/已有的）。
    private func learnPeers(_ urls: [String]) {
        var added = false
        for raw in urls {
            guard let urlObj = Self.normalizedWebSocketURL(raw) else { continue }
            let normalized = urlObj.absoluteString
            let host = urlObj.host ?? ""
            // 只收公网可路由地址：环回/RFC1918 私网/链路本地/ULA 一律丢弃，防 LAN MITM 用 PEERS 帧
            // 把自己（如 ws://10.0.0.5:6001）塞进备用池被持久化、下次冷启动自动连上（对齐节点端 isPublicWsUrl）。
            guard !Self.isPrivateOrLocalHost(host),
                  normalized != nodeURL,
                  !backupURLs.contains(normalized) else { continue }
            backupURLs.append(normalized)
            added = true
        }
        if added { UserDefaults.standard.set(backupURLs, forKey: "v0id-peer-backup") }
    }

    /// host 是否为环回/私网/链路本地/ULA（gossip 学来的命中则丢弃）。对齐节点端 isPublicWsUrl
    /// 的「只放行全局单播」策略（packages/node/src/p2p.ts）。
    static func isPrivateOrLocalHost(_ rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if let pct = host.firstIndex(of: "%") { host = String(host[..<pct]) }
        if host.isEmpty || host == "localhost" { return true }
        if host.contains(":") {
            // IPv6：只放行全局单播 2000::/3；其余（::1 环回 / fe80 链路本地 / fc,fd ULA / ::ffff: 映射 等）拒
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

    // MARK: - 钱包动作

    /// 本地构造+签名一笔转账并广播。失败抛错（余额/地址/nonce 等）。
    @discardableResult
    public func sendTransfer(wallet: Wallet, to: String, amount: Int, memo: String = "", fee: Int = TxBuilder.minFee) throws -> Transaction {
        try precheckTransfer(wallet: wallet, to: to, amount: amount, fee: fee, burn: 0)
        let tx = try wallet.createTransaction(to: to, amount: amount, nonce: nextNonce(), memo: memo, fee: fee)
        broadcast(tx)
        return tx
    }

    /// 本地构造+签名一条链上消息（amount 0 + burn + memo 正文）并广播。
    @discardableResult
    public func sendMessage(wallet: Wallet, to: String, text: String, burn: Int = TxBuilder.messageBurn, fee: Int = TxBuilder.minFee) throws -> Transaction {
        try precheckTransfer(wallet: wallet, to: to, amount: 0, fee: fee, burn: burn)
        let tx = try wallet.createMessage(to: to, text: text, nonce: nextNonce(), burn: burn, fee: fee)
        broadcast(tx)
        return tx
    }

    // ---- 新功能：昵称 / 集市 / 红包 / 加密私信（都建在转账 + memo 上）----

    /// 抢注链上昵称：自转 1 $V0ID，memo `NAME|<name>`。先到先得、全网唯一。
    @discardableResult
    public func claimName(wallet: Wallet, name: String) throws -> Transaction {
        let (memo, err) = Names.makeNameClaim(name)
        guard let memo else { throw FeatureError.invalid(err ?? "昵称无效") }
        return try sendTransfer(wallet: wallet, to: wallet.address, amount: 1, memo: memo, fee: TxBuilder.minFee)
    }

    /// 集市上架：自转 1 $V0ID，memo `MKT|<price>|<title>`。
    @discardableResult
    public func sellListing(wallet: Wallet, price: Int, title: String) throws -> Transaction {
        let (memo, err) = Market.makeListing(price: price, title: title)
        guard let memo else { throw FeatureError.invalid(err ?? "上架参数无效") }
        return try sendTransfer(wallet: wallet, to: wallet.address, amount: 1, memo: memo, fee: TxBuilder.minFee)
    }

    /// 集市购买：付给卖家 listing.price，memo `BUY|<listingTxid>`。
    @discardableResult
    public func buyListing(wallet: Wallet, listing: Listing) throws -> Transaction {
        try sendTransfer(wallet: wallet, to: listing.seller, amount: listing.price,
                         memo: "\(Config.buyPrefix)\(listing.id)", fee: TxBuilder.minFee)
    }

    /// 集市撤单：自转 1 $V0ID，memo `DEL|<listingTxid>`（仅卖家本人有效）。
    @discardableResult
    public func delistListing(wallet: Wallet, listing: Listing) throws -> Transaction {
        try sendTransfer(wallet: wallet, to: wallet.address, amount: 1,
                         memo: "\(Config.delPrefix)\(listing.id)", fee: TxBuilder.minFee)
    }

    /// 发红包：转给托管地址 total，memo `RED|<count>|<r|e>`。
    @discardableResult
    public func sendRedPacket(wallet: Wallet, total: Int, count: Int, mode: RedMode) throws -> Transaction {
        let (memo, err) = RedPacket.makeRedPacket(total: total, count: count, mode: mode)
        guard let memo else { throw FeatureError.invalid(err ?? "红包参数无效") }
        return try sendTransfer(wallet: wallet, to: Config.redEscrowAddress, amount: total, memo: memo, fee: TxBuilder.minFee)
    }

    /// 抢红包：自转 amount=0，memo `CLAIM|<id>`。入账由共识从托管池派发。
    @discardableResult
    public func claimRedPacket(wallet: Wallet, id: String) throws -> Transaction {
        try sendZeroAmountOp(wallet: wallet, memo: "\(Config.claimPrefix)\(id)")
    }

    /// 退红包：自转 amount=0，memo `REFUND|<id>`（仅发起人、过期后有效）。
    @discardableResult
    public func refundRedPacket(wallet: Wallet, id: String) throws -> Transaction {
        try sendZeroAmountOp(wallet: wallet, memo: "\(Config.refundPrefix)\(id)")
    }

    /// 加密私信：明文用 ECDH 共享密钥加密成 `ENC|<密文>`，再走链上消息（amount0+burn+memo）。
    @discardableResult
    public func sendEncryptedMessage(wallet: Wallet, to: String, plaintext: String,
                                     burn: Int = TxBuilder.messageBurn, fee: Int = TxBuilder.minFee) throws -> Transaction {
        guard let memo = Encryption.encryptMemo(plaintext, recipientAddress: to, senderSeed: wallet.privateKey) else {
            throw FeatureError.invalid("加密失败：收件地址无效")
        }
        guard memo.unicodeScalars.count <= Config.maxMemo else { throw FeatureError.invalid("密文超出 \(Config.maxMemo) 码点上限") }
        return try sendMessage(wallet: wallet, to: to, text: memo, burn: burn, fee: fee)
    }

    /// CLAIM/REFUND 这类 amount=0 自转：跳过“空交易”拦截（入账由共识从托管池支付），但仍校验手续费/余额。
    private func sendZeroAmountOp(wallet: Wallet, memo: String) throws -> Transaction {
        let fee = TxBuilder.minFee
        let pendingOut = pending
            .filter { $0.from == wallet.address }
            .reduce(0) { $0 + $1.amount + $1.fee + $1.burnAmount }
        let available = state.balance(of: wallet.address) - pendingOut
        if fee > available { throw SendError.insufficient(available: available, need: fee) }
        let tx = try wallet.createTransaction(to: wallet.address, amount: 0, nonce: nextNonce(), memo: memo, fee: fee)
        broadcast(tx)
        return tx
    }

    public enum FeatureError: LocalizedError {
        case invalid(String)
        public var errorDescription: String? { if case let .invalid(s) = self { return s }; return nil }
    }

    private func broadcast(_ tx: Transaction) {
        pending.append(tx)
        send(.tx(tx))
    }

    /// 发送前的本地校验，给出友好报错（与节点 addTransaction 的规则一致）。
    private func precheckTransfer(wallet: Wallet, to: String, amount: Int, fee: Int, burn: Int) throws {
        guard Crypto.isValidAddress(to), to != Crypto.nullAddress else {
            throw SendError.invalidRecipient
        }
        guard amount >= 0, burn >= 0 else { throw SendError.negative }
        if amount == 0 && burn == 0 { throw SendError.emptyTx }
        guard fee >= TxBuilder.minFee else { throw SendError.feeTooLow }
        // 占用额 = 金额 + 手续费 + 销毁额（含本地已 pending 的同地址交易）
        let pendingOut = pending
            .filter { $0.from == wallet.address }
            .reduce(0) { $0 + $1.amount + $1.fee + $1.burnAmount }
        let need = amount + fee + burn
        let available = state.balance(of: wallet.address) - pendingOut
        if need > available { throw SendError.insufficient(available: available, need: need) }
    }

    public enum SendError: LocalizedError {
        case invalidRecipient, negative, emptyTx, feeTooLow
        case insufficient(available: Int, need: Int)
        public var errorDescription: String? {
            switch self {
            case .invalidRecipient: return "收款地址格式无效（须为 0x + 64 位 hex，且非虚空地址）"
            case .negative: return "金额/销毁额不能为负"
            case .emptyTx: return "空交易：转账须金额>0，消息须销毁额>0"
            case .feeTooLow: return "手续费至少 \(TxBuilder.minFee)（gas）"
            case let .insufficient(available, need): return "余额不足：可用 \(available)，需要 \(need)"
            }
        }
    }

    // MARK: - 浏览/消息（便捷转发）

    public func inbox() -> [ChainMessage] { address.map { Messages.inbox(chain, address: $0) } ?? [] }
    public func outbox() -> [ChainMessage] { address.map { Messages.outbox(chain, address: $0) } ?? [] }
    public func recentBlocks(_ n: Int = 30) -> [Block] { Array(chain.suffix(n).reversed()) }
    public func search(_ q: String) -> Explorer.Result { Explorer.search(chain, q) }

    // ---- 新功能：派生只读视图（重放整条链）----

    /// 昵称注册表（先到先得）。
    public func nameRegistry() -> NameRegistry { Names.parseNames(chain) }
    /// 地址 → 显示名（没有则 nil）。
    public func name(for address: String) -> String? { nameRegistry().name(for: address) }
    /// 集市商品（最新在前）。
    public func listings() -> [Listing] { Market.parseMarket(chain) }
    /// 红包（最新在前）。
    public func redPackets() -> [RedPacketView] { RedPacket.parseRedPackets(chain) }
    /// 新成员（首次上链，最新在前）。
    public func newcomers(_ limit: Int = 25) -> [Newcomer] { Explorer.newcomers(chain, limit: limit) }

    /// 用当前钱包尝试解密一条 `ENC|` 私信；非加密原样返回，解不开返回 nil。
    /// 我是收件人 → 对方=发件人；我是发件人 → 对方=收件人（ECDH 对称）。
    public func decrypt(message msg: ChainMessage, wallet: Wallet) -> String? {
        guard Encryption.isEncryptedMemo(msg.text) else { return msg.text }
        let other = (msg.to == wallet.address) ? msg.from : msg.to
        return Encryption.decryptMemo(msg.text, otherPartyAddress: other, mySeed: wallet.privateKey)
    }
}
