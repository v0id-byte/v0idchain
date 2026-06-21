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
  // 取自公网种子 mc.void1211.com 规范链（2026-06-21，链高 ~425；均深度确认 125+ 块）。
  // 冻结前 300 块历史：任何回滚到此前的 reorg（即便工作量更大）一律被拒。
  { index: 100, hash: '000002609afc7fd7b80a86708bff3ad16f50e8a7215650e3d103e69433193a4c' },
  { index: 200, hash: '0000048d00342b94b4b15c12500e47f002cb5b0726ccc1a9746cb5f3d6b89e28' },
  { index: 300, hash: '000001e93ce2e77f98a07ec6a0688c3534458a8e8eca2977349aaeb73fa73d06' },
];

/** 交易备注最大长度（字符） */
export const MAX_MEMO = 128;

/**
 * 链上消息默认销毁额（$V0ID）：发一条消息默认烧掉这么多币进虚空（NULL_ADDRESS，永久不可花 = 销毁）。
 * 消息交易 = amount 0 + burn>0 + memo 正文；发送方另付最低 MIN_FEE 给打包矿工（保留矿工动力）。
 * 这是默认值，发送时可调高（烧得更多更有仪式感、也更通缩）。
 */
export const MESSAGE_BURN = 5;

/**
 * mempool 容量上限：待打包交易池最多缓存多少笔。手续费已给 spam 定了价（每笔至少花 MIN_FEE），
 * 这里再加一道硬上限兜底内存（spam 仍受“nonce 顺序 + 余额充足 + 手续费”三重约束，本就要花真币）。
 */
export const MAX_MEMPOOL = 5_000;

/** 每挖出一个区块，矿工获得的**出块奖励**（coinbase 新币）。矿工实得 = 此奖励 + 本块所有交易的手续费。 */
export const BLOCK_REWARD = 1;

/**
 * 最低手续费（gas）：每笔普通转账必须 ≥ 此值，付给打包它的矿工。杜绝零手续费的免费 spam。
 * coinbase / 创世交易的手续费恒为 0（它们不付费，反而是手续费的收款方）。
 */
export const MIN_FEE = 1;

/**
 * 单个区块最多打包多少笔**普通**交易（不含 coinbase）。这是矿工侧的打包策略（非共识强校验）：
 * mempool 拥堵时，矿工按手续费从高到低挑、挑满即止 —— 给得多的先上链，形成真实的手续费竞价市场。
 * 取一个较宽的值：日常教学几乎不触顶，又足以在压测时演示“高手续费优先”。
 */
export const MAX_BLOCK_TXS = 50;

/** 创世预挖额：给下面的“央行”地址发一笔启动币（其余的币全靠挖矿产生）。 */
export const GENESIS_PREMINE = 1_000;

/**
 * 创世预挖收款地址（“央行” / treasury）。
 * 这是**地址 = 公钥**，公开安全；对应**私钥只存所有者本机**（`.data/treasury/wallet.json`，0600），
 * 绝不进仓库。谁持有该私钥，谁就能用普通 `send` 分发这 1000 启动币。
 * 想换成你自己的地址：跑一次 `wallet new` 拿到地址填到这里即可（各节点必须一致）。
 * 注：此地址已于加 gas 时轮换过一次（旧地址的私钥曾在明文环境出现，弃用）。
 */
export const GENESIS_PREMINE_ADDRESS =
  '0xd63300cb79b682979a5c62bad419a2a1147da9be4111736d52c636523a20cefb';

/** 固定创世时间戳 —— 所有节点必须一致，保证各自算出的创世 hash 相同 */
export const GENESIS_TIMESTAMP = 1_700_000_000_000;

/** 空地址：coinbase 与创世交易的 from */
export const NULL_ADDRESS = '0x' + '0'.repeat(64);
