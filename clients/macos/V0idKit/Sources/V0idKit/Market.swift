// 集市：完全建在“转账 + memo”之上，不改共识（余额走普通转账，本文件只做 memo 解析/构造）。
// 上架 = 自转 1 币 memo `MKT|<价格>|<标题>`；购买 = 付款给卖家 memo `BUY|<上架txid>`；撤单 = memo `DEL|<上架txid>`。
// 对应 packages/core/src/market.ts —— 解析规则必须一致。
import Foundation

public struct Listing: Identifiable, Equatable {
    public let id: String        // 上架交易 txid
    public let title: String
    public let price: Int
    public let seller: String
    public let timestamp: Int
    public var delisted: Bool
    public var sold: Bool
    public var soldBy: String?
}

public enum Market {
    public static func buildListMemo(price: Int, title: String) -> String {
        "\(Config.mktPrefix)\(price)|\(title)"
    }

    /// 校验“上架”入参；返回 memo 或错误。
    public static func makeListing(price: Int, title: String) -> (memo: String?, error: String?) {
        guard price > 0 else { return (nil, "价格必须是正整数") }
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.unicodeScalars.count <= Config.maxTitle else { return (nil, "标题需 1~\(Config.maxTitle) 字") }
        let memo = buildListMemo(price: price, title: t)
        guard memo.unicodeScalars.count <= Config.maxMemo else { return (nil, "标题过长") }
        return (memo, nil)
    }

    /// 扫整条链，把 MKT/BUY/DEL memo 还原成商品列表（最新在前）。
    public static func parseMarket(_ chain: [Block]) -> [Listing] {
        var listings = [String: Listing]()
        var delisted = Set<String>()
        var sold = [String: String]()   // listingId → buyer

        for b in chain {
            for tx in b.transactions {
                let m = tx.memo
                if m.isEmpty { continue }

                if m.hasPrefix(Config.mktPrefix), tx.from == tx.to {
                    // 上架必须“自转”，防止把别人的付款误判成上架
                    let rest = String(m.dropFirst(Config.mktPrefix.count))
                    guard let sep = rest.firstIndex(of: "|") else { continue }
                    let priceStr = String(rest[..<sep])
                    let title = String(rest[rest.index(after: sep)...])
                    guard let price = Int(priceStr), price > 0, !title.isEmpty else { continue }
                    listings[tx.txid] = Listing(id: tx.txid, title: title, price: price, seller: tx.from,
                                                timestamp: tx.timestamp, delisted: false, sold: false, soldBy: nil)
                } else if m.hasPrefix(Config.delPrefix) {
                    let id = String(m.dropFirst(Config.delPrefix.count))
                    if let l = listings[id], tx.from == l.seller { delisted.insert(id) } // 只有卖家本人能撤
                } else if m.hasPrefix(Config.buyPrefix) {
                    let id = String(m.dropFirst(Config.buyPrefix.count))
                    // 购买需付给卖家且金额 ≥ 标价；首笔有效购买为准
                    if let l = listings[id], tx.to == l.seller, tx.amount >= l.price, sold[id] == nil {
                        sold[id] = tx.from
                    }
                }
            }
        }

        var out = [Listing]()
        for var l in listings.values {
            l.delisted = delisted.contains(l.id)
            if let buyer = sold[l.id] { l.sold = true; l.soldBy = buyer }
            out.append(l)
        }
        return out.sorted { $0.timestamp > $1.timestamp }
    }
}
