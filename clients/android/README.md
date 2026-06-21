# v0idChain 轻钱包（Android 原生轻客户端）

一个 **Kotlin + Jetpack Compose** 的 Android 原生轻客户端，连接 [v0idChain](../../README.md)（手搓教学区块链，原生代币 `$V0ID`）。

> 轻客户端 = **本地生成/保管私钥 + 本地 ed25519 签名 + 连一个节点收发**。不挖矿、不需要 Node 运行时。
> 通过 WebSocket 连节点拉全链、按 [CLIENT-PROTOCOL.md](../../docs/CLIENT-PROTOCOL.md) §4 重放算余额、广播自己的交易、接收新块。

本实现严格遵循权威规范 [`docs/CLIENT-PROTOCOL.md`](../../docs/CLIENT-PROTOCOL.md)，并通过其 **§9 金标准向量**逐字节自检（见下文）。

---

## 功能（MVP）

| 模块 | 说明 |
|------|------|
| **钱包** | 生成新钱包 / 用 64-hex 私钥导入；私钥经 Android Keystore 加密落地（EncryptedSharedPreferences）；展示地址 + 余额 |
| **转账** | 收款地址 / 金额 / 手续费(默认 1) / 备注 → 本地 ed25519 签名 → WS 广播 |
| **链上消息** | 给地址发消息（`amount=0` + `burn`(默认 5) + `memo` 正文）；收件箱（发给我的）/ 发件箱（我发的） |
| **逛链** | 最近区块列表；按 **地址 / txid / 区块号** 搜索；链上新成员（首次上链地址） |
| **诊断** | 设置页一键运行 §9 金标准向量自检，逐行显示 PUB_HEX / PREIMAGE / TXID / SIGNATURE 是否全绿 |

余额 / nonce 全部按规范 §4 **重放全链自算**（当前无 SPV，需拉全链 ~700KB）。

---

## 架构与技术选型

```
app/src/main/java/com/v0id/wallet/
  core/        ← 纯 JVM，零 Android 依赖，可被单测直接运行（共识关键）
    Hex.kt            hex ↔ bytes
    Crypto.kt         sha256Hex（MessageDigest）+ NULL_ADDRESS + 地址校验
    Ed25519.kt        RFC8032 ed25519（BouncyCastle 低层 crypto 类）
    JsonStringify.kt  逐字节复刻 JS JSON.stringify（txid 预映像，§3.2）
    Transaction.kt    交易模型 + computeTxid + signTransaction/signMessage（§3.3）
    Wallet.kt         种子→公钥→地址；生成/导入
    Block.kt / ChainState.kt / Messages.kt   区块、§4 余额重放、消息解析
    SelfTest.kt       §9 金标准向量（GoldVectors + runSelfTest）
  net/         ← OkHttp WebSocket（P2P §6）+ JSON 编解码
    WsClient.kt       连接 / HELLO+QUERY_ALL / 收 BLOCKS / 广播 TX / 自动重连
    ChainCodec.kt     Block/Transaction ↔ org.json
  data/
    KeyVault.kt       EncryptedSharedPreferences（主密钥在 Keystore）
  WalletViewModel.kt  状态机：链合并、余额/nonce、待发交易、发送、搜索
  ui/                 Compose UI（克制的中性 Material3 主题，跟随系统亮/暗；仿 iOS 分组 Form）：钱包/转账/消息/逛链/设置
```

**关键选型理由**

- **ed25519 = BouncyCastle**（`org.bouncycastle:bcprov-jdk18on`）。用低层 `Ed25519Signer` / `Ed25519PrivateKeyParameters`，**不注册 JCE Provider**（避免与 Android 内置旧版 BC 冲突）。签名与「32 字节种子 → 公钥」派生都是确定性 RFC8032，故与参考实现 `@noble/ed25519`、CryptoKit **逐字节一致**——已用 §9 向量验证 `PUB_HEX` 一致后才使用。
- **txid 序列化手写**（`JsonStringify.kt`），**不用通用 JSON 库**。逐字节匹配 ECMA-262 `JSON.stringify`（转义、空格、整数格式）；差一个字节 txid 就变、签出的交易全网校验不过被直接丢弃。Kotlin 与 JS 同为 UTF-16，逐 `Char` 遍历即可让中文/emoji（代理对）原样落入 UTF-8，与 JS 一致。
- **SHA-256 = `java.security.MessageDigest`**。
- **WebSocket = OkHttp**。
- **私钥存储 = EncryptedSharedPreferences**（主密钥在 Android Keystore）。不直接用 Keystore 存 ed25519，因为 Keystore 密钥不可导出、且其 ed25519 签名跨 API 等级行为不一，无法保证拿到与 RFC8032 逐字节一致的原始签名。规范明确允许 Keystore 或 EncryptedSharedPreferences。

---

## 明文流量配置（重要）

Android 默认（targetSdk ≥ 28）**禁明文流量**，而 v0idChain 种子目前是明文 `ws://`。
本工程用 [`res/xml/network_security_config.xml`](app/src/main/res/xml/network_security_config.xml) **仅对种子域名与本地调试主机**放行明文（比全局 `usesCleartextTraffic` 更克制）：

```xml
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain>mc.void1211.com</domain>   <!-- 公网种子 -->
    <domain>10.0.2.2</domain>          <!-- 模拟器访问宿主机 -->
    <domain>127.0.0.1</domain>
    <domain>localhost</domain>
  </domain-config>
</network-security-config>
```

> 长期方向：种子前置反向代理上 `wss://`，届时只需把连接 URL 改成 `wss://`，本配置可移除。

---

## Build / Run

### 前置

- **JDK 17–21**（AGP 8.7 要求；本机系统 JDK 若是 25 会过新，请用 Android Studio 自带的 JBR）。
- **Android SDK**（platform 35、build-tools 35）。在 [`local.properties`](#) 写 `sdk.dir=/path/to/Android/sdk`（已 gitignore，需各自创建）。

```properties
# clients/android/local.properties
sdk.dir=/Users/<you>/Library/Android/sdk
```

### 用 Gradle Wrapper 构建（推荐指定 JDK 21）

```bash
cd clients/android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"  # 或任意 JDK 17–21
export ANDROID_HOME="$HOME/Library/Android/sdk"

./gradlew :app:assembleDebug          # 产物：app/build/outputs/apk/debug/app-debug.apk
```

### 安装并运行到模拟器 / 真机

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.v0id.wallet/.MainActivity
```

或直接用 Android Studio 打开 `clients/android/` 目录，Run ▶。

---

## 验证 (a)：金标准向量自检（§9，无需模拟器）

`core/` 全是纯 JVM 代码（只依赖 BouncyCastle + `java.security`），可在宿主 JVM 直接跑单测：

```bash
cd clients/android
JAVA_HOME=".../jbr/Contents/Home" ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew :app:testDebugUnitTest --tests "com.v0id.wallet.core.GoldVectorTest"
```

`GoldVectorTest` 断言（全部通过）：

- `addressDerivation` —— 种子 `0102…20` 派生出 `PUB_HEX = 79b5562e…049664`、`ADDRESS = 0x79b5…`
- `goldVectorsAllGreen` —— 转账 / 消息两条 **PREIMAGE → TXID → SIGNATURE** 逐字节命中规范
- `productionFactoryPath` —— App 实际使用的 `signTransaction` / `signMessage` 也复现金标准向量
- `escapeSelfCheck` —— `JSON.stringify(["x\"y\nz\t🎲"])` 逐字节一致

App 内也可在 **设置 → 金标准向量自检 → 运行自检** 实时看到 8 行全绿。

---

## 验证 (b)：端到端（模拟器 + 本地节点）

1. 在仓库根启动本地 dev 节点（含「链上消息」的当前仓库代码）：
   ```bash
   corepack pnpm dev:node1          # 节点 P2P ws://127.0.0.1:6001，API http://127.0.0.1:7001
   ```
2. App 里进 **设置**，把节点切到「**模拟器本地**」（`ws://10.0.2.2:6001`，模拟器访问宿主机）→ 保存并连接。
3. App 同步链、看到余额；**转账** / **发消息**（本地签名广播）。
4. 用 CLI 确认到账（注意 `--name node1` 以定位该节点的 API 令牌）：
   ```bash
   corepack pnpm v0id inbox   --name node1 --api http://127.0.0.1:7001   # 收件箱（发给该节点的消息）
   corepack pnpm v0id balance <你的App地址> --name node1 --api http://127.0.0.1:7001
   ```

> **本地链 checkpoint 提醒**：`config.ts` 的 `CHECKPOINTS` 取自公网种子链。**全新独立**的本地节点挖到 **高度 100** 时其 #100 区块 hash 与该 checkpoint 不符、会被拒，链卡在 99。
> 因此本地端到端测试请**把发送测试控制在高度 100 以内**（例如不带 `--mine` 启动、用 `v0id mine <N>` 按需出块），或连一条已与公网种子同步的链。

## 验证 (c)：连公网种子（可选）

App 默认节点即公网种子 `ws://mc.void1211.com:6001`，启动后会同步真实链高。
**切勿往公网链发测试垃圾消息**——发送测试只在本地节点做。

---

## 软分叉提醒

链上消息（`burn>0`）是一次软分叉：旧版本节点会拒绝含消息交易的块。发消息前请确保所连节点已升级到含 Phase 11 的版本（**公网种子已升级**；本地 dev 节点用当前仓库代码即可）。纯转账不受影响。

---

## 安全 / 免责

- 私钥永远只在本机（Keystore 加密）。地址 = 公钥，可公开分享。
- 这是**教学 / 玩具链**，`$V0ID` **无任何真实价值**，App **不含任何真钱 / 支付功能**。请勿存放真实资产。
