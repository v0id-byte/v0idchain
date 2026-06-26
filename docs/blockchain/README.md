# v0idChain ⛓ — 区块链模块（原生代币 `$V0ID`）

**[English](README.en.md) | 中文**

> 这是 v0idChain 三大模块之一。整个仓库是一个 hub：
> **[🧅 v0idnet 匿名网络](../v0idnet/README.md)**（招牌）· **⛓ 区块链**（本模块，一切的底座）· **🎮 链上游戏**（[../game/README.md](../game/README.md)）。
> 回到 **[仓库总览 → ../../README.md](../../README.md)**。

手搓的教学型区块链：币靠**挖矿**产生，转账付**手续费（gas）**给矿工。TypeScript + Node.js，pnpm monorepo。
手写区块 / 哈希 / Merkle 根 / 链式结构 / PoW 挖矿 / ed25519 签名 / WebSocket P2P / 最大工作量链共识。

> **自建链，验证逻辑我们自己说了算** —— 挖矿出块（拿出块奖励 + 手续费）出币，转账付手续费归打包矿工。
> 它**不是**经过审计的生产级密码货币，而是一条**教学级**链；同时它也是上层 **v0idnet 匿名网络**与**链上游戏**共同运行的**底座**（昵称、质押、托管支付等都建在它的交易层之上）。

---

## 这是什么（给用户）

一条能真正联网、能和同学互转的小链。币从**挖矿**来，每笔转账付一点手续费给矿工。除了转账，它还内建了一圈“社交玩具”，全部建在**转账 + 备注（memo）约定**之上、**不改共识**：

| 你能做什么 | 一句话 |
| --- | --- |
| ⛏ **挖矿** | 跑 PoW 出块，拿 1 出块奖励 + 本块所有手续费 |
| 💸 **转账** | 给地址转 `$V0ID`，付手续费（gas）给打包矿工 |
| 💬 **链上消息** | 给地址留言 = **烧一点币进虚空**，正文随链永久可查 |
| 🔒 **加密私信** | 加 `-e` 端到端加密（x25519 ECDH + XChaCha20-Poly1305），旁人只看到乱码 |
| 🪪 **昵称** | 抢注一个**全网唯一**的名字，从此显示 `@名字` 而非 `0x…` |
| 🧧 **红包** | 发拼手气/均分红包，别人来抢，过期可退（共识级托管） |
| 🛒 **集市** | 用 `$V0ID` 买卖商品/服务，挂单随链全网同步 |

### 快速开始

> **完整安装步骤（含 Node.js 升级）见 [RUNNING-A-NODE.md](RUNNING-A-NODE.md)；转账 / 集市 / 加密私信 / 红包 / 钱包备份的逐条讲解见 [TUTORIAL.md](TUTORIAL.md)。** 下面是速查版。

**前提：Node.js ≥ v22.13**（`pnpm@9.15.0` 要求此版本）。

```bash
git clone https://github.com/v0id-byte/v0idchain.git
cd v0idchain
corepack enable
corepack pnpm install
```

**装上全局短命令 `v0id`（推荐）。** 预编译成单文件，之后任意目录直接敲 `v0id <子命令>`：

```bash
corepack pnpm build:cli                       # esbuild 打包 → packages/cli/dist/index.cjs
cd packages/cli && corepack pnpm link --global && cd ../..
v0id --help                                   # 现在全局可用
```

> 首次 `link` 若报 `Unable to find the global bin directory`，先跑 `corepack pnpm setup`（写入 PATH，新开终端生效）再 link。不想装全局，可在仓库根目录定义同名函数：`v0id() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }`（带 ~1s 冷启动）。

**加入公网挖矿（一条命令）：**

```bash
corepack pnpm mine        # 连 ws://mc.void1211.com:6001，自动挖矿
```

> **双击** `mine.command`（macOS）/ `mine.bat`（Windows）可自动装依赖 + 开仪表盘 + 开挖。

**本地沙盒（双节点，不联公网）：**

```bash
corepack pnpm dev:node1   # 终端 1：node1，挖矿
corepack pnpm dev:node2   # 终端 2：node2，连上 node1
```

**Web 仪表盘（可选，有节点在跑时）：** `corepack pnpm dev:web` → 浏览器 http://localhost:5173（实时链高 / 余额 / 区块浏览器 / 转账面板）。

### 常用命令

```bash
v0id start --mine                                   # 启动节点并自动挖矿
v0id info                                            # 节点状态：链高 / 余额 / 对等数 / 地址
v0id send <to> <amount> [--fee <n>] [--memo <文字>]  # 转账（付 金额+手续费）
v0id msg  <to> <文字…> [-e]                          # 链上消息（-e 端到端加密；默认烧 5 + 1 gas）
v0id inbox                                            # 收件箱
v0id name claim <名字>                               # 抢注全网唯一昵称
v0id market sell <price> <标题…>  /  v0id market buy <id>   # 集市上架 / 购买
v0id wallet show --secret                            # 查看私钥（= 备份，挖到第一个币就备份！）
```

> 完整子命令、`market` / `name` / `wallet` 全集见 [TUTORIAL.md](TUTORIAL.md)。写操作（send/mine/market…）需带 `--name <节点名>` 或 `--api <url>` 指向运行中的节点（CLI 自动读取该节点的 API 令牌）。

> 🧪 **想亲手当攻击者、看防御如何把你拒掉？** 见 **[攻防实验手册 → LABS.md](LABS.md)**：篡改金额 / 压难度长 fork / 未来时间戳 / 双花 / 改坏链文件 / 越过 checkpoint，6 个可复现实验（每个一条命令、附实测拒绝信息）。

---

## 架构 & 协议（给开发者）

### 区块与链

```
Block { index, timestamp, prevHash, transactions[], merkleRoot, difficulty, nonce, miner, hash }
calcBlockHash = sha256Hex(JSON.stringify([index, timestamp, prevHash, merkleRoot, difficulty, nonce, miner]))
```

- **哈希**：全协议统一用 `sha256Hex(s)` = 对字符串 UTF-8 字节做 SHA-256 → 小写 hex。
- **Merkle 根**：交易 `txid` 两两 `sha256Hex(a+b)` 逐层归并（奇数复制末尾，空集 → `sha256Hex("")`），写进区块头。
- 区块头通过 `merkleRoot → hash → PoW` 把整组交易锚定。

### 共识：PoW + 最大工作量链

- **自适应难度，两代并存**（`packages/core/src/blockchain.ts: expectedDifficulty`）：
  - **v1**（高度 `< POW_V2_HEIGHT=15000`）：`difficulty` = 前导 0 **比特**数（非 hex 位 → 每 ±1 bit = 难度 ×/÷2，平滑可调），每 `RETARGET_INTERVAL` 块按窗口实际耗时向 `TARGET_BLOCK_TIME_MS`（8 秒）重定向。
  - **v2**（高度 `≥ 15000`，已为节点/钱包预留升级窗口）：`difficulty` 字段改承载 **BTC 风格 compact target（nBits）**，每 `POW_V2_RETARGET_INTERVAL` 块按比例重定向、单次限幅 ×/÷4 —— 给精确累计工作量。**区块 JSON 结构不变**。
  - 像 BTC 一样**无人为上限**（仅受 256-bit 物理天花板约束），有 `MIN_DIFFICULTY` 地板保证总能降回可挖。难度写进区块头、由各节点用链历史**确定性重算并校验**，矿工无法私设。
- **最大工作量合法链**（`replaceChain` / `chainWork`）：按**累计 PoW 工作量**（v1 `Σ 2^difficulty`，v2 BTC 风格 target proof）选链，**而非链长**；严格更大才替换（先到先得）。
- **未来时间戳上限**：时间戳须**单调不减**且不超本地时钟 `MAX_FUTURE_DRIFT_MS`（2 分钟）。这封死“把时钟调到未来 → 拉长重定向窗口 → 把难度压到地板”的操纵——与最大工作量规则合力，把“压难度双花”收敛为**真·≥51% 算力攻击**（任何 PoW 链都无法靠选链规则防住的固有上限）。
- **检查点（checkpoint）**：`config.ts` 的 `CHECKPOINTS` 硬编码若干 `{高度, hash}`；链在这些高度必须吻合，`replaceChain` 拒绝任何回滚到最新 checkpoint 之前的 reorg → **冻结已确认历史**，抬高深度 reorg 成本（低算力 PoW 链的标准缓冲，同 Bitcoin Core 早期）。当前已填入种子规范链前 300 块。

### 交易、签名与状态

```
Transaction { from, to, amount, fee, nonce, timestamp, memo, burn?, signature, txid }
```

- **签名**：**ed25519**（`@noble/ed25519`，RFC 8032，`zip215:false` 严格验签）。地址 = `0x` + 公钥小写 hex（64 字符）→ 地址**内含公钥**，验签直接从 `from` 取。
- **txid**：`txid = sha256Hex(JSON.stringify([from, to, amount, fee, nonce, timestamp, memo]))`，**`burn` 仅在 >0 时追加**到末尾。这保证历史/创世交易哈希**逐字节不变**（“加消息不重置链”的根基）。`fee` 一并计入 → **篡改手续费即破坏 txid**。签的是 `txid` 解码后的 **32 字节**（不是 hex 字符串）。
- **防重放**：每个地址自增 **nonce**，同一笔签名交易不能重复扣款。
- **手续费（gas）→ 矿工**：每笔普通转账 `fee ≥ minFeeFor(amount)`（保底 `MIN_FEE=1`，外加 ≥ `floor(amount × FEE_RATE_BPS/10000)` 的比例费，10 bps = 0.1%）；`coinbase 金额 = 出块奖励 BLOCK_REWARD + 本块手续费总额`，由共识钉死、多一分少一分即非法 → 杜绝矿工凭空增发。矿工按费**高者优先**打包（每块至多 `MAX_BLOCK_TXS`），形成手续费市场。
- **`applyTx` / `computeState` / `validateChain` 一套状态机**（`blockchain.ts`）：`computeState`（重放算余额/nonce/红包池/质押池）与 `validateChain`（共识唯一权威，从创世重放校验 PoW / coinbase / 每笔签名 / nonce 顺序 / 余额 / merkleRoot / checkpoint）**共用同一个 `applyTx`** → 矿工与校验方算出完全一致的状态，杜绝分叉。金额强制为正整数（浮点会让各节点累积舍入误差而撕裂共识）。

### memo 约定式协议动词

很多“功能”不改共识，而是约定 memo 前缀，让扫链的客户端把交易**还原**成更高层语义。链本身只把它们当合法交易；新代码只是为了**解释/显示**：

| 动词 | 形态 | 含义 |
| --- | --- | --- |
| `NAME\|<名字>` | 自转 1 币 | 抢注全网唯一昵称（先到先得，`names.ts`） |
| 消息（无前缀） | `amount=0 + burn>0 + memo` | 链上消息正文（`messages.ts`） |
| `ENC\|<密文>` | 同上，memo 为密文 | 端到端加密私信 |
| `RED\|份数\|r或e` | 转给 `RED_ESCROW_ADDRESS` | 发红包（拼手气 r / 均分 e，`redpacket.ts`） |
| `CLAIM\|<id>` / `REFUND\|<id>` | `amount=0` | 抢红包 / 过期退款（共识级托管，状态机在 `blockchain.ts`） |
| `MKT\|价格\|标题` / `BUY\|<id>` / `DEL\|<id>` | 转账 + memo | 集市上架 / 购买 / 撤单 |
| `STAKE\|<role>` / `UNSTAKE\|` / `SLASH\|` | 转给 `STAKE_ESCROW_ADDRESS` / `amount=0` | **v0idnet 中继押金/罚没**（详见 [v0idnet 模块](../v0idnet/README.md)） |

> ⚠️ **消息 / 加密私信是软分叉**：纯转账块新老节点都认；一旦块里有消息交易，或 memo 超过旧上限 128（加密私信把 `MAX_MEMO` 抬到 512），**未升级的节点会拒绝那个块**。但创世 hash 与既有 checkpoint **完全不变**（`burn` 仅 >0 时计入 txid）→ 老链与央行预挖原样有效，**无需重置链**。红包 `CLAIM/REFUND`、质押 `UNSTAKE/SLASH` 用 `amount=0` 的新边界，激活高度前按历史普通交易处理。**昵称不软分叉**（抢注在旧节点眼里只是合法自转）。

### 代码在哪

```
v0idchain/packages/
├── core/   区块链核心：crypto / wallet / transaction / block / blockchain / config
│           + memo 子系统：messages · redpacket · names · staking（…游戏子系统另属 game 模块）
├── node/   节点：p2p（WebSocket 网络）/ node（编排 + 挖矿循环）/ api（本地 HTTP 控制口，仅 127.0.0.1）
├── cli/    命令行（`v0id`）：start / send / mine / balance / info / msg / name / market / wallet
└── web/    Vite + React 仪表盘 + 区块浏览器
```

CLI 是**瘦客户端**：`start` 把节点跑起来，其余子命令通过节点的**本地 HTTP API**（仅 `127.0.0.1`，写接口需 Bearer 令牌 `api.token`，`0600`）操作运行中的节点。整链同步走 WebSocket（`HELLO` / `QUERY_ALL` / `BLOCKS` / `TX` / `PEERS`，单帧 ≤ 64MB）。

### 延伸阅读

- **[CLIENT-PROTOCOL.md](CLIENT-PROTOCOL.md)** — 跨实现互操作规范 + **金标准测试向量**（写任何非 Node 客户端必读：txid 预映像、签名、加密私信向量）。
- **[WEBRTC-MESH-DESIGN.md](WEBRTC-MESH-DESIGN.md)** — 浏览器原生 P2P（WebRTC mesh）设计。
- **[LABS.md](LABS.md)** — 6 个攻防动手实验。
- **[RUNNING-A-NODE.md](RUNNING-A-NODE.md)** · **[TUTORIAL.md](TUTORIAL.md)**（[English](TUTORIAL.en.md)）。

---

## 设计取向 & 已知边界（玩具链，别上真钱）

- **币的唯一来源 = coinbase**（出块奖励部分被共识钉死为 `BLOCK_REWARD`；手续费只是从发送方搬运、非增发）。创世给一个**“央行”地址**预挖 `GENESIS_PREMINE=1000` 启动币——`config.ts` 只写它的**地址（公钥，公开安全）**，**私钥只存所有者本机**（`.data/treasury/wallet.json`，已 gitignore）。央行是**单签普通地址、无任何铸币特权**，丢私钥 = 丢这 1000 币，与任何单签钱包一样。仓库里**不含任何私钥**。
- **整链校验是共识唯一权威**：每次接收都从创世重放，区块 hash 经 `txid` 把每笔交易（含 coinbase/创世）的内容锚定到 PoW —— 改金额/收款方都会被识破。创世块内容被完全锁定（既比对 `.hash` 又用内容重算）。
- **不可信输入一律设防**：P2P 消息逐字段校验、畸形包直接丢弃；收款地址必须合法 `0x`+64hex；gossip 学来的 peer 过滤私网/环回/链路本地（防 SSRF）；`knownUrls` 置顶 FIFO、`mempool ≤ MAX_MEMPOOL`、WS 单帧与分片同步聚合缓冲均有上限（防 OOM）；`wallet.json` / `api.token` / `chain.json` / `peers.json` 收紧到 `0600`；`chain.json` 损坏先备份再从创世重建（绝不静默清空）。
- **仍然没有**：Sybil 抗性、TLS、节点间鉴权/加密、成熟手续费市场（已有“高者优先 + 每块上限”雏形）。已知低危残留：HELLO 的 `address` 字段无签名（可冒充身份做 peer 展示，但盗不了币——花钱仍需 ed25519 签名）；inbound 连接数无上限、无逐连接带宽限流。**这是教学链，别上真钱**；真要联公网，至少自行套 TLS、管好 `api.token` 与央行私钥，并理解“低算力下 PoW 链固有的 51% 风险”。

---

## 致谢 & 许可证

依赖 [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) / [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) / [`@noble/curves`](https://github.com/paulmillr/noble-curves) / [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers)（Paul Miller，MIT）做签名/哈希/加密、[`ws`](https://github.com/websockets/ws)（MIT）做 P2P、[`commander`](https://github.com/tj/commander.js)（MIT）做 CLI，以及 [`react`](https://react.dev) / [`vite`](https://vite.dev) / [`tsx`](https://github.com/privatenumber/tsx) / [`typescript`](https://www.typescriptlang.org) 做仪表盘与工具链。设计参考 [Bitcoin 白皮书](https://bitcoin.org/bitcoin.pdf)、[RFC 8032（Ed25519）](https://www.rfc-editor.org/rfc/rfc8032)、[RFC 7748（X25519）](https://www.rfc-editor.org/rfc/rfc7748)、[FIPS 180-4（SHA-256）](https://csrc.nist.gov/pubs/fips/180-4/upd1/final)（**仅借鉴设计、未拷贝源码**）。完整清单见仓库根的 **[THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md)**。

v0idChain 自身代码以 **MIT License** 开源（© 2026 v0id-byte，见 [LICENSE](../../LICENSE)）。
