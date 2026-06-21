// 链上消息：发消息（amount 0 + burn + memo 正文）+ 收件箱/发件箱。卡片化，仿 iOS。
import SwiftUI
import V0idKit

struct MessagesView: View {
    @EnvironmentObject var model: AppModel
    @State private var to = ""
    @State private var text = ""
    @State private var burn = "\(Config.messageBurn)"
    @State private var fee = "\(Config.minFee)"
    @State private var encrypt = false
    @State private var box: Box = .inbox
    enum Box: String, CaseIterable, Identifiable { case inbox = "收件箱", outbox = "发件箱"; var id: String { rawValue } }

    var body: some View {
        Group {
            if model.wallet == nil {
                ContentUnavailableState(icon: "envelope", title: "请先创建或登录钱包",
                                        message: "到「钱包」页创建新钱包或导入私钥后再来收发消息。")
            } else {
                ScrollView {
                    VStack(spacing: 20) {
                        compose
                        mailbox
                    }
                    .padding(20)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .navigationTitle("链上消息")
    }

    private var compose: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("发一条链上消息", systemImage: "paperplane").font(.headline)
            Text("消息 = 一笔 amount 0 的交易：烧掉 \(Config.symbol) 进虚空（默认 \(Config.messageBurn)），正文随交易永久上链。")
                .font(.caption).foregroundStyle(.secondary)
            TextField("收件地址 0x + 64 hex", text: $to, axis: .vertical)
                .textFieldStyle(.roundedBorder).font(.system(.footnote, design: .monospaced)).autocorrectionDisabled()
            TextField("消息正文（≤\(Config.plainTextLimit) 字）", text: $text, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(2...5)
            HStack(spacing: 12) {
                labeledField("🔥 销毁额") {
                    TextField("\(Config.messageBurn)", text: $burn).textFieldStyle(.roundedBorder).frame(width: 80)
                }
                labeledField("手续费") {
                    TextField("\(Config.minFee)", text: $fee).textFieldStyle(.roundedBorder).frame(width: 80)
                }
                Spacer()
                Button {
                    model.sendMessage(to: to, text: text, burn: Int(burn) ?? Config.messageBurn,
                                      fee: Int(fee) ?? Config.minFee, encrypt: encrypt)
                    if model.lastError == nil { text = "" }
                } label: {
                    Label(encrypt ? "加密发送" : "发送", systemImage: encrypt ? "lock.fill" : "paperplane.fill")
                }
                .controlSize(.large).buttonStyle(.borderedProminent)
                .disabled(!canSend)
            }
            Toggle(isOn: $encrypt) {
                Text("🔒 端到端加密（用 TA 的公钥加密，只有收发双方能解；密文上链）").font(.caption)
            }
            .toggleStyle(.checkbox)
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
        guard let b = Int(burn), b > 0, let f = Int(fee), f >= Config.minFee else { return false }
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return Crypto.isValidAddress(to.trimmingCharacters(in: .whitespaces).lowercased())
    }

    private var mailbox: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("", selection: $box) {
                ForEach(Box.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden()

            let items = box == .inbox ? model.inboxMsgs : model.outboxMsgs
            if items.isEmpty {
                Text(box == .inbox ? "还没有人给你发消息。" : "你还没发过消息。")
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 12)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(items) { m in messageRow(m) }
                }
            }
        }
    }

    private func messageRow(_ m: DisplayMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(box == .inbox ? "来自 \(model.displayName(m.from))" : "发给 \(model.displayName(m.to))")
                    .font(.caption).foregroundStyle(.secondary)
                if m.encrypted {
                    Text(m.locked ? "🔒 加密（无法解密）" : "🔒 加密").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text("🔥\(m.burn) · #\(m.height) · \(formatTime(m.timestamp))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Text(m.locked ? "（加密内容，仅收发双方可见）" : m.text)
                .font(.body)
                .foregroundStyle(m.locked ? .secondary : .primary)
                .textSelection(.enabled)
        }
        .card(radius: 12, padding: 12)
    }
}
