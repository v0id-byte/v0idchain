// 设置页：导出私钥 / 登录其它钱包（切换）/ 退出 / 关于。卡片化，仿 iOS。
import SwiftUI
import V0idKit

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var switchHex = ""
    @State private var revealKey = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                if let w = model.wallet {
                    exportCard(w)
                    switchCard
                    forgetCard
                } else {
                    Text("还没有钱包。请到「钱包」页创建或登录。")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .card()
                }
                aboutCard
            }
            .padding(20)
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("设置")
    }

    private func exportCard(_ w: Wallet) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("导出私钥", systemImage: "key.horizontal").font(.headline)
            Text("⚠️ 64 hex 字符。任何拿到它的人都能动用此钱包——务必妥善保管，泄露即丢币。")
                .font(.caption).foregroundStyle(.secondary)
            if revealKey {
                CopyableRow(label: "私钥", value: w.privateKeyHex, sensitive: true)
            } else {
                Button("显示私钥") {
                    // 显示私钥前先做身份验证（Touch ID，回退账户密码）。
                    BiometricGate.authenticate(reason: "验证身份以显示私钥") { ok in if ok { revealKey = true } }
                }
                .buttonStyle(.bordered)
            }
        }
        .card()
        .tint(.orange)
    }

    private var switchCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("登录其它钱包", systemImage: "arrow.left.arrow.right").font(.headline)
            Text("用另一个 64-hex 私钥替换当前钱包（如把挖矿钱包带进来用，无需转账、不花 gas）。")
                .font(.caption).foregroundStyle(.secondary)
            TextField("私钥 64 hex…", text: $switchHex)
                .textFieldStyle(.roundedBorder)
                .font(.system(.footnote, design: .monospaced))
            Button("切换到该钱包") {
                model.importWallet(privateKeyHex: switchHex); switchHex = ""; revealKey = false
            }
            .buttonStyle(.bordered)
            .disabled(switchHex.trimmingCharacters(in: .whitespaces).count != 64)
        }
        .card()
    }

    private var forgetCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("退出钱包", systemImage: "trash").font(.headline)
            Text("从本机 Keychain 删除私钥。请先确认你已备份私钥，否则将无法恢复。")
                .font(.caption).foregroundStyle(.secondary)
            Button(role: .destructive) {
                model.forgetWallet(); revealKey = false
            } label: {
                Label("退出并删除私钥", systemImage: "trash")
            }
            .buttonStyle(.bordered)
        }
        .card()
    }

    private var aboutCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("关于", systemImage: "info.circle").font(.headline)
            kv("链", Config.chainName)
            kv("代币", Config.symbol)
            kv("客户端", "macOS 轻客户端 · 不挖矿")
            Text("教学 / 玩具链，\(Config.symbol) 无现实价值；本 App 不含任何真钱 / 支付功能。")
                .font(.caption2).foregroundStyle(.secondary).padding(.top, 2)
        }
        .card()
    }

    private func kv(_ k: String, _ v: String) -> some View {
        HStack { Text(k).foregroundStyle(.secondary); Spacer(); Text(v) }.font(.subheadline)
    }
}
