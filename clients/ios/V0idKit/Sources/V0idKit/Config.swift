// v0idChain 全局参数 —— 必须与 packages/core/src/config.ts 完全一致，否则与全网不兼容。
// （iOS 历史上把 minFee / messageBurn / nullAddress 散落在 TxBuilder/Crypto 里；本文件集中新功能用到的常量，
//   并复用既有那几个值，避免双份真相。）
import Foundation

public enum Config {
    /// 代币符号与链名
    public static let symbol = "$V0ID"
    public static let chainName = "v0idChain"

    /// 空地址：coinbase / 创世交易的 from，也是“虚空 / 销毁”地址（消息烧掉的币记到这里）。
    public static let nullAddress = Crypto.nullAddress

    /// 最低手续费（gas）：每笔普通转账 / 消息必须 ≥ 此值，付给打包矿工。
    public static let minFee = TxBuilder.minFee

    /// 链上消息默认销毁额（$V0ID）。
    public static let messageBurn = TxBuilder.messageBurn

    /// 交易备注 / 消息正文最大长度（Unicode 码点）。128→512：容纳端到端加密私信的密文。
    /// 与 packages/core MAX_MEMO 一致（共识校验上限）。
    public static let maxMemo = 512

    /// 普通明文消息/备注的 UI 输入上限（与 web 一致）；加密密文可用到 maxMemo。
    public static let plainTextLimit = 128

    /// v2 共识激活高度：激活后区块 difficulty 字段承载 BTC 风格 compact target(nBits)。
    public static let powV2Height = 15_000

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
}
