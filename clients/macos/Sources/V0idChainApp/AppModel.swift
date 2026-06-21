// App 状态中枢：钱包 + 节点连接池 + 链快照 + 派生状态（余额 / nonce / 消息）。
// 所有链逻辑都来自 V0idKit；这里只做编排与 SwiftUI 绑定。
import Foundation
import SwiftUI
import V0idKit

@MainActor
final class AppModel: ObservableObject {
    // ---- 钱包 ----
    @Published private(set) var wallet: Wallet?

    // ---- 连接（多节点池；只暴露“连了几个”，不暴露具体地址）----
    @Published private(set) var peerCount = 0

    // ---- 链 ----
    @Published private(set) var chain: [Block] = []
    @Published private(set) var state = ChainState()

    // ---- 用户可见提示 ----
    @Published var lastError: String?
    @Published var lastNotice: String?

    /// 已广播但尚未上链的本地交易（用于算下一笔 nonce、做乐观 UI）。
    @Published private(set) var pending: [V0idKit.Transaction] = []

    private var client: NodeClient?
    private var eventTask: Task<Void, Never>?

    // ---- 派生状态 ----
    var address: String? { wallet?.address }
    var height: Int { chain.isEmpty ? 0 : chain.count - 1 }
    var balance: Int { wallet.map { state.balance($0.address) } ?? 0 }
    /// 已扣住的待发额（金额 + 手续费 + 销毁额），用于显示「可用余额」。
    var pendingOut: Int { pending.reduce(0) { $0 + $1.amount + $1.fee + $1.burnAmount } }
    var available: Int { balance - pendingOut }
    var nextNonce: Int {
        guard let a = address else { return 0 }
        return state.nonce(a) + pending.filter { $0.from == a }.count
    }
    var burned: Int { state.burned }
    var isConnected: Bool { peerCount > 0 }

    var inbox: [ChainMessage] { address.map { Chain.inbox(chain, address: $0) } ?? [] }
    var outbox: [ChainMessage] { address.map { Chain.outbox(chain, address: $0) } ?? [] }

    // ---- 启动 ----
    func bootstrap() {
        if let hex = Keychain.loadPrivateKey(), let w = try? Wallet.fromPrivateKeyHex(hex) {
            wallet = w
        }
        startClient()
    }

    // ---- 钱包操作 ----
    func generateWallet() {
        let w = Wallet.generate()
        Keychain.savePrivateKey(w.privateKeyHex)
        wallet = w
        pending = []
        lastNotice = "已生成新钱包"
        restartClient()
    }

    /// 登录/导入已有钱包（如把挖矿钱包带到 Mac，无需转账、不花 gas）。覆盖当前钱包。
    func importWallet(privateKeyHex: String) {
        do {
            let w = try Wallet.fromPrivateKeyHex(privateKeyHex)
            Keychain.savePrivateKey(w.privateKeyHex)
            wallet = w
            pending = []
            lastNotice = "已登录钱包 \(short(w.address))"
            restartClient()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func forgetWallet() {
        Keychain.deletePrivateKey()
        wallet = nil
        pending = []
        lastNotice = "已退出（私钥已从 Keychain 删除）"
        restartClient()
    }

    // ---- 连接池 ----
    private func startClient() {
        eventTask?.cancel()
        let addr = wallet?.address ?? Config.nullAddress
        let c = NodeClient(bootstrap: Config.bootstrapNodes, myAddress: addr, maxPeers: Config.maxPeers)
        client = c
        eventTask = Task { [weak self] in
            for await ev in c.events {
                self?.handle(ev)   // Task 继承 @MainActor 隔离，直接同步调用
            }
        }
        Task { await c.start() }
    }

    /// 钱包变化时重建连接池（用新地址自报家门）。
    private func restartClient() {
        let old = client
        Task { await old?.stop() }
        peerCount = 0
        startClient()
    }

    private func handle(_ ev: NodeEvent) {
        switch ev {
        case .peers(let n): peerCount = n
        case .error(let msg): lastError = msg
        case .chain(let blocks):
            chain = blocks
            state = Chain.computeState(blocks)
            // 已上链的待发交易移出 pending
            let onChain = Set(blocks.flatMap { $0.transactions.map { $0.txid } })
            pending.removeAll { onChain.contains($0.txid) }
        }
    }

    // ---- 发送 ----
    /// 转账。校验地址 / 金额 / 余额；本地签名后广播给所有连接；加入 pending。
    func send(to: String, amount: Int, fee: Int, memo: String) {
        guard let w = wallet else { lastError = "请先创建或登录钱包"; return }
        let to = to.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Crypto.isValidAddress(to) else { lastError = "收款地址格式无效（应为 0x + 64 hex）"; return }
        guard to != Config.nullAddress else { lastError = "不能向虚空地址转账"; return }
        guard amount > 0 else { lastError = "转账金额必须 > 0"; return }
        guard fee >= Config.minFee else { lastError = "手续费至少 \(Config.minFee)"; return }
        guard memo.unicodeScalars.count <= Config.maxMemo else { lastError = "备注超过 \(Config.maxMemo) 字"; return }
        guard amount + fee <= available else { lastError = "余额不足：可用 \(available)，需要 \(amount + fee)"; return }
        do {
            let tx = try TxBuilder.transfer(wallet: w, to: to, amount: amount, nonce: nextNonce, memo: memo, fee: fee)
            pending.append(tx)
            broadcast(tx, notice: "已广播转账 \(amount) \(Config.symbol) → \(short(to))（等矿工打包）")
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// 链上消息：amount 0 + burn + memo 正文，另付 fee。
    func sendMessage(to: String, text: String, burn: Int, fee: Int) {
        guard let w = wallet else { lastError = "请先创建或登录钱包"; return }
        let to = to.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Crypto.isValidAddress(to) else { lastError = "收件地址格式无效（应为 0x + 64 hex）"; return }
        guard to != Config.nullAddress else { lastError = "不能向虚空地址发消息"; return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { lastError = "消息正文不能为空"; return }
        guard trimmed.unicodeScalars.count <= Config.maxMemo else { lastError = "消息超过 \(Config.maxMemo) 字"; return }
        guard burn > 0 else { lastError = "销毁额必须 > 0"; return }
        guard fee >= Config.minFee else { lastError = "手续费至少 \(Config.minFee)"; return }
        guard burn + fee <= available else { lastError = "余额不足：可用 \(available)，需要 \(burn + fee)（销毁 \(burn) + 手续费 \(fee)）"; return }
        do {
            let tx = try TxBuilder.message(wallet: w, to: to, text: trimmed, nonce: nextNonce, burn: burn, fee: fee)
            pending.append(tx)
            broadcast(tx, notice: "已广播消息 → \(short(to))（🔥 烧 \(burn)，等矿工打包）")
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// 异步广播到连接池；失败则回滚乐观 pending 并报错。
    private func broadcast(_ tx: V0idKit.Transaction, notice: String) {
        let c = client
        Task {
            do {
                try await c?.broadcast(tx)
                lastNotice = notice
            } catch {
                pending.removeAll { $0.txid == tx.txid }
                lastError = error.localizedDescription
            }
        }
    }

    func claimName(_ rawName: String) {
        guard let w = wallet else { lastError = "请先创建或登录钱包"; return }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let reserved: Set<String> = ["treasury","official","admin","system","null","v0id","v0idchain","genesis","coinbase"]
        guard name.range(of: #"^[a-z0-9_-]{1,20}$"#, options: .regularExpression) != nil,
              !name.hasPrefix("0x"), !reserved.contains(name) else {
            lastError = "昵称无效：1~20 位小写字母/数字/_/-，不能用保留名"; return
        }
        guard available >= 2 else {
            lastError = "余额不足：抢注需 2 $V0ID（自转 1 + 手续费 \(Config.minFee)）"; return
        }
        do {
            let tx = try TxBuilder.transfer(wallet: w, to: w.address, amount: 1, nonce: nextNonce, memo: "NAME|\(name)", fee: Config.minFee)
            pending.append(tx)
            broadcast(tx, notice: "已广播抢注 @\(name)（先到先得，等矿工打包）")
        } catch {
            lastError = error.localizedDescription
        }
    }

    // ---- 浏览器 ----
    func search(_ q: String) -> SearchResult { Chain.search(chain, q) }

    var recentBlocks: [Block] { Array(chain.suffix(30).reversed()) }
}

/// 地址缩写：0x1234…abcd
func short(_ s: String) -> String {
    guard s.count > 14 else { return s }
    return String(s.prefix(8)) + "…" + String(s.suffix(6))
}
