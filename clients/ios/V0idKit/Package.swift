// swift-tools-version: 5.9
import PackageDescription

// V0idKit —— v0idChain 轻客户端的自包含逻辑层（密钥 / 规范化序列化 / 签名 / 余额重放 /
// 链上消息 / Keychain / WebSocket 节点客户端）。纯逻辑 + 网络，无 UI。
// 同一个包既给 iOS App 用，也能在 macOS 上 `swift test` 跑金标准向量自检（CryptoKit 跨平台一致）。
let package = Package(
    name: "V0idKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v13),
    ],
    products: [
        .library(name: "V0idKit", targets: ["V0idKit"]),
    ],
    targets: [
        .target(name: "V0idKit"),
        .testTarget(name: "V0idKitTests", dependencies: ["V0idKit"]),
    ]
)
