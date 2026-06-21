package com.v0id.wallet.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily

// 克制的中性配色 + 单一靛蓝强调色，跟随系统亮/暗。不堆品牌色——内容优先（仿 iOS 系统观感）。

private val LightScheme = lightColorScheme(
    primary = Color(0xFF4C53D4),
    onPrimary = Color.White,
    secondary = Color(0xFF5B6470),
    background = Color(0xFFF7F7FA),
    onBackground = Color(0xFF1A1A1F),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF1A1A1F),
    surfaceVariant = Color(0xFFEFEFF4),       // 分组卡片底
    onSurfaceVariant = Color(0xFF6C6C78),     // 次级文字
    outlineVariant = Color(0xFFE2E2EA),
    error = Color(0xFFD0463B),
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFFB7BCFF),
    onPrimary = Color(0xFF20243F),
    secondary = Color(0xFF9AA0AC),
    background = Color(0xFF0D0D11),
    onBackground = Color(0xFFECECF1),
    surface = Color(0xFF131318),
    onSurface = Color(0xFFECECF1),
    surfaceVariant = Color(0xFF1B1B22),       // 分组卡片底
    onSurfaceVariant = Color(0xFF9A9AA6),     // 次级文字
    outlineVariant = Color(0xFF2A2A33),
    error = Color(0xFFFF8B80),
)

/** 语义状态色（连接状态点 / 烧币）——M3 配色里没有，单独给。 */
data class StatusColors(
    val online: Color,
    val pending: Color,
    val burn: Color,
)

val LocalStatus = staticCompositionLocalOf {
    StatusColors(online = Color(0xFF34B27B), pending = Color(0xFFD9962B), burn = Color(0xFFE0762E))
}

/** 等宽——地址 / 哈希 / 技术数值统一用。 */
val Mono = TextStyle(fontFamily = FontFamily.Monospace)

@Composable
fun V0idTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    MaterialTheme(
        colorScheme = if (dark) DarkScheme else LightScheme,
        content = content,
    )
}
