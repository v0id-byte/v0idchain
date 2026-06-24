// 逛链页：最近区块列表 + 按 地址/txid/区块号 搜索。
import SwiftUI
import V0idKit

private func difficultyText(_ difficulty: Int) -> String {
    difficulty > 255 ? String(format: "nBits 0x%08x", difficulty) : "\(difficulty) bit"
}

struct ExploreView: View {
    @EnvironmentObject var node: NodeClient
    @State private var query = ""
    private var registry: NameRegistry { node.nameRegistry() }

    var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    let newcomers = node.newcomers(12)
                    if !newcomers.isEmpty {
                        Section("新成员 🆕") {
                            ForEach(newcomers) { n in
                                HStack {
                                    AddressLabel(address: n.address, registry: registry)
                                    Spacer()
                                    Text("#\(n.height)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Section("最近区块") {
                        ForEach(node.recentBlocks(40)) { block in
                            NavigationLink { BlockDetail(block: block, registry: registry) } label: { BlockRow(block: block) }
                        }
                    }
                } else {
                    searchResults
                }
            }
            .navigationTitle("逛链")
            .searchable(text: $query, prompt: "地址 / txid / 区块号")
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        switch node.search(query) {
        case let .address(address, balance, history):
            Section("地址") {
                CopyableRow(label: "地址", value: address)
                LabeledContent("余额", value: "\(balance) $V0ID")
            }
            Section("历史（最新在前）") {
                if history.isEmpty { Text("无记录").foregroundStyle(.secondary) }
                ForEach(history) { ref in TxRow(ref: ref, focus: address, registry: registry) }
            }
        case let .tx(ref):
            Section("交易") { TxDetail(ref: ref) }
        case let .block(block):
            Section("区块") {
                NavigationLink { BlockDetail(block: block, registry: registry) } label: { BlockRow(block: block) }
            }
        case .none:
            ContentUnavailableView.search(text: query)
        }
    }
}

private struct BlockRow: View {
    let block: Block
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("#\(block.index)").font(.headline)
                Spacer()
                Text("\(block.transactions.count) 笔").font(.caption).foregroundStyle(.secondary)
            }
            Text(block.hash).font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
    }
}

private struct BlockDetail: View {
    let block: Block
    let registry: NameRegistry
    var body: some View {
        List {
            Section("区块头") {
                LabeledContent("高度", value: "\(block.index)")
                LabeledContent("PoW 难度", value: difficultyText(block.difficulty))
                LabeledContent("矿工", value: block.miner.display(in: registry))
                CopyableRow(label: "hash", value: block.hash)
                CopyableRow(label: "prevHash", value: block.prevHash)
                CopyableRow(label: "merkleRoot", value: block.merkleRoot)
                LabeledContent("时间", value: Date(timeIntervalSince1970: Double(block.timestamp) / 1000).formatted())
            }
            Section("交易（\(block.transactions.count)）") {
                ForEach(block.transactions) { tx in TxDetail(ref: TxRef(tx: tx, blockIndex: block.index)) }
            }
        }
        .navigationTitle("区块 #\(block.index)")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct TxRow: View {
    let ref: TxRef
    let focus: String   // 当前关注的地址（用于标方向）
    let registry: NameRegistry
    private var tx: V0idKit.Transaction { ref.tx }
    private var outgoing: Bool { tx.from == focus }
    private var memoPreview: String { tx.memo.hasPrefix(Config.encPrefix) ? "🔒 加密私信" : tx.memo }
    var body: some View {
        HStack {
            Image(systemName: tx.isMessage ? "envelope" : (outgoing ? "arrow.up.right" : "arrow.down.left"))
                .foregroundStyle(tx.isMessage ? .blue : (outgoing ? .red : .green))
            VStack(alignment: .leading, spacing: 2) {
                Text(tx.isCoinbase ? "coinbase" : (tx.isMessage ? "消息：\(memoPreview)" : (outgoing ? "转出 → \(tx.to.display(in: registry))" : "转入 ← \(tx.from.display(in: registry))")))
                    .font(.subheadline).lineLimit(1)
                Text("#\(ref.blockIndex) · \(tx.txid.prefix(12))…").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            if !tx.isMessage { Text("\(tx.amount)").font(.system(.subheadline, design: .monospaced)) }
        }
    }
}

private struct TxDetail: View {
    let ref: TxRef
    private var tx: V0idKit.Transaction { ref.tx }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CopyableRow(label: "txid", value: tx.txid)
            CopyableRow(label: "from", value: tx.from)
            CopyableRow(label: "to", value: tx.to)
            HStack { Text("amount").foregroundStyle(.secondary); Spacer(); Text("\(tx.amount)") }
            HStack { Text("fee").foregroundStyle(.secondary); Spacer(); Text("\(tx.fee)") }
            if tx.burnAmount > 0 {
                HStack { Text("🔥 burn").foregroundStyle(.secondary); Spacer(); Text("\(tx.burnAmount)") }
            }
            HStack { Text("nonce").foregroundStyle(.secondary); Spacer(); Text("\(tx.nonce)") }
            if !tx.memo.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("memo").font(.caption).foregroundStyle(.secondary)
                    Text(tx.memo)
                }
            }
        }
        .font(.system(.subheadline, design: .monospaced))
        .padding(.vertical, 4)
    }
}
