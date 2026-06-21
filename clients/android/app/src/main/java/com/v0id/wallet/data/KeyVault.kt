package com.v0id.wallet.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 私钥安全存储：主密钥放 Android Keystore（硬件支持时不可导出），私钥落地用 AES-256-GCM 加密
 * （EncryptedSharedPreferences）。节点 URL 等非敏感配置一并放这里，简单起见。
 *
 * 为何不直接用 Keystore 存 ed25519：Keystore 的密钥不可导出、且其 ed25519 签名跨 API 等级行为不一，
 * 无法保证拿到与 RFC8032 参考实现逐字节一致的原始签名。故采用“自管 32 字节种子 + Keystore 加密落地”的标准模式
 * （规范明确允许 Keystore 或 EncryptedSharedPreferences）。
 */
class KeyVault(context: Context) {

    private val prefs = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "v0id_wallet_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun hasWallet(): Boolean = prefs.contains(KEY_PRIV)

    fun savePrivateKeyHex(hex: String) {
        prefs.edit().putString(KEY_PRIV, hex).apply()
    }

    fun loadPrivateKeyHex(): String? = prefs.getString(KEY_PRIV, null)

    fun clearWallet() {
        prefs.edit().remove(KEY_PRIV).apply()
    }

    var nodeUrl: String
        get() = prefs.getString(KEY_NODE, null) ?: ""
        set(value) {
            prefs.edit().putString(KEY_NODE, value).apply()
        }

    /** gossip 学到的备用节点地址，逗号分隔（同 Bitcoin peers.dat）。 */
    var knownPeers: String
        get() = prefs.getString(KEY_PEERS, null) ?: ""
        set(value) {
            prefs.edit().putString(KEY_PEERS, value).apply()
        }

    companion object {
        private const val KEY_PRIV = "private_key_hex"
        private const val KEY_NODE = "node_url"
        private const val KEY_PEERS = "known_peers"
    }
}
