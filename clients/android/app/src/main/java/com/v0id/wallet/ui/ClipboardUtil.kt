package com.v0id.wallet.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle

/**
 * 复制敏感内容（私钥）到系统剪贴板：
 * - API 33+ 打 EXTRA_IS_SENSITIVE → 系统剪贴板预览不明文显示内容；
 * - 60s 后自动清空（仅当剪贴板仍是我们写入的内容，避免误清用户之后复制的东西）。
 * 普通地址/txid 仍走 Compose 的 LocalClipboardManager（不过期，方便粘贴）。
 */
fun copySensitiveToClipboard(context: Context, label: String, text: String, ttlMs: Long = 60_000) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText(label, text)
    if (Build.VERSION.SDK_INT >= 33) {
        clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
    }
    cm.setPrimaryClip(clip)
    Handler(Looper.getMainLooper()).postDelayed({
        val current = runCatching { cm.primaryClip?.getItemAt(0)?.text?.toString() }.getOrNull()
        if (current == text) {
            if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip()
            else cm.setPrimaryClip(ClipData.newPlainText("", ""))
        }
    }, ttlMs)
}
