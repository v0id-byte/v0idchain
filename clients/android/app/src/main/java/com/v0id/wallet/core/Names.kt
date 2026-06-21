package com.v0id.wallet.core

/**
 * 链上昵称（全网唯一抢注，先到先得）：建在“自转 + memo `NAME|<名字>`”之上，不改共识。
 * 对应 packages/core/src/names.ts —— 解析规则必须一致（先到先得 + 读端小写规范化）。
 */
data class NameRegistry(
    /** 名字 → 首位抢到者地址（永久绑定，先到先得）。 */
    val nameToOwner: Map<String, String>,
    /** 地址 → 当前显示名（= 最近一次成功拥有的名字）。 */
    val addressToName: Map<String, String>,
) {
    /** 地址 → 显示名（没有则 null）。 */
    fun nameFor(address: String): String? = addressToName[address]
}

private val NAME_REGEX = Regex("^[a-z0-9_-]{1,20}$")

/** 1~20 位小写字母/数字/下划线/连字符；不以 0x 开头；非保留名。入参应已小写。 */
fun isValidName(name: String): Boolean {
    if (name.startsWith("0x") || name in RESERVED_NAMES) return false
    return NAME_REGEX.matches(name)
}

fun buildNameMemo(name: String): String = NAME_PREFIX + name

/** 校验并规范化（trim+小写）抢注名；返回 memo 或错误。 */
fun makeNameClaim(raw: String): Pair<String?, String?> {
    val n = raw.trim().lowercase()
    if (n in RESERVED_NAMES) return null to "“$n” 是保留名，禁止抢注"
    if (!isValidName(n)) return null to "昵称需 1~$MAX_NAME 位 小写字母/数字/_/-，且不以 0x 开头"
    val memo = buildNameMemo(n)
    if (memo.codePointCount(0, memo.length) > MAX_MEMO) return null to "昵称过长"
    return memo to null
}

/** 扫整条链还原昵称注册表（先到先得；同一地址可改名）。纯函数 → reorg 安全。 */
fun parseNames(chain: List<Block>): NameRegistry {
    val nameToOwner = HashMap<String, String>()
    val addressToName = HashMap<String, String>()
    for (b in chain) {
        for (tx in b.transactions) {
            val m = tx.memo
            if (!m.startsWith(NAME_PREFIX)) continue
            if (tx.from != tx.to) continue              // 抢注必须是自转
            if ((tx.burn ?: 0L) != 0L) continue         // 排除“自发消息”
            val name = m.substring(NAME_PREFIX.length).trim().lowercase()
            if (!isValidName(name)) continue
            val owner = nameToOwner[name]
            if (owner != null && owner != tx.from) continue   // 已被别人抢走
            if (owner == null) nameToOwner[name] = tx.from     // 第一笔抢注者永久拥有
            addressToName[tx.from] = name                      // 本人最新抢注 → 显示名
        }
    }
    return NameRegistry(nameToOwner, addressToName)
}
