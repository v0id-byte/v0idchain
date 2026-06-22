// 通用 UI 小工具：地址缩写、复制、连接状态徽标、toast 浮层、生物识别门限。
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import LocalAuthentication
import V0idKit

/// 生物识别门限：敏感操作（显示/备份私钥）前要求设备主人验证（Face/Touch ID，失败回退设备密码）。
/// - 用 .deviceOwnerAuthentication（生物识别 OR 密码），没录入 Face/Touch ID 也能用；
/// - 设备没设密码时优雅放行（不把教学钱包用户锁死）；completion 一律主线程回调（驱动 SwiftUI）。
/// - 操作层门限，不改 Keychain item 访问控制（item 级门限的主线程死锁/锁死风险留作上设备实测后续，审计 F04）。
enum BiometricGate {
    static func authenticate(reason: String, completion: @escaping (Bool) -> Void) {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            DispatchQueue.main.async { completion(true) } // 无可用验证手段（未设密码）→ 放行
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
            DispatchQueue.main.async { completion(success) }
        }
    }
}

extension String {
    /// 地址缩写：0x1234…abcd
    var shortAddress: String {
        guard count > 16 else { return self }
        return "\(prefix(8))…\(suffix(6))"
    }
}

enum Clipboard {
    static func copy(_ s: String) { UIPasteboard.general.string = s }

    /// 敏感内容（私钥）复制：60s 自动过期 + 仅本机（不参与 Handoff / 通用剪贴板），
    /// 缩短私钥停留在系统剪贴板、被其他 App 读取的窗口。普通地址/txid 仍走 `copy`（不过期，方便粘贴）。
    static func copySensitive(_ s: String, ttl: TimeInterval = 60) {
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: s]],
            options: [
                .localOnly: true,
                .expirationDate: Date(timeIntervalSinceNow: ttl),
            ]
        )
    }
}

extension String {
    /// 地址 → 显示文本：有昵称则 `@name`，否则地址缩写。
    func display(in registry: NameRegistry) -> String {
        if let name = registry.name(for: self) { return "@\(name)" }
        return shortAddress
    }
}

/// 地址标签：有昵称显示 `@name`（主）+ 地址缩写（次）；无昵称仅显示地址缩写。
struct AddressLabel: View {
    let address: String
    let registry: NameRegistry
    var prefix: String = ""           // 例如 "来自 " / "发给 "

    var body: some View {
        if let name = registry.name(for: address) {
            VStack(alignment: .leading, spacing: 1) {
                Text("\(prefix)@\(name)").font(.subheadline).foregroundStyle(.primary)
                Text(address.shortAddress).font(.caption2).foregroundStyle(.secondary)
            }
        } else {
            Text("\(prefix)\(address.shortAddress)").font(.subheadline).foregroundStyle(.primary)
        }
    }
}

extension NodeClient.Status {
    var label: String {
        switch self {
        case .disconnected: return "未连接"
        case .connecting: return "连接中"
        case .syncing: return "同步中"
        case .connected: return "已连接"
        }
    }
    var color: Color {
        switch self {
        case .disconnected: return .secondary
        case .connecting, .syncing: return .orange
        case .connected: return .green
        }
    }
}

/// 顶部连接状态徽标。
struct ConnectionBadge: View {
    @EnvironmentObject var node: NodeClient
    private var isFailed: Bool { node.status != .connected && node.connectionError != nil }

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(isFailed ? Color.red : node.status.color).frame(width: 8, height: 8)
            Text(isFailed ? "连接失败 · 高度 \(node.height)" : "\(node.status.label) · 高度 \(node.height)")
                .font(.caption).foregroundStyle(isFailed ? Color.red : Color.secondary)
        }
    }
}

/// 一行 label + 可复制的 monospace 值。
struct CopyableRow: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            HStack {
                Text(value).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                Spacer(minLength: 8)
                Button { Clipboard.copy(value) } label: { Image(systemName: "doc.on.doc") }
                    .buttonStyle(.borderless)
            }
        }
    }
}

// MARK: - Toast

struct ToastView: View {
    let toast: AppModel.Toast
    var body: some View {
        Text(toast.text)
            .font(.subheadline)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(toast.kind == .error ? Color.red.opacity(0.5) : Color.clear))
            .foregroundStyle(toast.kind == .error ? Color.red : Color.primary)
            .shadow(radius: 8, y: 4)
            .padding(.bottom, 24)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

struct ToastHost: ViewModifier {
    @EnvironmentObject var model: AppModel
    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(toast: toast)
                    .id(toast.id)
                    .task(id: toast.id) {
                        try? await Task.sleep(nanoseconds: 2_500_000_000)
                        withAnimation { if model.toast?.id == toast.id { model.toast = nil } }
                    }
            }
        }
        .animation(.spring(duration: 0.3), value: model.toast)
    }
}

extension View {
    func toastHost() -> some View { modifier(ToastHost()) }
}

// MARK: - Keyboard

private func resignFirstResponder() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

extension View {
    /// 双保险收键盘：向下滚动收起 + 数字键盘"完成"按钮。
    func withKeyboardDismiss() -> some View {
        self
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("完成") { resignFirstResponder() }
                }
            }
    }
}
