# 怎么开节点 —— 完整安装指南

> 新手入口：先跑通这篇，再去 [TUTORIAL.md](../TUTORIAL.md) 学转账 / 集市 / 备份等玩法。

---

## 1. 系统要求

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| **Node.js** | **v22.13** | 本项目用 `pnpm@9.15.0`，该版本要求 Node ≥ 22.13 |
| **pnpm** | 9.15.0 | 通过 corepack 自动管理，无需手动全局安装 |
| **Git** | 任意 | 克隆代码用 |

> ⚠️ 如果 `corepack pnpm install` 报错 `This version of pnpm requires at least Node.js v22.13`，说明 Node.js 版本太低，按下面第 2 节升级。

---

## 2. 安装 / 升级 Node.js

**推荐用 nvm（Node 版本管理器）——可随时切换版本，不污染系统全局。**

### macOS / Linux

```bash
# 安装 nvm（已有可跳过）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# 重开终端，或 source ~/.bashrc / ~/.zshrc

# 安装 Node v22（LTS）并切换
nvm install 22
nvm use 22
node -v      # 应显示 v22.x.x（≥ 22.13）
```

> 如果不想用 nvm，也可以到 [nodejs.org](https://nodejs.org) 下载 **v22.x LTS** 安装包，按向导安装。

### Windows

```powershell
# 下载并安装 nvm-windows
# https://github.com/coreybutler/nvm-windows/releases → nvm-setup.exe

nvm install 22
nvm use 22
node -v
```

> 同样可以从 [nodejs.org](https://nodejs.org) 直接下载 v22.x 的 Windows 安装包。

---

## 3. 启用 corepack

Node v22 自带 corepack，首次使用需开启：

```bash
corepack enable      # 开启（需要 node ≥ 16.10）
corepack pnpm -v     # 应打印 9.15.0
```

本项目所有 pnpm 命令都写成 `corepack pnpm …`，不依赖全局 pnpm，版本由 `package.json` 的 `packageManager` 字段锁定。

---

## 4. 克隆代码 & 安装依赖

```bash
git clone https://github.com/v0id-byte/v0idchain.git
cd v0idchain
corepack pnpm install      # 首次约 30 s，装完不会重复装
```

验证环境正常：

```bash
corepack pnpm smoke        # 跑核心冒烟测试，全绿说明 OK
```

---

## 5. 加入公网、开始挖矿（最快上手）

一条命令连上公共种子并开始挖：

```bash
corepack pnpm mine
```

等价于：

```
start --name miner --p2p-port 6001 --api-port 7001 --peers ws://mc.void1211.com:6001 --mine
```

启动后会打印你的**钱包地址**，然后先同步再挖矿：

```
🔄 正在连接 / 同步区块…        ← 追平全网链高，期间不挖（避免分叉）
⛏  12:00:05  链高 502 +3  余额 2 $V0ID  难度 21bit  对等 1  池 0
```

看到「对等 ≥ 1、链高从几百起涨」就说明接上了。

**双击更省事**：`mine.command`（macOS）/ `mine.bat`（Windows）自动装依赖 + 开仪表盘 + 开挖，什么都不用配。

挖矿时另开一个终端查自己状态：

```bash
v() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }   # 简写
v info --name miner          # 地址 / 余额 / 链高 / 对等数
v balance --name miner       # 只看余额
```

> ⚠️ **挖到第一个币，立刻备份钱包**（见 [TUTORIAL.md §8](../TUTORIAL.md#8-钱包备份与找回必看)）：私钥只在 `.data/miner/wallet.json`，删了数据目录币就没了。

---

## 6. 本地沙盒（两个节点互联，不联公网）

适合学习机制 / 调试功能，开两个终端分别跑 node1 / node2：

**终端 1 — node1（自动挖矿）**

```bash
corepack pnpm dev:node1
# = start --name node1 --p2p-port 6001 --api-port 7001 --mine
```

**终端 2 — node2（连上 node1）**

```bash
corepack pnpm dev:node2
# = start --name node2 --p2p-port 6002 --api-port 7002 --peers ws://127.0.0.1:6001
```

**终端 3 — 操作**

```bash
v() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }

v info --api http://127.0.0.1:7001 --name node1    # 看 node1 状态（含地址）
v info --api http://127.0.0.1:7002 --name node2    # 看 node2 状态，复制地址备用

# node1 挖几块后有余额，把 5 个币转给 node2（手续费 1，备注随意）
v send 0x<node2地址> 5 --fee 1 --memo "午饭钱" --api http://127.0.0.1:7001 --name node1

# 等 node1 挖出下一块打包这笔交易，两端余额应一致
v balance 0x<node2地址> --api http://127.0.0.1:7002
```

---

## 7. 开自己的公网种子节点

在有公网 IP 的服务器上充当种子，让同学连过来：

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start \
  --name seed \
  --p2p-port 6001 \
  --api-port 7001 \
  --advertise ws://<公网IP或域名>:6001
```

- 放通防火墙 **P2P 端口**（这里 6001），API 端口（7001）只绑 `127.0.0.1` 不对外。
- 同学加 `--peers ws://<公网IP或域名>:6001` 即可接入，gossip 会自动帮大家发现彼此。

---

## 8. Web 仪表盘（实时看链 + 转账）

确保有节点在跑，另开终端：

```bash
corepack pnpm dev:web
```

浏览器打开 **http://localhost:5173** —— 实时链高 / 余额 / 区块流 / 区块浏览器，页面里也能直接转账。

> 转账要粘贴 API 令牌（在 `.data/<节点名>/api.token`）——跨源页面读不到本地文件，贴一次浏览器会记住。

---

## 9. 常见启动问题

| 现象 | 原因 / 解法 |
|------|------------|
| `This version of pnpm requires at least Node.js v22.13` | Node.js 版本低于 22.13，按第 2 节升级 |
| `corepack: command not found` | 运行 `npm install -g corepack`，或换用 `npx pnpm …` |
| `Error: listen EADDRINUSE :::6001` | 端口被占。换 `--p2p-port 6002`，或找到并关掉占用进程 |
| 链高一直 0 / 从 0 开始涨（未联网）| 没连上种子（`对等 0`）。检查 `--peers` 地址与防火墙 |
| `unauthorized：缺少或错误的 API token` | 写操作（send / mine / market）需带 `--name <启动时的名字>` |
| `corepack pnpm install` 一直报网络错误 | 检查是否需要代理，或改用镜像：`COREPACK_NPM_REGISTRY=https://registry.npmmirror.com corepack pnpm install` |

更多问题见 [TUTORIAL.md §10 常见问题排查](../TUTORIAL.md#10-常见问题排查-)。
