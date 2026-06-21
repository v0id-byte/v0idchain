package com.v0id.wallet.net

import com.v0id.wallet.core.Block
import com.v0id.wallet.core.Transaction
import org.json.JSONArray
import org.json.JSONObject

/**
 * 链/交易的 JSON 编解码。
 *
 * 关键洞见：节点收到我们的 TX 后会**用字段值重算 txid**（payloadHash），再与我们带上的 txid/签名比对。
 * 所以**线上 JSON 的转义无需匹配**我们手写的 JsonStringify —— 只要字段值经 JSON 往返不变（必然不变），
 * 节点就会算出同一个 txid。手写序列化器只用于本地算 txid/签名，不用于线缆格式。
 */
object ChainCodec {

    fun parseBlocks(arr: JSONArray): List<Block> {
        val blocks = ArrayList<Block>(arr.length())
        for (i in 0 until arr.length()) blocks.add(parseBlock(arr.getJSONObject(i)))
        return blocks
    }

    fun parseBlock(o: JSONObject): Block {
        val ta = o.getJSONArray("transactions")
        val txs = ArrayList<Transaction>(ta.length())
        for (i in 0 until ta.length()) txs.add(parseTx(ta.getJSONObject(i)))
        return Block(
            index = o.getLong("index"),
            timestamp = o.getLong("timestamp"),
            prevHash = o.getString("prevHash"),
            transactions = txs,
            merkleRoot = o.getString("merkleRoot"),
            difficulty = o.getLong("difficulty"),
            nonce = o.getLong("nonce"),
            miner = o.getString("miner"),
            hash = o.getString("hash"),
        )
    }

    fun parseTx(o: JSONObject): Transaction {
        val burn = if (o.has("burn") && !o.isNull("burn")) o.getLong("burn") else null
        return Transaction(
            from = o.getString("from"),
            to = o.getString("to"),
            amount = o.getLong("amount"),
            fee = o.getLong("fee"),
            nonce = o.getLong("nonce"),
            timestamp = o.getLong("timestamp"),
            memo = o.optString("memo", ""),
            burn = burn,
            signature = o.optString("signature", ""),
            txid = o.getString("txid"),
        )
    }

    /** 交易 → JSON。burn 仅在 >0 时写入（与 packages/core 一致：普通转账无 burn 字段）。 */
    fun txToJson(tx: Transaction): JSONObject {
        val o = JSONObject()
        o.put("from", tx.from)
        o.put("to", tx.to)
        o.put("amount", tx.amount)
        o.put("fee", tx.fee)
        o.put("nonce", tx.nonce)
        o.put("timestamp", tx.timestamp)
        o.put("memo", tx.memo)
        if ((tx.burn ?: 0L) > 0L) o.put("burn", tx.burn)
        o.put("signature", tx.signature)
        o.put("txid", tx.txid)
        return o
    }
}
