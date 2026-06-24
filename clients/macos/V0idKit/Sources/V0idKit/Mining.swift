// PoW 挖矿：自适应难度重定向 + 组块模板 + 分批 nonce 搜索。
// 对应 packages/core/src/blockchain.ts 的 expectedDifficulty / mine 与 block.ts 的 mineBlock。
// 轻客户端 solo 挖矿：本机搜 nonce 出块，广播给所连节点（节点 onBlocks 接受续接块并转播）。
import Foundation

public enum Mining {
    private static let powV2TimespanMs = Config.powV2RetargetInterval * Config.targetBlockTimeMs

    private static func expectedDifficultyV1(_ chain: [Block], index: Int) -> Int {
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

    private static func isCompactDifficulty(_ difficulty: Int) -> Bool { difficulty > 255 }

    private static func targetFromBitDifficulty(_ difficulty: Int) -> [UInt8] {
        if difficulty >= 256 { return Array(repeating: 0, count: 32) }
        var out = Array(repeating: UInt8(0xff), count: 32)
        let zeroBytes = max(0, difficulty / 8)
        if zeroBytes > 0 {
            for i in 0..<min(zeroBytes, out.count) { out[i] = 0 }
        }
        let rem = difficulty % 8
        if rem > 0 && zeroBytes < out.count {
            out[zeroBytes] = UInt8(0xff >> rem)
        }
        return out
    }

    private static func targetFromCompact(_ compact: Int) -> [UInt8]? {
        if compact <= 0 || compact > 0xffffffff { return nil }
        let size = compact >> 24
        let word = compact & 0x007fffff
        if word == 0 || (compact & 0x00800000) != 0 || size > 32 { return nil }
        var out = Array(repeating: UInt8(0), count: 32)
        if size <= 3 {
            let value = word >> (8 * (3 - size))
            for i in 0..<size {
                out[31 - i] = UInt8((value >> (8 * i)) & 0xff)
            }
            return out
        }
        let start = 32 - size
        out[start] = UInt8((word >> 16) & 0xff)
        out[start + 1] = UInt8((word >> 8) & 0xff)
        out[start + 2] = UInt8(word & 0xff)
        return out
    }

    private static func compactFromTarget(_ target: [UInt8]) -> Int {
        let first = target.firstIndex { $0 != 0 }
        guard let first else { return 0x01000000 }
        var size = target.count - first
        var compact = 0
        if size <= 3 {
            var value = 0
            for b in target[first...] { value = (value << 8) | Int(b) }
            compact = value << (8 * (3 - size))
        } else {
            compact = (Int(target[first]) << 16) | (Int(target[first + 1]) << 8) | Int(target[first + 2])
        }
        if (compact & 0x00800000) != 0 {
            compact >>= 8
            size += 1
        }
        return (size << 24) | (compact & 0x007fffff)
    }

    private static func targetFromStoredDifficulty(_ difficulty: Int) -> [UInt8]? {
        isCompactDifficulty(difficulty) ? targetFromCompact(difficulty) : targetFromBitDifficulty(difficulty)
    }

    private static func compareTarget(_ a: [UInt8], _ b: [UInt8]) -> Int {
        for (x, y) in zip(a, b) {
            if x < y { return -1 }
            if x > y { return 1 }
        }
        return 0
    }

    private static func bytesToLimbs(_ bytes: [UInt8]) -> [UInt32] {
        var limbs = [UInt32]()
        var i = bytes.count
        while i > 0 {
            var limb: UInt32 = 0
            let start = max(0, i - 4)
            for b in bytes[start..<i] { limb = (limb << 8) | UInt32(b) }
            limbs.append(limb)
            i = start
        }
        while limbs.last == 0 && limbs.count > 1 { limbs.removeLast() }
        return limbs
    }

    private static func limbsToBytes32(_ limbs: [UInt32]) -> [UInt8] {
        var out = Array(repeating: UInt8(0), count: 32)
        var pos = 31
        for limb in limbs {
            for shift in stride(from: 0, through: 24, by: 8) {
                if pos < 0 { return out }
                out[pos] = UInt8((limb >> UInt32(shift)) & 0xff)
                pos -= 1
            }
        }
        return out
    }

    private static func multiply(_ limbs: [UInt32], by m: Int) -> [UInt32] {
        var out = [UInt32]()
        var carry: UInt64 = 0
        for limb in limbs {
            let v = UInt64(limb) * UInt64(m) + carry
            out.append(UInt32(v & 0xffffffff))
            carry = v >> 32
        }
        while carry > 0 {
            out.append(UInt32(carry & 0xffffffff))
            carry >>= 32
        }
        return out
    }

    private static func divide(_ limbs: [UInt32], by d: Int) -> [UInt32] {
        var out = Array(repeating: UInt32(0), count: limbs.count)
        var rem: UInt64 = 0
        for i in stride(from: limbs.count - 1, through: 0, by: -1) {
            let cur = (rem << 32) | UInt64(limbs[i])
            out[i] = UInt32(cur / UInt64(d))
            rem = cur % UInt64(d)
        }
        while out.last == 0 && out.count > 1 { out.removeLast() }
        return out
    }

    private static func adjustedTarget(prevTarget: [UInt8], actual rawActual: Int) -> [UInt8] {
        let minActual = powV2TimespanMs / Config.powV2MaxAdjustFactor
        let maxActual = powV2TimespanMs * Config.powV2MaxAdjustFactor
        let actual = min(max(rawActual, minActual), maxActual)
        let product = multiply(bytesToLimbs(prevTarget), by: actual)
        var target = limbsToBytes32(divide(product, by: powV2TimespanMs))
        let powLimit = targetFromBitDifficulty(Config.minDifficulty)
        let minTarget = targetFromBitDifficulty(Config.maxDifficulty)
        if compareTarget(target, powLimit) > 0 { target = powLimit }
        if compareTarget(target, minTarget) < 0 { target = minTarget }
        return target
    }

    private static func expectedDifficultyV2(_ chain: [Block], index: Int) -> Int {
        let prev = chain[index - 1]
        let prevTarget = targetFromStoredDifficulty(prev.difficulty) ?? targetFromBitDifficulty(Config.minDifficulty)
        if index == Config.powV2Height { return compactFromTarget(prevTarget) }
        if index % Config.powV2RetargetInterval != 0 || index - Config.powV2RetargetInterval < 1 {
            return prev.difficulty
        }
        let windowStart = chain[index - Config.powV2RetargetInterval]
        return compactFromTarget(adjustedTarget(prevTarget: prevTarget, actual: prev.timestamp - windowStart.timestamp))
    }

    /// 自适应难度：v1 历史高度使用前导 0 bit；v2 激活后使用 BTC 风格 compact target。
    public static func expectedDifficulty(_ chain: [Block], index: Int) -> Int {
        if index < Config.powV2Height { return expectedDifficultyV1(chain, index: index) }
        return expectedDifficultyV2(chain, index: index)
    }

    public static func meetsDifficulty(_ hashHex: String, _ difficulty: Int) -> Bool {
        if !isCompactDifficulty(difficulty) { return Crypto.meetsDifficulty(hashHex, difficulty) }
        guard let target = targetFromCompact(difficulty), let hash = Hex.decode(hashHex), hash.count == 32 else { return false }
        return compareTarget(hash, target) <= 0
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
                if meetsDifficulty(h, difficulty) {
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
