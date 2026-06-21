// 主框架：侧边栏（钱包 / 转账 / 消息 / 逛链）+ 顶部加宽状态条 + 全局提示。
import SwiftUI
import V0idKit

enum AppSection: String, CaseIterable, Identifiable {
    case wallet = "钱包"
    case send = "转账"
    case messages = "消息"
    case explorer = "逛链"
    case settings = "设置"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .wallet: return "wallet.pass"
        case .send: return "paperplane"
        case .messages: return "envelope"
        case .explorer: return "cube.transparent"
        case .settings: return "gearshape"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @State private var selection: AppSection? = .wallet

    var body: some View {
        NavigationSplitView {
            List(AppSection.allCases, selection: $selection) { s in
                Label(s.rawValue, systemImage: s.icon).tag(s)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
        } detail: {
            VStack(spacing: 0) {
                statusBar          // 全宽状态条（加宽，不再挤在 toolbar 里）
                Divider()
                detail
            }
        }
        .overlay(alignment: .bottom) { toast }
    }

    @ViewBuilder private var detail: some View {
        switch selection ?? .wallet {
        case .wallet: WalletView()
        case .send: SendView()
        case .messages: MessagesView()
        case .explorer: ExplorerView()
        case .settings: SettingsView()
        }
    }

    // 全宽状态条：连接节点数 / 链高 / 已销毁。液态玻璃材质、横向铺满、间距充足。
    private var statusBar: some View {
        HStack(spacing: 14) {
            ConnectionBadge(peers: model.peerCount)
            statusChip(icon: "cube", "链高 \(model.height)")
            statusChip(icon: "flame", "已销毁 \(model.burned) \(Config.symbol)")
            Spacer()
            if !model.chain.isEmpty {
                Text("\(model.chain.count) 块")
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
    }

    private func statusChip(icon: String, _ text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.caption).foregroundStyle(.secondary)
            Text(text).font(.callout).monospacedDigit()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.quaternary.opacity(0.5), in: Capsule())
    }

    @ViewBuilder private var toast: some View {
        if let err = model.lastError {
            noticeBar(text: err, color: .red, systemImage: "exclamationmark.triangle.fill") {
                model.lastError = nil
            }
        } else if let note = model.lastNotice {
            noticeBar(text: note, color: .green, systemImage: "checkmark.circle.fill") {
                model.lastNotice = nil
            }
        }
    }

    // 仿 iOS：胶囊 + 超薄材质浮层。
    private func noticeBar(text: String, color: Color, systemImage: String, dismiss: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage).foregroundStyle(color)
            Text(text).font(.subheadline)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(color.opacity(0.45)))
        .shadow(radius: 8, y: 4)
        .padding(.bottom, 18)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .onTapGesture { dismiss() }
        .task {
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            dismiss()
        }
    }
}
