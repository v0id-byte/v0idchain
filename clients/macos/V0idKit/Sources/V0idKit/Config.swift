// v0idChain 全局参数 —— 必须与 packages/core/src/config.ts 完全一致，否则与全网不兼容。
import Foundation

public enum Config {
    /// 代币符号与链名
    public static let symbol = "$V0ID"
    public static let chainName = "v0idChain"

    /// 空地址：coinbase / 创世交易的 from，也是“虚空 / 销毁”地址（消息烧掉的币记到这里）。
    public static let nullAddress = "0x" + String(repeating: "0", count: 64)

    /// 最低手续费（gas）：每笔普通转账 / 消息必须 ≥ 此值，付给打包矿工。
    public static let minFee = 1

    /// 链上消息默认销毁额（$V0ID）：发一条消息默认烧这么多进虚空。
    public static let messageBurn = 5

    /// 交易备注 / 消息正文最大长度（Unicode 码点）。128→512：容纳端到端加密私信的密文。
    /// 与 packages/core MAX_MEMO 一致（共识校验上限）。
    public static let maxMemo = 512

    /// 普通明文消息/备注的 UI 输入上限（与 web 一致）；加密密文可用到 maxMemo。
    public static let plainTextLimit = 128

    /// 出块奖励（coinbase 新币）。矿工实得 = 奖励 + 本块手续费。
    public static let blockReward = 1

    // ---- 链上昵称（NAME| 自转 memo，先到先得；纯约定，不改共识）----
    public static let namePrefix = "NAME|"
    public static let maxName = 20
    /// 保留名：禁止抢注，防冒充“央行/官方/系统”。
    public static let reservedNames: Set<String> = [
        "treasury", "official", "admin", "system", "null", "v0id", "v0idchain", "genesis", "coinbase",
    ]

    // ---- 集市（MKT/BUY/DEL 转账 memo；纯约定，余额走普通转账）----
    public static let mktPrefix = "MKT|"
    public static let buyPrefix = "BUY|"
    public static let delPrefix = "DEL|"
    public static let maxTitle = 100

    // ---- 链上红包（共识级托管 + 条件支付）----
    /// 红包托管地址：发红包时锁定的总额记到这里（不可花）。与 NULL 区分，便于审计。
    public static let redEscrowAddress = "0x" + String(repeating: "0", count: 63) + "1"
    public static let redPrefix = "RED|"      // 发红包：RED|<份数>|<r|e>
    public static let claimPrefix = "CLAIM|"  // 抢红包：CLAIM|<红包txid>
    public static let refundPrefix = "REFUND|" // 退款：REFUND|<红包txid>（仅发起人、且过期后）
    public static let maxRedCount = 100
    /// 红包过期块数：创建后再过这么多块仍没抢完，发起人可退款。
    public static let redExpiry = 10

    // ---- 端到端加密私信（ENC| 密文上链；仍是 amount0+burn 消息）----
    public static let encPrefix = "ENC|"

    /// 默认连接的公网种子节点（明文 ws，软分叉后已含「链上消息」）。
    public static let defaultSeed = "ws://mc.void1211.com:6001"
    /// 本地 dev 节点（`corepack pnpm dev:node1`）。
    public static let localNode = "ws://127.0.0.1:6001"

    /// 引导节点：客户端从这里起步，再通过 QUERY_PEERS 发现并连上整网其它节点（不只压种子一个）。
    /// 两个种子互为备份（v0id@6001 + rpi@6201），任一挂掉客户端仍可接入。
    public static let bootstrapNodes: [String] = [defaultSeed, "ws://mc.void1211.com:6201"]
    /// 同时保持的最大连接数（连上一批 → 整链只向其一拉、交易广播给全部、掉线自动补）。
    public static let maxPeers = 6
}
