# v0idChain ⛓ — 手搓区块链，原生代币 `$V0ID`

**[English](README.en.md) | 中文**

零成本、零 gas、零手续费的教学型区块链。TypeScript + Node.js，pnpm monorepo。
手写区块 / 哈希 / 链式结构 / PoW 挖矿 / ed25519 签名 / WebSocket P2P / 最长链共识。

> 自建链，验证逻辑我们自己说了算 —— 转账零手续费，挖矿（出块奖励）出币。

---

## 这是什么

| 能力 | 实现 |
| --- | --- |
| 区块 & 链 | `{ index, timestamp, prevHash, transactions, merkleRoot, difficulty, nonce, miner, hash }`，SHA-256 链接 |
| 共识 | PoW（**自适应难度**，按前导 0 **比特** + 比特币式重定向）+ **最长合法链**规则 |
| 代币 | `$V0ID`；币靠**挖矿**产生（每出一块矿工奖励 **50**）；创世给“央行”地址预挖 **1000** 启动币 |
| 交易 | `{ from, to, amount, nonce, timestamp, memo, signature, txid }`，**零手续费**，可带**备注 memo** |
| 区块头 | 交易 **Merkle 根** + 每块自适应 `difficulty`（前导 0 比特数） |
| 签名 | **ed25519**（`@noble/ed25519`）；地址 = `0x` + 公钥 hex |
| 防重放 | 每个地址自增 **nonce**，同一笔签名交易不能重复扣款 |
| 网络 | `ws` WebSocket 全双工；区块/交易广播；**peer gossip 自动发现**；断线自动重连 |
| 仪表盘 | 实时链状态 + 转账（带备注）+ **区块浏览器**（按地址/txid/区块搜索） |
| 持久化 | 链 + 钱包落盘成 JSON（`<dataDir>/chain.json`、`wallet.json`），重启不丢 |

---

## 项目结构

```
v0idchain/
├── packages/
│   ├── core/   区块链核心：crypto / wallet / transaction / block / blockchain / storage
│   ├── node/   节点：p2p（WebSocket 网络）/ node（编排+挖矿循环）/ api（本地 HTTP 控制口）
│   └── cli/    命令行：start / mine / send / balance / peers / info / wallet
└── scripts/    smoke.ts（核心冒烟）/ integration.ts（多节点集成测试）
```

CLI（`v0id`）通过节点的**本地 HTTP API**（仅 `127.0.0.1`）操作运行中的节点：
`start` 把节点跑起来，其余子命令是瘦客户端，用 `--api` 指定要操作哪个节点。

---

## 快速开始

### 0. 准备 pnpm（已装可跳过）

Node ≥ 18。本机用 Node 自带的 corepack 即可，无需全局装 pnpm：

```bash
corepack pnpm -v      # 任何 pnpm 命令都可写成 corepack pnpm …
```

### 1. 安装依赖

```bash
corepack pnpm install
```

### 🚀 加入公网一起挖矿（最快上手）

装好 Node + 依赖后，**一条命令**连上公共种子节点并开始挖矿：

```bash
corepack pnpm mine        # 连 ws://mc.void1211.com:6001，自动挖矿，每 5s 打一行状态
```

> 嫌命令麻烦？**双击** `mine.command`（macOS）或 `mine.bat`（Windows）—— 自动装依赖、开仪表盘、开挖。

想边挖边看链：另开一个终端 `corepack pnpm dev:web` → 浏览器 http://localhost:5173 。
挖到的币靠你自己的钱包（数据在 `.data/miner/`）持有，可以用 `send` 转给同学。

### 2. 自检（可选但推荐）

```bash
corepack pnpm smoke          # 核心逻辑：挖矿/转账/余额/防重放/篡改检测/最长链
corepack pnpm exec tsx scripts/integration.ts   # 多节点：广播/同步/迟到追链/持久化
```

### 3. 本地开双节点

开**两个终端**：

```bash
# 终端 1 —— node1，自动挖矿
corepack pnpm dev:node1

# 终端 2 —— node2，连上 node1
corepack pnpm dev:node2
```

`dev:node1` = `start --name node1 --p2p-port 6001 --api-port 7001 --mine`
`dev:node2` = `start --name node2 --p2p-port 6002 --api-port 7002 --peers ws://127.0.0.1:6001`

再开**第三个终端**操作它们：

```bash
v="corepack pnpm exec tsx packages/cli/src/index.ts"   # 或 corepack pnpm v0id

# 每个节点启动时都会打印自己的「地址 0x…」；用 info 也能随时查到
$v info --api http://127.0.0.1:7001        # node1 状态：链高/余额/对等/【地址】
$v info --api http://127.0.0.1:7002        # node2 状态：复制这里的【地址】备用

# 币靠挖矿产生：node1 开了 --mine，挖几块就有余额了（见 info 的余额）
# node1 把挖来的币转 300 给 node2（零手续费，可加 --memo "留言"）
$v send 0x<node2地址> 300 --api http://127.0.0.1:7001

$v balance 0x<某地址> --api http://127.0.0.1:7001   # 两个节点查到的余额应一致
```

> 启动币（创世预挖 1000）在“央行”地址，只有持有其私钥的人（项目作者，私钥存本机不入仓库）能用 `send` 分发。其他人一律靠**挖矿**拿币。

> 链数据落盘在 `./.data/<节点名>/`（重启不丢）。想从创世重新开始，删掉它即可：`rm -rf .data`。

### 4. Web 仪表盘（可选，实时看链）

确保至少有一个节点在跑（如上面的 node1），然后另开一个终端：

```bash
corepack pnpm dev:web
```

浏览器打开 **http://localhost:5173** —— 实时显示链高、本节点余额、难度(bit)、对等节点数、交易池，
以及最新区块流（每 1.5s 刷新，每块显示难度与 Merkle 根）。右上角输入框可切换要查看的节点 API 地址
（默认 `http://127.0.0.1:7001`，想看 node2 就改成 `http://127.0.0.1:7002`）。页面里能直接**转账**
（可填**备注**），还带一个**区块浏览器**：按地址查余额与交易史、按 txid 查单笔交易、按区块号/hash 查区块。

> 仪表盘是纯前端，只通过节点的 HTTP API 读写；节点 API 已开 CORS，本机直接用即可。

---

## CLI 命令速查

```
v0id start [选项]                启动节点（P2P + 本地 API，可选自动挖矿）
  --name <name>                  节点名，决定数据目录（默认 ./.data/<name>）
  --p2p-port <port>              P2P 端口（默认 6001）
  --api-port <port>              本地 HTTP API 端口（默认 7001）
  --peers / --bootstrap <urls>   逗号分隔的对等/种子节点 ws 地址
  --advertise <url>              对外广播的本节点 ws 地址（公网/局域网才需要）
  --mine                         启动后自动挖矿
  --mine-interval <ms>           出块间隔（默认 4000）

v0id info     [--api URL]        节点状态
v0id balance  [address] [--api]  查余额（省略地址=查本节点）
v0id send     <to> <amount> [--memo <文字>] [--api]    转账（零手续费，可带备注）
v0id mine     [blocks]      [--api]    立即挖 N 个块
v0id peers    [--api]            已连接的对等节点
v0id connect  <ws-url> [--api]   主动连一个对等节点

v0id market list   [--all] [--api]            看在售商品（--all 含已售/下架）
v0id market sell   <price> <title…> [--api]   上架（自转 1 币，memo 记商品）
v0id market buy    <id> [--api]               购买（付标价给卖家，id 可填前缀）
v0id market delist <id> [--api]               撤下自己的商品

v0id wallet show [--name|--data-dir] [--secret]   查看地址/公钥（--secret 显私钥）
v0id wallet new  [--name|--data-dir]              新建钱包
v0id wallet treasury-address                      显示“央行”预挖地址
```

---

## 集市（用 `$V0ID` 买卖商品/服务）

让币有用处 = 让币有价值。集市完全建在**转账 + memo**之上，**不改共识、零中心化服务器** ——
商品信息随链全网同步、永久可查：

- **上架** = 给自己转 1 币，memo 写 `MKT|价格|标题`（净额不变，只是把商品记上链）
- **购买** = 把标价转给卖家，memo 写 `BUY|<上架txid>`
- **撤单** = memo `DEL|<上架txid>`（仅卖家本人有效）

任何节点扫一遍链就能把这些 memo 还原成商品列表（已售/下架自动标注）。仪表盘里有「集市」面板，
也能用 CLI：

```bash
$v market sell 30 复习笔记第3章 --api http://127.0.0.1:7001   # 上架（等一个区块确认）
$v market list --api http://127.0.0.1:7002                    # 别的节点也能看到（已同步）
$v market buy 9f59c01a --api http://127.0.0.1:7002            # 用 id 前缀购买
```

> 链上结算（付款 + 成交记录），线下交付（笔记/帮忙/请客）。上架需先有 ≥1 余额（自转那 1 币）。

---

## 和同学联机

每个人 `corepack pnpm install` 后启动各自的节点，关键是**互相能连上**。

### A. 同一局域网（同 WiFi）

A 同学启动并查到自己内网 IP（如 `192.168.1.23`）：

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start --name me \
  --p2p-port 6001 --api-port 7001 --advertise ws://192.168.1.23:6001 --mine
```

B 同学连过去（连上一个就够，gossip 会自动发现其他人）：

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start --name me \
  --p2p-port 6001 --api-port 7001 --peers ws://192.168.1.23:6001 --mine
```

### B. 跨网络 —— 用一台公网机器当种子节点（推荐）

在一台有公网地址的机器上常驻一个种子节点（例如映射好端口的服务器）：

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start --name seed \
  --p2p-port 6001 --api-port 7001 --advertise ws://<公网域名或IP>:6001
```

> 需放通 / 端口转发 P2P 端口（这里 6001）。API 端口只监听 127.0.0.1，不对外。

所有同学只要把 `--peers ws://<公网域名或IP>:6001` 指向它即可，之后通过 gossip 自动认识彼此：

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start --name me \
  --p2p-port 6001 --api-port 7001 --peers ws://<公网域名或IP>:6001 --mine
```

---

## 设计说明 & 已知边界（玩具链，别上真钱）

- **币的来源 = 挖矿。** 每出一块矿工得 50 新币；想拿币就开 `--mine`。创世另给一个“央行”地址预挖 1000 启动币，`config.ts` 里只写它的**地址（公钥，公开安全）**，对应**私钥只存所有者本机**（`.data/treasury/wallet.json`，已 gitignore，不入仓库）。只有持私钥者能用普通 `send` 分发这 1000。仓库里**不含任何私钥**。
- **自适应难度**（前导 0 *比特*，非 hex 位 → 每 ±1 bit = 难度 ×/÷2，可平滑调整）。每 `RETARGET_INTERVAL` 块按过去窗口实际耗时向 `TARGET_BLOCK_TIME_MS` 重定向，钳制在 `MIN/MAX_DIFFICULTY`。难度字段写进区块头、由各节点用链历史确定性重算并校验，矿工无法私自降难度。时间戳要求单调不减（为保持各节点确定性，**不设**未来时间上限）。
- **最长链共识**：收到更长的合法链就整体替换。同高度分叉时保留当前链（先到先得）。极端情况下短暂分叉会随后被更长链收敛。
- **整链校验是共识唯一权威**：每次接收都会从创世重放，校验 PoW、coinbase 规则、每笔签名、nonce 顺序、余额（防双花/超额）。区块 hash 承诺交易的 `txid`，而校验时对**每一笔交易（含 coinbase/创世）都断言 `txid === 内容哈希`**，于是交易内容经由 txid 被 PoW 真正锚定 —— 改金额/收款方都会被识破。
- **创世块内容被完全锁定**：既比对 `.hash` 字段，又用内容重算 hash，再叠加上面的 txid 绑定 → 攻击者既偷不走预挖、也无法往创世里塞交易凭空增发。（早期版本曾有此漏洞，已修复并加了回归测试。）
- **金额必须是正整数**：浮点会让不同节点按不同交易顺序累积舍入误差、对“余额够不够”得出不同结论，从而撕裂共识 —— 故在验签层拒绝小数/越界金额。
- **不可信输入一律设防**：P2P 消息逐字段校验、畸形包直接丢弃（不会打挂节点）；转账收款地址必须是合法 `0x`+64hex；`knownUrls`/`seenTx` 均有上限，防内存无界增长与重连风暴。
- **本机 API 防 CSRF**：HTTP API 只绑 `127.0.0.1`，且 CORS 只放行本机（`localhost`/`127.0.0.1`）页面 —— 防止你浏览的恶意网站偷偷 `fetch` 你正在跑的节点去 `POST /send` 盗币（尤其是持币的“央行”节点）。
- **没有 Sybil / DoS 防护、没有 TLS、没有交易费市场**。这是教学链，不是生产系统。

---

## 路线图

- [x] Phase 1 — core：区块 / 链 / PoW / 创世交易
- [x] Phase 2 — CLI：钱包 / 转账 / 余额 / 挖矿
- [x] Phase 3 — P2P：双节点同步 / peer 发现 / 持久化
- [x] Phase 4 — 挖矿广播 + 最长链共识
- [x] Phase 5 — Web 仪表盘（React/Vite 实时看链 + 转账）
- [x] Phase 6 — 进阶：**自适应难度** · 交易 **备注 memo** · **Merkle 根** · **区块浏览器**（搜地址/txid/区块）
- [x] Phase 7 — **集市**：用 `$V0ID` 买卖商品/服务（建在 memo 之上，不改共识）
