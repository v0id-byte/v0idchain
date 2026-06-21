// 转账页：收款地址 / 金额 / 手续费(默认 1) / 备注 → 本地签名广播。Form/Section 风格，仿 iOS。
import SwiftUI
import V0idKit

struct SendView: View {
    @EnvironmentObject var model: AppModel
    @State private var to = ""
    @State private var amount = ""
    @State private var fee = "\(Config.minFee)"
    @State private var memo = ""

    var body: some View {
        Group {
            if model.wallet == nil {
                ContentUnavailableState(icon: "wallet.pass", title: "请先创建或登录钱包",
                                        message: "到「钱包」页创建新钱包或导入私钥后再来转账。")
            } else {
                form
            }
        }
        .navigationTitle("转账")
    }

    private var form: some View {
        Form {
            Section("收款方") {
                TextField("0x + 64 位 hex 地址", text: $to, axis: .vertical)
                    .font(.system(.footnote, design: .monospaced))
                    .autocorrectionDisabled()
            }
            Section("金额与手续费") {
                LabeledContent("金额（\(Config.symbol)）") {
                    TextField("0", text: $amount).multilineTextAlignment(.trailing).frame(width: 120)
                }
                LabeledContent("手续费 / gas") {
                    TextField("\(Config.minFee)", text: $fee).multilineTextAlignment(.trailing).frame(width: 120)
                }
            }
            Section("备注（可空，≤\(Config.maxMemo) 码点）") {
                TextField("随交易一起上链、计入签名…", text: $memo, axis: .vertical)
            }
            Section {
                Button {
                    model.send(to: to, amount: Int(amount) ?? 0, fee: Int(fee) ?? Config.minFee, memo: memo)
                    if model.lastError == nil { to = ""; amount = ""; memo = ""; fee = "\(Config.minFee)" }
                } label: {
                    Label("签名并广播", systemImage: "paperplane.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canSend)
            } footer: {
                Text("可用余额 \(model.available) \(Config.symbol)。本机用 ed25519 签名后广播到所有连接，约一个区块确认。下一笔 nonce = \(model.nextNonce)。")
            }
        }
        .formStyle(.grouped)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
    }

    private var canSend: Bool {
        guard let amt = Int(amount), amt > 0, let f = Int(fee), f >= Config.minFee else { return false }
        return Crypto.isValidAddress(to.trimmingCharacters(in: .whitespaces).lowercased())
    }
}

/// 简易空状态占位（仿 iOS ContentUnavailableView，但兼容 macOS 13）。
struct ContentUnavailableState: View {
    let icon: String
    let title: String
    let message: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 44, weight: .light)).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: 360)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
