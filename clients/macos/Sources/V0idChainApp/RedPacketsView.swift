// 链上红包：发红包（托管 + memo RED|count|mode）/ 抢红包（CLAIM）/ 退款（REFUND）。
import SwiftUI
import V0idKit

struct RedPacketsView: View {
    @EnvironmentObject var model: AppModel
    @State private var totalText = "10"
    @State private var countText = "3"
    @State private var isRandom = true

    var body: some View {
        Group {
            if model.wallet == nil {
                ContentUnavailableState(icon: "gift", title: "请先创建或登录钱包",
                                        message: "到「钱包」页创建新钱包或导入私钥后再来发红包。")
            } else {
                ScrollView {
                    VStack(spacing: 20) {
                        sendCard
                        listCard
                    }
                    .padding(20)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .navigationTitle("链上红包")
    }

    // MARK: - 发红包卡

    private var sendCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("发一个链上红包", systemImage: "gift").font(.headline)
            Text("红包总额转进托管地址，抢的人各得一份；过期未抢完可退款。")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                labeledField("总额 \(Config.symbol)") {
                    TextField("10", text: $totalText).textFieldStyle(.roundedBorder).frame(width: 80)
                }
                labeledField("份数") {
                    TextField("3", text: $countText).textFieldStyle(.roundedBorder).frame(width: 80)
                }
                labeledField("类型") {
                    Picker("", selection: $isRandom) {
                        Text("拼手气").tag(true)
                        Text("均分").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 140)
                }
                Spacer()
                Button {
                    model.sendRedPacket(
                        total: Int(totalText) ?? 0,
                        count: Int(countText) ?? 1,
                        isRandom: isRandom)
                    if model.lastError == nil { totalText = "10"; countText = "3" }
                } label: {
                    Label("发出", systemImage: "gift.fill")
                }
                .controlSize(.large).buttonStyle(.borderedProminent)
                .disabled(!canSend)
            }
        }
        .card()
    }

    private func labeledField<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            content()
        }
    }

    private var canSend: Bool {
        guard let total = Int(totalText), total >= 1,
              let count = Int(countText), count >= 1, count <= Config.maxRedCount,
              total >= count else { return false }
        return model.available >= total + Config.minFee
    }

    // MARK: - 红包列表

    private var listCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("链上红包").font(.headline)
            let packets = model.redPackets
            if packets.isEmpty {
                Text("链上暂无红包。").foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(packets) { p in packetRow(p) }
                }
            }
        }
        .card()
    }

    private func packetRow(_ p: RedPacketView) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                statusBadge(p)
                Spacer()
                Text("· #\(p.createHeight)").font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("发起：\(short(p.creator))").font(.caption).foregroundStyle(.secondary)
                    Text("\(p.total) \(Config.symbol) / \(p.count) 份 · \(p.isRandom ? "拼手气" : "均分")")
                        .font(.subheadline)
                }
                Spacer()
                if !p.done {
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("剩余 \(p.remaining) / \(p.remainingCount) 份")
                            .font(.caption).foregroundStyle(.secondary)
                        actionButton(p)
                    }
                }
            }
            if !p.claims.isEmpty {
                Divider()
                ForEach(p.claims) { c in
                    HStack {
                        Text(short(c.who)).font(.caption2).foregroundStyle(.secondary)
                        Spacer()
                        Text("+\(c.amount) · #\(c.height)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .card(radius: 12, padding: 12)
    }

    private func statusBadge(_ p: RedPacketView) -> some View {
        let label = p.refunded ? "已退款" : p.done ? "已抢完" : "进行中"
        let color: Color = (p.done || p.refunded) ? .gray : .green
        return Text(label)
            .font(.caption2)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    @ViewBuilder
    private func actionButton(_ p: RedPacketView) -> some View {
        if p.creator == (model.address ?? "") {
            Button("退款") { model.refundRedPacket(id: p.id) }
                .controlSize(.small).buttonStyle(.bordered)
        } else if !p.claims.contains(where: { $0.who == (model.address ?? "") }) {
            Button("抢红包") { model.claimRedPacket(id: p.id) }
                .controlSize(.small).buttonStyle(.borderedProminent)
        }
    }
}
