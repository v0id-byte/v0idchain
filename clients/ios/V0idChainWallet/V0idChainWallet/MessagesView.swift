// 消息页：发链上消息（明文或🔒端到端加密）+ 收件箱/发件箱（加密私信自动解密）。
// 加密私信 = ENC| 密文上链，仍是 amount0+burn 消息；只有收发双方能用 ECDH 共享密钥解开。
import SwiftUI
import V0idKit

struct MessagesView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var node: NodeClient

    enum Box: String, CaseIterable { case inbox = "收件箱", outbox = "发件箱" }
    @State private var box: Box = .inbox
    @State private var showCompose = false

    private var messages: [ChainMessage] { box == .inbox ? node.inbox() : node.outbox() }
    private var registry: NameRegistry { node.nameRegistry() }

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
                        MessageRow(msg: msg, isInbox: box == .inbox,
                                   registry: registry,
                                   decrypted: model.decrypt(msg))
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
    let registry: NameRegistry
    /// 解密结果：非加密 = 原文；加密且解开 = 明文；加密但解不开 = nil。
    let decrypted: String?

    private var isEncrypted: Bool { msg.text.hasPrefix("ENC|") }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                AddressLabel(address: isInbox ? msg.from : msg.to,
                             registry: registry,
                             prefix: isInbox ? "来自 " : "发给 ")
                Spacer()
                Text("🔥\(msg.burn) · #\(msg.height)").font(.caption2).foregroundStyle(.secondary)
            }
            if isEncrypted {
                if let plain = decrypted {
                    Label(plain, systemImage: "lock.fill").font(.body).foregroundStyle(.primary)
                } else {
                    Label("(无法解密)", systemImage: "lock.slash").font(.body).foregroundStyle(.secondary)
                }
            } else {
                Text(decrypted ?? msg.text).font(.body)
            }
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
    @State private var encrypt = false
    @State private var burnText = "\(TxBuilder.messageBurn)"
    @State private var feeText = "\(TxBuilder.minFee)"

    private var burn: Int? { Int(burnText) }
    private var fee: Int? { Int(feeText) }
    private var canSend: Bool {
        guard let burn, burn > 0, let fee, fee >= TxBuilder.minFee, !text.isEmpty else { return false }
        // 明文上限 128；加密时给密文留余量，但明文本身仍限 128（与 web 一致）。
        guard text.unicodeScalars.count <= 128 else { return false }
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
                    Toggle(isOn: $encrypt) {
                        Label("端到端加密（🔒只有对方能解）", systemImage: encrypt ? "lock.fill" : "lock.open")
                    }
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
                        let toAddr = to.trimmingCharacters(in: .whitespaces).lowercased()
                        let ok: Bool
                        if encrypt {
                            ok = model.sendEncryptedMessage(to: toAddr, plaintext: text,
                                                            burn: burn ?? TxBuilder.messageBurn, fee: fee ?? TxBuilder.minFee)
                        } else {
                            ok = model.sendMessage(to: toAddr, text: text,
                                                   burn: burn ?? TxBuilder.messageBurn, fee: fee ?? TxBuilder.minFee)
                        }
                        if ok { dismiss() }
                    } label: {
                        Label(encrypt ? "加密并烧币发送" : "烧币发送",
                              systemImage: encrypt ? "lock.fill" : "flame.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).disabled(!canSend)
                } footer: {
                    Text(encrypt
                         ? "加密私信用你与收件人的 ECDH 共享密钥（XChaCha20-Poly1305）封装明文成 ENC| 密文再上链；全网都看得到密文，但只有你俩能解。"
                         : "链上消息 = amount 0 + 销毁 \(burn ?? 0) + 正文。销毁的 $V0ID 进虚空永久不可花；另付手续费给矿工。")
                }
            }
            .navigationTitle(encrypt ? "发加密私信" : "发消息")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }
}
