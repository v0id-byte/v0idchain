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

/**
 * 区块时间戳允许领先本地时钟的上限（毫秒）。校验时拒绝 timestamp > now + 该值的区块。
 * 防“把时钟往前调 1 小时 → 拉长重定向窗口 → 把难度压到地板”的时间戳操纵。
 * 取 2 分钟：远松于真实 NTP 偏差（杜绝误杀诚实块），又远紧于攻击所需的小时级伪造。
 */
export const MAX_FUTURE_DRIFT_MS = 120_000;

/**
 * 检查点（checkpoint）：硬编码的 `{ 高度, 该高度区块 hash }`。链在这些高度的区块 hash 必须吻合，
 * 否则整链判为非法；`replaceChain` 也拒绝任何回滚到最新 checkpoint 之前的 reorg。
 * 作用：把 checkpoint 之前的历史**冻结**——即便攻击者凑出更大累计工作量也改不动旧账，
 * 大幅抬高深度 reorg / ≥51% 攻击成本（低算力 PoW 链的固有软肋，同 Bitcoin Core 早期做法）。
 * 默认空。运营者应**定期**从规范链取一个已被充分确认（后面又压了很多块）的高度，
 * 用 `v0id checkpoint <height>` 生成下面这种条目并提交（**所有节点必须一致**；填错会让本地链无法通过校验）。
 */
export const CHECKPOINTS: { index: number; hash: string }[] = [
  // 例：{ index: 1000, hash: '0000abcd…' },
];

/** 交易备注最大长度（字符） */
export const MAX_MEMO = 128;

/**
 * mempool 容量上限：待打包交易池最多缓存多少笔。零手续费链没有 fee 市场来给 spam 定价，
 * 故用一个硬上限兜底内存（spam 仍受“nonce 顺序 + 余额充足”约束，本就要花真币）。
 */
export const MAX_MEMPOOL = 5_000;

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
