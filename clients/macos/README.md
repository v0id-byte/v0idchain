# v0idChain · macOS 原生轻客户端

一个用 **Swift + SwiftUI** 写的 macOS 原生轻客户端，连上任意 v0idChain 节点即可：建钱包、查余额、转账、发链上消息、逛链。**本地保管私钥、本地 ed25519 签名**，通过 WebSocket 连一个节点拉全链算余额、广播交易、接收新块——**不挖矿，不需要 Node 运行时**。

> 权威协议见仓库根 [`docs/blockchain/CLIENT-PROTOCOL.md`](../../docs/blockchain/CLIENT-PROTOCOL.md)。本客户端的 `txid` 序列化与签名与 `packages/core` **逐字节兼容**，已用规范 §9 金标准向量自检 + 真节点端到端验证（见下）。

---

## 功能（MVP）

- **钱包**：**创建新钱包** 或 **登录已有钱包**（64-hex 私钥导入——把挖矿钱包带到 Mac 用，无需转账、不花 gas）；私钥存 **Keychain**；展示地址 + 余额（重放全链自算）。登录后还能随时「登录其它钱包」切换或「退出」。
- **转账**：收款地址 / 金额 / 手续费（默认 1）/ 备注 → 本地签名广播给所有连接。
- **链上消息**：给地址发消息（`amount=0` + `burn` 默认 5 + `memo` 正文）+ 收件箱（发给我的）/ 发件箱（我发的）。
- **逛链**：最近区块列表 + 按 地址 / txid / 区块号 搜索（逻辑同 `packages/web` explorer）。高记录地址用 `LazyVStack` + 只渲染最近 200 条，避免卡顿。
- 顶部全宽状态条实时显示**已连接节点数** / 链高 / 🔥 全网已销毁额。

## 连接：多节点、自动发现、不暴露节点信息

客户端从内置种子引导，再通过 `QUERY_PEERS` **发现整网其它节点并同时连上一批**（随机挑选，默认最多 6 个）：

- **降低种子负担**：整链只向其中**一个**节点 `QUERY_ALL`（落后才拉），其余靠轻量 `QUERY_LATEST` 心跳 + 新块广播；不再让每个客户端反复拉爆种子机。
- **更稳**：交易广播给**所有**连接；任一节点掉线自动补连其它已知节点（死地址进冷却，不抽风式重拨；连接数只数“已建立”的，UI 不闪烁）。
- **不暴露节点信息**：界面只显示“已连接 N 节点”，不暴露/不需要手填具体地址——自动随机连。

> ⚠️ **要真正连上多个节点，被连的节点必须对外广播一个公网可达地址**：节点出于 SSRF 安全**不会 gossip 私网/环回地址**。所以同学的矿机若想分担客户端负载，应以 `--advertise ws://<公网IP>:6001` 启动；否则种子只会 gossip 它自己，客户端实际就连种子一个（功能正常，只是没散开）。生产化方向是种子前置 `wss://` 反代。

---

## 目录结构

```
clients/macos/
├── V0idKit/                     # 共识关键逻辑（独立 SwiftPM 包，纯 Foundation + CryptoKit，无 UI）
│   ├── Package.swift
│   ├── Sources/V0idKit/
│   │   ├── Crypto.swift         # hex / SHA-256 / ed25519 验签 / merkleRoot / 难度位
│   │   ├── JSONStringify.swift  # ⚠️ 手写的 JSON.stringify 字节级序列化器（共识关键）
│   │   ├── Wallet.swift         # ed25519 密钥 + 地址（CryptoKit Curve25519.Signing）
│   │   ├── Transaction.swift    # txid 预映像 / 本地签名 / 自洽性校验
│   │   ├── Block.swift          # 区块结构 + calcBlockHash
│   │   ├── Chain.swift          # 重放全链算余额/nonce/已销毁 + 消息解析 + explorer 检索
│   │   ├── NodeClient.swift     # P2P：URLSessionWebSocketTask 拉链/广播/接增量
│   │   └── Config.swift         # 全局参数（须与 packages/core 一致）
│   └── Tests/V0idKitTests/
│       ├── GoldVectorTests.swift # 规范 §9 金标准向量自检
│       └── LiveNodeTests.swift   # 端到端（连真节点，env-gated）
├── Sources/V0idChainApp/        # SwiftUI App（由 Xcode app target 编译，依赖 V0idKit 包）
├── Info.plist                   # ATS 例外（放行明文 ws://）
├── project.yml                  # xcodegen 工程定义
└── V0idChain.xcodeproj          # 已提交，可直接 open（也可用 xcodegen 重新生成）
```

`V0idKit` 刻意做成自包含的独立包，先不跨 App 共享——**iOS 客户端将各自实现，日后由维护者合并成共享包**。

---

## 构建 & 运行

需要 **Xcode 15+**（含 macOS 13+ SDK）。

```bash
cd clients/macos
open V0idChain.xcodeproj      # 直接打开
# ⌘R 运行。首次可能需在 Signing & Capabilities 选一个 Team，
# 或选 “Sign to Run Locally”（教学 App，无沙箱）。
```

工程由 [`xcodegen`](https://github.com/yonyz/XcodeGen) 从 `project.yml` 生成。改了 `project.yml` 或增删源文件后重新生成：

```bash
brew install xcodegen        # 仅维护者需要
cd clients/macos && xcodegen generate
```

客户端默认从公网种子 `ws://mc.void1211.com:6001` 引导并自动发现/连接更多节点（见上「连接」一节）。要改连本地 dev 节点做测试，改 `V0idKit/Sources/V0idKit/Config.swift` 里的 `bootstrapNodes` 即可。

---

## 验证（已全绿）

### (a) 金标准向量自检 — 与 `packages/core` 逐字节对齐

```bash
cd clients/macos/V0idKit
swift test --filter GoldVectorTests
```

复现规范 §9：**ADDRESS → PREIMAGE → TXID** 逐字节一致（含 `🍜`/转义/`burn` 仅 >0 才入预映像），**SIGNATURE** 走验签等价判定（见下）。

### (b) 端到端 — 连本地 dev 节点真收发

先在仓库根起一个**隔离**的本地节点（勿用连了公网种子的挖矿节点）：

```bash
# 仓库根。独立端口、不带 --peers = 自有创世，绝不碰公网链
corepack pnpm v0id start --name e2e --p2p-port 6011 --api-port 7011 --mine
```

另一个终端跑端到端测试（用该节点的挖矿钱包做有余额的发送方）：

```bash
cd clients/macos/V0idKit
PRIV=$(python3 -c "import json;print(json.load(open('../../../.data/e2e/wallet.json'))['privateKey'])")
V0ID_LIVE_WS=ws://127.0.0.1:6011 V0ID_LIVE_PRIV=$PRIV swift test --filter LiveNodeTests
```

测试用 `NodeClient`（App 同款网络代码）同步 → 转账 → 发消息 → 等打包确认。再用 CLI 独立复核（GET 接口免令牌）：

```bash
# 测试输出里会打印 RECIPIENT=0x...，用它查收件箱与余额
corepack pnpm v0id inbox  <RECIPIENT> --api http://127.0.0.1:7011   # 应看到那条消息
corepack pnpm v0id balance <RECIPIENT> --api http://127.0.0.1:7011  # 应看到转账到账
```

> ⚠️ **发送测试只在本地隔离节点做**。要连公网种子，仅做**只读**同步验证链高，**别往公网链发测试垃圾消息**。

### (c) 只读同步公网（可选）

App 把节点切到种子即可看到真实链高同步；只读拉链，不发任何交易。

---

## 关键实现说明

### txid 序列化（§3.2）
`JSONStringify.swift` 是**手写**的、与 ECMA-262 `JSON.stringify` 逐字节一致的序列化器（不是通用 JSON 编码器）：数组无空格、整数纯十进制、字符串仅转义 `" \ \b \t \n \f \r` 及其余 `U+0000–U+001F`（小写 `\u00xx`），中文/emoji 原样按 UTF-8 输出，不转义 `/`。`burn` **仅在 >0 时**追加进预映像——这正是「加消息不重置链」的根基。

### 签名：CryptoKit 是随机化的（重要）
ed25519 用 **CryptoKit `Curve25519.Signing`**（私钥 = 32 字节 `rawRepresentation`，公钥 = `publicKey.rawRepresentation`，RFC 8032）。但 **Apple 的 ed25519 实现是随机化（hedged nonce）的**——同一 (私钥, 消息) 每次签出的字节都不同，**因此无法复现规范 §9 里那串固定 SIGNATURE hex**。

这不影响正确性：随机 nonce 的签名仍是**合法的 RFC 8032 签名**，网络的严格验签（`zip215:false`）照样通过 → **交易会被全网接受，不会被丢弃**。前三步（ADDRESS/PREIMAGE/TXID）才是决定 txid 是否一致的关键，均逐字节对齐。

故金标准 SIGNATURE 步改为**验签等价**判定（与「字节相等」目标等价、且端到端已用真节点证实交易被接受）：
1. 本客户端新签出的签名能被金标准公钥验过（→ 全网会接受我的交易）；
2. 金标准那串固定签名能被本客户端的验签器验过（→ 验签器 ≡ 网络验签器）。

> 若日后需要「字节级复现固定签名」，可引入一个确定性 ed25519 实现（RFC 8032 deterministic）替换签名一处；当前为零额外依赖、用户已确认采用 CryptoKit + 验签等价方案。

### 余额 / nonce（§4）
无 SPV，需拉**全链**（现 ~700KB-1MB）重放自算：`balance[from] -= amount+fee+burn`、`burn>0` 记入 `NULL_ADDRESS`、`nonce[from]+=1`、`balance[to]+=amount`。下一笔 nonce = 链上 nonce + 本地已广播未打包的待发笔数。

### Keychain
私钥以 generic password 存于 `com.v0idchain.macos`，`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` + `kSecAttrSynchronizable=false`——仅本机、解锁后可读，**不随 iCloud Keychain 同步、也不进加密备份/设备迁移**（与 iOS 端一致，兑现“永不离开本机”），永不落盘明文。「显示/备份私钥」前需通过生物识别（Touch ID，回退账户密码）；「退出钱包」即从 Keychain 删除。

### ATS（明文 ws://）
v0idChain 是明文 `ws://` 教学链，`Info.plist` 放行明文加载（并对种子域名 `mc.void1211.com` 设例外）。生产化方向是种子前置 `wss://`，届时只需改连接 URL 并收紧 ATS。

---

## 软分叉提醒

链上消息（`burn>0`）是一次**软分叉**：旧版本节点会拒绝含消息交易的块。发消息前请确保所连节点已升级到含 Phase 11 的版本（**公网种子已升级**；本地 dev 用当前仓库代码即可）。纯转账不受影响。

---

这是**教学 / 玩具链**，`$V0ID` 无任何现实价值；本 App **不含任何真钱 / 支付功能**。
