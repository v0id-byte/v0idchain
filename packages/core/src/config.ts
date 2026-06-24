// v0idChain 全局参数 —— 所有节点必须完全一致，否则创世块 / 共识不兼容。

/** 代币符号与链名 */
export const SYMBOL = '$V0ID';
export const CHAIN_NAME = 'v0idChain';

/**
 * PoW 难度（自适应）。
 *
 * v1（高度 < POW_V2_HEIGHT）：difficulty 是“前导 0 bit 数”。
 * v2（高度 >= POW_V2_HEIGHT）：difficulty 字段承载 BTC 风格 compact target（nBits）。
 *
 * 这样保持区块 JSON 结构不变，同时让新区块使用 target-based 难度和精确累计工作量。
 */
export const GENESIS_DIFFICULTY = 16; // 创世难度（bit）；16 bit ≈ 2^16 次哈希，瞬间完成
export const MIN_DIFFICULTY = 8; // 下限（地板）：算力骤降时难度能一路降回这里，避免链被永久卡死
// 无实际上限：像 BTC 一样随全网算力一直往上加。255 只是物理天花板（哈希共 256 bit）。
// ⚠️ 代价：若算力先暴涨、后骤降，少数慢机器会被高难度卡住（难度要等下次重定向才降）。
export const MAX_DIFFICULTY = 255;

/** v2 共识激活高度：公网种子 2026-06-24 约 #13711，#15000 给节点和钱包预留升级窗口。 */
export const POW_V2_HEIGHT = 15_000;

/** 目标出块时间；v1/v2 均沿用 8 秒目标 */
export const TARGET_BLOCK_TIME_MS = 8_000;
/** v1 重定向窗口（历史兼容）。 */
export const RETARGET_INTERVAL = 8;
/** v2 BTC 风格重定向窗口：60 块约 8 分钟，适合当前小算力网络。 */
export const POW_V2_RETARGET_INTERVAL = 60;
/** BTC 风格单次重定向限幅：target 最多 ×4 或 ÷4。 */
export const POW_V2_MAX_ADJUST_FACTOR = 4;

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

/**
 * 交易备注 / 消息正文最大长度（Unicode 码点）。128→512：容纳端到端加密私信的密文
 * （nonce+tag+base/hex 开销后仍够发一段话）。
 * ⚠️ 这是**共识校验上限**（verifyTransaction 据此判合法），不进 txid 哈希 → 创世/checkpoint 不变、链不重置；
 * 但属**软分叉**：超 128 码点 memo 的块在旧节点（旧上限 128）会被拒 → 全网须一起升级到本值。
 */
export const MAX_MEMO = 512;

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
 * 比例手续费率（基点，basis points，10000 bps = 100%）：普通转账在 MIN_FEE 保底之上，
 * 还需 ≥ floor(amount × FEE_RATE_BPS / 10000)。10 bps = 0.1%：
 *   转账 1000 → 最低费 1（保底），10000 → 10，100000 → 100。
 * 属**软分叉**：大额转账 fee=1 在新版节点被拒，旧节点仍接受；全网须同步升级。
 */
export const FEE_RATE_BPS = 10;

/** 某笔转账（amount）所需的最低手续费（整数）：max(MIN_FEE, floor(amount × FEE_RATE_BPS / 10000)) */
export function minFeeFor(amount: number): number {
  return Math.max(MIN_FEE, Math.floor((amount * FEE_RATE_BPS) / 10_000));
}

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

/** 空地址：coinbase 与创世交易的 from。也是“销毁/虚空”地址（消息烧币、红包烧掉的钱进这里）。 */
export const NULL_ADDRESS = '0x' + '0'.repeat(64);

// ---- 链上抢红包（共识级托管 + 条件支付）----
/** 红包托管地址：发红包时锁定的总额记到这里（不可花，等价于“合约托管账户”）。与 NULL 区分，便于审计。 */
export const RED_ESCROW_ADDRESS = '0x' + '0'.repeat(63) + '1';

/**
 * 系统/协议地址集合（非真人账户）：虚空/销毁地址 + 红包托管地址。
 * 供 UI / 新人发现等处把它们与真实用户区分（如不把红包托管地址误报成“🆕 新地址首次上链”）。
 */
export const SYSTEM_ADDRESSES: ReadonlySet<string> = new Set([NULL_ADDRESS, RED_ESCROW_ADDRESS]);
/** 三种红包操作的 memo 前缀。RED 是“自转 amount=总额 + memo”；CLAIM/REFUND 是 amount=0 + memo。 */
export const RED_PREFIX = 'RED|'; // 发红包：RED|<份数>|<r|e>（r=拼手气随机, e=均分）
export const CLAIM_PREFIX = 'CLAIM|'; // 抢红包：CLAIM|<红包txid>
export const REFUND_PREFIX = 'REFUND|'; // 退款：REFUND|<红包txid>（仅发起人、且过期后）
/** 单个红包最多份数（防滥用 + 限制单红包状态规模） */
export const MAX_RED_COUNT = 100;
/**
 * 红包过期块数：创建后再过这么多块仍没抢完，发起人可发 REFUND 取回剩余。
 * 取 10（约 80 秒 @ 8s 目标出块）——抢红包讲究“快”，过期即可退（过期前后都能抢，直到退款）。所有节点须一致（改它即软分叉）。
 */
export const RED_EXPIRY = 10;
