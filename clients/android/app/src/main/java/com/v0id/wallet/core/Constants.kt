package com.v0id.wallet.core

/** 普通转账最低手续费（gas）。 */
const val MIN_FEE = 1L

/** 链上消息默认销毁额（烧进虚空的 $V0ID）。 */
const val MESSAGE_BURN = 5L

/** 备注 / 消息正文最大长度（Unicode 码点）。128→512：容纳端到端加密私信的密文。与 packages/core MAX_MEMO 一致。 */
const val MAX_MEMO = 512

/** 普通明文消息/备注的 UI 输入上限（与 web 一致）；加密密文可用到 MAX_MEMO。 */
const val PLAIN_TEXT_LIMIT = 128

/** 代币符号。 */
const val SYMBOL = "\$V0ID"

// ───── 链上昵称（NAME| 自转 memo，先到先得；纯约定，不改共识）─────
const val NAME_PREFIX = "NAME|"
const val MAX_NAME = 20
/** 保留名：禁止抢注，防冒充“央行/官方/系统”。 */
val RESERVED_NAMES = setOf(
    "treasury", "official", "admin", "system", "null", "v0id", "v0idchain", "genesis", "coinbase",
)

// ───── 集市（MKT/BUY/DEL 转账 memo；纯约定，余额走普通转账）─────
const val MKT_PREFIX = "MKT|"
const val BUY_PREFIX = "BUY|"
const val DEL_PREFIX = "DEL|"
const val MAX_TITLE = 100

// ───── 链上红包（共识级托管 + 条件支付）─────
/** 红包托管地址：发红包时锁定的总额记到这里（不可花）。与 NULL 区分，便于审计。 */
const val RED_ESCROW_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000001"
const val RED_PREFIX = "RED|"        // 发红包：RED|<份数>|<r|e>
const val CLAIM_PREFIX = "CLAIM|"    // 抢红包：CLAIM|<红包txid>
const val REFUND_PREFIX = "REFUND|"  // 退款：REFUND|<红包txid>（仅发起人、且过期后）
const val MAX_RED_COUNT = 100
/** 红包过期块数：创建后再过这么多块仍没抢完，发起人可退款。 */
const val RED_EXPIRY = 10

// ───── 端到端加密私信（ENC| 密文上链；仍是 amount0+burn 消息）─────
const val ENC_PREFIX = "ENC|"

/** 默认公网种子节点（明文 ws://，长期方向是 wss://）。 */
const val DEFAULT_SEED_WS = "ws://mc.void1211.com:6001"

/** 模拟器访问宿主机本地 dev 节点的便捷地址。 */
const val EMULATOR_HOST_WS = "ws://10.0.2.2:6001"
