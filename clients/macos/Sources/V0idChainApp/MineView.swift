// 挖矿大页：本机 solo PoW —— 一键开挖，实时算力/难度，已确认出块与奖励（以同步链为准）。
// 真挖矿：设备自己搜 nonce 出块、广播全网、拿出块奖励，和 `pnpm mine` 节点同一套共识。
import SwiftUI
import V0idKit

struct MineView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                if model.wallet == nil {
                    noWalletHint
                } else {
                    heroCard
                    statsCard
                    rewardCard
                }
                explainerCard
            }
            .padding(20)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("挖矿")
    }

    // ---- 英雄卡：状态 + 大开关 ----
    private var heroCard: some View {
        VStack(spacing: 16) {
            Image(systemName: "hammer.fill")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(model.mineState == .mining ? Color.accentColor : Color.secondary)
                .modifier(PulseIfMining(active: model.mineState == .mining))

            VStack(spacing: 4) {
                Text(stateTitle).font(.title3.weight(.semibold))
                Text(stateSubtitle).font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Button(action: model.toggleMining) {
                Label(model.miningEnabled ? "停止挖矿" : "开始挖矿",
                      systemImage: model.miningEnabled ? "stop.fill" : "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .buttonStyle(.borderedProminent)
            .tint(model.miningEnabled ? .red : .accentColor)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    private var stateTitle: String {
        switch model.mineState {
        case .idle: return "未挖矿"
        case .waiting: return "等待中…"
        case .mining: return "挖矿中"
        }
    }
    private var stateSubtitle: String {
        switch model.mineState {
        case .idle: return "点下方按钮开始本机挖矿"
        case .waiting:
            return model.isConnected ? "正在同步链…" : "等待连接到节点…"
        case .mining:
            return "正在为区块 #\(model.chain.count) 搜索 nonce"
        }
    }

    // ---- 实时指标 ----
    private var statsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("实时").font(.headline)
            HStack(spacing: 12) {
                statTile("算力", formatHashRate(model.hashRate), "speedometer")
                statTile("当前难度", difficultyText(model.nextDifficulty), "dial.high")
            }
            HStack(spacing: 12) {
                statTile("本块已试", abbrevCount(model.currentAttempts), "number")
                statTile("预计出块", model.mineState == .mining ? estTimePerBlock : "—", "timer")
            }
            HStack(spacing: 12) {
                statTile("待打包池", "\(model.nodeMempool.count) 笔", "tray.full")
                statTile("上块打包", "\(model.lastBlockTxCount) 笔", "shippingbox")
            }
        }
        .card()
    }

    private func statTile(_ label: String, _ value: String, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(label, systemImage: icon).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.system(.title3, design: .rounded).weight(.semibold))
                .monospacedDigit().contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
    }

    // ---- 战绩（以同步链为准，抗重组）----
    private var rewardCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("我的出块").font(.headline)
            HStack {
                Label("已确认出块", systemImage: "cube.fill")
                Spacer()
                Text("\(model.minedBlocksConfirmed) 块").font(.system(.body, design: .rounded).weight(.medium))
                    .monospacedDigit()
            }
            Divider()
            HStack {
                Label("累计奖励", systemImage: "bitcoinsign.circle.fill")
                Spacer()
                Text("\(model.minedRewardConfirmed) \(Config.symbol)")
                    .font(.system(.body, design: .rounded).weight(.medium)).monospacedDigit()
                    .foregroundStyle(.tint)
            }
            if model.blocksFoundSession > model.minedBlocksConfirmed {
                Text("本次会话已广播 \(model.blocksFoundSession) 块；未确认的可能在与其它矿工的竞争中被取代。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .card()
    }

    private var noWalletHint: some View {
        VStack(spacing: 12) {
            Image(systemName: "hammer").font(.system(size: 44, weight: .light)).foregroundStyle(.secondary)
            Text("先去「钱包」创建或登录").font(.headline)
            Text("挖矿奖励会发到你的钱包地址，需要先有钱包。")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 40)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    // ---- 说明 ----
    private var explainerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("这是真挖矿").font(.headline)
            bullet("你的 Mac 自己搜 nonce，算出满足难度的区块 hash，再广播给全网节点。")
            bullet("出块奖励 = \(Config.blockReward) \(Config.symbol) + 该块手续费，发到你的钱包地址。")
            bullet("会打包待处理的转账/消息/昵称/集市交易赚手续费；红包交易留给全节点矿工。")
            bullet("PoW 目标全网自适应（目标约 \(Config.targetBlockTimeMs / 1000) 秒一块）：算力越强，你抢到块的机会越大。")
            bullet("和公网种子矿工同台竞争——挖到块要靠运气和算力，别人先挖到时你这块会被放弃。")
        }
        .card()
    }

    private func bullet(_ s: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•").foregroundStyle(.tint)
            Text(s).font(.callout).foregroundStyle(.secondary)
        }
    }

    // ---- 格式化 ----
    private var estTimePerBlock: String {
        guard model.hashRate > 0 else { return "—" }
        let expectedHashes = pow(2.0, Double(model.nextDifficulty))
        return formatDuration(expectedHashes / model.hashRate)
    }
}

/// 挖矿中给图标加脉冲动画——macOS 14+ 用 symbolEffect，13 上优雅降级为静态。
private struct PulseIfMining: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if #available(macOS 14.0, *) {
            content.symbolEffect(.pulse, isActive: active)
        } else {
            content
        }
    }
}

func formatHashRate(_ r: Double) -> String {
    if r >= 1_000_000 { return String(format: "%.2f MH/s", r / 1_000_000) }
    if r >= 1_000 { return String(format: "%.1f kH/s", r / 1_000) }
    return String(format: "%.0f H/s", r)
}

func abbrevCount(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
    return "\(n)"
}

func formatDuration(_ s: Double) -> String {
    guard s.isFinite, s > 0 else { return "—" }
    if s < 1 { return "<1 秒" }
    if s < 60 { return String(format: "%.0f 秒", s) }
    if s < 3_600 { return String(format: "%.1f 分", s / 60) }
    if s < 86_400 { return String(format: "%.1f 时", s / 3_600) }
    return String(format: "%.1f 天", s / 86_400)
}
