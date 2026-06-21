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

    /// 交易备注 / 消息正文最大长度（Unicode 码点）。
    public static let maxMemo = 128

    /// 出块奖励（coinbase 新币）。矿工实得 = 奖励 + 本块手续费。
    public static let blockReward = 1

    /// 默认连接的公网种子节点（明文 ws，软分叉后已含「链上消息」）。
    public static let defaultSeed = "ws://mc.void1211.com:6001"
    /// 本地 dev 节点（`corepack pnpm dev:node1`）。
    public static let localNode = "ws://127.0.0.1:6001"

    /// 引导节点：客户端从这里起步，再通过 QUERY_PEERS 发现并连上整网其它节点（不只压种子一个）。
    public static let bootstrapNodes: [String] = [defaultSeed]
    /// 同时保持的最大连接数（连上一批 → 整链只向其一拉、交易广播给全部、掉线自动补）。
    public static let maxPeers = 6
}
