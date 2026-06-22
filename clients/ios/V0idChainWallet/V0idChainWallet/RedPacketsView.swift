// 红包页：发红包（拼手气/均分）+ 抢红包 + 退款 + 列表（含领取明细）。
// 发红包 = 转给托管地址 RED|<份数>|<r|e>；抢 = 自转 amount0 CLAIM|<id>；退 = 自转 amount0 REFUND|<id>。
// 入账由共识从托管池派发（ChainState 复刻同一套 applyTx），故余额始终与全网一致。
import SwiftUI
import V0idKit

struct RedPacketsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var node: NodeClient
    @State private var showSend = false

    private var registry: NameRegistry { node.nameRegistry() }
    private var packets: [RedPacketView] { node.redPackets() }

    var body: some View {
        NavigationStack {
            Group {
                if packets.isEmpty {
                    ContentUnavailableView(
                        "还没有红包",
                        systemImage: "gift",
                        description: Text("发一个红包：把总额转入托管地址，写一条 RED memo，全网即可抢。"))
                } else {
                    List(packets) { packet in
                        RedPacketCard(packet: packet,
                                      registry: registry,
                                      myAddress: model.address)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("红包")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSend = true } label: { Image(systemName: "plus.circle") }
                }
            }
            .sheet(isPresented: $showSend) { SendRedSheet() }
        }
    }
}

private struct RedPacketCard: View {
    @EnvironmentObject var model: AppModel
    let packet: RedPacketView
    let registry: NameRegistry
    let myAddress: String?

    private var alreadyClaimed: Bool { packet.claims.contains { $0.who == myAddress } }
    private var isCreator: Bool { packet.creator == myAddress }
    private var canClaim: Bool {
        !packet.done && packet.remainingCount > 0 && !alreadyClaimed && !isCreator
    }
    private var canRefund: Bool { isCreator && !packet.done && packet.remaining > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(packet.mode == .random ? "拼手气" : "均分", systemImage: "gift.fill")
                    .font(.headline).foregroundStyle(.red)
                Spacer()
                Text("#\(packet.createHeight)").font(.caption2).foregroundStyle(.secondary)
            }
            HStack {
                Text("发起人").font(.caption).foregroundStyle(.secondary)
                AddressLabel(address: packet.creator, registry: registry)
            }
            HStack {
                Text("\(packet.total) $V0ID · \(packet.count) 份").font(.subheadline.monospaced())
                Spacer()
                if packet.refunded {
                    Text("已退款").font(.caption).foregroundStyle(.orange)
                } else if packet.done {
                    Text("已抢完").font(.caption).foregroundStyle(.green)
                } else {
                    Text("剩 \(packet.remaining) / \(packet.remainingCount) 份").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !packet.claims.isEmpty {
                Divider()
                ForEach(Array(packet.claims.enumerated()), id: \.offset) { _, claim in
                    HStack {
                        Text(claim.who.display(in: registry)).font(.caption)
                        Spacer()
                        Text("+\(claim.amount)").font(.caption.monospaced()).foregroundStyle(.green)
                    }
                }
            }
            if canClaim || canRefund {
                HStack {
                    if canClaim {
                        Button { _ = model.claimRedPacket(id: packet.id) } label: {
                            Label("抢", systemImage: "hand.tap").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent).controlSize(.small).tint(.red)
                    }
                    if canRefund {
                        Button { _ = model.refundRedPacket(id: packet.id) } label: {
                            Label("退款", systemImage: "arrow.uturn.backward").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                .padding(.top, 2)
            } else if alreadyClaimed {
                Text("你已抢过这个红包").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct SendRedSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var totalText = ""
    @State private var countText = ""
    @State private var mode: RedMode = .random

    private var total: Int? { Int(totalText.trimmingCharacters(in: .whitespaces)) }
    private var count: Int? { Int(countText.trimmingCharacters(in: .whitespaces)) }
    private var canSend: Bool {
        guard let total, let count, total >= 1, count >= 1, count <= 100 else { return false }
        return total >= count
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("红包总额（$V0ID）") {
                    TextField("0", text: $totalText)
                        .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                }
                Section("份数（1~100）") {
                    TextField("0", text: $countText)
                        .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                }
                Section("玩法") {
                    Picker("玩法", selection: $mode) {
                        Text("拼手气").tag(RedMode.random)
                        Text("均分").tag(RedMode.equal)
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    Button {
                        if model.sendRedPacket(total: total ?? 0, count: count ?? 0, mode: mode) { dismiss() }
                    } label: {
                        Label("发红包", systemImage: "gift.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).disabled(!canSend)
                } footer: {
                    Text("总额转入托管地址锁定；别人用 CLAIM 抢、金额由领取所在区块 hash 确定（拼手气）或均分。抢完即结，发起人可在过期后退回剩余。")
                }
            }
            .withKeyboardDismiss()
            .navigationTitle("发红包")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }
}
