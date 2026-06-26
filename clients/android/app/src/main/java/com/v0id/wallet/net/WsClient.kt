package com.v0id.wallet.net

import com.v0id.wallet.core.Block
import com.v0id.wallet.core.Transaction
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.Proxy
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * 轻客户端的纯出站 WebSocket（CLIENT-PROTOCOL §6）。不开 WS 服务器。
 * 连上后：发 HELLO（height=0）+ QUERY_ALL → 收 BLOCKS（整链）→ 上层算余额/nonce；
 * 之后持续监听增量 BLOCKS；广播自己的 TX。
 *
 * 自动重连：连接失败/断开后（非用户主动断开）由上层 ViewModel 调度重连。
 */
class WsClient(
    private val onBlocks: (List<Block>) -> Unit,
    private val onStatus: (Status) -> Unit,
    private val onLog: (String) -> Unit,
    private val onPeers: (List<String>) -> Unit = {},
) {
    enum class Status { DISCONNECTED, CONNECTING, CONNECTED }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)     // 保活
        .readTimeout(0, TimeUnit.MILLISECONDS)  // WS 长连，不超时
        .connectTimeout(15, TimeUnit.SECONDS)
        // 绕过系统代理（Clash/VPN 等）：OkHttp 默认走 ProxySelector.getDefault()，会把 ws:// 长连
        // 送进代理隧道，代理一抖就断。直连节点更可靠（同 macOS/iOS 客户端的处置）。
        .proxy(Proxy.NO_PROXY)
        .build()

    private var ws: WebSocket? = null
    private var myAddress: String = ""
    // 每条连接唯一的 HELLO listen 后缀：节点端按 listen 给连接判重（p2p.ts），同一客户端
    // 自动重连时若沿用旧 listen，可能与服务端尚未清理的陈旧连接对撞被踢 → 永久抖动。
    private var connToken: String = ""

    @Volatile var status: Status = Status.DISCONNECTED
        private set

    @Volatile private var userClosed = false
    // true = 正在连接 bootstrap 种子；false = fallback gossip peer。
    // gossip peer 失败是正常 P2P 现象（TUN 代理下死 peer 握手被代理接管 → HTTP 502/504），不上报日志。
    @Volatile private var isBootstrap = true

    fun connect(url: String, address: String, isBootstrap: Boolean = true) {
        this.isBootstrap = isBootstrap
        userClosed = false
        myAddress = address
        connToken = UUID.randomUUID().toString().take(8)   // 本次连接唯一，避免 listen 自我对撞
        setStatus(Status.CONNECTING)
        val trimmed = url.trim()
        // 强制 ws:// 或 wss:// scheme：否则 replaceFirst 对 http://attacker 或裸 host 不生效，
        // OkHttp 会照单全收连上非节点地址（钓鱼）。这里在网络层兜底拦截（setNodeUrl 已先校验一道）。
        if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
            onLog("地址无效（需 ws:// 或 wss://）：$url")
            setStatus(Status.DISCONNECTED)
            return
        }
        val httpUrl = trimmed
            .replaceFirst("ws://", "http://")
            .replaceFirst("wss://", "https://")
        val req = try {
            Request.Builder().url(httpUrl).build()
        } catch (e: Exception) {
            onLog("地址无效：$url")
            setStatus(Status.DISCONNECTED)
            return
        }
        ws = client.newWebSocket(req, listener)
    }

    fun disconnect() {
        userClosed = true
        ws?.close(1000, "bye")
        ws = null
        setStatus(Status.DISCONNECTED)
    }

    /** 主动重新拉全链（用户下拉刷新 / 检测到分叉时）。 */
    fun requestChain() {
        ws?.send(JSONObject().put("type", "QUERY_ALL").toString())
    }

    /** 广播一笔本地签名的交易。返回是否已写入发送队列。 */
    fun broadcastTx(tx: Transaction): Boolean {
        val sock = ws ?: return false
        val msg = JSONObject().put("type", "TX").put("tx", ChainCodec.txToJson(tx))
        return sock.send(msg.toString())
    }

    val isUserClosed: Boolean get() = userClosed

    private fun setStatus(s: Status) {
        status = s
        onStatus(s)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            setStatus(Status.CONNECTED)
            // 自报家门（height=0：不被回拨也无所谓）+ 要整条链 + 问邻居
            webSocket.send(
                JSONObject()
                    .put("type", "HELLO")
                    .put("address", myAddress)
                    .put("height", 0)
                    .put("listen", "light://$myAddress/$connToken")
                    .toString(),
            )
            webSocket.send(JSONObject().put("type", "QUERY_ALL").toString())
            webSocket.send(JSONObject().put("type", "QUERY_PEERS").toString())
            onLog("已连接，正在同步全链…")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            try {
                val o = JSONObject(text)
                when (o.optString("type")) {
                    "BLOCKS" -> {
                        val arr = o.optJSONArray("blocks") ?: return
                        val blocks = ChainCodec.parseBlocks(arr)
                        if (blocks.isNotEmpty()) onBlocks(blocks)
                    }
                    "PEERS" -> {
                        val arr = o.optJSONArray("peers") ?: return
                        val urls = (0 until arr.length()).mapNotNull { i -> arr.optString(i).takeIf { it.isNotBlank() } }
                        if (urls.isNotEmpty()) onPeers(urls)
                    }
                }
            } catch (e: Exception) {
                onLog("解析消息失败：${e.message}")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            setStatus(Status.DISCONNECTED)
            // gossip peer 失败属正常 P2P 现象（TUN 下死 peer 握手被代理接管 → HTTP 502/504），不上报日志；
            // bootstrap 种子失败才是真错误（配置写死的节点，必须可达）。
            if (!userClosed && isBootstrap) onLog("连接断开：${t.message ?: "未知错误"}")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            setStatus(Status.DISCONNECTED)
        }
    }
}
