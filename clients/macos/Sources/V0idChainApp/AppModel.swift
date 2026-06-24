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
    /// 连接层持久错误（peerCount > 0 后自动清空；独立于 toast，以便一直可见）。
    @Published private(set) var connectionError: String?

    /// 已广播但尚未上链的本地交易（用于算下一笔 nonce、做乐观 UI）。
    @Published private(set) var pending: [V0idKit.Transaction] = []

    // ---- 挖矿（本机 solo PoW）----
    @Published private(set) var mineState: MineState = .idle
    @Published private(set) var hashRate: Double = 0        // 估算算力（H/s），仅挖矿中有意义
    @Published private(set) var currentAttempts: Int = 0    // 当前这块已试 nonce 数
    @Published private(set) var blocksFoundSession = 0      // 本次会话本机挖到并广播的块数（乐观，可能含被重组掉的孤块）
    @Published private(set) var nodeMempool: [V0idKit.Transaction] = []  // 节点广播来的待打包交易（供选包）
    @Published private(set) var lastBlockTxCount = 0        // 上一个挖到的块里打包的普通交易数
    private var mineWanted = false                          // 用户意图：是否在挖（开关状态）
    private var mineAttempt: Task<Void, Never>?             // 当前挖矿/等待任务（每条同一时刻只有一个）

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

    // ---- 挖矿派生状态 ----
    /// 开关是否打开（含「想挖但还没连上」的等待态）。
    var miningEnabled: Bool { mineWanted }
    /// 下一块要求的 PoW 目标：v1=前导 0 bit；v2=compact target(nBits)。
    var nextDifficulty: Int { chain.isEmpty ? Config.genesisDifficulty : Mining.nextDifficulty(chain) }
    /// 本机地址在**已同步链**里收到的 coinbase 块数 = 已确认出块（输掉竞争被重组的孤块自然不计，数字永远诚实）。
    var minedBlocksConfirmed: Int {
        guard let me = address else { return 0 }
        return chain.reduce(0) { acc, b in
            guard b.index > 0, let cb = b.transactions.first, cb.isCoinbase, cb.to == me else { return acc }
            return acc + 1
        }
    }
    /// 已确认出块累计奖励（出块奖励 + 打包的手续费），从链上 coinbase 金额累加。
    var minedRewardConfirmed: Int {
        guard let me = address else { return 0 }
        return chain.reduce(0) { acc, b in
            guard b.index > 0, let cb = b.transactions.first, cb.isCoinbase, cb.to == me else { return acc }
            return acc + cb.amount
        }
    }

    // ---- 派生展示状态（链/钱包变化时 recomputeDerived 刷新，避免每帧重扫整链）----
    @Published private(set) var names = NameRegistry()
    @Published private(set) var market: [Listing] = []
    @Published private(set) var redPackets: [RedPacketView] = []
    @Published private(set) var newcomers: [Newcomer] = []
    @Published private(set) var inboxMsgs: [DisplayMessage] = []
    @Published private(set) var outboxMsgs: [DisplayMessage] = []

    /// 地址 → 显示名：有昵称显示 @名字，否则缩写地址（完整地址仍随处可复制，便于识破仿冒）。
    func displayName(_ address: String) -> String {
        if let n = names.name(for: address) { return "@\(n)" }
        return short(address)
    }
    /// 我的当前显示名（没抢注过则 nil）。
    var myName: String? { address.flatMap { names.name(for: $0) } }

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
        stopMining()   // 没钱包无法挖矿 → 先停
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
        if mineWanted { mineAttempt?.cancel() }  // 旧地址的活作废；重连后用新地址在新链顶重挖
        recomputeDerived()   // 钱包变了 → 立即用新地址刷新解密 / 显示名 / 收发件箱
        startClient()
    }

    private func handle(_ ev: NodeEvent) {
        switch ev {
        case .peers(let n):
            peerCount = n
            if n > 0 { connectionError = nil }   // 连上了 → 清除持久连接错误
            if mineWanted, mineState == .waiting, n > 0 { restartMining() }  // 刚连上 → 立刻开挖（不等轮询）
        case .mempool(let txs):
            nodeMempool = txs   // 下一块组模板时纳入选包
        case .error(let msg):
            if peerCount == 0 {
                connectionError = msg   // 还没连上 → 持久显示，不走会消失的 toast
            } else {
                lastError = msg         // 已连接时的错误（广播失败等）→ toast
            }
        case .chain(let blocks):
            chain = blocks
            state = Chain.computeState(blocks)
            // 已上链的待发交易移出 pending
            let onChain = Set(blocks.flatMap { $0.transactions.map { $0.txid } })
            pending.removeAll { onChain.contains($0.txid) }
            recomputeDerived()
            // 链顶变了 → 放弃当前这块陈旧的活；被取消的任务在 completion 里会自动到新链顶重挖。
            if mineWanted { mineAttempt?.cancel() }
        }
    }

    /// 重算派生展示状态：昵称表 / 集市 / 红包 / 新成员 / 收发件箱（含加密私信本地解密）。
    private func recomputeDerived() {
        names = Names.parseNames(chain)
        market = Market.parseMarket(chain)
        redPackets = RedPacket.parseRedPackets(chain)
        newcomers = Chain.newcomers(chain)
        guard let me = address else { inboxMsgs = []; outboxMsgs = []; return }
        let seed = wallet?.privateKey
        func decode(_ m: ChainMessage) -> DisplayMessage {
            guard m.encrypted, let seed else {
                return DisplayMessage(msg: m, text: m.text, encrypted: m.encrypted, locked: false)
            }
            let other = m.to == me ? m.from : m.to   // 我是收件人→对方=发件人，否则→收件人
            if let plain = Encryption.decryptMemo(m.text, otherPartyAddress: other, mySeed: seed) {
                return DisplayMessage(msg: m, text: plain, encrypted: true, locked: false)
            }
            return DisplayMessage(msg: m, text: m.text, encrypted: true, locked: true)
        }
        inboxMsgs = Chain.inbox(chain, address: me).map(decode)
        outboxMsgs = Chain.outbox(chain, address: me).map(decode)
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

    /// 链上消息：amount 0 + burn + memo 正文，另付 fee。encrypt=true → 用收件人公钥端到端加密正文（`ENC|` 密文上链）。
    func sendMessage(to: String, text: String, burn: Int, fee: Int, encrypt: Bool = false) {
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
        var body = trimmed
        if encrypt {
            guard let enc = Encryption.encryptMemo(trimmed, recipientAddress: to, senderSeed: w.privateKey) else {
                lastError = "加密失败（收件地址无效？）"; return
            }
            guard enc.unicodeScalars.count <= Config.maxMemo else {
                lastError = "加密后超长（>\(Config.maxMemo) 字），消息太长"; return
            }
            body = enc
        }
        do {
            let tx = try TxBuilder.message(wallet: w, to: to, text: body, nonce: nextNonce, burn: burn, fee: fee)
            pending.append(tx)
            broadcast(tx, notice: "已广播\(encrypt ? " 🔒加密" : "")消息 → \(displayName(to))（🔥 烧 \(burn)，等矿工打包）")
        } catch {
            lastError = error.localizedDescription
        }
    }

    // ---- 集市 / 红包：都建在“转账 + memo”之上（余额由 computeState 复刻共识保证一致）----
    private func submit(to: String, amount: Int, memo: String, fee: Int = Config.minFee, notice: String) {
        guard let w = wallet else { lastError = "请先创建或登录钱包"; return }
        guard amount + fee <= available else { lastError = "余额不足：可用 \(available)，需要 \(amount + fee)"; return }
        do {
            let tx = try TxBuilder.transfer(wallet: w, to: to, amount: amount, nonce: nextNonce, memo: memo, fee: fee)
            pending.append(tx)
            broadcast(tx, notice: notice)
        } catch { lastError = error.localizedDescription }
    }

    func marketSell(price: Int, title: String) {
        guard let me = address else { lastError = "请先创建或登录钱包"; return }
        let (memo, err) = Market.makeListing(price: price, title: title)
        guard let memo else { lastError = err; return }
        submit(to: me, amount: 1, memo: memo, notice: "已上架「\(title)」\(price) \(Config.symbol)（等矿工打包）")
    }
    func marketBuy(_ l: Listing) {
        submit(to: l.seller, amount: l.price, memo: Config.buyPrefix + l.id,
               notice: "已下单付款 \(l.price) \(Config.symbol) → \(displayName(l.seller))")
    }
    func marketDelist(_ l: Listing) {
        guard let me = address else { return }
        submit(to: me, amount: 1, memo: Config.delPrefix + l.id, notice: "已撤下「\(l.title)」")
    }

    func redSend(total: Int, count: Int, mode: RedMode) {
        let (memo, err) = RedPacket.makeRedPacket(total: total, count: count, mode: mode)
        guard let memo else { lastError = err; return }
        submit(to: Config.redEscrowAddress, amount: total, memo: memo,
               notice: "🧧 已发出 \(total) \(Config.symbol)/\(count) 份（等一个区块确认后可抢）")
    }
    func redGrab(_ p: RedPacketView) {
        guard let me = address else { lastError = "请先创建或登录钱包"; return }
        submit(to: me, amount: 0, memo: Config.claimPrefix + p.id, notice: "🧧 已出手抢！")
    }
    func redRefund(_ p: RedPacketView) {
        guard let me = address else { return }
        submit(to: me, amount: 0, memo: Config.refundPrefix + p.id, notice: "↩️ 已申请退款（需过期）")
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

    // ---- 挖矿（本机 solo PoW）----
    // 开关 → 门控（有钱包 + 已连上 + 已同步到链）→ 组块（coinbase 空块）→ 后台搜 nonce →
    // 找到即乐观接链 + 广播；新链顶到达就放弃这块、到新顶重挖。奖励数字以同步链为准（抗重组）。

    func toggleMining() { mineWanted ? stopMining() : startMining() }

    func startMining() {
        guard wallet != nil else { lastError = "请先创建或登录钱包再挖矿"; return }
        guard !mineWanted else { return }
        mineWanted = true
        blocksFoundSession = 0
        restartMining()
    }

    func stopMining() {
        mineWanted = false
        mineAttempt?.cancel()
        mineAttempt = nil
        mineState = .idle
        hashRate = 0
        currentAttempts = 0
    }

    /// 唯一的「(重新)开挖」入口：先取消上一个任务，再按当前状态开一个新任务（搜 nonce 或等待）。
    /// 主线程同步执行（cancel→赋值之间无 await）→ 任一时刻最多一个活跃挖矿任务。
    private func restartMining() {
        mineAttempt?.cancel()
        guard mineWanted else { mineState = .idle; hashRate = 0; currentAttempts = 0; return }
        guard let miner = address, isConnected, !chain.isEmpty else {
            // 没钱包 / 没连上 / 还没同步到链 → 等一会再看（连上会被 .peers 事件提前唤醒）。
            mineState = .waiting; hashRate = 0; currentAttempts = 0
            mineAttempt = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await self?.restartMining()
            }
            return
        }
        mineState = .mining
        currentAttempts = 0
        let snapshot = chain
        let startHeight = snapshot.count            // 我们出的块 index = startHeight
        // 选包：节点广播来的 mempool + 本机已广播待打包交易（去重）；selectTxs 按链顶状态精确过滤、跳过红包交易。
        var pool = nodeMempool
        let known = Set(pool.map { $0.txid })
        pool.append(contentsOf: pending.filter { !known.contains($0.txid) })
        let extraTxs = Mining.selectTxs(chain: snapshot, mempool: pool)
        let template = Mining.buildTemplate(chain: snapshot, miner: miner, extraTxs: extraTxs)
        mineAttempt = Task.detached(priority: .utility) { [weak self] in
            let startedNs = DispatchTime.now().uptimeNanoseconds
            let throttle = Throttle()
            let found = await Mining.search(template: template, onBatch: { attempts in
                let now = DispatchTime.now().uptimeNanoseconds
                guard now &- throttle.lastNs > 300_000_000 else { return }   // UI 最多 ~3 次/秒
                throttle.lastNs = now
                let elapsed = Double(now &- startedNs) / 1e9
                let rate = elapsed > 0 ? Double(attempts) / elapsed : 0
                Task { @MainActor [weak self] in
                    guard let self, self.mineState == .mining else { return }
                    self.currentAttempts = attempts
                    self.hashRate = rate
                }
            })
            await MainActor.run { [weak self] in self?.handleMineResult(found, startHeight: startHeight) }
        }
    }

    /// 一个挖矿任务结束：找到块且链顶未变 → 乐观接链 + 广播；随后总在最新链顶继续下一块。
    private func handleMineResult(_ found: Block?, startHeight: Int) {
        if let block = found, chain.count == startHeight, chain.last?.hash == block.prevHash {
            chain.append(block)                         // 乐观接链：节点不会把我的块回声给我，必须自己续顶
            state = Chain.computeState(chain)
            let mined = Set(block.transactions.map { $0.txid })
            pending.removeAll { mined.contains($0.txid) }
            recomputeDerived()
            blocksFoundSession += 1
            lastBlockTxCount = max(0, block.transactions.count - 1)
            let reward = block.transactions.first?.amount ?? Config.blockReward
            let txNote = lastBlockTxCount > 0 ? "，打包 \(lastBlockTxCount) 笔交易" : ""
            lastNotice = "⛏️ 挖到区块 #\(block.index)！已广播全网（奖励 \(reward) \(Config.symbol)\(txNote)）"
            let c = client
            Task { try? await c?.broadcastBlock(block) }
        }
        restartMining()   // 找到 / 被打断 / 取消 —— 都在最新链顶继续挖
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

func difficultyText(_ difficulty: Int) -> String {
    difficulty > 255 ? String(format: "nBits 0x%08x", difficulty) : "\(difficulty) bit"
}

/// 挖矿状态：idle=未开/已停；waiting=想挖但还没连上/没钱包/没同步；mining=正在搜 nonce。
enum MineState: Equatable { case idle, waiting, mining }

/// 跨线程节流计数器（仅在单个挖矿任务线程内读写，@unchecked Sendable 足够）。
final class Throttle: @unchecked Sendable { var lastNs: UInt64 = 0 }

/// 展示用消息：在 ChainMessage 之上附加“本端解密结果 + 加密/锁定标识”。
struct DisplayMessage: Identifiable {
    let msg: ChainMessage
    let text: String       // 解密后的明文；非加密则为原文；加密但解不开则为密文
    let encrypted: Bool
    let locked: Bool       // 加密但本端无法解密（查的是别人的私信）
    var id: String { msg.txid }
    var from: String { msg.from }
    var to: String { msg.to }
    var burn: Int { msg.burn }
    var height: Int { msg.height }
    var timestamp: Int { msg.timestamp }
}
