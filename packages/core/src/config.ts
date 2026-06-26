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

// ---- 中继质押托管（Phase 3A-1：给洋葱中继名录加“押金”门槛，软分叉）----
/** 质押托管地址：STAKE 锁定的押金记到这里（不可花，等价于“质押合约账户”）。与红包托管 '…1' 区分（'…2'）。 */
export const STAKE_ESCROW_ADDRESS = '0x' + '0'.repeat(63) + '2';

/**
 * 质押共识激活高度。该高度前，`STAKE|`/`UNSTAKE|`/`SLASH|` 备注和 `…2` 托管地址都按历史普通交易处理
 * （amount=0 的新边界仍拒绝），避免升级节点重放老链时把历史普通 memo/转账 retroactive 地解释成质押操作。
 * 选择 16000：晚于 2026-06-24 公网种子约 #13711 和 POW_V2_HEIGHT=15000，给节点升级留窗口。
 */
export const STAKING_ACTIVATION_HEIGHT = 16_000;

/**
 * 系统/协议地址集合（非真人账户）：虚空/销毁地址 + 红包托管地址 + 质押托管地址。
 * 供 UI / 新人发现等处把它们与真实用户区分（如不把托管地址误报成“🆕 新地址首次上链”）。
 */
export const SYSTEM_ADDRESSES: ReadonlySet<string> = new Set([NULL_ADDRESS, RED_ESCROW_ADDRESS, STAKE_ESCROW_ADDRESS]);
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

// ---- 中继质押托管（Phase 3A-1：押金 + 失职罚没，软分叉）----
// 三种操作（建在普通交易 + memo 之上，旧节点不认 → 软分叉，边界同红包 CLAIM/REFUND）：
//   质押 STAKE   ：转给托管地址（to==STAKE_ESCROW_ADDRESS）amount=押金，memo `STAKE|<role>`。
//                  旧节点只看到一笔“转账到托管” → 余额效果一致、不静默分叉；分叉只在 UNSTAKE/SLASH（amount=0）处发生。
//   赎回 UNSTAKE ：amount=0，memo `UNSTAKE|<stakeTxid>`。仅质押人、且过 STAKE_LOCK_BLOCKS 锁定期后，取回本金-已罚没。
//   罚没 SLASH   ：amount=0，memo `SLASH|<stakeId>|<金额>|<epoch>`。仅 MEASURER_ADDRESS（度量者）签发，把失职押金移交国库。
/** 三种质押操作的 memo 前缀。STAKE 是“转托管 amount=押金 + memo”；UNSTAKE/SLASH 是 amount=0 + memo。 */
export const STAKE_PREFIX = 'STAKE|'; // 质押：STAKE|<role>（role ∈ guard|middle|hsdir）
export const UNSTAKE_PREFIX = 'UNSTAKE|'; // 赎回：UNSTAKE|<stakeTxid>（仅质押人、过锁定期）
export const SLASH_PREFIX = 'SLASH|'; // 罚没：SLASH|<stakeId>|<金额>|<epoch>（仅度量者签发）

/**
 * 度量者地址（measurer / 失职裁决者）。
 * 谁持有该地址对应私钥，谁就能对任何质押发 SLASH 罚没押金，因此这里必须只放**地址/公钥**，
 * 不得在生产配置中导出或提交对应私钥/种子。启用真网质押前，运营者应生成并保管离线度量者钱包，
 * 如需轮换只替换本常量（所有节点必须一致）。
 */
export const MEASURER_ADDRESS = '0x7f2db296c7cbb50681531e2a04a99414f11f0d0ff5b03e4e40b3a1f6beec9638';

/**
 * 每个角色的最低押金（$V0ID）。Guard ≥ HSDir ≥ Middle（押金高低对应去匿名风险/信任）：
 *   guard 直接看到客户端 IP（入口）→ 风险最高，押金最高；hsdir 存隐藏服务描述符 → 中等；middle 仅转发 → 最低。
 * v1 无 exit 角色。数值参照创世预挖 GENESIS_PREMINE=1000：取**个位~十几币**的小额（guard 仅占预挖 1.2%），
 * 让 ~1000 币的小经济体也轻松付得起、又有真实的成本门槛与女巫成本。当前是教学/小算力网络的保守起点，
 * 主网算力上来后可按需调大（改它即软分叉，全网须一致）。
 */
/** 质押基准值（创世难度 GENESIS_DIFFICULTY=16 时的最低押金）；实际门槛随难度线性增长，见 computeStakeMin。 */
export const STAKE_MIN: { guard: number; middle: number; hsdir: number } = { guard: 500, hsdir: 300, middle: 100 };

/**
 * 押金锁定块数：质押后再过这么多块才能 UNSTAKE 取回本金。取 12（约 96 秒 @ 8s 目标出块，与红包过期
 * RED_EXPIRY=10 同量级的“托管冷却”概念）——既给度量者一个完整 EPOCH_BLOCKS 周期内 SLASH 失职中继的窗口
 * （使其无法“质押→立刻赎回”逃过罚没），又不至于过长。这是教学/小算力网络的保守起点，可按需调大；
 * 所有节点须一致（改它即软分叉）。
 */
export const STAKE_LOCK_BLOCKS = 12;

/**
 * 角色奖励倍率（后续阶段的奖励/激励计算消费；本阶段仅定义+注释，不参与共识）。middle 基准 1×，
 * guard/hsdir 按其稀缺性与价值给更高倍率（与 STAKE_MIN 的高低排序一致）。可调。
 */
export const ROLE_REWARD_MULT: { guard: number; middle: number; hsdir: number } = { guard: 3, middle: 1, hsdir: 2 };

/** 度量/奖励周期长度（块）：10 块约 80 秒 @ 8s（≤ STAKE_LOCK_BLOCKS，保证锁定期覆盖至少一个周期）。后续阶段按 epoch 结算奖励与度量。可调。 */
export const EPOCH_BLOCKS = 10;

/** 早期引导奖励截止高度：此高度前的 epoch 给中继额外奖励倍率，吸引首批中继加入。后续阶段消费。可调。 */
export const BOOTSTRAP_BONUS_UNTIL_HEIGHT = 50_000;
/** 早期引导奖励倍率：BOOTSTRAP_BONUS_UNTIL_HEIGHT 之前，奖励再 ×此倍率。后续阶段消费。可调。 */
export const BOOTSTRAP_BONUS_MULT = 2;

// ---- 中继激励工具（Phase 3A-2/3/4：链下度量者 / 奖励 / 罚没的参数）----
// 注：这些常量被**链下工具**（packages/node measurer + CLI reward-epoch/slash-epoch）消费，
// 不进共识状态机。它们影响“度量者愿意发什么 SLASH / 国库愿意发多少奖励”，而非链如何校验这些交易
// （链对 SLASH 的合法性只认 MEASURER_ADDRESS 与 parseSlash 的范围，见 staking.ts / blockchain.ts）。

/**
 * 连续掉线多少个 epoch 才罚没（保守、仅惩罚“持续掉线”而非偶发抖动）。取 3：一个中继要连续 3 个
 * 完整度量周期（3×EPOCH_BLOCKS≈240 秒 @8s）都探测不通，度量者才会形成一笔 SLASH。单次/偶发掉线不罚。
 * 这是链下裁决策略，可按运营经验调（调大=更宽容、调小=更严苛）；不影响链如何校验 SLASH。
 */
export const SLASH_AFTER_EPOCHS = 3;

/**
 * 单次罚没占“剩余本金”的比例（0~1）。取 0.1（10%）：每次只罚一小口，给掉线中继留改正空间，也避免
 * 度量者误判一次就清空某人押金。amount = floor(SLASH_FRACTION × (本金-已罚没))。保守、可调。
 * 链侧仍对 SLASH 金额封顶为剩余本金（封顶逻辑见 applyTx），故即便这里配置过大也不会超额罚没。
 */
export const SLASH_FRACTION = 0.1;

/**
 * 每个 epoch 的奖励池预算（$V0ID，从国库 GENESIS_PREMINE 拨付）。**有限启动池**：预挖共 GENESIS_PREMINE=1000，
 * 取 5/epoch 是一个保守的引导值——意味着即便在 BOOTSTRAP_BONUS_MULT 加成下，单 epoch 也只发个位数到十几币，
 * 国库够撑很多个周期再耗尽（这是教学/小经济体的“慢放水”起点，绝非永续通胀）。
 * ⚠️ 这是**链下**预算上限：reward-epoch 默认只预览不发；只有显式 --send 才真的从国库转账、烧掉这笔有限池。
 * 主网经济体量上来后按需调大；它不进共识、改它不分叉。
 */
export const REWARD_EPOCH_POOL = 5;
