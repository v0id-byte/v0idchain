# 虚空世界 · 链上像素社交世界 🎮

**[English](./README.en.md) | 中文**

> v0idChain 三大模块之一。
> [🏠 总览（根 README）](../../README.md) · [⛓ 区块链（底座）](../blockchain/README.md) · [🧅 v0idnet 匿名网络（头牌）](../v0idnet/README.md) · **🎮 链上游戏（本模块）**

一个**完全跑在链上**的像素社交世界：你养崽（链上基因 NFT）、种地、钓鱼、下矿，把每一件藏品都铸进 **虚空图鉴（Void Codex）**——一面**不可伪造、随链永久可查**的收藏墙。

这不是一次性 demo。它是一个**真游戏**，也是 `$V0ID` 链最好的「能用、好玩」教学展柜：所有有价值的东西（崽、渔获、作物、矿物、地块）都是**链上资产**，靠玩家本人**签名**铸造、由**全网节点校验**，游戏服务器一行都改不了它。

> 🎨 **像素是底色。** 全程像素风、等宽字体、硬像素阴影——没有圆角、毛玻璃、渐变。审美就是设计的一部分，不是省事。

---

## 目录

- [给玩家](#给玩家)
  - [这是什么](#这是什么)
  - [玩法一览](#玩法一览)
  - [虚空图鉴：脊椎](#虚空图鉴脊椎)
  - [怎么开始玩](#怎么开始玩)
- [给开发者](#给开发者)
  - [一句话架构](#一句话架构)
  - [三层分离铁律](#三层分离铁律)
  - [代码地图](#代码地图)
  - [memo 约定 = 链上资产](#memo-约定--链上资产)
  - [确定性渲染：同基因处处同长相](#确定性渲染同基因处处同长相)
  - [经济参数](#经济参数)
  - [边界守卫与安全姿态](#边界守卫与安全姿态)
  - [本地跑起来](#本地跑起来)
  - [设计文档](#设计文档)

---

# 给玩家

## 这是什么

一个 Stardew 风的**像素社交世界**，但底层是 `$V0ID` 区块链：

- 走进你的房间、镇中心、农场、东侧矿洞，逛别人的家、串门。
- 收集**四类链上藏品**——崽、鱼、作物、矿物——每一件都**写在链上、谁也伪造不了**。
- 把战绩聚成 **虚空图鉴**，一键导出像素**战绩卡 PNG** 炫给朋友。

设计上它**不追 DAU、不打卡**：定位是「教学展柜 + 社交玩具」。摩擦被**仪式化**（开盲盒式的揭晓、烧币的肉痛感都是体验的一部分），留存靠「收集欲」而非签到。

## 玩法一览

| 玩法 | 你做什么 | 链上产物 | 状态 |
| --- | --- | --- | --- |
| **崽（PET NFT）** | 孵化一只链上基因崽；繁育出带「妈的眼睛、爸的花纹」的子崽；进化加视觉光环；送崽给朋友 | 一只唯一的、基因决定长相的像素崽 | ✅ 已实现 |
| **农场（种植）** | 买地（动态地价）→ 建田地 → 种芜菁/小麦/南瓜/星之果 → 按区块高度成长 → 收获 | 链上收藏作物（品质由收获区块 hash 定） | ✅ 已实现 |
| **崽派驻农场** | 把崽派去某块田，按稀有度+进化阶**确定性加速**作物成长 | 派驻期间崽被锁（不能繁育/转移） | ✅ 已实现 |
| **钓鱼** | 到水边玩抛竿 QTE；满意的那一竿铸成链上渔获 | 链上渔获藏品（鱼种/稀有度由区块 hash 定） | ✅ 已实现 |
| **矿洞** | 下矿采矿，把「发现证明」或「材料」铸上链 | 链上矿物资产（纯度/稀有度由区块 hash 定） | ✅ 核心已实现 · 像素材质待补 |
| **虚空图鉴 + 战绩卡** | 看四类藏品的稀有度墙 + 收集完成度；导出像素战绩卡 PNG | 一张可炫耀的 PNG | ✅ 已实现 |
| **房间 / 串门 / 社交名片** | 装修个人房间、逛别人家、看链上社交名片 | 房间布局（便利层）+ 链上聚合名片 | ✅ 已实现 |
| **作物 P2P 二级市场** | 玩家间转让作物 / 地块 | `CROPX` / `LANDX` | 🚧 Phase 2（已留 memo 前缀，本期不处理） |
| **镇中心实时 presence** | 看到别的玩家在世界里走动 | WebSocket（不上链） | 🚧 阶段 1（协议已定义，见 GAME-PROTOCOL §2.5） |

> **稀有度的来历（贯穿全部四类藏品）**：稀有度 = 该资产链上 hash 的**前导 0 比特数**（≥5 稀有 / ≥8 史诗 / ≥12 传说，概率 `2⁻ᵏ`）。和挖矿同一套哲学——稀有靠「碰巧 hash 出很多前导 0」，**谁也伪造不出传说**。而 hash 掺入了**出块后才确定的区块 hash**，所以你抛竿、改前端 JS、挑 txid 都没用：**经济自带反作弊**。

## 虚空图鉴：脊椎

四类玩法表面各玩各的，但**喂的是同一个收集 meta**——虚空图鉴。它把崽 / 鱼 / 作物 / 矿物聚成一面：

- **稀有度战绩墙**：四档（普通/稀有/史诗/传说）各有多少件。
- **收集完成度**（宝可梦式）：鱼种、作物、矿物各收齐了几种。
- **镇馆之宝**：所有藏品按稀有度取前 5。
- **战绩卡 PNG**：一键把上面这些渲染成一张像素卡片，下载分享。

图鉴**只收录链上资产**（可验证、不可伪造 = 图鉴的全部意义）；单机背包里的果子、菜地不计入。

## 怎么开始玩

1. **打开游戏**——线上体验：**[game.void1211.com](https://game.void1211.com)**（部署细节见 [DEPLOY-game.md](./DEPLOY-game.md)）。
2. **自动拿币**——首次进入，faucet 自动给你的新地址发一笔 `$V0ID`（每地址一次，从央行预挖池**搬运**、不是增发）。
3. **铸你的第一件藏品**——去基座孵一只崽，或到水边按 `E` 开钓，或进农场种地。**钱包私钥永远只在你本地浏览器**，所有「写」动作都在本地签名，服务器只替你广播。
4. **集齐、炫耀**——把藏品填满虚空图鉴，导出战绩卡。

> 想要原生体验？仓库另有原生轻客户端 / 桌面端在建（见根 README）。本模块的 game-web 是**浏览器**入口。

---

# 给开发者

## 一句话架构

**一个完全 on-chain 的游戏，建在 `$V0ID` 链的「memo 约定」之上——不改共识、无软分叉、系统零增发。**

所有玩法（崽/农场/钓鱼/矿洞）都是同一个朴素形态的交易：**自转（`from === to`）+ 烧币（`burn > 0`）+ 一个 `memo` 前缀**。旧节点眼里这只是一笔合法的「自发消息」，照收不误——所以**无需改动共识、无需软分叉**。任何节点把链重放一遍（纯函数 `parseXxx(chain)`）就能还原全部游戏状态，**reorg 安全、跨客户端逐字节一致**。

```
浏览器 (core/browser：本地构造 + ed25519 签名)
   │  POST /api/tx  { tx: <已签名交易> }
   ▼
game-server  ──（只转发，不代签，持节点 token）──►  v0idChain 节点  POST /tx/submit  ──► 全网广播
```

游戏服务器是**非权威便利层**：它转发只读链查询、代广播已签名交易、跑 faucet、存房间布局/presence。它**宕机谁也不丢任何有价值的东西**，也**无法凭空造出链上价值**。

## 三层分离铁律

| 层 | 角色 | 放什么 |
| --- | --- | --- |
| 客户端（game-web） | 即时、零延迟 | 世界渲染、走路、动画、钓鱼/采矿 QTE、装扮预览 |
| 游戏服务器（game-server） | **非权威便利层** | 链只读代理、转发已签名交易、faucet、房间布局字节、presence |
| v0idChain（core/node） | **唯一价值真相** | 崽/作物/渔获/矿物（NFT）、`$V0ID` 余额、地块归属、昵称、集市 |

这条铁律由 `scripts/check-boundaries.ts` 用工具钉死（见下）。

## 代码地图

```
packages/
├── core/src/          区块链核心 + 游戏的「价值真相层」（纯函数，无 UI）
│   ├── pets.ts        崽 NFT：孵化/繁育(breedGene)/进化/派驻 + parsePets + petTraits
│   ├── farm.ts        农场：买地/建田/种植/收获 + parseFarm + 动态地价 landPrice + 成长/品质
│   ├── fishing.ts     钓鱼：铸渔获 + parseFish + fishTraits（稀有度复用 petRarity）
│   ├── mining.ts      矿洞：发现证明/材料铸造 + parseMines + mineTraits（链上权威，8 种矿）
│   ├── mine.ts        矿洞客户端侧元数据（材质/图标，browser 导出）
│   └── feed.ts        全网动态流聚合（deriveFeed）
├── game-server/src/   非权威便利层（Node HTTP，绑 127.0.0.1）
│   ├── server.ts      所有 HTTP 端点（只读代理 / /api/tx / /api/faucet / 房间 / profile / feed）
│   ├── faucet.ts      唯一发币口：从央行池搬运（限额 + 限速 + 全局上限）
│   ├── security.ts    安全头 / CORS 白名单 / 每 IP 限流 / 入参严格校验
│   ├── rooms.ts       房间布局字节（键=属主地址，附链上版本 hash）
│   └── chain.ts       上游节点 RPC 封装
└── game-web/src/      React 游戏 UI（Vite）
    ├── App.tsx        主状态机：7 个面板（codex/wallet/pets/fish/farm/mine/profile）
    ├── Codex.tsx      虚空图鉴：四类藏品聚合 + 完成度 + 战绩卡
    ├── pet-render.ts / fish-render.ts / crop-render.ts   程序化像素渲染（同基因/hash 处处同长相）
    ├── brag-card.ts   战绩卡 PNG 导出
    ├── engine/        2D 像素引擎：scene/ground/buildings/foliage/light/mine…（程序化「假 3D」）
    └── FarmPanel / FishingModal / Social / Hotbar / RevealOverlay …
```

> ⚠️ **矿洞有两份元数据**：`mining.ts` 是**链上权威**（8 种矿：铜/铁/银/金/紫晶/虚空水晶/星核/远古遗物，`parseMines` + 校验 + `burn` 计算），game-server 与 browser 的图鉴都走它；`mine.ts` 是早期的客户端侧元数据子集（5 种）。新代码以 `mining.ts` 为准。

## memo 约定 = 链上资产

每个子系统都把资产编码进 `memo` 前缀。一律 **`from===to` + `burn>0`**，由各自的 `parseXxx(chain)` 纯函数校验归属/烧费/状态后才「入账」：

| 子系统 | memo | 动作 | 烧币 |
| --- | --- | --- | --- |
| 崽 | `PET\|` | 孵化（崽 id = txid，gene = sha256(主人+txid)） | `PET_HATCH_COST` |
| 崽 | `PETX\|<崽id>` | 送崽/转移（仅当前主人有效） | ≥1（转给对方） |
| 崽 | `PETBREED\|<父>\|<母>` | 繁育（子基因 = `breedGene(双亲, 区块hash, txid)`，可见遗传） | `PET_BREED_COST` |
| 崽 | `PETEVO\|<崽id>` | 进化（+1 阶至 `MAX_EVO`，仅视觉光环） | `PET_EVO_COST` |
| 崽 | `PETFARM\|<崽id>\|<zoneId>` / `PETUNSTATION\|<崽id>` | 派驻田地加速 / 召回 | `PETFARM_COST` / 0 |
| 农场 | `LAND\|<n>` | 买地（n 须紧接下一号，`burn ≥ landPrice`） | 动态地价 |
| 农场 | `ZONE\|<plotN>\|<type>` | 建功能区（MVP 只实 `farmland`） | `ZONE_COST` |
| 农场 | `PLANT\|<zoneId>\|<crop>\|<slot>` | 种植（记 `plantHeight`） | `SEED_COST[crop]` |
| 农场 | `HARVEST\|<plantId>` | 收获成熟作物 → 链上收藏作物 | `HARVEST_BURN` |
| 钓鱼 | `FISH\|` | 铸渔获（id = txid，hash 掺区块 hash） | `FISH_BURN` |
| 矿洞 | `MINE\|DISC\|…` / `MINE\|MAT\|…` | 铸发现证明 / 材料 | 随深度/档位 |

> 这些「协议 memo」形态上撞「链上私信」（`amount=0 + burn>0`），故 `messages.ts` 的 `isProtocolMemo()` 集中排除全部前缀，`parseMessages` 跳过——子系统交易**不会被误收进私信收件箱**。

**成长 = 区块高度。** 作物成熟度 = `clamp((当前链高 − plantHeight) / GROW_BLOCKS[crop], 0, 1)`，纯由链高算 → 无「时间」歧义、reorg 安全、跨端一致，**不需要「浇水」交易**。

**品质/稀有度 = 出块后的区块 hash。** `cropHash`/`catchHash`/`mineAssetHash` = `sha256(owner + '|' + 出块区块hash + '|' + txid)`，与红包 `redSeed` 同源。玩家改不动链上 txid 与区块 hash → **伪造不出传说**；想刷好东西要再烧币、再落进一个不可控的新区块。

## 确定性渲染：同基因处处同长相

资产的**外观全靠链上 hash 纯函数推导**，链上不存任何图：

- core 提供 `petTraits(gene)` / `fishTraits(catchHash)` / `cropTraits(crop, hash)` / `mineTraits(...)`——把 hash 的不同字节段映射成体型/色相/眼/花纹/鱼种/品质…
- 客户端的 `renderPet` / `renderFish` / `renderCrop` 按**版本化的 Render Spec**（GAME-PROTOCOL §4/§6/§7）把这些 traits 画成 16×16 / 32×32 像素，整数放大、关抗锯齿。

因为 traits 在 core 锁定，**同一基因/hash 在任意客户端（web、未来的原生端）渲染逐像素一致**。改映射表 = bump 到 Spec v2，且必须保证旧资产长相不跳变。

## 经济参数

整数币，**全部只烧进虚空、系统零增发**；唯一发币例外是 faucet（从央行预挖池搬运）。

| 参数 | 位置 | 默认 |
| --- | --- | --- |
| `PET_HATCH_COST` / `PET_BREED_COST` / `PET_EVO_COST` / `MAX_EVO` | `core/pets.ts` | 300 / 200 / 80 / 3 |
| `PETFARM_COST`（派驻）/ `farmAssistPct`（加速上限） | `core/pets.ts` | 50 / 封顶 50% |
| `LAND_BASE` / `LAND_K` / `LAND_QUAD_DEN` / `LAND_VELOCITY_WINDOW` | `core/farm.ts` | 200 / 50 / 2500 / 720 |
| `ZONE_COST` / `SEED_COST` / `GROW_BLOCKS` / `HARVEST_BURN` | `core/farm.ts` | 100 / 10·15·25·50 / 30·60·120·200 / 2 |
| `FISH_BURN` | `core/fishing.ts` | 2 |
| `FAUCET_AMOUNT` / `FAUCET_GLOBAL_CAP` | game-server (env) | 可配 |

**动态地价（`landPrice`）是共识可复算路径**，所以是**全整数定点 bonding curve**（`scarcity` 线性档 + 二次档，再叠 velocity 加成），**无浮点、无 `Math.pow`、无 `ceil`**——浮点最后一位 ulp 差异会让两端对「某笔买地是否合法」判定分歧 → 农场状态跨客户端分裂。原生客户端必须照固定的整数算子顺序复现（golden 向量见 GAME-PROTOCOL §7.3）。

> ⚠️ **「上链动作可能被链状态拒绝，烧费不退」**：农场是「乐观提交、事后裁决」架构。买地价格竞态（涨价后 `burn < price`）或同格并发（两笔抢同一格，链序首胜）会让败者那笔被 `parseFarm` 忽略，但 `burn` 已真实进虚空、不退。客户端用「`ceil(landPrice × 1.05)` 缓冲 + 前置校验」缓解（GAME-PROTOCOL §7.8）。

## 边界守卫与安全姿态

- **架构边界**由 `scripts/check-boundaries.ts` 钉死（`corepack pnpm check:boundaries`）：① 游戏层只能依赖 `@v0idchain/core[/browser]`，绝不碰 node/cli；② 链层永不反向依赖游戏层。链能脱离游戏独活。
- **game-server 安全基线**（见 `game-server/src/{config,security,server}.ts` + [DEPLOY-game.md](./DEPLOY-game.md)）：只 `listen('127.0.0.1')`（外部流量必过 nginx）；安全头全开 + 严格 CSP；CORS 白名单（绝不 `*`）；写端点每 IP 限流 + 64KB body 上限 + 入参严格校验；央行私钥/节点 token 只从 env 或 0600 文件读，**绝不进任何响应**。
- **faucet 不是增发**：只从央行地址搬运，限额 + 限速 + 全局上限；零绕过 coinbase 的新币路径。

## 本地跑起来

```bash
# 1. 起本机节点（出币 + 提供 API token / 央行钱包）
corepack pnpm dev:node1
# 2. 起游戏服务器（默认绑 127.0.0.1:8790，读 .data/node1 的 token + 钱包）
corepack pnpm dev:game-server
# 3. 起前端（Vite，默认 CORS 白名单含 5173）
corepack pnpm dev:game-web

# 抽查
curl -s http://127.0.0.1:8790/health        # → {"ok":true,"height":<n|null>}
corepack pnpm --filter @v0idchain/game-server typecheck
corepack pnpm tsx scripts/smoke.ts           # 核心冒烟（含农场/崽段回归）
corepack pnpm check:boundaries               # 架构边界守卫
```

## 设计文档

| 文档 | 内容 |
| --- | --- |
| [GAME-PROTOCOL.md](./GAME-PROTOCOL.md) | 游戏服务器↔客户端便利层协议 + 全部 memo 约定 + 基因→像素 Render Spec（**权威参考**） |
| [ECONOMY-LAND-DESIGN.md](./ECONOMY-LAND-DESIGN.md) | 土地/农场经济：动态地价、成长、品质随机源 |
| [FISHING-DESIGN.md](./FISHING-DESIGN.md) | 钓鱼 QTE + 渔获 memo 约定 + 鱼种/稀有度 |
| [MINE_ART_REQUIREMENTS.md](./MINE_ART_REQUIREMENTS.md) | 矿洞像素材质需求书（待补的位图资源清单） |
| [RENDER-3D-FEEL.md](./RENDER-3D-FEEL.md) | 像素 2D「假装 3D」的渲染调研（光向/接触阴影/伪透视，带出处） |
| [CODE-REVIEW-game.md](./CODE-REVIEW-game.md) | 游戏层代码审查记录 |
| [DEPLOY-game.md](./DEPLOY-game.md) | game-server 生产部署安全清单（1211 机：独立用户 + systemd 沙箱 + nginx + 防火墙 + TLS） |

---

> 三个模块同属一个 monorepo，共享 `packages/core`。回到 [🏠 总览](../../README.md) 看 v0idnet（匿名网络）与区块链（底座）如何与本游戏拼成一体。
