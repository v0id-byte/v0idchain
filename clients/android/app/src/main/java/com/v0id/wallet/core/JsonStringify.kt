package com.v0id.wallet.core

/**
 * 逐字节复刻 ECMA-262 `JSON.stringify`（仅针对 txid 预映像所需的 [字符串 / 整数] 数组），见 CLIENT-PROTOCOL §3.2。
 *
 * 为什么手写而不用通用 JSON 库：各家库的转义、空格、数字格式各不相同，差一个字节 txid 就变了、
 * 签出来的交易全网校验不过被直接丢弃。这里严格只做规范允许的转义。
 *
 * 注意（与 JS 的 UTF-16 行为对齐）：Kotlin String 与 JS String 一样是 UTF-16。逐 `Char`（UTF-16 码元）遍历，
 * 非控制字符（含中文、emoji 的代理对两个码元）原样输出；最终整串按 UTF-8 编码 —— 与 JSON.stringify 结果逐字节一致。
 *
 * 转义规则（且仅这些）：" → \" ，\ → \\ ，U+0008 → \b ，U+0009 → \t ，U+000A → \n ，
 * U+000C → \f ，U+000D → \r ，其余 U+0000–U+001F → \u00xx（小写）。其它一律原样，不转义 '/'。
 */
object JsonStringify {
    fun array(items: List<Any>): String {
        val sb = StringBuilder()
        sb.append('[')
        for ((i, item) in items.withIndex()) {
            if (i > 0) sb.append(',')
            when (item) {
                is String -> encodeString(item, sb)
                is Long -> sb.append(item.toString())   // 整数 → 纯十进制
                is Int -> sb.append(item.toString())
                else -> throw IllegalArgumentException("不支持的 JSON 值类型：${item::class}")
            }
        }
        sb.append(']')
        return sb.toString()
    }

    // 用整数码点匹配，避免在源码里写不可见的控制字符字面量（Kotlin 也无 '\f' 转义）。
    private fun encodeString(s: String, sb: StringBuilder) {
        sb.append('"')
        for (c in s) {
            when (val code = c.code) {
                0x22 -> sb.append("\\\"")   // "
                0x5C -> sb.append("\\\\")   // \
                0x08 -> sb.append("\\b")
                0x09 -> sb.append("\\t")
                0x0A -> sb.append("\\n")
                0x0C -> sb.append("\\f")
                0x0D -> sb.append("\\r")
                else ->
                    if (code < 0x20) {
                        sb.append("\\u")
                        sb.append(code.toString(16).padStart(4, '0'))
                    } else {
                        sb.append(c)
                    }
            }
        }
        sb.append('"')
    }
}
