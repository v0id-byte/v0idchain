// ⚠️ 共识关键：手写一个与 ECMA-262 `JSON.stringify` 逐字节一致的序列化器。
// 绝不用通用 JSON 编码器（各家转义 / 空格 / 数字格式不同）。见 CLIENT-PROTOCOL §3.2。
//
// 只需支持本协议用到的两种值：整数 与 字符串，外层恒为数组。
import Foundation

public enum JSONValue {
    case string(String)
    case int(Int)
}

public enum JSONStringify {
    /// 序列化一个字符串，规则与 JSON.stringify 对单个字符串一致：
    /// - 首尾加 `"`；
    /// - 仅转义 `"`→\" `\`→\\ U+0008→\b U+0009→\t U+000A→\n U+000C→\f U+000D→\r；
    /// - 其余 U+0000–U+001F 控制字符 → \u00xx（小写 hex）；
    /// - 其他所有字符（含中文 / emoji）原样输出（最终按 UTF-8 编码），不转义 `/`，不转 \uXXXX。
    ///
    /// 注：Swift String 永远是良构 Unicode（不含孤立代理项），故无需处理 lone surrogate 的 \udXXX 情况。
    public static func string(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
        return out
    }

    /// 序列化一个整数：纯十进制，无 `+`、无前导 0、无小数点、无指数（共识强制整数，均在安全整数范围）。
    public static func int(_ n: Int) -> String { String(n) }

    /// 序列化一个数组：`[` 元素间 `,` `]`，无任何空格。
    public static func array(_ values: [JSONValue]) -> String {
        var parts = [String]()
        parts.reserveCapacity(values.count)
        for v in values {
            switch v {
            case .string(let s): parts.append(string(s))
            case .int(let n): parts.append(int(n))
            }
        }
        return "[" + parts.joined(separator: ",") + "]"
    }
}
