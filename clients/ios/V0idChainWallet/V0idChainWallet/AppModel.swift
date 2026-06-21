// AppModel：把钱包（Keychain）、节点设置（UserDefaults）、NodeClient 串起来，作为全局 EnvironmentObject。
import Foundation
import SwiftUI
import V0idKit

@MainActor
final class AppModel: ObservableObject {
    /// 默认公网种子节点。
    static let defaultNodeURL = "ws://mc.void1211.com:6001"

    @Published private(set) var wallet: Wallet?
    @Published var nodeURL: String
    @Published var toast: Toast?

    let node: NodeClient

    init() {
        let saved = UserDefaults.standard.string(forKey: "nodeURL") ?? Self.defaultNodeURL
        nodeURL = saved
        node = NodeClient(nodeURL: saved)
        loadWalletFromKeychain()
        if wallet != nil { node.connect() }
    }

    var hasWallet: Bool { wallet != nil }
    var address: String? { wallet?.address }

    // MARK: - 钱包生命周期

    private func loadWalletFromKeychain() {
        guard let seed = (try? Keychain.load()) ?? nil, let w = try? Wallet(seed: seed) else { return }
        wallet = w
        node.address = w.address
    }

    func createWallet() {
        do {
            let w = Wallet.generate()
            try Keychain.save(seed: w.privateKey)
            activate(w)
            show("已创建新钱包")
        } catch {
            show("创建失败：\(error.localizedDescription)", kind: .error)
        }
    }

    func importWallet(privateKeyHex: String) {
        let hex = privateKeyHex.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        do {
            let w = try Wallet(seedHex: hex)
            try Keychain.save(seed: w.privateKey)
            activate(w)
            show("已导入钱包")
        } catch {
            show("导入失败：\(error.localizedDescription)", kind: .error)
        }
    }

    private func activate(_ w: Wallet) {
        wallet = w
        node.address = w.address
        node.connect()
    }

    func resetWallet() {
        try? Keychain.delete()
        node.disconnect()
        wallet = nil
        show("已退出并清除本机私钥")
    }

    // MARK: - 节点设置

    func applyNodeURL(_ url: String) {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        nodeURL = trimmed
        UserDefaults.standard.set(trimmed, forKey: "nodeURL")
        node.nodeURL = trimmed
        node.connect()
        show("已切换节点并重连")
    }

    func reconnect() { node.connect() }

    func claimName(_ rawName: String) -> Bool {
        guard let wallet else { show("请先创建钱包", kind: .error); return false }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let reserved: Set<String> = ["treasury","official","admin","system","null","v0id","v0idchain","genesis","coinbase"]
        guard name.range(of: #"^[a-z0-9_-]{1,20}$"#, options: .regularExpression) != nil,
              !name.hasPrefix("0x"), !reserved.contains(name) else {
            show("昵称无效：1~20 位小写字母/数字/_/-，不能用保留名", kind: .error)
            return false
        }
        do {
            let tx = try node.sendTransfer(wallet: wallet, to: wallet.address, amount: 1, memo: "NAME|\(name)", fee: TxBuilder.minFee)
            show("已广播抢注 @\(name) · txid \(tx.txid.prefix(10))…（先到先得，等一个区块确认）")
            return true
        } catch {
            show(error.localizedDescription, kind: .error)
            return false
        }
    }

    // MARK: - 交易动作（包一层，统一弹 toast）

    func sendTransfer(to: String, amount: Int, memo: String, fee: Int) -> Bool {
        guard let wallet else { return false }
        do {
            let tx = try node.sendTransfer(wallet: wallet, to: to, amount: amount, memo: memo, fee: fee)
            show("已广播转账 · txid \(tx.txid.prefix(10))…")
            return true
        } catch {
            show(error.localizedDescription, kind: .error)
            return false
        }
    }

    func sendMessage(to: String, text: String, burn: Int, fee: Int) -> Bool {
        guard let wallet else { return false }
        do {
            let tx = try node.sendMessage(wallet: wallet, to: to, text: text, burn: burn, fee: fee)
            show("已广播消息 · 烧掉 \(burn) $V0ID · txid \(tx.txid.prefix(10))…")
            return true
        } catch {
            show(error.localizedDescription, kind: .error)
            return false
        }
    }

    // MARK: - Toast

    struct Toast: Identifiable, Equatable {
        enum Kind { case info, error }
        let id = UUID()
        let text: String
        let kind: Kind
    }

    func show(_ text: String, kind: Toast.Kind = .info) {
        toast = Toast(text: text, kind: kind)
    }
}
