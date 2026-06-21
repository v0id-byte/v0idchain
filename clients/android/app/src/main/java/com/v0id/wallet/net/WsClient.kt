package com.v0id.wallet.net

import com.v0id.wallet.core.Block
import com.v0id.wallet.core.Transaction
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
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
        .build()

    private var ws: WebSocket? = null
    private var myAddress: String = ""

    @Volatile var status: Status = Status.DISCONNECTED
        private set

    @Volatile private var userClosed = false

    fun connect(url: String, address: String) {
        userClosed = false
        myAddress = address
        setStatus(Status.CONNECTING)
        val httpUrl = url.trim()
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
                    .put("listen", "light://$myAddress")
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
            if (!userClosed) onLog("连接断开：${t.message ?: "未知错误"}")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            setStatus(Status.DISCONNECTED)
        }
    }
}
