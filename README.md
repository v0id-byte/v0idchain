# v0idChain — 匿名网络 · 区块链 · 链上游戏

**[English](README.en.md) | 中文**

一个从零手搓的 TypeScript 项目,长出了三块能跑的东西:一个 **Tor 式洋葱匿名网络(v0idnet)**、它脚下的**自建区块链($V0ID)**、以及一个**全链上的像素游戏**。pnpm monorepo,`tsx` 直跑、无构建步。

> 诚实说在前:这是**自建/学习级**实现(不是经过审计的生产密码学)。匿名网络在设计上是真的、但规模小=匿名弱。各模块按真实成熟度诚实介绍。

---

## 🧅 v0idnet —— `.v0id` 洋葱匿名网络(主角)

> **[→ 模块文档 docs/v0idnet/](docs/v0idnet/README.md)** · [架构与原理(含图)](docs/v0idnet/ARCHITECTURE.md)

类 Tor 的洋葱匿名网络:访客与服务器经 **3 跳加密电路**通信,`.v0id` 隐藏服务让**收发双方互不知 IP**。区块链当**去中心化中继目录**(回放链即得一致名单,替代 Tor 目录权威)。

- **浏览 / 托管 `.v0id` 隐藏服务** · **跑中继** · **Mixnet**(opt-in)· **质押激励层**(已建,height 16000 激活)
- **下载 v0id 浏览器**(签名公证 macOS app):[browser-v0.2.5](https://github.com/v0id-byte/v0idchain/releases/tag/browser-v0.2.5) · Win/Linux 敬请期待
- **线上网络**:种子 `mc.void1211.com:6001` + 6 中继,真 3 跳电路已验证

## ⛓ v0idChain —— $V0ID 区块链(底座)

> **[→ 模块文档 docs/blockchain/](docs/blockchain/README.md)** · [开节点](docs/blockchain/RUNNING-A-NODE.md) · [完整教程](docs/blockchain/TUTORIAL.md)

手写区块 / 哈希 / PoW 挖矿(自适应难度 + 比特币式重定向 + 最大工作量链)/ ed25519 签名 / WebSocket P2P。币靠挖矿产生,转账付手续费(gas)给矿工。v0idnet 与游戏都跑在它上面。

- 转账 · 链上**消息**(烧币进虚空)· 全网唯一**昵称** · 端到端**加密私信** · **红包** · **集市**
- 一切社交/游戏/匿名功能都用 **memo 约定**叠在链上,大多不改共识

✅经认证的公共节点：[节点列表](docs/blockchain/SEED-LIST.md)

🤔**想看示范网址？**

  http://n7gflua3d4zzwkmzzmwvonjtht7g34krrujzzn7w5nruu2q4cf7ipoab.v0id/

## 🎮 链上游戏 —— 像素社交世界 [game.void1211.com](game.void1211.com) 即可开玩！

> **[→ 模块文档 docs/game/](docs/game/README.md)**

一个**全链上的像素社交世界**:收集崽/NFT、种植、钓鱼、挖矿采集,喂养一个**虚空图鉴**收藏 meta。完全建在区块链的 memo 约定之上(不改共识)。

---

## 快速上手

```bash
corepack pnpm install                 # Node 18+，仓库自带 pnpm
# 跑一个节点 + 挖矿(详见各模块文档)
corepack pnpm exec tsx packages/cli/src/index.ts start --mine --peers ws://mc.void1211.com:6001
```

- **想匿名上网** → [v0idnet 上手](docs/v0idnet/README.md)
- **想玩链 / 开发** → [区块链上手](docs/blockchain/README.md) + [教程](docs/blockchain/TUTORIAL.md)
- **想玩游戏** → [游戏文档](docs/game/README.md)

## 仓库结构

| 目录 | 内容 |
|---|---|
| `packages/core` | 链 + 洋葱协议 + 游戏逻辑(`onion*` `hs*` `mixnet` / `pets` `farm` `fishing` `mine`) |
| `packages/node` | P2P + 本地 API + 中继子系统(`relay/*`) |
| `packages/cli` | `v0id` 命令行守护进程 |
| `packages/game-server` · `game-web` · `web` | 游戏服务/前端 · web 钱包 |
| `clients/desktop` | v0id 浏览器(Electron) |
| `docs/{v0idnet,blockchain,game}/` | 三大模块文档 |

## 诚实边界与署名

匿名集小 = 弱匿名;不防全局被动对手 / 应用层去匿名;激励 v1 中心化测量。各模块文档有详细的诚实边界。第三方代码许可与署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md);v0idnet 思想借鉴 Tor / Nym / Orchid / Lokinet(见各文件头与 [ARCHITECTURE §9](docs/v0idnet/ARCHITECTURE.md))。
