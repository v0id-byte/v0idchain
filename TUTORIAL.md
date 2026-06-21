# v0idChain 完整教程 🧭

**[English](TUTORIAL.en.md) | 中文** · 从零到「联机挖矿 / 转账 / 摆摊」，外加每条常用命令的讲解。

> 读完你能：跑起一个节点、挖到 `$V0ID`、给同学转账（带备注/手续费）、在集市买卖、备份找回钱包，并看懂每条指令在干嘛。
> 配套参考：[README](README.md)（速查表 + 设计说明）。

---

## 0. 先理解 5 个概念（白话版）

| 概念 | 一句话 |
| --- | --- |
| **钱包 / 地址** | 一对密钥。**地址** = `0x` + 公钥，公开给别人收款用；**私钥**只在你本机，丢了币就找不回。地址就是身份。 |
| **挖矿出币** | 你的节点不停算哈希（PoW）找到一个符合难度的区块，**每出一块奖励 1 个 `$V0ID`**（外加这块里所有交易的手续费）。这是币的唯一来源。 |
| **手续费（gas）** | 每笔转账要付一点手续费（默认最低 **1**），**归打包这笔的矿工**。给得多的，矿工优先打包。发送方付「金额 + 手续费」，收款方实收「金额」。 |
| **nonce / 防重放** | 每个地址有个自增计数。同一笔签好名的交易不能被重复广播扣两次钱。 |
| **共识 = 最大工作量链** | 全网谁的链**累计 PoW 工作量最大**就以谁为准（不是谁更长）。再加「未来时间戳上限」「checkpoint 冻结历史」防作弊。 |

还有两个会用到的：**集市** = 用转账 + 备注（memo）在链上摆摊买卖；**央行地址** = 创世预挖 1000 启动币的地址（私钥只在项目作者手里）。

---

## 1. 准备环境（5 分钟）

需要 **Node ≥ 18**（建议 20+）。本机用 Node 自带的 **corepack** 跑 pnpm，不用全局装：

```bash
node -v                     # 确认 ≥ 18
git clone https://github.com/v0id-byte/v0idchain.git
cd v0idchain
corepack pnpm install       # 装依赖（任何 pnpm 命令都写成 corepack pnpm …）
```

为了少打字，先记一个**简写**（本教程后面都用 `$v` 代表 CLI）：

```bash
v="corepack pnpm exec tsx packages/cli/src/index.ts"
$v --help                   # 看所有命令
```

---

## 2. 路线 A：加入公网链，一条命令开挖（最快上手）

```bash
corepack pnpm mine
```

这条等价于：以节点名 `miner` 启动，连上公共种子 `ws://mc.void1211.com:6001`，自动挖矿，每 5s 打一行状态。你会先看到：

```
  🔄 正在连接 / 同步区块…        ← 先连上种子、把链追平，期间不挖（避免分叉）
  ⛏ 12:00:05  链高 502 +3  余额 2 $V0ID  难度 21bit  对等 1  池 0
```

> **为什么一开始不挖？** 联网节点会**先连上 + 追平全网链高**才开挖，断网会暂停——否则你会从创世自己挖出一条没人认的「平行链」。看到链高从几百开始涨、对等≥1，就说明同步上了。

**双击更省事**：`mine.command`（macOS）/ `mine.bat`（Windows）会自动装依赖 + 开仪表盘 + 开挖。

挖矿时另开一个终端操作这个 `miner` 节点（注意带 `--name miner`，见下方「令牌」说明）：

```bash
$v info  --name miner                 # 看自己的地址/余额/链高
$v balance --name miner               # 查本节点余额
```

> ⚠️ **令牌（token）**：`pnpm mine` 的节点名是 **miner**。查询类命令（info/balance/peers）不需要令牌；但**转账/挖矿等写操作**要带 `--name miner`，CLI 才能从 `.data/miner/api.token` 自动读到令牌（否则会 `unauthorized`）。也可显式 `--token <令牌>`。

**👉 挖到币后，第一件事是备份钱包**（见 [第 8 节](#8-钱包备份与找回必看)）。

---

## 3. 路线 B：本地沙盒，彻底搞懂机制（强烈推荐先玩这个）

不连公网，在自己电脑上开**两个节点**互相同步，看清「挖矿→出币→转账→同步」全过程。

**终端 1** —— node1，自动挖矿：

```bash
corepack pnpm dev:node1
# = start --name node1 --p2p-port 6001 --api-port 7001 --mine
```

**终端 2** —— node2，连上 node1：

```bash
corepack pnpm dev:node2
# = start --name node2 --p2p-port 6002 --api-port 7002 --peers ws://127.0.0.1:6001
```

**终端 3** —— 操作它们（本地沙盒里 node1/node2 各有独立数据目录，令牌各自在 `.data/node1`、`.data/node2`）：

```bash
v="corepack pnpm exec tsx packages/cli/src/index.ts"

$v info --api http://127.0.0.1:7001 --name node1     # node1：链高在涨、余额在涨（它在挖）
$v info --api http://127.0.0.1:7002 --name node2     # node2：复制它的【地址】备用

# node1 把挖来的币转 5 给 node2（带 1 手续费、附条备注）
$v send 0x<node2地址> 5 --fee 1 --memo "午饭钱" --api http://127.0.0.1:7001 --name node1

# 等 node1 再挖出一块把这笔打包，两个节点查到的余额应一致
$v balance 0x<node2地址> --api http://127.0.0.1:7001     # 应显示 5
$v balance 0x<node2地址> --api http://127.0.0.1:7002     # node2 也是 5（已同步）
```

看明白这一圈，你就懂了整条链。

---

## 4. 常用指令逐条讲解 📖

所有「客户端」子命令都通过 `--api <地址>`（默认 `http://127.0.0.1:7001`）对话一个**正在运行**的节点；用 `--name` / `--data-dir` 定位该节点的令牌文件。

### `start` —— 启动节点（最重要）

```bash
$v start --name me --p2p-port 6001 --api-port 7001 --peers ws://mc.void1211.com:6001 --mine
```

| 选项 | 作用 |
| --- | --- |
| `--name <名>` | 节点名，决定数据目录 `./.data/<名>/`（默认 `node`） |
| `--p2p-port <端口>` | 节点间 P2P 端口（默认 6001） |
| `--api-port <端口>` | 本地 HTTP 控制口，只绑 `127.0.0.1`（默认 7001） |
| `--peers` / `--bootstrap <urls>` | 逗号分隔的种子/对等节点 ws 地址 |
| `--advertise <url>` | 对外广播的本节点 ws 地址（公网/局域网当种子才需要） |
| `--mine` | 启动后自动挖矿 |
| `--mine-interval <ms>` | 出块间歇，默认 `0`=连续挖（节奏由难度决定）；设 >0 可省电 |

启动后会打印：地址、P2P/API 地址、数据目录、**令牌路径**（`api.token`）、当前链高与余额。

### `info` —— 节点状态

```bash
$v info --name me
```
```
地址   0x….
余额   7 $V0ID
链高   503（504 个区块）
交易池 0 笔待打包
难度   21
手续费 ≥ 1（gas，给矿工）
对等   1 个节点
```

### `balance` —— 查余额

```bash
$v balance                       # 不带地址 = 查本节点自己
$v balance 0x<某地址> --name me   # 查任意地址
```

### `send` —— 转账（核心）

```bash
$v send 0x<收款地址> 100 --fee 2 --memo "请你喝奶茶" --name me
```
- 发送方实际扣 **金额 + 手续费**（这里 102）；收款方收到 **金额**（100）；手续费（2）给把这笔打进区块的矿工。
- `--fee`：默认最低 **1**；**给多了打包更优先**（拥堵时拼手续费）。
- `--memo`：上链可查的备注（≤128 字，可含 emoji）。
- 输出 `✅ 交易已广播 txid=… 手续费=2`。交易要等被矿工挖进一个区块才算确认（余额才变）。

### `mine` —— 手动挖几块

```bash
$v mine 3 --name me      # 让运行中的节点立刻挖 3 个块
```
（`start --mine` 是后台连续挖；`mine N` 是手动催几块，沙盒里调试很方便。）

### `peers` / `connect` —— 看/加对等节点

```bash
$v peers --name me                                  # 当前连了谁
$v connect ws://127.0.0.1:6002 --name me            # 主动连一个节点
```

### `checkpoint` —— 生成历史冻结点（运营者用）

```bash
$v checkpoint 300 --name me
#  { index: 300, hash: '0000…' },     ← 粘进 packages/core/src/config.ts 的 CHECKPOINTS
```
把某个**已充分确认**的高度钉死，防深度回滚（≥51% 攻击）。**所有节点必须填一致并一起重启**，填错 hash 会让本地链校验不过。一般人用不到，这是给维护者周期性加的。

### `market` —— 集市（见 [第 6 节](#6-集市摆摊买卖)）

```bash
$v market list [--all] --name me
$v market sell <价格> <标题…> --name me
$v market buy  <商品id前缀> --name me
$v market delist <商品id> --name me
```

### `msg` / `inbox` —— 链上消息（烧币留言，见 [第 7 节](#7-链上消息--新人发现-)）

```bash
$v msg 0x<收件人地址> 你好呀 --name me            # 发消息：默认烧 5 + 1 手续费
$v inbox --name me2                              # 收件人查收件箱（等一个区块确认）
$v inbox --sent --name me                        # 看自己发出去的
```

### `newcomers` —— 看本次会话发现的新成员

```bash
$v newcomers --name me     # 列出「新节点上线」「新地址首次上链」（运行中的节点也会实时打 🆕）
```

### `name` —— 链上昵称（全网唯一抢注，先到先得）

```bash
$v name claim v0id-boss --name me   # 抢注昵称（自转 1 币 + memo；先到先得；等一个区块）
$v name list  --name me             # 看已注册的昵称
$v name who   v0id-boss --name me   # 这个昵称属于哪个地址
$v name of    --name me             # 我（或指定地址）的显示昵称
```

抢到后，转账/消息/浏览器里你就显示成 `@v0id-boss` 而不是一长串地址。名字 1~20 位 小写字母/数字/`_`/`-`；`treasury`/`official` 等保留名禁注。纯 memo 约定、**不改共识**。

### `wallet` —— 钱包管理（**不需要节点在跑**，直接读数据目录）

```bash
$v wallet show --name me [--secret]     # 看地址/公钥；--secret 连私钥一起显示（= 备份）
$v wallet new  --name me2               # 在新数据目录里生成一个新钱包
$v wallet import <64位私钥> --name me   # 用备份私钥恢复钱包（连链上余额一起找回）
$v wallet treasury-address             # 显示「央行」预挖地址（公开信息）
```

---

## 5. Web 仪表盘（可视化看链 + 转账）

确保有节点在跑，另开终端：

```bash
corepack pnpm dev:web
```

浏览器开 **http://localhost:5173**：实时链高、余额、难度、对等数、交易池、最新区块流，还有**区块浏览器**（按地址/txid/区块号查）。右上角能切换要看的节点 API、以及**粘贴 API 令牌**。

> **想在仪表盘里转账**？因为页面是跨源前端、读不到本机文件，所以要把令牌**手动粘贴一次**：令牌在节点数据目录的 `api.token`（如 `.data/miner/api.token`），复制内容贴进右上角「API 令牌」框即可（浏览器会记住）。只看链不转账则不用。

---

## 6. 集市：摆摊买卖 🛒

集市完全建在「转账 + 备注」之上，**不改共识、零服务器**，商品随链全网同步：

```bash
# 卖家上架（自转 1 币 + 最低手续费，把商品记上链；需 ≥2 余额）
$v market sell 30 复习笔记第3章 --name me
#  🏷 已上架 txid=9f59c01a…（等一个区块确认后可见）

# 任何人都能看到（已同步全网）
$v market list --name me
#  [在售] 30 $V0ID  复习笔记第3章   卖家 0x12ab…  id 9f59c01a34bc…

# 买家购买（付标价给卖家，id 填前缀即可）
$v market buy 9f59c01a --name me
#  🛒 已下单付款 txid=…
```

撤单：`$v market delist <商品id> --name me`（仅卖家本人有效）。
**链上结算（付款 + 成交记录都在链上），线下交付**（笔记/帮忙/请客）。

---

## 7. 链上消息 & 新人发现 ✉️

**发消息 = 烧币留言。** 给任意地址发一句话：不转币，而是把一点 `$V0ID` **销毁进虚空**（永久不可花 = 销毁），
正文明文上链、全网同步、永久可查。技术上它是一种新交易（`amount=0 + burn>0 + memo=正文`），另付最低手续费给打包矿工。

```bash
# node1 给 node2 发消息（默认烧 5 + 1 手续费）
$v msg 0x<node2地址> "在链上给你留个话 👋" --name node1
#  ✉️ 消息已广播 txid=…  🔥烧=5 手续费=1

# 等一个区块把它打包后，node2 查收件箱
$v inbox --name node2
#  ← 0x…（node1）  在链上给你留个话 👋   🔥5 #25   2026/6/21 …

$v inbox --sent --name node1     # node1 看自己发出去的
```

烧得多更壕、更通缩：`--burn 50`。全网累计销毁量看 `v0id info` 的「已销毁 🔥」或仪表盘顶部。

**🔒 加密私信**：加 `-e`，消息只有收件人能解（密文上链、旁人只看到 `ENC|` 乱码；你作为发件人也能解自己发的）：

```bash
$v msg 0x<node2地址> "只有你能看到的悄悄话 🤫" -e --name node1
$v inbox --name node2     # node2 自动解密显示明文 + 🔒
```

> 加密把 memo 上限从 128 抬到 512（装密文）——这是软分叉，需全网一起升级；不重置链。

**新人发现。** 运行中的节点遇到两种「新人」会实时打一行 `🆕`，也可 `v0id newcomers` / 仪表盘「新成员」面板回看：

- **新节点上线**（P2P 层）：有新机器连进网络、握手报出地址时。
- **新地址首次上链**（经济身份）：某地址第一次作为转账/消息的收发方出现在区块里时。

> ⚠️ **消息是一次软分叉**：没升级到本版本的节点会拒绝含消息交易的块。联网玩消息前请确保**所有节点（含公网种子）都升级**。
> 但创世 hash 与既有 checkpoint **完全不变**（销毁额仅在 >0 时计入 txid），老链与央行预挖原样有效，**不用重置链**。

---

## 8. 钱包备份与找回（必看‼️）

私钥只在你本机的 `.data/<节点名>/wallet.json`（已设为 `0600` 仅你可读）。**删了数据目录 / 换电脑 = 币没了**，除非你备份过私钥。

```bash
# 备份：显示私钥，抄到安全的地方（别截图发群里）
$v wallet show --name miner --secret

# 找回：换机或误删后，用私钥恢复（连链上余额一起回来）
$v wallet import <你抄下的64位私钥> --name miner
# 然后正常 corepack pnpm mine 联网，余额会自动同步回来
```

---

## 9. 和同学联机 🌐

### A. 同一局域网（同 WiFi）

A 同学查到自己内网 IP（如 `192.168.1.23`）后当「小种子」：

```bash
$v start --name me --p2p-port 6001 --api-port 7001 --advertise ws://192.168.1.23:6001 --mine
```

其他人连上他（连一个就够，gossip 会自动发现其他人）：

```bash
$v start --name me --p2p-port 6001 --api-port 7001 --peers ws://192.168.1.23:6001 --mine
```

### B. 跨网络 —— 直接用现成的公网种子

最省事：所有人都 `corepack pnpm mine`（已内置 `--peers ws://mc.void1211.com:6001`），自动汇入同一条链。互相转账只要拿到对方 `info` 里的地址即可。

---

## 10. 常见问题排查 🛠️

| 现象 | 原因 / 解法 |
| --- | --- |
| **链高一直 0 / 从创世自己涨** | 没连上网（`对等 0`）。联网节点必须先连上+追平才挖；检查 `--peers` 地址、防火墙/端口。`info` 看 `对等` 是否 ≥1。 |
| **`unauthorized：缺少或错误的 API token`** | 写操作（send/mine/market）要令牌。带 `--name <你启动时的名字>`（如 `--name miner`）让 CLI 自动读 `api.token`，或 `--token <令牌>`。 |
| **`连不上节点 …`** | 那个节点没在跑，或 `--api` 端口写错。先 `start`，再用对应 `--api-port`。 |
| **转账报「余额不足：可用 X，需要 Y（含手续费 N）」** | 你的余额 < 金额 + 手续费。先挖几块或收点币；或调小金额/`--fee`。 |
| **两节点链高/余额对不上** | 等几秒同步；或对方刚挖出新块还没传到。`peers` 确认互相连着。 |
| **看到 `chain.json 无法加载…已备份到 chain.json.corrupt-…`** | 链文件损坏，节点已**自动备份坏文件并从创世重建**（联网会同步回来）——这是保护，不是 bug。 |
| **想从头再来** | 删数据目录：`rm -rf .data/<节点名>`（**会丢这个节点的钱包**，先备份私钥！）。 |

---

## 11. 安全与边界（别上真钱）

这是**教学链**。已经做了不少加固（最大工作量共识 + 未来时间戳上限防双花、checkpoint 冻结历史、API 令牌、钱包/令牌 `0600`、P2P 私网过滤防 SSRF、损坏链兜底——详见 [README 的「设计说明 & 已知边界」](README.md#设计说明--已知边界玩具链别上真钱)）。

但仍然：**没有 TLS、没有节点间加密、低算力下有 PoW 链固有的 51% 风险**（checkpoint 只是抬高成本不是消除）。所以：**别放真钱**；玩、学、和同学联机刚刚好。

---

## 12. 进阶

```bash
corepack pnpm smoke                              # 核心逻辑自检（挖矿/转账/共识/安全回归）
corepack pnpm exec tsx scripts/integration.ts    # 多节点集成测试
corepack pnpm -r run typecheck                   # 全包类型检查
```

源码导览：`packages/core`（区块/链/PoW/交易/钱包/存储/共识）· `packages/node`（p2p / 挖矿编排 / 本地 API）· `packages/cli`（命令行）· `packages/web`（仪表盘）。想改规则就从 `packages/core/src/config.ts`（参数）和 `blockchain.ts`（共识）下手。

玩得开心 —— 挖到第一个 `$V0ID` 时，记得 `wallet show --secret` 备份！
