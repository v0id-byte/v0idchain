// 钱包页：地址 + 余额 + 全网已烧毁 + 连接状态。
import SwiftUI
import V0idKit

struct WalletView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var node: NodeClient
    @State private var claimInput = ""

    /// 我的当前显示名（没抢注过则 nil）。
    private var myName: String? { model.address.flatMap { node.nameRegistry().name(for: $0) } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    balanceCard
                    if let address = model.address {
                        infoCard(address: address)
                        claimCard
                    }
                    networkCard
                }
                .padding()
            }
            .navigationTitle("钱包")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { node.connect() } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            .refreshable { node.connect() }
        }
    }

    private var balanceCard: some View {
        VStack(spacing: 6) {
            Text("余额").font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(node.balance())")
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .contentTransition(.numericText())
                Text("$V0ID").font(.headline).foregroundStyle(.secondary)
            }
            if let name = myName {
                Text("@\(name)").font(.subheadline.weight(.medium)).foregroundStyle(.tint)
            }
            ConnectionBadge()
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    private func infoCard(address: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            CopyableRow(label: "我的地址（= 公钥，可公开）", value: address)
            Divider()
            HStack {
                Label("下一笔 nonce", systemImage: "number")
                Spacer()
                Text("\(node.nextNonce())").font(.system(.body, design: .monospaced))
            }
            .font(.subheadline)
            if !node.pending.isEmpty {
                HStack {
                    Label("待确认交易", systemImage: "clock")
                    Spacer()
                    Text("\(node.pending.count)").font(.system(.body, design: .monospaced))
                }
                .font(.subheadline).foregroundStyle(.orange)
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private var claimCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("🪪 链上昵称").font(.headline)
            HStack(spacing: 8) {
                TextField(myName.map { "改名（当前 @\($0)）" } ?? "小写字母/数字/_/-（1~20 位）", text: $claimInput)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                Button("抢注") {
                    if model.claimName(claimInput) { claimInput = "" }
                }
                .disabled(claimInput.trimmingCharacters(in: .whitespaces).isEmpty)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            Text("自转 1 $V0ID + 手续费 1，先到先得，全网唯一。")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private var networkCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("网络").font(.headline)
            row("节点", node.nodeURL)
            row("链高", "\(node.height)")
            row("🔥 全网已烧毁", "\(node.totalBurned) $V0ID")
            if let err = node.lastError {
                Text(err).font(.caption).foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).foregroundStyle(.secondary)
            Spacer()
            Text(v).font(.system(.subheadline, design: .monospaced))
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
    }
}
