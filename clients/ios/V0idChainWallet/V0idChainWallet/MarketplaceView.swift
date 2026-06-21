// 集市页：在售/已售商品列表 + 上架表单 + 购买 / 撤单。
// 上架 = 自转 1 币 memo MKT|<价>|<标题>；购买 = 付款给卖家 memo BUY|<txid>；撤单 = memo DEL|<txid>。
import SwiftUI
import V0idKit

struct MarketplaceView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var node: NodeClient

    enum Tab: String, CaseIterable { case active = "在售", sold = "已成交" }
    @State private var tab: Tab = .active
    @State private var showSell = false

    private var registry: NameRegistry { node.nameRegistry() }
    private var all: [Listing] { node.listings() }
    private var shown: [Listing] {
        switch tab {
        case .active: return all.filter { !$0.sold && !$0.delisted }
        case .sold: return all.filter { $0.sold }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding()

                if shown.isEmpty {
                    ContentUnavailableView(
                        tab == .active ? "暂无在售商品" : "还没有成交记录",
                        systemImage: "bag",
                        description: Text("上架 = 自转 1 $V0ID 写一条 MKT memo，全网即可见。"))
                        .frame(maxHeight: .infinity)
                } else {
                    List(shown) { listing in
                        ListingRow(listing: listing,
                                   registry: registry,
                                   isMine: listing.seller == model.address)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("集市")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSell = true } label: { Image(systemName: "plus.circle") }
                }
            }
            .sheet(isPresented: $showSell) { SellSheet() }
        }
    }
}

private struct ListingRow: View {
    @EnvironmentObject var model: AppModel
    let listing: Listing
    let registry: NameRegistry
    let isMine: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(listing.title).font(.headline).lineLimit(2)
                Spacer()
                Text("\(listing.price) $V0ID").font(.subheadline.monospaced()).foregroundStyle(.primary)
            }
            HStack {
                Text("卖家").font(.caption).foregroundStyle(.secondary)
                AddressLabel(address: listing.seller, registry: registry)
                Spacer()
                if listing.sold, let buyer = listing.soldBy {
                    HStack(spacing: 4) {
                        Text("已售给").font(.caption).foregroundStyle(.secondary)
                        Text(buyer.display(in: registry)).font(.caption).foregroundStyle(.green)
                    }
                } else if listing.delisted {
                    Text("已撤单").font(.caption).foregroundStyle(.orange)
                }
            }
            if !listing.sold && !listing.delisted {
                HStack {
                    if isMine {
                        Button(role: .destructive) { _ = model.delistListing(listing) } label: {
                            Label("撤单", systemImage: "trash").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered).controlSize(.small)
                    } else {
                        Button { _ = model.buyListing(listing) } label: {
                            Label("购买 · \(listing.price)", systemImage: "cart").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct SellSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var priceText = ""
    private var price: Int? { Int(priceText.trimmingCharacters(in: .whitespaces)) }
    private var canSell: Bool {
        guard let price, price > 0 else { return false }
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && t.unicodeScalars.count <= 100
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("商品标题（≤100 字）") {
                    TextField("例如：二手机械键盘", text: $title, axis: .vertical).lineLimit(1...4)
                }
                Section("价格（$V0ID）") {
                    TextField("0", text: $priceText)
                        .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                }
                Section {
                    Button {
                        if model.sellListing(price: price ?? 0, title: title) { dismiss() }
                    } label: {
                        Label("上架", systemImage: "tag.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).disabled(!canSell)
                } footer: {
                    Text("上架会自转 1 $V0ID 并写一条 MKT memo（另付 1 手续费）。买家付够标价即成交，可随时撤单。")
                }
            }
            .navigationTitle("上架商品")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        }
    }
}
