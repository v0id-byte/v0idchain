// 逛链：最近区块列表 + 按 地址 / txid / 区块号 搜索（逻辑同 packages/web explorer）。
import SwiftUI
import V0idKit

struct ExplorerView: View {
    @EnvironmentObject var model: AppModel
    @State private var query = ""
    @State private var result: SearchResult = .none
    /// 高记录地址只渲染最近 N 条，避免一次性铺几千行卡死 UI。
    private let addressLimit = 200

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                searchBar
                if case .none = result {
                    if !query.isEmpty {
                        Text("没找到「\(query)」对应的地址 / 交易 / 区块。").foregroundStyle(.secondary)
                    }
                    newcomersPanel
                    recentBlocks
                } else {
                    resultView
                }
            }
            .padding(24)
            .frame(maxWidth: 720, alignment: .leading)
        }
        .navigationTitle("逛链")
    }

    private var searchBar: some View {
        HStack {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("搜索：地址 0x… / txid（64 hex）/ 区块号或 hash", text: $query)
                .textFieldStyle(.plain)
                .font(.system(.body, design: .monospaced))
                .onSubmit { result = model.search(query) }
            if !query.isEmpty {
                Button { query = ""; result = .none } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
            Button("搜索") { result = model.search(query) }
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    // ---- 搜索结果 ----
    @ViewBuilder private var resultView: some View {
        switch result {
        case .address(let addr, let bal, let history):
            let shown = Array(history.prefix(addressLimit))
            VStack(alignment: .leading, spacing: 10) {
                Text("地址").font(.headline)
                CopyableMono(text: addr)
                Text("余额（按入账）：\(bal) \(Config.symbol) · \(history.count) 笔记录")
                    .font(.callout).foregroundStyle(.secondary)
                if history.count > shown.count {
                    Text("记录较多，仅显示最近 \(shown.count) 条（共 \(history.count)）")
                        .font(.caption).foregroundStyle(.secondary)
                }
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(shown) { ref in txRow(ref.tx, height: ref.blockIndex) }
                }
            }
        case .tx(let ref):
            VStack(alignment: .leading, spacing: 10) {
                Text("交易 · 区块 #\(ref.blockIndex)").font(.headline)
                txDetail(ref.tx)
            }
        case .block(let b):
            blockDetail(b)
        case .none:
            EmptyView()
        }
    }

    // ---- 新成员（最近首次上链的地址，最新在前）----
    @ViewBuilder private var newcomersPanel: some View {
        if !model.newcomers.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("新成员 🆕 · \(model.newcomers.count)").font(.headline)
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(model.newcomers.prefix(12)) { n in
                        HStack {
                            CopyableMono(text: n.address, display: model.displayName(n.address))
                            Spacer()
                            Text("#\(n.height)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .card()
        }
    }

    // ---- 最近区块 ----
    private var recentBlocks: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("最近区块").font(.headline)
                Spacer()
                Text("链高 \(model.height) · 共 \(model.chain.count) 块").font(.caption).foregroundStyle(.secondary)
            }
            if model.chain.isEmpty {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("同步中…").foregroundStyle(.secondary) }
            }
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(model.recentBlocks) { b in
                    DisclosureGroup {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(b.transactions) { tx in txRow(tx, height: b.index) }
                        }
                        .padding(.top, 4)
                    } label: {
                        blockHeaderRow(b)
                    }
                }
            }
        }
    }

    private func blockHeaderRow(_ b: Block) -> some View {
        HStack(spacing: 10) {
            Text("#\(b.index)").font(.system(.body, design: .monospaced)).bold()
            Text("\(b.transactions.count) tx").font(.caption).foregroundStyle(.secondary)
            Text("难度 \(b.difficulty)").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(formatTime(b.timestamp)).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func blockDetail(_ b: Block) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("区块 #\(b.index)").font(.headline)
            kv("hash", b.hash)
            kv("prevHash", b.prevHash)
            kv("merkleRoot", b.merkleRoot)
            HStack(spacing: 20) {
                Text("难度 \(b.difficulty)").font(.caption)
                Text("nonce \(b.nonce)").font(.caption)
                Text(formatTime(b.timestamp)).font(.caption)
            }.foregroundStyle(.secondary)
            Text("矿工").font(.caption).foregroundStyle(.secondary)
            CopyableMono(text: b.miner, display: model.displayName(b.miner))
            Divider()
            Text("交易（\(b.transactions.count)）").font(.subheadline).bold()
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(b.transactions) { tx in txRow(tx, height: b.index) }
            }
        }
    }

    // ---- 交易行 / 详情 ----
    private func txRow(_ tx: V0idKit.Transaction, height: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(txKind(tx).label).font(.caption).foregroundStyle(txKind(tx).color)
                CopyableMono(text: tx.txid, display: short(tx.txid))
                Spacer()
                if tx.isMessage {
                    Text("🔥\(tx.burnAmount)").font(.caption).foregroundStyle(.secondary)
                } else if !tx.isCoinbase {
                    Text("\(tx.amount) +fee \(tx.fee)").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                } else {
                    Text("+\(tx.amount)").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            HStack {
                Text(tx.isCoinbase ? "虚空" : model.displayName(tx.from)).font(.caption2).foregroundStyle(.secondary)
                Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.secondary)
                Text(model.displayName(tx.to)).font(.caption2).foregroundStyle(.secondary)
                if tx.isMessage && !tx.memo.isEmpty {
                    Text(tx.memo.hasPrefix(Config.encPrefix) ? "· 🔒 加密私信" : "· \(tx.memo)")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
    }

    private func txDetail(_ tx: V0idKit.Transaction) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack { Text(txKind(tx).label).foregroundStyle(txKind(tx).color); Spacer() }
            kv("txid", tx.txid)
            kv("from", tx.isCoinbase ? Config.nullAddress + "（虚空 / coinbase）" : tx.from)
            kv("to", tx.to)
            HStack(spacing: 20) {
                Text("amount \(tx.amount)").font(.caption)
                Text("fee \(tx.fee)").font(.caption)
                if tx.burnAmount > 0 { Text("🔥 burn \(tx.burnAmount)").font(.caption) }
                Text("nonce \(tx.nonce)").font(.caption)
            }.foregroundStyle(.secondary)
            if !tx.memo.isEmpty {
                Text("memo").font(.caption).foregroundStyle(.secondary)
                Text(tx.memo).textSelection(.enabled)
            }
            Text(formatTime(tx.timestamp)).font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func kv(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.caption2).foregroundStyle(.secondary)
            CopyableMono(text: v)
        }
    }
}
