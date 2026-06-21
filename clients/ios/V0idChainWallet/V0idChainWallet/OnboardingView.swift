// 引导页：生成新钱包 / 用 64-hex 私钥导入。
import SwiftUI
import V0idKit

struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @State private var importHex = ""
    @State private var showImport = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            VStack(spacing: 10) {
                Image(systemName: "cube.transparent")
                    .font(.system(size: 56, weight: .light))
                Text("v0idChain 轻钱包")
                    .font(.largeTitle.weight(.semibold))
                Text("本地保管私钥 · 本地签名 · 连节点收发 $V0ID")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 12) {
                Button {
                    model.createWallet()
                } label: {
                    Label("生成新钱包", systemImage: "sparkles")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button {
                    showImport = true
                } label: {
                    Label("导入已有私钥", systemImage: "key")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
            .padding(.horizontal)

            Text("私钥只存本机 Keychain（ThisDeviceOnly），绝不上传。")
                .font(.caption2).foregroundStyle(.secondary)
            Spacer()
        }
        .padding()
        .sheet(isPresented: $showImport) {
            ImportSheet(hex: $importHex) {
                model.importWallet(privateKeyHex: importHex)
                importHex = ""
                showImport = false
            }
        }
    }
}

private struct ImportSheet: View {
    @Binding var hex: String
    @Environment(\.dismiss) private var dismiss
    let onImport: () -> Void

    private var isValid: Bool {
        let h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        return h.count == 64 && h.allSatisfy { $0.isHexDigit }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("64 位十六进制私钥") {
                    TextField("0102…1f20（64 hex 字符）", text: $hex, axis: .vertical)
                        .font(.system(.footnote, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Button("导入", action: onImport)
                        .disabled(!isValid)
                } footer: {
                    Text("私钥 = 32 字节种子的 hex。导入后会派生地址并连到节点。")
                }
            }
            .navigationTitle("导入钱包")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }
}
