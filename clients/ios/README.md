# v0idChain iOS 轻客户端

一个 **iOS 原生轻客户端 App**（Swift + SwiftUI），用于 [v0idChain](../../) 这条手搓教学区块链，原生代币 **$V0ID**。

- **本地保管私钥**（Keychain，`ThisDeviceOnly`），**本地用 ed25519 签名**交易；
- 通过 **WebSocket** 连一个节点（默认公网种子 `ws://mc.void1211.com:6001`），拉全链算余额、广播自己的交易、接收新块；
- **不挖矿、不需要 Node 运行时**；
- 完整对齐权威规范 [`docs/blockchain/CLIENT-PROTOCOL.md`](../../docs/blockchain/CLIENT-PROTOCOL.md) 与参考实现 `packages/core` —— **txid 与签名逐字节/可验签兼容**。

> 这是教学/玩具链。**没有任何真钱/支付功能**，私钥与 $V0ID 都不代表现实资产。

---

## 目录结构

```
clients/ios/
├── V0idKit/                      # 自包含逻辑层（纯 Swift + CryptoKit/Foundation/Security），无 UI
│   ├── Package.swift             #   本地 Swift Package，被 App 以相对路径 ../V0idKit 依赖
│   ├── Sources/V0idKit/
│   │   ├── Hex.swift             #   hex 编解码
│   │   ├── CanonicalJSON.swift   #   ⭐ 手写的 JSON.stringify 字节级序列化器（txid 预映像，§3.2）
│   │   ├── Crypto.swift          #   SHA-256 + ed25519(CryptoKit) + 地址派生 + Merkle/难度
│   │   ├── Wallet.swift          #   密钥/地址 + 交易构造与签名（createTransaction/createMessage）
│   │   ├── Models.swift          #   Transaction / Block / ChainMessage（wire JSON 模型）
│   │   ├── ChainState.swift      #   §4 余额/nonce 重放 + 链上消息解析 + 区块浏览检索
│   │   ├── Keychain.swift        #   私钥存取（ThisDeviceOnly，可导出做软件签名）
│   │   ├── Protocol.swift        #   P2P 线协议（HELLO/QUERY_ALL/BLOCKS/TX）编解码
│   │   └── NodeClient.swift      #   URLSessionWebSocketTask 节点客户端（§6 流程）
│   ├── Tests/V0idKitTests/
│   │   └── GoldVectorTests.swift #   §9 金标准向量 XCTest（在 Xcode 里 ⌘U 运行）
│   └── SelfCheck/main.swift      #   不依赖 Xcode 的金标准自检（见下）
├── V0idChainWallet/              # SwiftUI App
│   ├── V0idChainWallet.xcodeproj #   依赖本地包 ../V0idKit
│   └── V0idChainWallet/          #   App / AppModel / 各页面 View / Info.plist / Assets
├── scripts/selfcheck.sh         # 一键金标准自检（swiftc，无需 Xcode）
└── README.md
```

链逻辑全部封进 **V0idKit**（先不跨 app 共享）；日后维护者可把它与 macOS 端合并成共享包，App 侧只需改依赖。

---

## 环境要求

- **Xcode 16 或更新**（项目 `objectVersion 56`，使用 `XCLocalSwiftPackageReference` 本地包引用）。
- 部署目标 **iOS 17+**（用到 `ContentUnavailableView` 等 API）。模拟器即可，无需真机。
- 不需要任何第三方依赖：ed25519/SHA-256 全部用系统 **CryptoKit**。

---

## Build / Run

1. 打开工程：
   ```bash
   open clients/ios/V0idChainWallet/V0idChainWallet.xcodeproj
   ```
   Xcode 会自动解析本地 Swift Package `V0idKit`（首次打开稍等几秒）。
2. 选一个 iOS 17+ 模拟器（如 iPhone 15/16），点 ▶︎ 运行。
3. 首屏：**生成新钱包** 或 **用 64-hex 私钥导入**。私钥写入 Keychain，App 随即连到节点并同步整链。

> 命令行构建（可选）：
> ```bash
> cd clients/ios/V0idChainWallet
> xcodebuild -scheme V0idChainWallet -destination 'platform=iOS Simulator,name=iPhone 16' build
> ```

### 切换节点 / 本地调试

设置页可改节点地址：
- 公网种子（默认）：`ws://mc.void1211.com:6001`
- 本地 dev 节点：`ws://127.0.0.1:6001` 或 `ws://localhost:6001`（模拟器与 Mac 共用 localhost）

---

## ⚠️ ATS（明文 ws:// 例外）

iOS 默认禁止明文 `ws://`。本项目已在 [`Info.plist`](V0idChainWallet/V0idChainWallet/Info.plist) 配置：

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key><true/>        <!-- 放行 127.0.0.1 / localhost / *.local 本地调试 -->
    <key>NSExceptionDomains</key>
    <dict>
        <key>mc.void1211.com</key>
        <dict>
            <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
            <key>NSIncludesSubdomains</key><true/>
        </dict>
    </dict>
</dict>
```

- 本地节点用 `NSAllowsLocalNetworking` 放行（IP 字面量写进 `NSExceptionDomains` 并不可靠，这是 Apple 推荐做法）。
- 公网种子用按域名的 `NSExceptionDomains` 例外。
- **长期方向**：种子前置反向代理上 `wss://`，届时删掉这些例外、把节点 URL 改成 `wss://` 即可。

---

## ✅ 金标准向量自检（头号要求）

实现必须与 `packages/core` 逐字节一致，否则签出的交易全网校验不过。两种验证途径：

**A) 不开 Xcode（推荐先跑）** —— 用 Command Line Tools 的 `swiftc`（CryptoKit 随 macOS SDK 提供）：
```bash
bash clients/ios/scripts/selfcheck.sh
```
应输出 `ALL GREEN ✅`，逐条复现 §9 的 PUB/ADDRESS → PREIMAGE → TXID → SIGNATURE。

**B) 在 Xcode 里** —— 打开工程后 `⌘U` 运行 `V0idKitTests`（`GoldVectorTests`）。

### 关于第 4 步 SIGNATURE 的一个重要说明（务必读）

规范 §9 给出的是一条**确定性** ed25519 签名（来自参考实现 `@noble/ed25519`）。而 **Apple CryptoKit 的 ed25519 采用 RFC8032 _hedged_（随机化 nonce）签名** —— 同一消息每次签出的字节都不同，因此**无法逐字节复现** §9 那条 SIGNATURE。

这**不影响全网兼容**：交易是否被节点接受，取决于**签名能否通过验签**，而非字节是否相等；CryptoKit 产出的每条签名都是合法的 RFC8032 签名、都能通过验签。自检因此把第 4 步换成一个**更强的双向互操作检查**：

1. 本端用 CryptoKit 对 `txid` 签出的签名 → 能通过验签（= 我们广播的交易会被节点接受）；
2. §9 的确定性金标准签名 → 也能通过本端验签（= 我们的验签路径与全网一致）。

前三步（公钥/地址、预映像、txid）则是确定性的，**逐字节复现** §9。

---

## 端到端测试（本地节点）

> 发送测试**只在本地节点**做，**不要往公网链发测试垃圾消息**。

1. 仓库根启动本地节点（含「链上消息」的当前仓库代码）：
   ```bash
   corepack pnpm dev:node1        # 节点 P2P: ws://127.0.0.1:6001 ，HTTP API: http://127.0.0.1:7001
   ```
2. 模拟器里 App → 设置页把节点改成 `ws://127.0.0.1:6001`（或 `ws://localhost:6001`）→ 钱包页应显示同步后的链高/余额。
3. 新钱包余额为 0，先从「央行/已有钱包」给它转一点币（用 CLI 或另一个钱包）：
   ```bash
   corepack pnpm v0id send <你的App地址> 50 --api http://127.0.0.1:7001
   ```
   等节点挖出一个区块后，App 余额应到账。
4. 在 App 里**转账**、**发消息**；再用 CLI 确认到账：
   ```bash
   corepack pnpm v0id inbox --api http://127.0.0.1:7001        # 看本地节点钱包的收件箱
   corepack pnpm v0id newcomers --api http://127.0.0.1:7001    # 看新地址首次上链
   ```
   （给本地节点自己的地址发消息，最直观；它的 `inbox` 即可看到 App 发出的消息。）
5. （可选）把节点改回公网种子，仅**验证同步真实链高**，不要发测试消息。

---

## 软分叉提醒

链上消息（`burn>0`）是一次**软分叉**：旧版本节点会拒绝含消息交易的块。发消息前请确保所连节点已升级到含 Phase 11（公网种子已升级；本地 dev 节点用当前仓库代码即可）。**纯转账不受影响。**

---

## 安全 / 设计要点

- 私钥 = 32 字节 ed25519 种子，存普通 Keychain generic-password item，`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`（仅本机、不随 iCloud/备份外流）。**未用 Secure Enclave**：SE 只支持 P-256 且密钥不可导出，而 ed25519 软件签名需要可导出种子。
- 余额/nonce 按规范 §4 **重放全链自算**（当前无 SPV，需拉全链，约 700KB，单帧 WebSocket 收取）。
- **txid 预映像**用手写序列化器（`CanonicalJSON`），严格匹配 ECMA-262 `JSON.stringify`（无空格、整数十进制、仅转义 `" \ \b \t \n \f \r` 与其余控制字符 `\u00xx`，CJK/emoji 原样）。**绝不**用通用 JSON 编码器算 txid。
- 待发交易（已广播未上链）计入下一笔 `nonce` 并占用可用余额，避免连环超支。

## 已知限制（非目标）

- MVP **信任所连节点**：不做整链 PoW/难度/默克尔的 trustless 校验（规范 §5「最省事」路线）。`Crypto` 里已含 `merkleRoot`/`leadingZeroBits` 等原语，便于日后补 `validateChain`。
- 无 SPV / 轻同步；无推送；无 QR 扫码（地址靠复制粘贴）。
- 集市（market）功能未在 App 内实现（规范里属可选扩展）。
