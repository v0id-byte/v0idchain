// 链上昵称（全网唯一抢注，先到先得）：建在“自转 + memo `NAME|<名字>`”之上，不改共识。
// 对应 packages/core/src/names.ts —— 解析规则必须一致（先到先得 + 读端小写规范化）。
import Foundation

public struct NameRegistry {
    /// 名字 → 首位抢到者地址（永久绑定，先到先得）
    public var nameToOwner: [String: String]
    /// 地址 → 当前显示名（= 最近一次成功拥有的名字）
    public var addressToName: [String: String]

    public init(nameToOwner: [String: String] = [:], addressToName: [String: String] = [:]) {
        self.nameToOwner = nameToOwner
        self.addressToName = addressToName
    }

    /// 地址 → 显示名（没有则 nil）。
    public func name(for address: String) -> String? { addressToName[address] }
}

public enum Names {
    /// 1~20 位小写字母/数字/下划线/连字符；不以 0x 开头；非保留名。入参应已小写。
    public static func isValidName(_ name: String) -> Bool {
        guard name.count >= 1, name.count <= Config.maxName else { return false }
        guard !name.hasPrefix("0x"), !Config.reservedNames.contains(name) else { return false }
        return name.allSatisfy { c in
            ("a"..."z").contains(c) || ("0"..."9").contains(c) || c == "_" || c == "-"
        }
    }

    public static func buildNameMemo(_ name: String) -> String { Config.namePrefix + name }

    /// 校验并规范化（trim+小写）抢注名；返回 memo 或错误。
    public static func makeNameClaim(_ raw: String) -> (memo: String?, error: String?) {
        let n = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if Config.reservedNames.contains(n) { return (nil, "“\(n)” 是保留名，禁止抢注") }
        guard isValidName(n) else { return (nil, "昵称需 1~20 位 小写字母/数字/_/-，且不以 0x 开头") }
        let memo = buildNameMemo(n)
        if memo.unicodeScalars.count > Config.maxMemo { return (nil, "昵称过长") }
        return (memo, nil)
    }

    /// 扫整条链还原昵称注册表（先到先得；同一地址可改名）。纯函数 → reorg 安全。
    public static func parseNames(_ chain: [Block]) -> NameRegistry {
        var nameToOwner = [String: String]()
        var addressToName = [String: String]()
        for b in chain {
            for tx in b.transactions {
                let m = tx.memo
                guard m.hasPrefix(Config.namePrefix) else { continue }
                guard tx.from == tx.to else { continue }       // 抢注必须是自转
                guard (tx.burn ?? 0) == 0 else { continue }    // 排除“自发消息”
                let name = String(m.dropFirst(Config.namePrefix.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard isValidName(name) else { continue }
                if let owner = nameToOwner[name], owner != tx.from { continue } // 已被别人抢走
                if nameToOwner[name] == nil { nameToOwner[name] = tx.from }     // 第一笔抢注者永久拥有
                addressToName[tx.from] = name                                  // 本人最新抢注 → 显示名
            }
        }
        return NameRegistry(nameToOwner: nameToOwner, addressToName: addressToName)
    }
}
