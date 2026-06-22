// 通用小组件：卡片样式、可复制行、连接状态徽标、时间格式、生物识别门限。
// 设计语言参照 iOS 客户端（clients/ios）：.thinMaterial 圆角卡片、rounded 大数字、label/mono-value 行。
import SwiftUI
import LocalAuthentication
import V0idKit

/// 生物识别门限：显示/备份私钥前要求验证（Touch ID，失败回退账户密码）。取舍同 iOS 端。
/// 操作层门限，不改 Keychain item 访问控制（item 级门限的死锁/锁死风险留作上设备实测后续，审计 F04）。
enum BiometricGate {
    static func authenticate(reason: String, completion: @escaping (Bool) -> Void) {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            DispatchQueue.main.async { completion(true) } // 无可用验证手段 → 放行
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
            DispatchQueue.main.async { completion(success) }
        }
    }
}

/// iOS 同款卡片：内边距 + .thinMaterial 圆角。
extension View {
    func card(radius: CGFloat = 16, padding: CGFloat = 16) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: radius))
    }
}

/// 一行：caption 标签 + 等宽可复制值 + 复制按钮（仿 iOS CopyableRow）。
/// sensitive=true 时复制私钥用——60s 后自动清空系统剪贴板（NSPasteboard 全 OS 共享）。
struct CopyableRow: View {
    let label: String
    let value: String
    var sensitive: Bool = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Text(value).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                Spacer(minLength: 8)
                CopyButton(value: value, sensitive: sensitive)
            }
        }
    }
}

/// 纯复制按钮（复制后短暂打勾）。sensitive=true 时 60s 后自动清空剪贴板（仅当仍是我们写入的内容）。
struct CopyButton: View {
    let value: String
    var sensitive: Bool = false
    @State private var copied = false
    var body: some View {
        Button {
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(value, forType: .string)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
            if sensitive {
                // 私钥不长期滞留系统剪贴板：60s 后若内容未被用户换掉则清空。
                let copiedValue = value
                DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                    let pb = NSPasteboard.general
                    if pb.string(forType: .string) == copiedValue { pb.clearContents() }
                }
            }
        } label: {
            Image(systemName: copied ? "checkmark.circle.fill" : "doc.on.doc")
                .foregroundStyle(copied ? .green : .secondary)
        }
        .buttonStyle(.borderless)
        .help(sensitive ? "复制（60s 后自动从剪贴板清除）" : "复制：\(value)")
    }
}

/// 可点击复制的等宽文本（地址 / txid / hash）。
struct CopyableMono: View {
    let text: String
    var display: String? = nil
    @State private var copied = false

    var body: some View {
        Button {
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(text, forType: .string)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
        } label: {
            HStack(spacing: 6) {
                Text(display ?? text)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                Image(systemName: copied ? "checkmark.circle.fill" : "doc.on.doc")
                    .foregroundStyle(copied ? .green : .secondary)
                    .font(.caption)
            }
        }
        .buttonStyle(.plain)
        .help("点击复制：\(text)")
    }
}

/// 连接状态徽标：显示已连接的节点数（不暴露具体地址）。
struct ConnectionBadge: View {
    let peers: Int
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(peers > 0 ? Color.green : Color.orange).frame(width: 8, height: 8)
            Text(peers > 0 ? "已连接 \(peers) 节点" : "连接中…")
                .font(.callout)
        }
    }
}

func formatTime(_ millis: Int) -> String {
    let d = Date(timeIntervalSince1970: TimeInterval(millis) / 1000)
    let f = DateFormatter()
    f.dateFormat = "MM-dd HH:mm:ss"
    return f.string(from: d)
}

/// 一笔交易的类型标签。
func txKind(_ tx: V0idKit.Transaction) -> (label: String, color: Color) {
    if tx.isCoinbase { return ("⛏️ 出块", .purple) }
    if tx.isMessage { return ("✉️ 消息", .blue) }
    return ("💸 转账", .green)
}
