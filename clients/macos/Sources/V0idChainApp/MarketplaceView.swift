// 集市：上架（自转 1 币 + memo）/ 购买 / 撤单。商品随链全网同步、永久可查，零中心化服务器。
import SwiftUI
import V0idKit

struct MarketplaceView: View {
    @EnvironmentObject var model: AppModel
    @State private var title = ""
    @State private var price = ""

    private var active: [Listing] { model.market.filter { !$0.sold && !$0.delisted } }
    private var done: [Listing] { model.market.filter { $0.sold || $0.delisted } }

    var body: some View {
        Group {
            if model.wallet == nil {
                ContentUnavailableState(icon: "bag", title: "请先创建或登录钱包",
                                        message: "到「钱包」页创建新钱包或导入私钥后再来逛集市。")
            } else {
                ScrollView {
                    VStack(spacing: 20) {
                        sellCard
                        listingsCard
                        if !done.isEmpty { doneCard }
                    }
                    .padding(20)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .navigationTitle("集市 · \(active.count) 件在售")
    }

    private var sellCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("上架一件商品 / 服务", systemImage: "bag.badge.plus").font(.headline)
            Text("上架 = 自转 1 \(Config.symbol) + 手续费，把商品记上链；买家付标价给你即成交。")
                .font(.caption).foregroundStyle(.secondary)
            TextField("商品 / 服务（如：复习笔记 / 帮做PPT / 请喝奶茶）", text: $title)
                .textFieldStyle(.roundedBorder)
            HStack(spacing: 12) {
                labeled("价格 \(Config.symbol)") {
                    TextField("20", text: $price).textFieldStyle(.roundedBorder).frame(width: 120)
                }
                Spacer()
                Button {
                    model.marketSell(price: Int(price) ?? 0, title: title)
                    if model.lastError == nil { title = ""; price = "" }
                } label: { Label("上架", systemImage: "arrow.up.circle.fill") }
                .controlSize(.large).buttonStyle(.borderedProminent)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || (Int(price) ?? 0) <= 0)
            }
        }
        .card()
    }

    private var listingsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("在售").font(.headline)
            if active.isEmpty {
                Text("还没有人上架，来当第一个卖家吧。").foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(active) { l in listingRow(l) }
                }
            }
        }
    }

    private func listingRow(_ l: Listing) -> some View {
        let mine = l.seller == model.address
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(l.title).font(.body.weight(.medium))
                Text("卖家 \(model.displayName(l.seller))").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                Text("\(l.price) \(Config.symbol)").font(.headline).monospacedDigit()
                if mine {
                    Button("撤下") { model.marketDelist(l) }.buttonStyle(.bordered).controlSize(.small)
                } else {
                    Button("购买") { model.marketBuy(l) }.buttonStyle(.borderedProminent).controlSize(.small)
                }
            }
        }
        .card(radius: 12, padding: 12)
    }

    private var doneCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("已结束").font(.subheadline).foregroundStyle(.secondary)
            ForEach(done.prefix(12)) { l in
                HStack {
                    Text(l.sold ? "✓ 已售" : "✕ 下架").font(.caption)
                        .foregroundStyle(l.sold ? .green : .secondary)
                    Text(l.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    Text("\(l.price) \(Config.symbol)").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
            }
        }
        .card()
    }

    private func labeled<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            content()
        }
    }
}
