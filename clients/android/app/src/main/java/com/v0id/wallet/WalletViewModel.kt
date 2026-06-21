package com.v0id.wallet

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.v0id.wallet.core.*
import com.v0id.wallet.data.KeyVault
import com.v0id.wallet.net.WsClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 链上新成员（地址首次出现的高度）。 */
data class Newcomer(val address: String, val height: Long)

/**
 * 收/发件箱里一条消息的展示态：原始消息 + 解密结果。
 * 加密私信若能用本钱包解出 → plaintext 非空；解不开（非本人/格式坏）→ locked=true。
 */
data class MessageView(
    val msg: ChainMessage,
    val encrypted: Boolean,
    val locked: Boolean,        // 加密但无法解密
    val plaintext: String?,     // 解密后的明文（明文消息直接 = 原文）
)

/** 逛链搜索结果。 */
sealed interface SearchResult {
    data object Empty : SearchResult
    data object NotFound : SearchResult
    data class BlockHit(val block: Block) : SearchResult
    data class TxHit(val height: Long, val tx: Transaction) : SearchResult
    data class AddressHit(
        val address: String,
        val balance: Long,
        val nonce: Long,
        val txs: List<Pair<Long, Transaction>>, // (height, tx) 最新在前
    ) : SearchResult
}

/** UI 状态（不可变快照）。 */
data class WalletUi(
    val ready: Boolean = false,
    val hasWallet: Boolean = false,
    val address: String = "",
    val nodeUrl: String = DEFAULT_SEED_WS,
    val connection: WsClient.Status = WsClient.Status.DISCONNECTED,
    val height: Long = -1,
    val balance: Long = 0,
    val available: Long = 0,
    val burned: Long = 0,
    val nextNonce: Long = 0,
    val pendingCount: Int = 0,
    val txCount: Int = 0,
    val chain: List<Block> = emptyList(),
    val inbox: List<MessageView> = emptyList(),
    val outbox: List<MessageView> = emptyList(),
    val newcomers: List<Newcomer> = emptyList(),
    val names: NameRegistry = NameRegistry(emptyMap(), emptyMap()),
    val myName: String? = null,
    val listings: List<Listing> = emptyList(),
    val redPackets: List<RedPacketView> = emptyList(),
    val log: String = "",
    val selfTest: SelfTestResult? = null,
) {
    /** 地址 → `@名字` 显示（无昵称则返回缩写地址）。 */
    fun display(address: String): String {
        val n = names.nameFor(address)
        return if (n != null) "@$n" else shortAddress(address)
    }
}

/** 地址缩写（与 UI 一致）。 */
fun shortAddress(a: String): String =
    if (a.length > 16) "${a.take(8)}…${a.takeLast(6)}" else a

class WalletViewModel(app: Application) : AndroidViewModel(app) {

    private val vault = KeyVault(app)
    private var wallet: Wallet? = null

    private val _ui = MutableStateFlow(WalletUi())
    val ui: StateFlow<WalletUi> = _ui.asStateFlow()

    /** 一次性提示（Snackbar）。 */
    val events = MutableSharedFlow<String>(extraBufferCapacity = 8)

    // 已广播但还没被打包进块的本地交易（用于 nonce 自增与可用余额预扣）。
    private val pending = mutableListOf<Transaction>()

    private var wantConnected = false
    private var reconnectScheduled = false

    // ---- 种子失效 fallback：gossip 学到的备用地址 + 连续失败计数 ----
    private val backupPeers = mutableListOf<String>()
    private var failCount = 0

    private val ws = WsClient(
        onBlocks = { blocks -> viewModelScope.launch { onBlocks(blocks) } },
        onStatus = { st -> onStatus(st) },
        onLog = { msg -> appendLog(msg) },
        onPeers = { urls -> viewModelScope.launch { onPeers(urls) } },
    )

    init {
        viewModelScope.launch {
            val hex = withContext(Dispatchers.IO) { vault.loadPrivateKeyHex() }
            val savedNode = withContext(Dispatchers.IO) { vault.nodeUrl }
            val savedPeers = withContext(Dispatchers.IO) { vault.knownPeers }
            if (savedPeers.isNotBlank()) backupPeers.addAll(savedPeers.split(",").filter { it.isNotBlank() })
            val node = savedNode.ifBlank { DEFAULT_SEED_WS }
            if (hex != null) {
                wallet = Wallet.fromPrivateKeyHex(hex)
            }
            _ui.update {
                it.copy(
                    ready = true,
                    hasWallet = wallet != null,
                    address = wallet?.address ?: "",
                    nodeUrl = node,
                )
            }
            if (wallet != null) connect()
        }
    }

    // ---- 钱包 ----
    fun createWallet() {
        val w = Wallet.generate()
        persistWallet(w)
        emit("已生成新钱包")
    }

    fun importWallet(hex: String) {
        val w = try {
            Wallet.fromPrivateKeyHex(hex)
        } catch (e: Exception) {
            emit(e.message ?: "私钥格式错误"); return
        }
        persistWallet(w)
        emit("已导入钱包")
    }

    private fun persistWallet(w: Wallet) {
        wallet = w
        pending.clear()
        viewModelScope.launch(Dispatchers.IO) { vault.savePrivateKeyHex(w.privateKeyHex) }
        _ui.update { it.copy(hasWallet = true, address = w.address, chain = emptyList()) }
        recompute()
        connect()
    }

    fun resetWallet() {
        wantConnected = false
        ws.disconnect()
        viewModelScope.launch(Dispatchers.IO) { vault.clearWallet() }
        wallet = null
        pending.clear()
        _ui.update {
            WalletUi(ready = true, hasWallet = false, nodeUrl = it.nodeUrl)
        }
    }

    fun privateKeyHex(): String? = wallet?.privateKeyHex

    // ---- 节点 / 连接 ----
    fun setNodeUrl(url: String) {
        val clean = url.trim()
        viewModelScope.launch(Dispatchers.IO) { vault.nodeUrl = clean }
        // 切换节点 = 重新以该节点的视角同步：清空旧链与待发交易，避免“旧链更高 → 新节点较短链被忽略”。
        pending.clear()
        _ui.update { it.copy(nodeUrl = clean, chain = emptyList()) }
        recompute()
        if (wallet != null) {
            ws.disconnect()
            connect()
        }
    }

    fun connect() {
        val w = wallet ?: return
        wantConnected = true
        ws.connect(_ui.value.nodeUrl, w.address)
    }

    fun disconnect() {
        wantConnected = false
        ws.disconnect()
    }

    fun refresh() {
        if (ws.status == WsClient.Status.CONNECTED) ws.requestChain() else connect()
    }

    private fun onStatus(st: WsClient.Status) {
        _ui.update { it.copy(connection = st) }
        if (st == WsClient.Status.CONNECTED) failCount = 0   // 连上后重置 fallback 计数
        if (st == WsClient.Status.DISCONNECTED && wantConnected && !ws.isUserClosed) {
            scheduleReconnect()
        }
    }

    private fun onPeers(urls: List<String>) {
        var added = false
        val currentNode = _ui.value.nodeUrl
        for (url in urls) {
            val clean = url.trim()
            if (clean.isBlank() || clean.contains("127.") || clean.contains("localhost")) continue
            if (clean == currentNode || backupPeers.contains(clean)) continue
            backupPeers.add(clean)
            added = true
        }
        if (added) viewModelScope.launch(Dispatchers.IO) { vault.knownPeers = backupPeers.joinToString(",") }
    }

    private fun scheduleReconnect() {
        if (reconnectScheduled) return
        reconnectScheduled = true
        viewModelScope.launch {
            delay(3000)
            reconnectScheduled = false
            if (!wantConnected || ws.status != WsClient.Status.DISCONNECTED) return@launch
            val w = wallet ?: return@launch
            failCount++
            val targetUrl = if (failCount > 3 && backupPeers.isNotEmpty()) {
                backupPeers[(failCount - 4) % backupPeers.size]
            } else {
                _ui.value.nodeUrl
            }
            appendLog(if (targetUrl == _ui.value.nodeUrl) "正在重连…" else "种子不可达，尝试备用节点…")
            ws.connect(targetUrl, w.address)
        }
    }

    // ---- 收到区块 ----
    private fun onBlocks(incoming: List<Block>) {
        val current = _ui.value.chain
        val merged = mergeChain(current, incoming)
        when (merged) {
            is Merge.Replace -> { setChain(merged.chain); appendLog("已同步至 #${merged.chain.last().index}") }
            is Merge.Append -> { setChain(merged.chain); appendLog("新块 #${merged.chain.last().index}") }
            Merge.NeedFull -> ws.requestChain()
            Merge.Ignore -> {}
        }
    }

    private sealed interface Merge {
        data class Replace(val chain: List<Block>) : Merge
        data class Append(val chain: List<Block>) : Merge
        data object NeedFull : Merge
        data object Ignore : Merge
    }

    private fun mergeChain(current: List<Block>, incoming: List<Block>): Merge {
        if (incoming.isEmpty()) return Merge.Ignore
        val isFull = incoming.first().index == 0L
        if (current.isEmpty()) {
            return if (isFull) Merge.Replace(incoming) else Merge.NeedFull
        }
        val currentTop = current.last().index
        val incomingTop = incoming.last().index
        if (isFull) {
            return if (incomingTop > currentTop) Merge.Replace(incoming) else Merge.Ignore
        }
        // 增量
        if (incomingTop <= currentTop) return Merge.Ignore
        val first = incoming.first()
        return if (first.index == currentTop + 1 && first.prevHash == current.last().hash) {
            Merge.Append(current + incoming)
        } else {
            Merge.NeedFull // 有缺口或分叉 → 重拉全链
        }
    }

    private fun setChain(chain: List<Block>) {
        // 清理已上链的待发交易
        if (pending.isNotEmpty()) {
            val onChain = HashSet<String>()
            for (b in chain) for (tx in b.transactions) onChain.add(tx.txid)
            pending.removeAll { it.txid in onChain }
        }
        _ui.update { it.copy(chain = chain) }
        recompute()
    }

    // ---- 重算派生状态 ----
    private fun recompute() {
        val w = wallet
        val chain = _ui.value.chain
        val state = computeState(chain)
        val msgs = parseMessages(chain)
        val names = parseNames(chain)
        val addr = w?.address ?: ""
        val balance = state.balanceOf(addr)
        val pendingOut = pending.sumOf { it.amount + it.fee + (it.burn ?: 0L) }
        val nextNonce = state.nonceOf(addr) + pending.size
        val txCount = chain.sumOf { it.transactions.size }
        val inbox = if (addr.isEmpty()) emptyList() else msgs.filter { it.to == addr }.map { messageView(it, addr, isInbox = true) }
        val outbox = if (addr.isEmpty()) emptyList() else msgs.filter { it.from == addr }.map { messageView(it, addr, isInbox = false) }
        _ui.update {
            it.copy(
                height = if (chain.isEmpty()) -1 else chain.last().index,
                balance = balance,
                available = balance - pendingOut,
                burned = state.burned,
                nextNonce = nextNonce,
                pendingCount = pending.size,
                txCount = txCount,
                inbox = inbox,
                outbox = outbox,
                newcomers = recentNewcomers(chain, 25),
                names = names,
                myName = if (addr.isEmpty()) null else names.nameFor(addr),
                listings = parseMarket(chain),
                redPackets = parseRedPackets(chain),
            )
        }
    }

    /** 一条消息的展示态：加密私信尝试用本钱包种子解密（收件→对方=from；发件→对方=to）。 */
    private fun messageView(m: ChainMessage, me: String, isInbox: Boolean): MessageView {
        val w = wallet
        if (!Encryption.isEncryptedMemo(m.text) || w == null) {
            return MessageView(m, encrypted = false, locked = false, plaintext = m.text)
        }
        val other = if (isInbox) m.from else m.to
        val pt = Encryption.decryptMemo(m.text, other, w.seed)
        return MessageView(m, encrypted = true, locked = pt == null, plaintext = pt)
    }

    private fun recentNewcomers(chain: List<Block>, limit: Int): List<Newcomer> {
        val firstSeen = LinkedHashMap<String, Long>()
        for (b in chain) for (tx in b.transactions) {
            for (a in listOf(tx.from, tx.to)) {
                if (a == NULL_ADDRESS || a == RED_ESCROW_ADDRESS) continue
                if (a !in firstSeen) firstSeen[a] = b.index
            }
        }
        return firstSeen.entries
            .sortedByDescending { it.value }
            .take(limit)
            .map { Newcomer(it.key, it.value) }
    }

    // ---- 发送 ----
    fun sendTransfer(toRaw: String, amountStr: String, feeStr: String, memo: String) {
        val w = wallet ?: return emit("请先创建钱包")
        val to = toRaw.trim()
        if (!isValidAddress(to)) return emit("收款地址格式无效（应为 0x + 64 hex）")
        if (to == NULL_ADDRESS) return emit("不能向虚空地址转账")
        val amount = amountStr.trim().toLongOrNull()
        if (amount == null || amount < 1) return emit("金额必须是 ≥1 的整数")
        val fee = feeStr.trim().toLongOrNull()
        if (fee == null || fee < MIN_FEE) return emit("手续费至少为 $MIN_FEE")
        if (memo.codePointCount() > MAX_MEMO) return emit("备注最多 $MAX_MEMO 个字符")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        val need = amount + fee
        if (need > _ui.value.available) return emit("余额不足：可用 ${_ui.value.available}，需要 $need")

        val tx = signTransaction(w, to, amount, _ui.value.nextNonce, memo, fee, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx)
            recompute()
            emit("已广播转账，txid ${tx.txid.take(12)}…")
        } else {
            emit("广播失败：连接不可用")
        }
    }

    fun sendMessage(toRaw: String, text: String, burnStr: String, feeStr: String, encrypt: Boolean = false) {
        val w = wallet ?: return emit("请先创建钱包")
        val to = toRaw.trim()
        if (!isValidAddress(to)) return emit("收件地址格式无效（应为 0x + 64 hex）")
        if (to == NULL_ADDRESS) return emit("不能向虚空地址发消息")
        if (text.isBlank()) return emit("消息正文不能为空")
        // 明文上限与 web 一致（128 码点）；加密密文上链可用到 MAX_MEMO（512）。
        if (text.codePointCount() > PLAIN_TEXT_LIMIT) return emit("正文最多 $PLAIN_TEXT_LIMIT 个字符")
        val burn = burnStr.trim().toLongOrNull()
        if (burn == null || burn < 1) return emit("销毁额必须是 ≥1 的整数")
        val fee = feeStr.trim().toLongOrNull()
        if (fee == null || fee < MIN_FEE) return emit("手续费至少为 $MIN_FEE")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")

        // 加密：明文 → ENC|<密文> memo（端到端，只有收发双方能解）。
        val memo = if (encrypt) {
            Encryption.encryptMemo(text, to, w.seed) ?: return emit("加密失败：收件地址无效")
        } else {
            text
        }
        if (memo.codePointCount() > MAX_MEMO) return emit("密文过长（上限 $MAX_MEMO 码点）")

        val need = burn + fee
        if (need > _ui.value.available) return emit("余额不足：可用 ${_ui.value.available}，需要 $need（烧 $burn + 手续费 $fee）")

        val tx = signMessage(w, to, memo, _ui.value.nextNonce, burn, fee, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx)
            recompute()
            val tag = if (encrypt) "🔒加密消息" else "消息"
            emit("已广播$tag，烧掉 $burn ${SYMBOL}，txid ${tx.txid.take(12)}…")
        } else {
            emit("广播失败：连接不可用")
        }
    }

    fun claimName(nameRaw: String) {
        val w = wallet ?: return emit("请先创建钱包")
        val name = nameRaw.trim().lowercase()
        val reserved = setOf("treasury","official","admin","system","null","v0id","v0idchain","genesis","coinbase")
        val nameRegex = Regex("^[a-z0-9_-]{1,20}$")
        if (!nameRegex.matches(name) || name.startsWith("0x") || name in reserved)
            return emit("昵称无效：1~20 位小写字母/数字/_/-，不能用保留名")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        if (_ui.value.available < 2) return emit("余额不足：抢注需 2 $SYMBOL（自转 1 + 手续费 $MIN_FEE）")
        val tx = signTransaction(w, w.address, 1L, _ui.value.nextNonce, "NAME|$name", MIN_FEE, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx)
            recompute()
            emit("已广播抢注 @$name，先到先得，txid ${tx.txid.take(12)}…")
        } else {
            emit("广播失败：连接不可用")
        }
    }

    // ---- 集市（MKT/BUY/DEL，余额走普通转账）----
    /** 上架：自转 1 $V0ID + memo MKT|<价格>|<标题>。 */
    fun listItem(priceStr: String, title: String) {
        val w = wallet ?: return emit("请先创建钱包")
        val price = priceStr.trim().toLongOrNull()
        if (price == null || price <= 0) return emit("价格必须是正整数")
        val (memo, err) = makeListing(price, title)
        if (memo == null) return emit(err ?: "标题无效")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        if (_ui.value.available < 1 + MIN_FEE) return emit("余额不足：上架需 ${1 + MIN_FEE} $SYMBOL（自转 1 + 手续费 $MIN_FEE）")
        val tx = signTransaction(w, w.address, 1L, _ui.value.nextNonce, memo, MIN_FEE, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx); recompute()
            emit("已上架「$title」标价 $price $SYMBOL，txid ${tx.txid.take(12)}…")
        } else emit("广播失败：连接不可用")
    }

    /** 购买：付款给卖家（amount=标价）+ memo BUY|<上架txid>。 */
    fun buyItem(listing: Listing) {
        val w = wallet ?: return emit("请先创建钱包")
        if (listing.seller == w.address) return emit("不能购买自己上架的商品")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        val need = listing.price + MIN_FEE
        if (need > _ui.value.available) return emit("余额不足：可用 ${_ui.value.available}，需要 $need（货款 ${listing.price} + 手续费 $MIN_FEE）")
        val tx = signTransaction(w, listing.seller, listing.price, _ui.value.nextNonce, "${BUY_PREFIX}${listing.id}", MIN_FEE, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx); recompute()
            emit("已下单「${listing.title}」付 ${listing.price} $SYMBOL，txid ${tx.txid.take(12)}…")
        } else emit("广播失败：连接不可用")
    }

    /** 撤单：自转 1 $V0ID + memo DEL|<上架txid>（仅卖家本人）。 */
    fun delistItem(listing: Listing) {
        val w = wallet ?: return emit("请先创建钱包")
        if (listing.seller != w.address) return emit("只有卖家本人能撤单")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        if (_ui.value.available < 1 + MIN_FEE) return emit("余额不足：撤单需 ${1 + MIN_FEE} $SYMBOL")
        val tx = signTransaction(w, w.address, 1L, _ui.value.nextNonce, "${DEL_PREFIX}${listing.id}", MIN_FEE, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx); recompute()
            emit("已撤单「${listing.title}」，txid ${tx.txid.take(12)}…")
        } else emit("广播失败：连接不可用")
    }

    // ---- 红包（RED/CLAIM/REFUND，托管 + 条件支付）----
    /** 发红包：转给托管地址 amount=总额 + memo RED|<份数>|<r|e>。 */
    fun sendRedPacket(totalStr: String, countStr: String, mode: RedMode) {
        val w = wallet ?: return emit("请先创建钱包")
        val total = totalStr.trim().toLongOrNull()
        val count = countStr.trim().toIntOrNull()
        if (total == null || count == null) return emit("总额与份数都必须是整数")
        val (memo, err) = makeRedPacket(total, count, mode)
        if (memo == null) return emit(err ?: "红包参数无效")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        val need = total + MIN_FEE
        if (need > _ui.value.available) return emit("余额不足：可用 ${_ui.value.available}，需要 $need（红包 $total + 手续费 $MIN_FEE）")
        val tx = signTransaction(w, RED_ESCROW_ADDRESS, total, _ui.value.nextNonce, memo, MIN_FEE, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx); recompute()
            emit("已发出 $count 份红包共 $total $SYMBOL，txid ${tx.txid.take(12)}…")
        } else emit("广播失败：连接不可用")
    }

    /** 抢红包：自转 amount=0 + memo CLAIM|<红包id>（入账由共识从托管池支付）。 */
    fun claimRedPacket(rp: RedPacketView) {
        val w = wallet ?: return emit("请先创建钱包")
        if (rp.creator == w.address) return emit("不能抢自己发的红包")
        if (rp.done) return emit("红包已抢完或已退款")
        if (rp.claims.any { it.who == w.address }) return emit("你已经抢过这个红包了")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        if (_ui.value.available < MIN_FEE) return emit("余额不足：抢红包需付手续费 $MIN_FEE")
        // amount=0、burn=0、memo=CLAIM|<id>：共识允许此零额操作。
        val tx = signTransaction(w, w.address, 0L, _ui.value.nextNonce, "${CLAIM_PREFIX}${rp.id}", MIN_FEE, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx); recompute()
            emit("已抢红包，金额由所在区块敲定，txid ${tx.txid.take(12)}…")
        } else emit("广播失败：连接不可用")
    }

    /** 退款：自转 amount=0 + memo REFUND|<红包id>（仅发起人，过期后取回剩余）。 */
    fun refundRedPacket(rp: RedPacketView) {
        val w = wallet ?: return emit("请先创建钱包")
        if (rp.creator != w.address) return emit("只有发起人能退款")
        if (rp.done) return emit("红包已抢完或已退款")
        val expireAt = rp.createHeight + RED_EXPIRY
        if (_ui.value.height < expireAt) return emit("未到退款高度：需到 #$expireAt（当前 #${_ui.value.height}）")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        if (_ui.value.available < MIN_FEE) return emit("余额不足：退款需付手续费 $MIN_FEE")
        val tx = signTransaction(w, w.address, 0L, _ui.value.nextNonce, "${REFUND_PREFIX}${rp.id}", MIN_FEE, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx); recompute()
            emit("已申请退款，取回剩余 ${rp.remaining} $SYMBOL，txid ${tx.txid.take(12)}…")
        } else emit("广播失败：连接不可用")
    }

    // ---- 逛链搜索 ----
    fun search(query: String): SearchResult {
        val q = query.trim()
        if (q.isEmpty()) return SearchResult.Empty
        val chain = _ui.value.chain
        if (chain.isEmpty()) return SearchResult.NotFound

        // 区块号
        if (q.all { it.isDigit() }) {
            val idx = q.toLongOrNull() ?: return SearchResult.NotFound
            val b = chain.firstOrNull { it.index == idx } ?: return SearchResult.NotFound
            return SearchResult.BlockHit(b)
        }
        // 地址
        if (isValidAddress(q)) {
            val state = computeState(chain)
            val txs = ArrayList<Pair<Long, Transaction>>()
            for (b in chain) for (tx in b.transactions) {
                if (tx.from == q || tx.to == q) txs.add(b.index to tx)
            }
            txs.reverse()
            return SearchResult.AddressHit(q, state.balanceOf(q), state.nonceOf(q), txs)
        }
        // txid（64 hex）
        if (q.length == 64 && q.all { it.isHexDigit() }) {
            for (b in chain) for (tx in b.transactions) {
                if (tx.txid == q) return SearchResult.TxHit(b.index, tx)
            }
            return SearchResult.NotFound
        }
        return SearchResult.NotFound
    }

    // ---- 自检 ----
    fun runDiagnostics() {
        val r = runSelfTest()
        _ui.update { it.copy(selfTest = r) }
        emit(if (r.allGreen) "金标准向量自检全绿 ✅" else "自检未通过 ❌")
    }

    // ---- 工具 ----
    private fun appendLog(msg: String) {
        _ui.update { it.copy(log = msg) }
    }

    private fun emit(msg: String) {
        events.tryEmit(msg)
    }

    private fun String.codePointCount(): Int = codePointCount(0, length)
    private fun Char.isHexDigit(): Boolean =
        this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

    override fun onCleared() {
        ws.disconnect()
        super.onCleared()
    }
}
