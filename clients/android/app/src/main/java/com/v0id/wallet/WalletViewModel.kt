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
    val inbox: List<ChainMessage> = emptyList(),
    val outbox: List<ChainMessage> = emptyList(),
    val newcomers: List<Newcomer> = emptyList(),
    val log: String = "",
    val selfTest: SelfTestResult? = null,
)

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
        val addr = w?.address ?: ""
        val balance = state.balanceOf(addr)
        val pendingOut = pending.sumOf { it.amount + it.fee + (it.burn ?: 0L) }
        val nextNonce = state.nonceOf(addr) + pending.size
        val txCount = chain.sumOf { it.transactions.size }
        _ui.update {
            it.copy(
                height = if (chain.isEmpty()) -1 else chain.last().index,
                balance = balance,
                available = balance - pendingOut,
                burned = state.burned,
                nextNonce = nextNonce,
                pendingCount = pending.size,
                txCount = txCount,
                inbox = if (addr.isEmpty()) emptyList() else msgs.filter { m -> m.to == addr },
                outbox = if (addr.isEmpty()) emptyList() else msgs.filter { m -> m.from == addr },
                newcomers = recentNewcomers(chain, 25),
            )
        }
    }

    private fun recentNewcomers(chain: List<Block>, limit: Int): List<Newcomer> {
        val firstSeen = LinkedHashMap<String, Long>()
        for (b in chain) for (tx in b.transactions) {
            for (a in listOf(tx.from, tx.to)) {
                if (a == NULL_ADDRESS) continue
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

    fun sendMessage(toRaw: String, text: String, burnStr: String, feeStr: String) {
        val w = wallet ?: return emit("请先创建钱包")
        val to = toRaw.trim()
        if (!isValidAddress(to)) return emit("收件地址格式无效（应为 0x + 64 hex）")
        if (to == NULL_ADDRESS) return emit("不能向虚空地址发消息")
        if (text.isBlank()) return emit("消息正文不能为空")
        if (text.codePointCount() > MAX_MEMO) return emit("正文最多 $MAX_MEMO 个字符")
        val burn = burnStr.trim().toLongOrNull()
        if (burn == null || burn < 1) return emit("销毁额必须是 ≥1 的整数")
        val fee = feeStr.trim().toLongOrNull()
        if (fee == null || fee < MIN_FEE) return emit("手续费至少为 $MIN_FEE")
        if (ws.status != WsClient.Status.CONNECTED) return emit("未连接节点，无法广播")
        val need = burn + fee
        if (need > _ui.value.available) return emit("余额不足：可用 ${_ui.value.available}，需要 $need（烧 $burn + 手续费 $fee）")

        val tx = signMessage(w, to, text, _ui.value.nextNonce, burn, fee, System.currentTimeMillis())
        if (ws.broadcastTx(tx)) {
            pending.add(tx)
            recompute()
            emit("已广播消息，烧掉 $burn ${SYMBOL}，txid ${tx.txid.take(12)}…")
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
