// 规范化序列化：手写一个与 ECMA-262 `JSON.stringify` 逐字节一致的编码器，
// 专用于交易的 txid 预映像（CLIENT-PROTOCOL §3.2）。**不要**用通用 JSON 编码器（各家转义/空格/数字格式不同）。
//
// 仅需支持预映像里出现的两种元素：整数 与 字符串。
// 数组写法：`[`、元素间 `,`、`]`，**无任何空格**。
import Foundation

public enum CanonicalJSON {
    /// 预映像里的一个数组元素：整数或字符串（恰好覆盖 from/to/amount/fee/nonce/timestamp/memo/burn）。
    public enum Element {
        case int(Int)
        case string(String)
    }

    /// `JSON.stringify([...])`：数组无空格，元素按各自类型序列化。
    public static func array(_ elements: [Element]) -> String {
        var out = "["
        for (i, el) in elements.enumerated() {
            if i > 0 { out += "," }
            switch el {
            case .int(let n): out += String(n)             // 整数：纯十进制，无 +/前导0/小数点/指数
            case .string(let s): out += string(s)
            }
        }
        out += "]"
        return out
    }

    /// `JSON.stringify(string)`：双引号包裹 + 按 ECMA-262 规则转义。
    /// 仅转义：" \ \b \t \n \f \r，其余 U+0000–U+001F → \u00xx（小写 hex）；
    /// 其它字符（含中文/emoji）原样输出，不转义 `/`，不转 \uXXXX。
    public static func string(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""   // "
            case 0x5C: out += "\\\\"   // \
            case 0x08: out += "\\b"
            case 0x09: out += "\\t"
            case 0x0A: out += "\\n"
            case 0x0C: out += "\\f"
            case 0x0D: out += "\\r"
            case 0x00...0x1F:
                out += String(format: "\\u%04x", scalar.value) // 其余控制字符 → \u00xx 小写
            default:
                out.unicodeScalars.append(scalar)              // 原样（最终按 UTF-8 编码）
            }
        }
        out += "\""
        return out
    }
}
