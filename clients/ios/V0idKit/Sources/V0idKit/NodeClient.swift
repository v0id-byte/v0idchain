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
    /// 已广播、但尚未在链上出现的本地交易（用于 nonce 推进与 UI 提示）。
    @Published public private(set) var pending: [Transaction] = []

    public var nodeURL: String
    /// 当前钱包地址（设置后状态计算才有意义）。
    public var address: String?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession
    private var keepAlive: Timer?
    private var reconnectWork: DispatchWorkItem?
    private var manualClose = false
    private var generation = 0   // 每次 connect 自增，用于丢弃旧连接的回调
    private var syncingStart: Date?

    // ---- 种子失效 fallback：gossip 学到的备用地址 + 连续失败计数 ----
    private var backupURLs: [String] = []
    private var failCount = 0
    private var connectURL: String   // 当次实际目标（正常=nodeURL；种子挂了=备用节点）

    public init(nodeURL: String) {
        self.nodeURL = nodeURL
        self.connectURL = nodeURL
        self.session = URLSession(configuration: .default)
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
        doConnect()
    }

    /// 实际建立连接（connect() 和 scheduleReconnect() 共用；connectURL 已由调用方设置好）。
    private func doConnect() {
        disconnect(manual: false)   // 清掉旧连接但允许自动重连
        manualClose = false
        generation += 1
        let gen = generation
        // 必须是 ws:// 或 wss://，否则 URLSessionWebSocketTask 会抛 ObjC 异常直接崩（Swift try/catch 拦不住）。
        // 容错：用户没写 scheme（如 "localhost:6001"）就补 ws://；scheme 不对则报错不连。
        guard let url = Self.normalizedWebSocketURL(connectURL) else {
            status = .disconnected
            lastError = "节点地址无效（需 ws:// 或 wss://）：\(connectURL)"
            return
        }
        status = .connecting
        lastError = nil
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receiveLoop(gen: gen)
        // 握手：HELLO（height=0，listen 随意——我们不被回拨）→ 要整条链 + 问邻居
        send(.hello(address: address ?? Crypto.nullAddress, height: 0, listen: "ios-light-client"))
        send(.queryAll)
        send(.queryPeers)
        status = .syncing
        syncingStart = Date()
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
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if manual { status = .disconnected }
    }

    private func startKeepAlive() {
        keepAlive?.invalidate()
        keepAlive = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.status == .syncing {
                    // 卡在同步中：若超过 30s 无响应则重连，否则重发 QUERY_ALL。
                    if let start = self.syncingStart, Date().timeIntervalSince(start) > 30 {
                        self.connect()
                    } else {
                        self.send(.queryAll)
                    }
                } else {
                    self.send(.queryLatest)
                }
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
        guard let task else { return }
        do {
            let data = try msg.jsonData()
            let text = String(decoding: data, as: UTF8.self)
            task.send(.string(text)) { [weak self] error in
                if let error {
                    Task { @MainActor in self?.lastError = "发送失败：\(error.localizedDescription)" }
                }
            }
        } catch {
            lastError = "编码失败：\(error.localizedDescription)"
        }
    }

    private func receiveLoop(gen: Int) {
        guard let task else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, gen == self.generation else { return } // 旧连接的回调直接丢弃
                switch result {
                case .failure(let error):
                    self.lastError = error.localizedDescription
                    self.status = .disconnected
                    self.scheduleReconnect()
                case .success(let message):
                    self.handle(message)
                    self.receiveLoop(gen: gen) // 继续收下一帧
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let s): data = Data(s.utf8)
        case .data(let d): data = d
        @unknown default: return
        }
        guard let parsed = IncomingMessage.parse(data) else { return }
        switch parsed {
        case .blocks(let blocks):
            onBlocks(blocks)
        case .blocksError(let msg):
            lastError = msg
        case .peers(let urls):
            learnPeers(urls)
        case .other:
            break // 节点的 HELLO/QUERY_* 等：忽略
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
            guard host != "localhost", !host.hasPrefix("127."),
                  normalized != nodeURL,
                  !backupURLs.contains(normalized) else { continue }
            backupURLs.append(normalized)
            added = true
        }
        if added { UserDefaults.standard.set(backupURLs, forKey: "v0id-peer-backup") }
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
}
