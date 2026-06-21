package com.v0id.wallet.core

/** 普通转账最低手续费（gas）。 */
const val MIN_FEE = 1L

/** 链上消息默认销毁额（烧进虚空的 $V0ID）。 */
const val MESSAGE_BURN = 5L

/** 备注 / 消息正文最大长度（Unicode 码点）。 */
const val MAX_MEMO = 128

/** 代币符号。 */
const val SYMBOL = "\$V0ID"

/** 默认公网种子节点（明文 ws://，长期方向是 wss://）。 */
const val DEFAULT_SEED_WS = "ws://mc.void1211.com:6001"

/** 模拟器访问宿主机本地 dev 节点的便捷地址。 */
const val EMULATOR_HOST_WS = "ws://10.0.2.2:6001"
