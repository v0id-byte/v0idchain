// swift-tools-version:5.9
import PackageDescription

// V0idKit —— v0idChain 轻客户端的共识关键逻辑（密钥 / JSON.stringify 序列化 / 交易 / 状态 / P2P）。
// 纯 Foundation + CryptoKit，无 UI，可被 macOS / 将来 iOS App 复用。
//
// 自检 / 端到端：
//   cd clients/macos/V0idKit && swift test            # 金标准向量（规范 §9）
//   V0ID_LIVE_WS=ws://127.0.0.1:6011 V0ID_LIVE_PRIV=<priv> swift test --filter LiveNodeTests
let package = Package(
    name: "V0idKit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "V0idKit", targets: ["V0idKit"]),
    ],
    targets: [
        .target(name: "V0idKit"),
        .testTarget(name: "V0idKitTests", dependencies: ["V0idKit"]),
    ]
)
