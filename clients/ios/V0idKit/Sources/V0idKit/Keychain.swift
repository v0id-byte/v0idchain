// Keychain：保管 32 字节 ed25519 私钥种子。
// - kSecAttrAccessibleWhenUnlockedThisDeviceOnly：仅本机、解锁后可读，绝不随 iCloud/备份外流。
// - 用**普通 generic-password** item（非 Secure Enclave）：ed25519 私钥需可导出做软件签名，
//   而 Secure Enclave 只支持 P-256 且密钥不可导出，故不适用（见 CLIENT-PROTOCOL 平台说明）。
import Foundation
import Security

public enum Keychain {
    public enum KeychainError: Error, LocalizedError {
        case unexpectedStatus(OSStatus)
        public var errorDescription: String? {
            switch self {
            case .unexpectedStatus(let s):
                return "Keychain 错误（OSStatus \(s)）"
            }
        }
    }

    private static let service = "com.v0idchain.wallet"
    private static let account = "ed25519-seed"

    /// 写入（或覆盖）私钥种子。
    public static func save(seed: Data) throws {
        // 先删旧的，避免 duplicate item
        SecItemDelete(baseQuery() as CFDictionary)
        var attrs = baseQuery()
        attrs[kSecValueData as String] = seed
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }

    /// 读取私钥种子；不存在返回 nil。
    public static func load() throws -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
        return item as? Data
    }

    /// 删除私钥（重置钱包用）。
    public static func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
