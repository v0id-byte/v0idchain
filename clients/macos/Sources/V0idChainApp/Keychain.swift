// 私钥存 macOS Keychain（generic password）。私钥永不落盘明文、永不离开本机。
import Foundation
import Security

enum Keychain {
    private static let service = "com.v0idchain.macos"
    private static let account = "privateKeyHex"

    /// 保存 / 覆盖私钥 hex。
    static func savePrivateKey(_ hex: String) {
        let data = Data(hex.utf8)
        // 先删后写，避免 duplicate item。
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        // ThisDeviceOnly：与 iOS 端一致——私钥绝不随 iCloud Keychain 同步、也不进加密备份/设备迁移，
        // 兑现 README“私钥永不离开本机”的承诺（此前用 WhenUnlocked 会让 item 进入 iCloud/备份候选集）。
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        add[kSecAttrSynchronizable as String] = false  // 显式不同步（默认即 false，这里写明意图）
        SecItemAdd(add as CFDictionary, nil)
    }

    /// 读取私钥 hex（无则 nil）。
    static func loadPrivateKey() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// 删除私钥（“退出钱包”）。
    static func deletePrivateKey() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
