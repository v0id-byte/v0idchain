// 通用 UI 小工具：地址缩写、复制、连接状态徽标、toast 浮层。
import SwiftUI
import UIKit
import V0idKit

extension String {
    /// 地址缩写：0x1234…abcd
    var shortAddress: String {
        guard count > 16 else { return self }
        return "\(prefix(8))…\(suffix(6))"
    }
}

enum Clipboard {
    static func copy(_ s: String) { UIPasteboard.general.string = s }
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
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(node.status.color).frame(width: 8, height: 8)
            Text("\(node.status.label) · 高度 \(node.height)")
                .font(.caption).foregroundStyle(.secondary)
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
