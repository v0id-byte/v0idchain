# v0idChain ⛓ — 手搓区块链，原生代币 `$V0ID`

**[English](README.en.md) | 中文**

教学型区块链：币靠挖矿产生，转账付手续费（gas）给矿工。TypeScript + Node.js，pnpm monorepo。
手写区块 / 哈希 / 链式结构 / PoW 挖矿 / ed25519 签名 / WebSocket P2P / 最大工作量链共识。

> 自建链，验证逻辑我们自己说了算 —— 挖矿出块（拿出块奖励 + 手续费）出币，转账付手续费（gas）归打包矿工。

---

## 这是什么

| 能力 | 实现 |
| --- | --- |
| 区块 & 链 | `{ index, timestamp, prevHash, transactions, merkleRoot, difficulty, nonce, miner, hash }`，SHA-256 链接 |
| 共识 | PoW（**自适应难度**，按前导 0 **比特** + 比特币式重定向）+ **最大工作量合法链**规则（按累计 PoW，非链长） |
| 代币 | `$V0ID`；币靠**挖矿**产生（每出一块矿工得 **1** 出块奖励 **+ 本块手续费**）；创世给“央行”地址预挖 **1000** 启动币 |
| 交易 | `{ from, to, amount, fee, nonce, timestamp, memo, signature, txid }`，**带手续费（gas）归矿工**，可带**备注 memo** |
| 手续费 | 每笔 ≥ `MIN_FEE`（默认 **1**），归打包矿工；矿工按费**高者优先**打包（每块至多 `MAX_BLOCK_TXS` 笔），形成手续费市场 |
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
corepack pnpm smoke          # 核心逻辑：挖矿/转账/余额/防重放/篡改检测/最大工作量共识
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
# node1 把挖来的币转 300 给 node2（需付手续费，默认最低 1；--fee 可自定，可加 --memo "留言"）
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
  --mine-interval <ms>           出块间歇（默认 0=连续挖，节奏由 PoW 难度决定；设>0 可省电）

v0id info     [--api URL]        节点状态
v0id balance  [address] [--api]  查余额（省略地址=查本节点）
v0id send     <to> <amount> [--fee <n>] [--memo <文字>] [--api]   转账（付 金额+手续费；--fee 自定 gas，默认最低 1）
v0id mine     [blocks]      [--api]    立即挖 N 个块
v0id peers    [--api]            已连接的对等节点
v0id connect  <ws-url> [--api]   主动连一个对等节点

v0id market list   [--all] [--api]            看在售商品（--all 含已售/下架）
v0id market sell   <price> <title…> [--api]   上架（自转 1 币，memo 记商品）
v0id market buy    <id> [--api]               购买（付标价给卖家，id 可填前缀）
v0id market delist <id> [--api]               撤下自己的商品

v0id wallet show   [--name|--data-dir] [--secret]   查看地址/公钥（--secret 显私钥 = 备份）
v0id wallet new    [--name|--data-dir]              新建钱包
v0id wallet import <私钥> [--name|--data-dir] [--force]   用备份私钥恢复钱包（找回币）
v0id wallet treasury-address                        显示“央行”预挖地址
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

> 链上结算（付款 + 成交记录），线下交付（笔记/帮忙/请客）。上架需先有 ≥2 余额（自转 1 币 + 最低手续费 1，手续费归矿工）。

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

- **币的来源 = 挖矿。** 每出一块矿工得 1 新币（出块奖励）**＋ 该块所有交易的手续费**；想拿币就开 `--mine`。创世另给一个“央行”地址预挖 1000 启动币，`config.ts` 里只写它的**地址（公钥，公开安全）**，对应**私钥只存所有者本机**（`.data/treasury/wallet.json`，已 gitignore，不入仓库）。只有持私钥者能用普通 `send` 分发这 1000。仓库里**不含任何私钥**。
  - 央行是**单签普通地址**（无 multisig / 时间锁，也**没有任何“铸币特权”**——它只是预挖那一笔的收款方；新币只来自 coinbase，**出块奖励部分**被共识钉死为 `BLOCK_REWARD`（coinbase 总额 = 奖励 + 本块手续费；手续费只是从发送方搬运、非增发），谁也无法靠该私钥多发币）。因此**丢失/泄露央行私钥 = 丢掉这 1000 币**，与任何单签钱包一样——请离线妥善保管（`wallet.json` 现已强制 `0600`）。
- **手续费（gas）→ 矿工。** 每笔普通转账必须带 ≥ `MIN_FEE`（默认 **1**）的手续费：发送方付 `金额 + 手续费`，收款方实收 `金额`，**手续费归打包该笔的矿工**（计入其 coinbase）。`coinbase 金额 = 出块奖励 + 本块手续费总额`，由共识钉死、多一分少一分都判非法 → 杜绝矿工凭空多发；手续费随 `txid` 一起签名，**篡改手续费即破坏 txid**。矿工按手续费**从高到低**挑交易（每块至多 `MAX_BLOCK_TXS` 笔）——拥堵时给得多的先上链，形成简单的**手续费竞价市场**。全链守恒：手续费只是从发送方搬到矿工、**不增发**（新币仍只来自出块奖励）；coinbase / 创世自身手续费恒为 0。
- **自适应难度**（前导 0 *比特*，非 hex 位 → 每 ±1 bit = 难度 ×/÷2，可平滑调整）。每 `RETARGET_INTERVAL` 块按过去窗口实际耗时向 `TARGET_BLOCK_TIME_MS` 重定向 —— **像 BTC 一样：算力涨则难度涨、算力跌则难度跌，无人为上限**（只受哈希 256-bit 物理天花板约束），有 `MIN_DIFFICULTY` 地板保证总能降回可挖。⚠️ 代价同 BTC：若算力先暴涨后骤降，少数慢机器会被高难度暂时卡住（要等下次重定向才降）。难度字段写进区块头、由各节点用链历史确定性重算并校验，矿工无法私自设难度。**出块节奏由 PoW 难度真正决定**（默认连续挖、无人为节流）。挖矿是**分片异步**的：每枚举一批 nonce 就让出事件循环，所以即便难度高、单块要算几秒，节点也不会卡死、能照常收发区块（收到别人的新块就放弃这块陈旧的活）。时间戳要求**单调不减**，且**不得超出本地时钟 `MAX_FUTURE_DRIFT_MS`（2 分钟）**——封死“把时钟调到 1 小时后拉长重定向窗口、把难度压到地板”的时间戳操纵（这是唯一一处与本地时钟相关的上下文校验）。
- **最大工作量链共识**：按**累计 PoW 工作量**（`chainWork = Σ 2^difficulty`）而非链长来选链——这是比特币的正确做法，在难度合法波动时也能选出真正工作量最大的链，杜绝"纯靠凑长度"反超。工作量相等或更小不替换（先到先得）。⚠️ **单靠它并不能挡住"压难度双花"**：一条更长的低难 fork，累计工作量可能仍然更大（它继承了诚实链的高难前缀、又多出很多块）。真正挡住该攻击的是上面的**未来时间戳上限**——压难度必须把出块时间戳拉到远未来，会被直接拒，于是难度压不下去、廉价块产生不出来。两者合力把攻击**收敛为"真·≥51% 算力攻击"**（任何 PoW 链都无法靠选链规则防住的固有上限——低算力链尤其脆弱）。
- **检查点（checkpoint）**：`config.ts` 的 `CHECKPOINTS` 硬编码若干 `{高度, hash}`；链在这些高度必须吻合（否则整链判非法），且 `replaceChain` 拒绝任何回滚到最新 checkpoint 之前的 reorg。把已确认历史**冻结**——即便攻击者真凑出更大工作量也改不动旧账，这是低算力 PoW 链对抗深度 reorg / ≥51% 的标准缓冲（同 Bitcoin Core 早期）。**当前已填入种子规范链的前 300 块（高度 100/200/300，均深度确认）**；运营者可继续用 `v0id checkpoint <height>` 取更近的已充分确认高度追加（所有节点须一致并一起重启，填错会让本地链无法通过校验）。
- **整链校验是共识唯一权威**：每次接收都会从创世重放，校验 PoW、coinbase 规则、每笔签名、nonce 顺序、余额（防双花/超额）。区块 hash 承诺交易的 `txid`，而校验时对**每一笔交易（含 coinbase/创世）都断言 `txid === 内容哈希`**，于是交易内容经由 txid 被 PoW 真正锚定 —— 改金额/收款方都会被识破。
- **创世块内容被完全锁定**：既比对 `.hash` 字段，又用内容重算 hash，再叠加上面的 txid 绑定 → 攻击者既偷不走预挖、也无法往创世里塞交易凭空增发。（早期版本曾有此漏洞，已修复并加了回归测试。）
- **金额必须是正整数**：浮点会让不同节点按不同交易顺序累积舍入误差、对“余额够不够”得出不同结论，从而撕裂共识 —— 故在验签层拒绝小数/越界金额。
- **不可信输入一律设防**：P2P 消息逐字段校验、畸形包直接丢弃（不会打挂节点）；转账收款地址必须是合法 `0x`+64hex；`knownUrls`/`seenTx` 均有上限，防内存无界增长与重连风暴。
- **本机 API 双重设防**：HTTP API 只绑 `127.0.0.1`，CORS 只放行本机（`localhost`/`127.0.0.1`）页面（防浏览器 CSRF）；**写接口（转账/挖矿/连接/集市）还需 Bearer 令牌**——`.data/<node>/api.token`（随机 32 字节，`0600`，启动自动生成；CLI 自动读取，仪表盘手动粘贴一次）。这挡住了同机其他进程 / 其他本地用户直接 `POST /send` 盗币。只读 GET 与 `/health` 不设防。
- **P2P 加固**：gossip 学来的 peer 地址会过滤掉私网/环回/链路本地地址（防被诱导去拨内网服务，SSRF 类；运营者 `--peers`/`--advertise` 显式地址走 trusted 通道、例外）。**IPv6 字面量按“只放行全局单播 `2000::/3`”白名单处理**，堵住 `::ffff:` IPv4-mapped、`64:ff9b::` NAT64、`[::1]` 等绕过写法（Node 会把 `::ffff:127.0.0.1` 规整成带方括号的十六进制，逐前缀黑名单不可靠）。`knownUrls` 满时 FIFO 淘汰最早的“非置顶”项、运营者种子永久置顶（防被垃圾地址挤爆而连不上真节点）；单条 WS 消息 ≤ 64MB（防巨型 JSON OOM）；`mempool` ≤ `MAX_MEMPOOL`（手续费已给 spam 定价，这里再加硬上限兜底反灌）。
- **私钥/令牌文件 `0600`**：`wallet.json`（明文私钥）与 `api.token` 都收紧到仅属主可读写。
- **`chain.json` 损坏兜底**：加载失败（解析错误或整链校验不过）时**先把坏文件改名备份**（`chain.json.corrupt-<时间戳>`）再从创世重建，绝不静默清空——否则有人改一个字节就能让节点重启即丢光本地状态。
- **仍然没有**：Sybil 抗性、TLS、节点间鉴权/加密、**成熟的**手续费市场（已有“高者优先 + 每块上限”的雏形，但还没有动态最低费 / EIP-1559 式定价）。两个已知低危残留：**HELLO 的 `address` 字段无签名**（节点身份可冒充，仅影响 peer 列表展示与去重，盗不了币——花钱仍需 ed25519 签名）；**WS 只限单条消息大小、无总带宽限流**（被 `maxPeers=8` 间接约束）。这是教学链，**别上真钱**；真要联公网，至少自行套 TLS（如置于反向代理后）、管好 `api.token` 与央行私钥，并理解“低算力下 PoW 链固有的 51% 风险”。

---

## 路线图

- [x] Phase 1 — core：区块 / 链 / PoW / 创世交易
- [x] Phase 2 — CLI：钱包 / 转账 / 余额 / 挖矿
- [x] Phase 3 — P2P：双节点同步 / peer 发现 / 持久化
- [x] Phase 4 — 挖矿广播 + 最大工作量链共识
- [x] Phase 5 — Web 仪表盘（React/Vite 实时看链 + 转账）
- [x] Phase 6 — 进阶：**自适应难度** · 交易 **备注 memo** · **Merkle 根** · **区块浏览器**（搜地址/txid/区块）
- [x] Phase 7 — **集市**：用 `$V0ID` 买卖商品/服务（建在 memo 之上，不改共识）
- [x] Phase 8 — **安全加固**：最大工作量共识 + 未来时间戳上限（防压难度双花）· **checkpoint 冻结历史**（挡深度 reorg）· API 令牌鉴权 · P2P 私网过滤 / `knownUrls` 置顶 FIFO · WS 大小上限 · mempool 上限 · 私钥/令牌文件 `0600`
- [x] Phase 9 — **手续费（gas）**：转账付费、费归打包矿工（计入 coinbase，共识钉死 `奖励+费`）· 最低费 + **高者优先**打包（手续费市场雏形）· 央行地址轮换
