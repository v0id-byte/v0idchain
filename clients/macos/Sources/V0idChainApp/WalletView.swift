// 钱包页：英雄余额卡 + 地址/nonce 卡（仿 iOS）；无钱包时居中引导（创建 / 登录）。
// 私钥导出 / 切换 / 退出移到「设置」页。
import SwiftUI
import V0idKit

struct WalletView: View {
    @EnvironmentObject var model: AppModel
    @State private var claimInput = ""

    var body: some View {
        ScrollView {
            if let w = model.wallet {
                VStack(spacing: 20) {
                    balanceCard
                    infoCard(w)
                    claimCard
                    if !model.pending.isEmpty { pendingCard }
                }
                .padding(20)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            } else {
                onboarding
            }
        }
        .navigationTitle("钱包")
    }

    // ---- 英雄余额卡 ----
    private var balanceCard: some View {
        VStack(spacing: 8) {
            Text("余额").font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(model.balance)")
                    .font(.system(size: 46, weight: .bold, design: .rounded))
                    .contentTransition(.numericText())
                Text(Config.symbol).font(.headline).foregroundStyle(.secondary)
            }
            if let name = model.myName {
                Text("@\(name)").font(.subheadline.weight(.medium)).foregroundStyle(.tint)
            }
            if model.pendingOut > 0 {
                Text("可用 \(model.available) · 待发占用 \(model.pendingOut)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ConnectionBadge(peers: model.peerCount).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    // ---- 地址 / nonce 卡 ----
    private func infoCard(_ w: Wallet) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            CopyableRow(label: "我的地址（= 公钥，可公开）", value: w.address)
            Divider()
            row("下一笔 nonce", "\(model.nextNonce)", icon: "number")
            if !model.pending.isEmpty {
                row("待打包交易", "\(model.pending.count)", icon: "clock", color: .orange)
            }
        }
        .card()
    }

    private func row(_ k: String, _ v: String, icon: String, color: Color = .primary) -> some View {
        HStack {
            Label(k, systemImage: icon)
            Spacer()
            Text(v).font(.system(.body, design: .monospaced))
        }
        .font(.subheadline)
        .foregroundStyle(color == .primary ? .primary : color)
    }

    // ---- 链上昵称卡 ----
    private var claimCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("🪪 链上昵称").font(.headline)
            HStack(spacing: 8) {
                TextField(model.myName.map { "改名（当前 @\($0)）" } ?? "小写字母/数字/_/-（1~20 位）", text: $claimInput)
                    .textFieldStyle(.roundedBorder)
                Button("抢注") {
                    let name = claimInput
                    model.claimName(name)
                    if model.lastError == nil { claimInput = "" }
                }
                .disabled(claimInput.trimmingCharacters(in: .whitespaces).isEmpty)
                .buttonStyle(.borderedProminent)
            }
            Text("自转 1 $V0ID + 手续费 1，先到先得，全网唯一。")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .card()
    }

    // ---- 待打包交易卡 ----
    private var pendingCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("待打包交易").font(.headline)
            ForEach(model.pending) { tx in
                HStack(spacing: 8) {
                    Text(txKind(tx).label).font(.caption).foregroundStyle(txKind(tx).color)
                    Text(short(tx.txid)).font(.system(.footnote, design: .monospaced)).foregroundStyle(.secondary)
                    Spacer()
                    Text("→ \(short(tx.to))").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .card()
    }

    // ---- 无钱包：居中引导（创建 / 登录）----
    @State private var importHex = ""
    @State private var showImport = false

    private var onboarding: some View {
        VStack(spacing: 24) {
            Spacer(minLength: 40)
            VStack(spacing: 10) {
                Image(systemName: "cube.transparent").font(.system(size: 56, weight: .light))
                Text("v0idChain 轻钱包").font(.largeTitle.weight(.semibold))
                Text("本地保管私钥 · 本地签名 · 连节点收发 \(Config.symbol)")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }

            VStack(spacing: 12) {
                Button {
                    model.generateWallet()
                } label: {
                    Label("创建新钱包", systemImage: "sparkles").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)

                Button {
                    withAnimation { showImport.toggle() }
                } label: {
                    Label("登录已有钱包（导入私钥）", systemImage: "key").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered).controlSize(.large)

                if showImport {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("私钥 64 hex，例如 0102…1f20", text: $importHex)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.footnote, design: .monospaced))
                        Button("登录") {
                            model.importWallet(privateKeyHex: importHex); importHex = ""
                        }
                        .disabled(importHex.trimmingCharacters(in: .whitespaces).count != 64)
                        Text("把挖矿钱包带到 Mac 用，无需转账、不花 gas。")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(.top, 4)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .frame(maxWidth: 360)

            Text("私钥只存本机 Keychain，绝不上传。")
                .font(.caption2).foregroundStyle(.secondary)
            Spacer(minLength: 40)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }
}
