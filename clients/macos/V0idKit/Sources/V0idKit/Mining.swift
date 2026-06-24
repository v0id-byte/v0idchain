// PoW 挖矿：自适应难度重定向 + 组块模板 + 分批 nonce 搜索。
// 对应 packages/core/src/blockchain.ts 的 expectedDifficulty / mine 与 block.ts 的 mineBlock。
// 轻客户端 solo 挖矿：本机搜 nonce 出块，广播给所连节点（节点 onBlocks 接受续接块并转播）。
import Foundation

public enum Mining {
    /// 自适应难度：从链历史**确定性**算出 `index` 处区块应满足的难度（前导 0 比特数）。
    /// 各节点算法一致 → 难度无法伪造；本机算错则出的块会被全网判「难度不符」直接拒收。
    ///
    /// ⚠️ 跨语言取整坑：JS `Math.round` 朝 +∞ 取整（round-half-up：Math.round(-0.5)=0），
    /// 而 Swift 的 `Double.rounded()` 是 round-half-away-from-zero（-0.5 → -1）——二者在负的 .5
    /// 边界结论不同。这里用 `floor(x + 0.5)` 复刻 JS `Math.round` 的精确语义。
    public static func expectedDifficulty(_ chain: [Block], index: Int) -> Int {
        if index == 0 { return Config.genesisDifficulty }
        let prev = chain[index - 1]
        // 非重定向点，或重定向窗口会触及创世（时间戳为固定古值）→ 沿用上一块难度。
        if index % Config.retargetInterval != 0 || index - Config.retargetInterval < 1 {
            return prev.difficulty
        }
        let windowStart = chain[index - Config.retargetInterval]
        // 窗口实际耗时 = prev 与 windowStart 的时间差，跨 retargetInterval-1 个出块间隔。
        let actual = prev.timestamp - windowStart.timestamp
        let expected = (Config.retargetInterval - 1) * Config.targetBlockTimeMs
        let delta: Int
        if actual <= 0 {
            delta = 2 // 时间倒流/为零 → 视为极快，加满 2 bit
        } else {
            // = JS: Math.max(-2, Math.min(2, Math.round(Math.log2(expected / actual))))
            let rounded = Int(floor(log2(Double(expected) / Double(actual)) + 0.5))
            delta = max(-2, min(2, rounded))
        }
        return max(Config.minDifficulty, min(Config.maxDifficulty, prev.difficulty + delta))
    }

    /// 下一块（链顶之上）要求的难度——供 UI 展示与组模板用。
    public static func nextDifficulty(_ chain: [Block]) -> Int {
        expectedDifficulty(chain, index: chain.count)
    }

    /// 组一个待挖区块模板（nonce=0、hash 待填）。对应 blockchain.ts 的 mine() 组块部分。
    /// extraTxs = 选入的普通交易（MVP 传空 → 只打 coinbase 空块，仍是真 PoW、真奖励）。
    /// fees 自动汇总进 coinbase；timestamp 取 max(now, 链顶)（校验要求单调不减）。
    /// 前置条件：chain 非空（至少含创世）。
    public static func buildTemplate(chain: [Block], miner: String,
                                     extraTxs: [Transaction] = [],
                                     nowMs: Int = TxBuilder.nowMillis()) -> Block {
        let latest = chain[chain.count - 1]
        let index = chain.count // = height + 1
        let fees = extraTxs.reduce(0) { $0 + $1.fee }
        let cb = TxBuilder.coinbase(minerAddress: miner, blockIndex: index, fees: fees, timestamp: nowMs)
        let txs = [cb] + extraTxs
        return Block(
            index: index,
            timestamp: max(nowMs, latest.timestamp),
            prevHash: latest.hash,
            transactions: txs,
            merkleRoot: Crypto.merkleRoot(txs.map { $0.txid }),
            difficulty: expectedDifficulty(chain, index: index),
            nonce: 0,
            miner: miner,
            hash: ""
        )
    }

    /// 从 mempool 选出能干净接在当前链顶后的**普通交易**（转账/消息/昵称/集市），与节点 selectMempoolTxs 的
    /// 接纳条件一致 → 打出的块必过 validateChain。手续费市场：按 fee 高→低（txid 决定性兜底），多趟扫描让先入的
    /// 低 nonce 解锁同一发送方后续 nonce；最多 limit 笔。
    ///
    /// ⚠️ **有意跳过红包相关交易**（发往托管地址 / CLAIM / REFUND）：它们的合法性依赖共识级托管池状态，
    /// 轻客户端不跟踪该状态。块无需包含 mempool 全部交易，故跳过它们是合法选择——留给全节点矿工打包。
    /// 跳过红包交易也不会卡住同发送方后续 nonce：被跳过的交易不推进 expected nonce，其后续高 nonce 交易
    /// 自然选不进来（与全网一致，留待全节点连号打包）。
    public static func selectTxs(chain: [Block], mempool: [Transaction], limit: Int = Config.maxBlockTxs) -> [Transaction] {
        let st = Chain.computeState(chain)
        var balances = st.balances
        var nonces = st.nonces
        func isRedRelated(_ tx: Transaction) -> Bool {
            tx.to == Config.redEscrowAddress
                || tx.memo.hasPrefix(Config.claimPrefix)
                || tx.memo.hasPrefix(Config.refundPrefix)
        }
        var queue: [Transaction?] = mempool
            .filter { !isRedRelated($0) }
            .sorted { $0.fee != $1.fee ? $0.fee > $1.fee : $0.txid < $1.txid }
        var selected: [Transaction] = []
        var progressed = true
        while progressed && selected.count < limit {
            progressed = false
            for i in queue.indices where selected.count < limit {
                guard let tx = queue[i] else { continue }
                let expected = nonces[tx.from] ?? 0
                let cost = tx.amount + tx.fee + (tx.burn ?? 0)
                // 与 validateChain 接纳条件一致：nonce 对、余额够付、自洽、手续费达比例保底、不打到空地址。
                if tx.nonce == expected,
                   cost <= (balances[tx.from] ?? 0),
                   tx.to != Config.nullAddress,
                   tx.fee >= Config.minFeeFor(tx.amount),
                   tx.selfValid() {
                    selected.append(tx)
                    balances[tx.from, default: 0] -= cost
                    balances[tx.to, default: 0] += tx.amount
                    if let b = tx.burn, b > 0 { balances[Config.nullAddress, default: 0] += b }
                    nonces[tx.from, default: 0] += 1
                    queue[i] = nil
                    progressed = true
                }
            }
        }
        return selected
    }

    /// 分批枚举 nonce 直到区块 hash 满足难度。对应 block.ts 的 mineBlock。
    /// 每 `batch` 个 nonce 让出一次事件循环（响应取消 / 新链顶 / UI 刷新）；CPU 密集，务必在后台 Task 跑。
    /// 返回封好 hash 的区块；被取消（Task.isCancelled 或 shouldStop()）→ nil。
    /// `onBatch` 每批回调一次「至今已试 nonce 数」，供 UI 估算算力（@Sendable，调用方自行切回主线程）。
    public static func search(
        template: Block,
        batch: Int = 16_384,
        shouldStop: @escaping @Sendable () -> Bool = { false },
        onBatch: (@Sendable (Int) -> Void)? = nil
    ) async -> Block? {
        var blk = template
        let difficulty = template.difficulty
        var nonce = 0
        while true {
            let end = nonce + batch
            while nonce < end {
                blk.nonce = nonce
                let h = blk.calcHash()
                if Crypto.meetsDifficulty(h, difficulty) {
                    blk.hash = h
                    return blk
                }
                nonce += 1
            }
            onBatch?(nonce)
            if Task.isCancelled || shouldStop() { return nil }
            await Task.yield() // 让出：被取消会在此后下一轮 isCancelled 命中
        }
    }
}
