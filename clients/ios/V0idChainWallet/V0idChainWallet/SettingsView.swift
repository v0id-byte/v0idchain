// 设置页：节点地址、导出私钥（备份）、退出/重置钱包。
import SwiftUI
import V0idKit

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var node: NodeClient

    @State private var nodeField = ""
    @State private var showKey = false
    @State private var revealedKey: String?
    @State private var confirmReset = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ws://host:port", text: $nodeField, axis: .vertical)
                        .font(.system(.footnote, design: .monospaced))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("连接此节点") { model.applyNodeURL(nodeField) }
                        .disabled(nodeField.trimmingCharacters(in: .whitespaces).isEmpty)
                    HStack {
                        Text("状态"); Spacer(); ConnectionBadge()
                    }
                    Button("用默认公网种子") {
                        nodeField = AppModel.defaultNodeURL
                        model.applyNodeURL(AppModel.defaultNodeURL)
                    }
                    .font(.footnote)
                } header: {
                    Text("节点")
                } footer: {
                    Text("默认 \(AppModel.defaultNodeURL)。本地调试用 ws://127.0.0.1:6001 或 ws://localhost:6001（已在 ATS 例外/本地联网中放行）。")
                }

                Section {
                    if let address = model.address {
                        CopyableRow(label: "地址", value: address)
                    }
                    Button {
                        // 显示私钥前先做身份验证（Face/Touch ID，回退设备密码）。
                        BiometricGate.authenticate(reason: "验证身份以显示私钥") { ok in
                            guard ok else { return }
                            revealedKey = (try? Keychain.load()).flatMap { $0 }.map { Hex.encode($0) }
                            showKey = true
                        }
                    } label: {
                        Label("显示/备份私钥", systemImage: "key.horizontal")
                    }
                    Button(role: .destructive) { confirmReset = true } label: {
                        Label("退出并清除本机私钥", systemImage: "trash")
                    }
                } header: {
                    Text("钱包")
                } footer: {
                    Text("私钥存于本机 Keychain（ThisDeviceOnly，不随 iCloud 同步/备份）。清除前请先备份私钥，否则资产无法找回。")
                }

                Section("关于") {
                    LabeledContent("客户端", value: "v0idChain 轻钱包")
                    LabeledContent("代币", value: "$V0ID")
                    LabeledContent("最低手续费", value: "\(TxBuilder.minFee)")
                    LabeledContent("默认烧币", value: "\(TxBuilder.messageBurn)")
                }
            }
            .navigationTitle("设置")
            .onAppear { if nodeField.isEmpty { nodeField = model.nodeURL } }
            .alert("私钥（64 hex）", isPresented: $showKey) {
                Button("复制") { if let k = revealedKey { Clipboard.copySensitive(k) } }
                Button("关闭", role: .cancel) { revealedKey = nil }
            } message: {
                Text(revealedKey ?? "读取失败")
            }
            .alert("确认清除？", isPresented: $confirmReset) {
                Button("清除", role: .destructive) { model.resetWallet() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("将从本机删除私钥并退出钱包。务必已备份私钥。")
            }
        }
    }
}
