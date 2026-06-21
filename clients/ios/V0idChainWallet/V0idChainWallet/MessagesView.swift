// 消息页：发链上消息（amount=0 + burn 默认5 + memo 正文）+ 收件箱/发件箱。
import SwiftUI
import V0idKit

struct MessagesView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var node: NodeClient

    enum Box: String, CaseIterable { case inbox = "收件箱", outbox = "发件箱" }
    @State private var box: Box = .inbox
    @State private var showCompose = false

    private var messages: [ChainMessage] { box == .inbox ? node.inbox() : node.outbox() }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $box) {
                    ForEach(Box.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding()

                if messages.isEmpty {
                    ContentUnavailableView(
                        box == .inbox ? "还没有人给你发消息" : "你还没发过消息",
                        systemImage: "tray",
                        description: Text("消息会在所连节点把交易打包进区块后出现。"))
                        .frame(maxHeight: .infinity)
                } else {
                    List(messages) { msg in
                        MessageRow(msg: msg, isInbox: box == .inbox)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("链上消息")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showCompose = true } label: { Image(systemName: "square.and.pencil") }
                }
            }
            .sheet(isPresented: $showCompose) { ComposeSheet() }
        }
    }
}

private struct MessageRow: View {
    let msg: ChainMessage
    let isInbox: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(isInbox ? "来自 \(msg.from.shortAddress)" : "发给 \(msg.to.shortAddress)")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("🔥\(msg.burn) · #\(msg.height)").font(.caption2).foregroundStyle(.secondary)
            }
            Text(msg.text).font(.body)
        }
        .padding(.vertical, 4)
    }
}

private struct ComposeSheet: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var node: NodeClient
    @Environment(\.dismiss) private var dismiss

    @State private var to = ""
    @State private var text = ""
    @State private var burnText = "\(TxBuilder.messageBurn)"
    @State private var feeText = "\(TxBuilder.minFee)"

    private var burn: Int? { Int(burnText) }
    private var fee: Int? { Int(feeText) }
    private var canSend: Bool {
        guard let burn, burn > 0, let fee, fee >= TxBuilder.minFee, !text.isEmpty else { return false }
        let addr = to.trimmingCharacters(in: .whitespaces).lowercased()
        return Crypto.isValidAddress(addr) && addr != Crypto.nullAddress
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("收件人地址") {
                    TextField("0x + 64 位 hex", text: $to, axis: .vertical)
                        .font(.system(.footnote, design: .monospaced))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section("正文（≤128 码点）") {
                    TextField("写点什么…", text: $text, axis: .vertical).lineLimit(3...8)
                }
                Section("烧币与手续费") {
                    LabeledContent("销毁 burn（进虚空）") {
                        TextField("5", text: $burnText).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                    }
                    LabeledContent("手续费 / gas") {
                        TextField("1", text: $feeText).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                    }
                }
                Section {
                    Button {
                        let ok = model.sendMessage(
                            to: to.trimmingCharacters(in: .whitespaces).lowercased(),
                            text: text, burn: burn ?? TxBuilder.messageBurn, fee: fee ?? TxBuilder.minFee)
                        if ok { dismiss() }
                    } label: {
                        Label("烧币发送", systemImage: "flame.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).disabled(!canSend)
                } footer: {
                    Text("链上消息 = amount 0 + 销毁 \(burn ?? 0) + 正文。销毁的 $V0ID 进虚空永久不可花；另付手续费给矿工。需所连节点已支持消息（公网种子已支持）。")
                }
            }
            .navigationTitle("发消息")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }
}
