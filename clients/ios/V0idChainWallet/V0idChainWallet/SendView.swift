// 转账页：收款地址 / 金额 / 手续费(默认1) / 备注 → 本地签名广播。
import SwiftUI
import V0idKit

struct SendView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var node: NodeClient

    @State private var to = ""
    @State private var amountText = ""
    @State private var feeText = "1"
    @State private var memo = ""

    private var amount: Int? { Int(amountText.trimmingCharacters(in: .whitespaces)) }
    private var fee: Int? { Int(feeText.trimmingCharacters(in: .whitespaces)) }

    private var canSend: Bool {
        guard let amount, amount > 0, let fee, fee >= TxBuilder.minFee else { return false }
        return Crypto.isValidAddress(to.trimmingCharacters(in: .whitespaces).lowercased())
            && to.lowercased() != Crypto.nullAddress
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("收款方") {
                    TextField("0x + 64 位 hex 地址", text: $to, axis: .vertical)
                        .font(.system(.footnote, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("金额与手续费") {
                    LabeledContent("金额（$V0ID）") {
                        TextField("0", text: $amountText)
                            .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                    }
                    LabeledContent("手续费 / gas") {
                        TextField("1", text: $feeText)
                            .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                    }
                }
                Section("备注（可空，≤128 码点）") {
                    TextField("备注…", text: $memo, axis: .vertical)
                }
                Section {
                    Button {
                        let ok = model.sendTransfer(
                            to: to.trimmingCharacters(in: .whitespaces).lowercased(),
                            amount: amount ?? 0,
                            memo: memo,
                            fee: fee ?? TxBuilder.minFee)
                        if ok { to = ""; amountText = ""; memo = ""; feeText = "1" }
                    } label: {
                        Label("签名并广播", systemImage: "paperplane.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSend)
                } footer: {
                    Text("可用余额 \(node.balance()) $V0ID。交易在本机用 ed25519 签名后广播到节点，约一个区块后确认。")
                }
            }
            .withKeyboardDismiss()
            .navigationTitle("转账")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { ConnectionBadge() } }
        }
    }
}
