// 红包：发（转给托管 + memo）/ 抢（CLAIM）/ 退款（REFUND，过期后）。拼手气随机额由抢中区块 hash 决定，抢前不可预测。
import SwiftUI
import V0idKit

struct RedPacketsView: View {
    @EnvironmentObject var model: AppModel
    @State private var total = ""
    @State private var count = ""
    @State private var equal = false   // 默认拼手气随机

    private var openPackets: [RedPacketView] { model.redPackets.filter { !$0.done } }
    private var done: [RedPacketView] { model.redPackets.filter { $0.done } }

    var body: some View {
        Group {
            if model.wallet == nil {
                ContentUnavailableState(icon: "gift", title: "请先创建或登录钱包",
                                        message: "到「钱包」页创建新钱包或导入私钥后再来发 / 抢红包。")
            } else {
                ScrollView {
                    VStack(spacing: 20) {
                        sendCard
                        openCard
                        if !done.isEmpty { doneCard }
                    }
                    .padding(20)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .navigationTitle("红包 · \(openPackets.count) 个在抢")
    }

    private var sendCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("发一个红包", systemImage: "gift.fill").font(.headline)
            Text("总额转入链上托管；别人发 CLAIM 抢，拼手气份额由抢中区块 hash 决定；过期未抢完你可退款。")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                labeled("总额 \(Config.symbol)") {
                    TextField("100", text: $total).textFieldStyle(.roundedBorder).frame(width: 110)
                }
                labeled("份数（≤ 总额）") {
                    TextField("10", text: $count).textFieldStyle(.roundedBorder).frame(width: 110)
                }
                Spacer()
                Button {
                    model.redSend(total: Int(total) ?? 0, count: Int(count) ?? 0, mode: equal ? .equal : .random)
                    if model.lastError == nil { total = ""; count = "" }
                } label: { Label("发红包", systemImage: "paperplane.fill") }
                .controlSize(.large).buttonStyle(.borderedProminent)
                .disabled((Int(total) ?? 0) <= 0 || (Int(count) ?? 0) <= 0)
            }
            Toggle(isOn: $equal) { Text("均分（默认拼手气随机）").font(.caption) }
                .toggleStyle(.checkbox)
        }
        .card()
    }

    private var openCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("在抢").font(.headline)
            if openPackets.isEmpty {
                Text("还没有红包，发一个吧 🧧").foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(openPackets) { p in packetRow(p) }
                }
            }
        }
    }

    private func packetRow(_ p: RedPacketView) -> some View {
        let me = model.address
        let mine = p.creator == me
        let grabbed = p.claims.contains { $0.who == me }
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("\(p.total) \(Config.symbol)").font(.headline).monospacedDigit()
                    Text(p.mode == .equal ? "均分" : "拼手气").font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                    if mine { Text("我发的").font(.caption2).foregroundStyle(.orange) }
                }
                Text("剩 \(p.remaining) / \(p.remainingCount) 份（共 \(p.count)）")
                    .font(.caption).foregroundStyle(.secondary)
                Text("发起 \(model.displayName(p.creator)) · #\(p.createHeight)")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            if mine {
                Button("退款") { model.redRefund(p) }.buttonStyle(.bordered).controlSize(.small)
            } else if grabbed {
                Text("已抢 ✓").font(.caption).foregroundStyle(.green)
            } else {
                Button("抢") { model.redGrab(p) }.buttonStyle(.borderedProminent).controlSize(.small)
            }
        }
        .card(radius: 12, padding: 12)
    }

    private var doneCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("已结束").font(.subheadline).foregroundStyle(.secondary)
            ForEach(done.prefix(12)) { p in
                HStack {
                    Text(p.refunded ? "↩️ 已退" : "✓ 抢完").font(.caption)
                        .foregroundStyle(p.refunded ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.green))
                    Text("\(p.total) \(Config.symbol) / \(p.count) 份").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text("发起 \(model.displayName(p.creator))").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .card()
    }

    private func labeled<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            content()
        }
    }
}
