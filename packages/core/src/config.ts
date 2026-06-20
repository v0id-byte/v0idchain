// v0idChain 全局参数 —— 所有节点必须完全一致，否则创世块 / 共识不兼容。

/** 代币符号与链名 */
export const SYMBOL = '$V0ID';
export const CHAIN_NAME = 'v0idChain';

/**
 * PoW 难度（自适应）：区块 hash 必须有 ≥ difficulty 个前导 0 **比特**（bit，非 hex 位）。
 * 比特粒度让难度能平滑调整（每 ±1 bit = 难度 ×/÷2），而不是 hex 粒度的 16 倍跳变。
 */
export const GENESIS_DIFFICULTY = 16; // 创世难度（bit）；16 bit ≈ 2^16 次哈希，瞬间完成
export const MIN_DIFFICULTY = 8; // 下限（地板）：算力骤降时难度能一路降回这里，避免链被永久卡死
// 无实际上限：像 BTC 一样随全网算力一直往上加。255 只是物理天花板（哈希共 256 bit）。
// ⚠️ 代价：若算力先暴涨、后骤降，少数慢机器会被高难度卡住（难度要等下次重定向才降）。
export const MAX_DIFFICULTY = 255;

/** 目标出块时间；每 RETARGET_INTERVAL 个区块按实际耗时重定向一次难度 */
export const TARGET_BLOCK_TIME_MS = 8_000;
export const RETARGET_INTERVAL = 8;

/** 交易备注最大长度（字符） */
export const MAX_MEMO = 128;

/** 每挖出一个区块，矿工获得的奖励（coinbase 新币）。零手续费，矿工只赚这个。 */
export const BLOCK_REWARD = 1;

/** 创世预挖额：给下面的“央行”地址发一笔启动币（其余的币全靠挖矿产生）。 */
export const GENESIS_PREMINE = 1_000;

/**
 * 创世预挖收款地址（“央行” / treasury）。
 * 这是**地址 = 公钥**，公开安全；对应**私钥只存所有者本机**（`.data/treasury/wallet.json`），
 * 绝不进仓库。谁持有该私钥，谁就能用普通 `send` 分发这 1000 启动币。
 * 想换成你自己的地址：跑一次 `wallet new` 拿到地址填到这里即可（各节点必须一致）。
 */
export const GENESIS_PREMINE_ADDRESS =
  '0xbf52e7a3d361042a0bb1f00b1d28fb9af42a0d170c8cd6e8868f531a44f6a74d';

/** 固定创世时间戳 —— 所有节点必须一致，保证各自算出的创世 hash 相同 */
export const GENESIS_TIMESTAMP = 1_700_000_000_000;

/** 空地址：coinbase 与创世交易的 from */
export const NULL_ADDRESS = '0x' + '0'.repeat(64);
