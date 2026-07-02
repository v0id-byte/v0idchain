package com.v0id.wallet.data

import android.content.Context
import com.v0id.wallet.core.Block
import com.v0id.wallet.core.verifyChainLink
import com.v0id.wallet.net.ChainCodec
import org.json.JSONArray
import java.io.File

/**
 * 本地已同步区块的落盘缓存：App 重开（冷启动/被系统杀后台再拉起）不用每次都问节点要整条链，
 * 只读本地缓存的链尾高度，向节点补拉缺口（QUERY_BLOCK_RANGE）。
 *
 * 存内部私有文件（非 EncryptedSharedPreferences）：链数据体量可能较大，SharedPreferences 不适合，
 * 且链本身不含私钥等敏感信息，不需要加密——完整性由读回时的哈希链校验保证（防篡改/损坏）。
 */
class ChainCache(context: Context) {
    private val file = File(context.filesDir, "chain-cache.json")

    /** 读本地缓存的链；文件不存在/损坏/哈希链校验不过 → 视为空缓存（调用方退回整链同步）。 */
    fun load(): List<Block> {
        if (!file.exists()) return emptyList()
        return try {
            val arr = JSONArray(file.readText())
            val blocks = ChainCodec.parseBlocks(arr)
            if (verifyChainLink(blocks, afterIndex = -1, tipHash = "")) blocks else emptyList()
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun save(chain: List<Block>) {
        try {
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(ChainCodec.blocksToJson(chain).toString())
            tmp.renameTo(file) // 原子替换，避免写到一半被杀进程留半个文件
        } catch (e: Exception) {
            // 落盘失败不致命：下次重开退回整链同步，故意静默。
        }
    }
}
