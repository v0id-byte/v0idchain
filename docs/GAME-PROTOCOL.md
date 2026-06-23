# v0idChain 游戏层协议（便利层 / Convenience-Layer Protocol）

> 配套 PRD：`v0idchain-game-PRD-stage0-1.md`（阶段 0 异步房间 + 阶段 1 实时镇中心）。
> 本文件定义 **游戏服务器 ↔ 客户端** 的便利层协议，以及 **崽（PET NFT）基因→像素** 的确定性渲染规范。
> 与 `CLIENT-PROTOCOL.md`（链/节点互操作规范）正交：那是“价值真相层”，这是“非权威便利层”。

## 0. 架构铁律（与 PRD §1 一致，任何实现不得违反）

| 层 | 角色 | 放什么 |
| --- | --- | --- |
| 客户端 | 即时、零延迟 | 世界渲染、走路、动画、装扮预览 |
| 游戏服务器 | **非权威便利层** | presence（在线/位置）、房间布局字节、临时聊天、世界 tile 状态 |
| v0idChain | **唯一价值真相** | 房间属主、崽（NFT）、`$V0ID` 余额/转账、集市成交、送礼、昵称 |

- 价值只在链上。服务器宕机 → 没人丢任何有价值的东西（PRD G4）。
- 服务器**不能**自动生成链上价值。链上铸造（崽）只能由玩家**签名**发起、全网节点**校验**。
- faucet 是唯一的 `$V0ID` 分发例外，且只从央行预挖池**搬运**（限额+限速），不是增发。
- 代码边界由 `scripts/check-boundaries.ts` 钉死：游戏层只依赖 `@v0idchain/core`，链层不反向依赖游戏层。

---

## 1. 客户端如何与链对话（自托管钱包）

客户端持有**自己的私钥**（浏览器 `localStorage`，永不上送）。所有“写”动作都在客户端用 `@v0idchain/core/browser` **本地构造 + 签名**，再把**已签名交易**交给游戏服务器代为广播。服务器**只转发、不代签**。

```
浏览器(core/browser: createTransaction/createMessage 本地签名)
      │  POST /api/tx  { tx: <signed Transaction> }
      ▼
game-server  ──(转发, 持节点 token)──►  v0idChain 节点  POST /tx/submit  ──► 全网广播
```

- 节点新增端点 `POST /tx/submit { tx }`：校验自洽性+余额+nonce 后入池广播（`node.acceptTx`）。私钥不离开浏览器。
- 读链一律走游戏服务器的只读代理（见 §2），避免在每个客户端硬编码节点地址 + CORS。

---

## 2. 游戏服务器 HTTP / WS 端点

基址默认 `:8790`（可配）。所有响应 `application/json`。**读**端点无需鉴权；**写**端点受 faucet 限速等约束（见各条）。

### 2.1 链只读代理（转发到节点，缓存若干秒）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/info` | 链高、难度、symbol、minFee 等（透传节点 `/info`） |
| GET | `/api/balance?address=` | 某地址余额 |
| GET | `/api/chain` | 整链（客户端据此本地解析崽/集市/昵称/消息；大链可加分页，本期直传） |
| GET | `/api/names` | 昵称注册表（名字↔地址） |
| GET | `/api/market` | 集市在售 |
| GET | `/api/pets?address=` | 某地址当前拥有的崽（服务器用 `parsePets` 算好，省客户端整链扫描） |
| GET | `/api/tx?txid=` | 交易确认状态（`confirmed/pending/unknown`，供“处理中→已到账”轮询） |

### 2.2 提交已签名交易
| 方法 | 路径 | body | 说明 |
| --- | --- | --- | --- |
| POST | `/api/tx` | `{ tx }` | 转发到节点 `/tx/submit`。tx 必须是 core 在浏览器签好的。 |

### 2.3 faucet（唯一发币口，从央行池搬运）
| 方法 | 路径 | body | 说明 |
| --- | --- | --- | --- |
| POST | `/api/faucet` | `{ address }` | 给新地址发 `FAUCET_AMOUNT` 个 `$V0ID`。**服务器持央行私钥**，本地签名一笔普通转账并广播。 |

约束（硬性）：
- 每地址只发一次；按 **设备指纹 / IP** 限速；设 **全局总额上限** `FAUCET_GLOBAL_CAP`，达上限后明确拒绝（不是崩溃）。
- 央行私钥放服务器本机 `0600`、gitignore（同 stockwatch 的 `.env`），**绝不进仓库**。
- faucet 转出全部来自央行地址；实现中不得出现任何绕过 coinbase 的新币生成路径。

### 2.4 房间布局（阶段 0）
| 方法 | 路径 | body | 说明 |
| --- | --- | --- | --- |
| GET | `/api/room?address=` | — | 取某地址房间布局字节 + 服务器记录的版本 hash（属主离线也能串门）。 |
| PUT | `/api/room` | `{ address, layout, versionTx }` | 属主更新布局。`versionTx` 是属主**签名**的“发布版本”交易 txid（链上只存属主+布局版本 hash，字节存服务器，见 §3）。 |

客户端校验：服务器返回的布局算出的 hash 必须等于链上该地址最新发布的版本 hash；不一致 → 标记“未验证/可能被篡改”，不直接采信（PRD 6.2 验收）。

### 2.5 presence（阶段 1，实时镇中心，WebSocket）
- `WS /ws`：连上后周期性收发玩家位置。**presence 不上链、不持久化为价值**；服务器重启不损失任何链上状态。
- 客户端 → 服务器：`{ type: 'move', address, x, y, dir }`（节流 ~10Hz）。
- 服务器 → 客户端：`{ type: 'world', players: [{ address, name, x, y, dir }] }`（广播在线玩家）。
- 头顶显示名：服务器把地址用昵称注册表解析成 `@昵称`（无则短地址）。

---

## 3. 房间归属与版本（链上只存 hash，字节存服务器）

memo 放不下整间房，故：
- **链上**：房间属主 = 地址本身（每地址一间免费起始房）；“当前布局版本” = 属主签名发布的一笔自转交易，memo `ROOM|<布局SHA256>`。
- **服务器**：存实际布局字节，键为属主地址，附其声明的版本 hash。
- 校验：`sha256(服务器布局字节) === 链上最新 ROOM| 版本 hash`。一致才算“已验证”。

> 注：把服务器布局写上链**不会让它变真**——防篡改靠“值钱的东西（崽）以链为准”，房间字节本身是低风险便利数据。阶段 3 起，房间确权结构平滑扩展为“带坐标的地块确权”（PRD P2，勿堵死）。

---

## 4. 崽（PET NFT）：链上约定 + 确定性渲染

### 4.1 链上约定（`@v0idchain/core` 的 `pets.ts`，纯 memo、不改共识）
- **孵化**：自转 + 烧 `PET_HATCH_COST` 个 `$V0ID`（进虚空）+ memo `PET|`。崽 id = 该交易 txid。
- **送崽/转移**：转 ≥1 币给对方 + memo `PETX|<崽id>`。仅“当前主人”发起有效，归属随链序流转。
- **基因** `gene = sha256(主人地址 + '|' + 孵化txid)`：确定性、唯一、不可伪造。
- 归属/基因由 `parsePets(chain)` 还原 —— 全网一致、reorg 安全。

### 4.2 基因 → 外观（`petTraits(gene)`，core 提供，全客户端共用 ⇒ 同基因处处同长相）

`petTraits` 取基因不同字节段，确定性推导：

| 字段 | 来源 | 取值 | 含义 |
| --- | --- | --- | --- |
| `body` | byte0 % 6 | 0–5 | 体型轮廓 |
| `hue` | byte1/255×359 | 0–359 | 主色相 |
| `bellyHue` | byte2/255×359 | 0–359 | 腹部/副色相 |
| `eyes` | byte3 % 6 | 0–5 | 眼睛样式 |
| `pattern` | byte4 % 6 | 0–5 | 花纹 |
| `accessory` | byte5<96?0:1+byte6%7 | 0–7 | 配饰（0=无） |
| `rarity` | `leadingZeroBits(gene)` | common/rare/epic/legendary | 稀有度（≥5/≥8/≥12 比特） |

稀有度刻意复用挖矿的“前导 0 比特越多越难得”——稀有靠碰巧 hash 出很多前导 0，谁也伪造不了，呼应本链 PoW 哲学。

### 4.3 像素映射（客户端渲染规范，版本化）
渲染 = 纯客户端、无需服务器/链存图。**Render Spec v1**（客户端 `renderPet` 实现，跨客户端须一致）：
1. 画布 16×16，整数放大到展示尺寸（像素风，关闭抗锯齿）。
2. 主体形状取自 `body` 的 6 张轮廓模板之一；填充色 = `hsl(hue, 65%, 55%)`，腹部 = `hsl(bellyHue, 60%, 70%)`。
3. `pattern` 在主体上叠加斑点/条纹/无等 6 种之一（用副色相描边）。
4. `eyes` 选 6 种眼型；`accessory` 选 0–7（帽子/蝴蝶结/眼镜…），0 为无。
5. `rarity` 仅加**外发光/描边**点缀（legendary 金边、epic 紫边…），不改变主体几何 → 不影响“同基因同外观”。

> 改这张映射表 = bump 到 Render Spec v2，并保证旧崽在新版仍稳定渲染（基因不变、长相不应跳变）。基因与 `petTraits` 在 core 锁定，是“同基因任意客户端同外观”（PRD 6.5 验收）的根。

---

## 5. 经济参数（整数币；最终值由 v0id 拍板，见 PRD Q2）

| 参数 | 位置 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PET_HATCH_COST` | `core/pets.ts` | 300 | 孵崽烧币额。崽贵以体现稀缺/炫耀价值。 |
| `FISH_BURN` | `core/fishing.ts` | 2 | 铸渔获藏品烧币额。很小：高频娱乐，瞎钓不上链、想收藏才烧。 |
| `LAND_BASE / LAND_K / LAND_QUAD_DEN / LAND_VELOCITY_NUM / LAND_VELOCITY_WINDOW` | `core/farm.ts` | 200 / 50 / 2500 / 1 / 720 | 买地动态地价 **全整数** bonding curve 参数（权威公式 + golden 向量见 §7.3）；烧进虚空。 |
| `ZONE_COST` | `core/farm.ts` | 100 | 建一个功能区块（田地）烧币额。 |
| `SEED_COST[crop]` | `core/farm.ts` | 10/15/25/50 | 各作物种子烧币额（芜菁/小麦/南瓜/星之果）。 |
| `GROW_BLOCKS[crop]` | `core/farm.ts` | 30/60/120/200 | 各作物成熟所需区块数（成长按区块高度推进）。 |
| `HARVEST_BURN` | `core/farm.ts` | 2 | 收获烧币额。很小：成本主要在种子 + 地。 |
| `FAUCET_AMOUNT` | game-server | 待定（人均多一些） | 单地址 faucet 额度。 |
| `FAUCET_GLOBAL_CAP` | game-server | 待定 | faucet 全局总额上限（央行池由矿工把出块奖励指向央行地址缓慢回补）。 |

> 央行收款地址（公开安全）：`0xd63300cb79b682979a5c62bad419a2a1147da9be4111736d52c636523a20cefb`（`GENESIS_PREMINE_ADDRESS`）。
> 往它转币 = 给 faucet 补水；faucet 用央行**私钥**（仅服务器本机）往外发。

---

## 6. 钓鱼（链上渔获藏品）：memo 约定 + 确定性渲染

定位：与崽（PET）/红包同级的**纯 memo 约定层**（`@v0idchain/core` 的 `fishing.ts`），不改共识、无软分叉。
链只当“**不可伪造的随机源 + 可验证的渔获账本**”。**钓鱼只烧币、绝不发币**（零新发币路径，不碰 faucet/央行私钥）。
日常瞎钓是**纯客户端 QTE**（零延迟、不触链）；只有想把某次渔获**铸成藏品**时，才发一笔交易。

### 6.1 链上约定（纯 memo，建在“自转 + 烧币 + memo”之上）
- **铸渔获**：自转（`from === to`）+ 烧 `FISH_BURN` 个 `$V0ID`（进虚空）+ memo `FISH|`。渔获 id = 该交易 txid。
  - 形态等同孵崽（`amount=0 + burn>0 + memo`）。旧节点眼里只是一笔合法的“自发消息”，照收 → 不软分叉。
- **渔获 hash**：`catchHash = sha256(主人地址 + '|' + 该交易所在区块hash + '|' + txid)`。
  与红包 `redSeed` 同源——掺入**出块后才确定的区块 hash** → 事前不可测、事后全网一致、不可伪造。
- 渔获列表由 `parseFish(chain)` 还原（`memo==='FISH|'` 且 `from===to` 且 `burn>0`）——全网一致、reorg 安全。渔获**不流转**（无转移操作，区别于崽的 `PETX`）。

> ⚠️ **协议 memo 不入收件箱**：`FISH|`（及 `PET|`/`PETX|`/`RED|`/`CLAIM|`/`REFUND|`）形态上撞“链上私信”（`amount=0+burn>0`）。
> `messages.ts` 的 `isProtocolMemo()` 集中排除这些前缀，`parseMessages` 跳过 → 子系统交易不会被误收进私信收件箱。
> 刻意**不含** `ENC|`（端到端加密私信，本就是正文）与 `NAME|`（`burn=0` 自转，本就非消息形态）。

### 6.2 防作弊（随机源 = 出块后的区块 hash）
`catchHash` 掺入区块 hash 是关键：玩家抛竿/改前端 JS 都改不动链上 txid 与区块 hash → **伪造不出传说鱼**。
重试要再烧 `FISH_BURN` + fee，且落进新的不可控区块 → 刷传说期望成本随档位指数上升，**经济自带反作弊**。
（被否决方案：客户端 RNG=可改、服务器掷骰=非权威、只用 txid=签名时已固定→可穷举挑。）

### 6.3 稀有度（复用崽的前导 0 比特门槛）
`fishRarity(catchHash) = petRarity(catchHash)`：按 `leadingZeroBits` —— `≥12` 传说 / `≥8` 史诗 / `≥5` 稀有 / else 普通。
概率 = `2⁻ᵏ`，与崽同。稀有靠“碰巧 hash 出很多前导 0”，呼应本链 PoW 哲学。

### 6.4 catchHash → 外观（`fishTraits(catchHash)`，core 提供，全客户端共用 ⇒ 同 hash 处处同长相）

| 字段 | 来源 | 取值 | 含义 |
| --- | --- | --- | --- |
| `rarity` | `leadingZeroBits(catchHash)` | common/rare/epic/legendary | 稀有度（同崽门槛） |
| `species` | byte0 % N | 0 .. N-1 | 该稀有度档位内的鱼种索引 |
| `hue` | byte1/255×359 | 0–359 | 主色相 |
| `bellyHue` | byte2/255×359 | 0–359 | 腹部/副色相 |
| `finStyle` | byte3 % 4 | 0–3 | 鳍/尾样式 |
| `sizeCm` | byte4 映射档位区间 | 8–200 | 体长（厘米，越稀有越大） |
| `shiny` | byte5 < 16 | bool | 闪光个体（约 1/16） |

**鱼种表**（`N_SPECIES` 各档位数；客户端按 species 索引取名/画样）：

| 稀有度 | 鱼种（按 species 索引） | 外发光 |
| --- | --- | --- |
| 普通 | 鲫鱼 / 鲈鱼 / 泥鳅 / 河虾 | 无 |
| 稀有 | 锦鲤 / 鳟鱼 / 河豚 | 蓝 `#54a8ff` |
| 史诗 | 金龙鱼 / 电鳗 / 月鱼 | 紫 `#b66bff` |
| 传说 | 虚空鲸 / 星之鲟 | 金 `#ffce3d` |

### 6.5 像素映射（客户端渲染规范，版本化）—— **Fish Render Spec v1**
渲染 = 纯客户端、无需服务器/链存图（客户端 `renderFish`，跨客户端须一致）：
1. 画布 32×32，整数放大到展示尺寸（像素风，关闭抗锯齿）。
2. 鱼一律**朝右**（椭圆身 + 左侧三角尾 + 1px 眼，同镇上鱼摊图标范式）。身大小随 `rarity`/`sizeCm` 缩放。
3. 主色 = `hsl(hue,62%,55%)`，腹 = `hsl(bellyHue,55%,74%)`；`finStyle` 决定尾长/张开与背鳍（尖/圆）。
4. 鱼种点缀：**虚空鲸**用深空体色 + 体内星点（呼应“烧币进虚空”）、**锦鲤**红白斑、**虾**加须；其余通用侧线斑。
5. `shiny` 加高光星；`rarity` 仅加**外发光**点缀（传说金/史诗紫/稀有蓝），不改主体几何 → 不影响“同 hash 同外观”。

> 改这张映射表 = bump 到 Fish Render Spec v2，并保证旧渔获在新版仍稳定渲染（catchHash 不变、长相不应跳变）。
> `catchHash` 与 `fishTraits` 在 core 锁定，是“同 hash 任意客户端同外观”的根。

### 6.6 服务端 / 客户端接口（只读 + 本地签名）
- 只读：`GET /api/fish[?address=]` → `parseFish`/`fishOf`（服务器算好，省客户端整链扫描）。**无写端点**。
- 写：铸渔获由客户端**本地签名**走 `POST /api/tx`（`createMessage(wallet, wallet.address, 'FISH|', nonce, FISH_BURN, MIN_FEE)`），服务器零私钥、只转发。
- 玩法：客户端 QTE（抛竿→咬钩→张力条收线）成功后弹结算卡：「留作纪念」（仅本地计数）/「铸成链上藏品」（上链）。
  鱼种由**上链后的** `catchHash` 事后确定 → 结算卡的本地预览仅作即时反馈，最终以链上真鱼为准。

---

## 7. 农场 / 土地（Stardew 式链上经济）：memo 约定 + 动态地价 + 确定性渲染

定位：与崽（PET）/红包/钓鱼同级的**纯 memo 约定层**（`@v0idchain/core` 的 `farm.ts`），不改共识、无软分叉。
经济闭环：**花币(烧进虚空) → 买地 / 建区块 / 种作物 → 按区块高度成长 → 收获链上收藏作物**；想回血只能 P2P 卖给别的玩家（Phase 2）。
**系统零增发**：四种动作（买地/建区块/种植/收获）只烧币，绝不发币（不碰 faucet/央行私钥）。日常走动/装修预览是纯客户端，只有“落定”的动作才上链一次。
详细设计见 `docs/ECONOMY-LAND-DESIGN.md`。

### 7.1 链上约定（纯 memo，建在“自转 + 烧币 + memo”之上）
四种动作都是玩家**本地签名**的一笔自转交易（`from === to`）+ 烧币（`burn > 0`）+ memo。旧节点眼里只是合法“自发消息”，照收 → 不软分叉。
归属/状态由 `parseFarm(chain)` 还原（校验铁律仿 `parsePets`：`from===owner`、烧币额正确、引用的地/区块/作物**确属该 owner 且状态合法**，否则忽略）——全网一致、reorg 安全。

| memo | 形态 | 烧币 | 校验要点 | 派生 id |
| --- | --- | --- | --- | --- |
| `LAND\|<n>` | 买地（解锁第 n 块专属农场地块） | `≥ landPrice(链上状态)` | `n` 必须**正好等于该 owner 下一个可买号**（从 0 起，禁跳号/重复）；烧 `≥` 当时动态地价 | `<owner>#<n>` |
| `ZONE\|<plotN>\|<type>` | 在已解锁地块上建功能区 | `=== ZONE_COST` | `plotN` 须属于该 owner；`type ∈ {farmland, orchard}`（MVP 只实 farmland） | 该交易 txid |
| `PLANT\|<zoneId>\|<crop>\|<slot>` | 在田地区块某格种作物 | `=== SEED_COST[crop]` | `zone` 须属该 owner 且为 `farmland`；`slot ∈ [0, ZONE_SLOTS)` 且当前为空 | 该交易 txid，记 `plantHeight = 所在区块号` |
| `HARVEST\|<plantId>` | 收成熟作物 → 产出链上收藏作物 | `=== HARVEST_BURN` | `plant` 须属该 owner、未收获、且**已成熟**（`cropGrowth ≥ 1`） | 该交易 txid（= 收藏作物链上 id） |
| `CROPX\|<cropId>\|<toAddr>` | 作物 P2P 转让 | — | **Phase 2**：先留前缀，本期 `parseFarm` 忽略（不改归属） | — |

> ⚠️ **协议 memo 不入收件箱**：`LAND\|`/`ZONE\|`/`PLANT\|`/`HARVEST\|`/`CROPX\|` 形态上撞“链上私信”（`amount=0+burn>0`）。
> `messages.ts` 的 `isProtocolMemo()` 已集中排除这些前缀，`parseMessages` 跳过 → 农场交易不会被误收进私信收件箱（同 `FISH\|`/`PET\|`/`RED\|` 等）。

### 7.2 成长 = 区块高度确定性（无需“浇水”交易）
作物把种植交易所在区块号记为 `plantHeight`。当前链高 `H` 时成熟度 `cropGrowth = clamp((H - plantHeight) / GROW_BLOCKS[crop], 0, 1)`。
纯由链高算 → 全网/跨端一致、reorg 安全（链重组就重算）、无“时间”歧义。视觉阶段 `cropStage`：`0` 种子 / `1` 幼苗（≥0.25）/ `2` 成株未结果（≥0.66）/ `3` 成熟可收（≥1）。

### 7.3 动态地价（随行情浮动的链上状态函数）—— **权威整数公式（跨实现逐字节一致）**
地价 = **全网供需的确定性 bonding curve**（`landPrice(farmState)`）：人人同价、链上可复算、随行情走。

> ⚠️ **共识可复算路径，必须全整数**：`landPrice` 是「某笔买地是否合法」的判定输入（`parseFarm` 要求 `burn ≥ price`），即已进入「全网必须算出同一结果」的路径。早期版本用浮点 `Math.pow(.,1.15)` + `ceil`，但**不同语言/运行时的浮点最后一位 ulp 差异**会让两端对同一笔买地取整后差 1 → 合法性判定分歧 → **农场状态跨客户端分裂**。故现已改为**只含整数 `+ - * /`（`/` 一律向下取整）的确定性公式**（同 `redpacket.computeShare` 的全整数纪律）。原生客户端（Swift/Kotlin/Rust）**必须照下面这套固定的整数算子顺序复现**，并用下方 golden 向量对拍。

**权威整数公式**（所有 `/` 为**向下取整除法** `floor`；本式所有被除数/除数恒非负，故 `floor` = 截断）：
```
linear      = floor( soldTotal * LAND_BASE / LAND_K )            // 线性档：每多卖 K 块 +1 个 BASE
quad        = floor( soldTotal * soldTotal * LAND_BASE / LAND_QUAD_DEN )  // 二次档：凸增、超线性（替代旧 ^1.15 的超线性意图）
scarcity    = LAND_BASE + linear + quad
velocityBump= floor( scarcity * recentSales * LAND_VELOCITY_NUM / LAND_VELOCITY_WINDOW )  // ×(1 + recentSales/WINDOW) 的整数展开
landPrice   = scarcity + velocityBump
  soldTotal   = parseFarm 还原的“全网已售地块总数”（卖得越多越稀缺 → 越贵）
  recentSales = 最近 LAND_VELOCITY_WINDOW 个区块内售出地块数（最近抢得越凶 → 越贵）
  LAND_BASE=200 · LAND_K=50 · LAND_QUAD_DEN=2500(=K²) · LAND_VELOCITY_NUM=1 · LAND_VELOCITY_WINDOW=720 块
```
**固定算子顺序（不可重排，否则取整结果可能差 1）**：先各自 `floor` 求出 `linear`、`quad` 再相加得 `scarcity`；velocity 加成是 `(scarcity * recentSales * NUM)` **先乘后** `floor` 除以 `WINDOW`。中间量 `soldTotal*soldTotal*LAND_BASE` 与 `scarcity*recentSales` 须用 ≥64-bit 整数承载（教学链规模下远不溢出）。

**Golden 向量**（输入 `{soldTotal, recentSales}` → 期望 `landPrice`，原生实现须逐字节复现）：

| soldTotal | recentSales | landPrice | 说明 |
| --- | --- | --- | --- |
| 0 | 0 | **200** | 零行情 = `LAND_BASE` |
| 1 | 0 | **204** | `linear=floor(200/50)=4`, `quad=0` |
| 10 | 0 | **248** | `linear=40`, `quad=floor(100·200/2500)=8` |
| 50 | 0 | **600** | `linear=200`, `quad=floor(2500·200/2500)=200` |
| 100 | 0 | **1400** | `linear=400`, `quad=800`（凸：远超线性档） |
| 100 | 50 | **1497** | `scarcity=1400`, `bump=floor(1400·50/720)=97` |
| 200 | 720 | **8400** | `scarcity=4200`, 满窗 `recentSales=WINDOW` → 翻倍 |
| 500 | 100 | **25283** | `scarcity=22200`, `bump=floor(22200·100/720)=3083` |

> 共识/复算关键：`parseFarm` 校验某笔买地时，用的是**截至该交易“之前”**的全网状态（`soldTotal` + 相对本块高度的窗口内成交数 `recentSales`）算地价 → 买方可预测、各节点可复算、同块内多笔按交易数组顺序定胜负（确定性）。回归测试见 `scripts/smoke.ts`「农场」段。
> 二级市场（已有地玩家间 P2P 转让，Phase 2 的 `CROPX`/`LANDX`）由卖方自由定价 → 直接的自由市场行情。

### 7.4 防作弊（收成品质 = 出块后的区块 hash）
收成品质源自不可伪造的随机源（同钓鱼 `catchHash` / 红包 `redSeed`）：
```
cropHash = sha256(owner + '|' + HARVEST交易所在区块hash + '|' + 该txid)
```
玩家改不了链上 txid 与区块 hash → **伪造不出黄金作物**。想刷好品质要再花种子 + 收获成本，且落进新的不可控区块 → **经济自带反作弊**。
`crop`（种类）来自种植时记下的作物、**不入 hash**（种什么收什么）；品质/色相/巨型/重量全由 `cropHash` 推导。

### 7.5 cropHash → 收成特征（`cropTraits(crop, cropHash)`，core 提供，全客户端共用 ⇒ 同 hash 处处同长相）

| 字段 | 来源 | 取值 | 含义 |
| --- | --- | --- | --- |
| `crop` | 种植时记录 | turnip/wheat/pumpkin/starfruit | 作物种类（不入 hash） |
| `quality` | `leadingZeroBits(cropHash)` | common/rare/epic/legendary | 品质（复用崽/鱼门槛：≥5/≥8/≥12 比特） |
| `hue` | byte1/255×359 | 0–359 | 主色相（同品质同种内个体差异） |
| `giant` | byte2 < 16 | bool | 巨型个体（约 1/16，结果阶段果实放大 1.25×） |
| `weightG` | byte3 映射档位区间 | 80–4000 | 展示重量（克，越稀有越重） |

品质中文标签：`common=普通 / rare=优质 / epic=稀有 / legendary=黄金`（与崽/鱼共用 `petRarity` 门槛，概率 `2⁻ᵏ`）。

### 7.6 像素映射（客户端渲染规范，版本化）—— **Crop Render Spec v1**
渲染 = 纯客户端、无需服务器/链存图（客户端 `renderCrop(crop, hash, size, stage)`，跨客户端须一致）：
1. 画布 32×32，整数放大到展示尺寸（像素风，关闭抗锯齿）；底座一律画**泥畦**把作物“种”在土里。
2. 按 `stage` 画成长：`0` 土里种子点 + 嫩芽 / `1` 矮茎单层叶 + 顶芽 / `2` 高茎双层叶 + 顶部叶团（未结果）/ `3` 成熟结果。
3. 果实主色 = `hsl(CROP_HUE[crop] ± (hue%40−20), qSat, 56%)`，`qSat` 随品质升（62→70→78→88）越饱和明亮；高光/暗部按主色派生。
4. 结果阶段按作物画果实：**南瓜**贴地大果带纵棱 + 蒂、**小麦**茎顶金穗 + 芒刺、**星之果**茎顶五角金星、**芜菁**（默认）茎顶圆根果 + 高光。
5. `giant` 在结果阶段果实放大 1.25× 并加炫耀光点；`quality` **仅加外发光**点缀（rare 蓝 `#54a8ff` / epic 紫 `#b66bff` / legendary 金 `#ffce3d`），**且只在成熟阶段发光**（生长中不剧透品质），不改主体几何 → 不影响“同 hash 同外观”。

> 改这张映射表 = bump 到 Crop Render Spec v2，并保证旧收成在新版仍稳定渲染（`cropHash` 不变、长相不应跳变）。`cropHash` 与 `cropTraits` 在 core 锁定，是“同 hash 任意客户端同外观”的根。

### 7.7 服务端 / 客户端接口（只读 + 本地签名）
- 只读：`GET /api/farm[?address=]` → `farmOf`（带 address，返回该地址的地块/区块/未收获作物/收成 + **当前动态地价 `landPrice` 预算** + 链高）/ `parseFarm`（不带，返回全网世界）。**无写端点**。
- 写：买地/建区块/种植/收获均由客户端**本地签名**走 `POST /api/tx`（`createMessage(wallet, wallet.address, memo, nonce, burn, MIN_FEE)`，`memo`/`burn` 由 `makeLandBuy`/`makeZone`/`makePlant`/`makeHarvest` + §7.1 烧币额构造），服务器零私钥、只转发。买地前先用 `GET /api/farm` 拿当前 `landPrice`；**买地的 `burn` 取 `ceil(landPrice × 1.05)`（含市场波动缓冲，见 §7.8 H1）**，其余动作 `burn` 为固定常量。
- 渲染/交互分离：农场场景 `buildFarm(farmView)` 把作物按 `cropStage` 画（走 `scene.crops`），动作走同坐标的交互点（`Interactable.farm: FarmRef`）→ `App.onInteract` 弹 `FarmActionModal`。

### 7.8 边界与已知语义（上链动作可能被链状态拒绝，烧费不退）
农场是「乐观提交、事后裁决」架构（同红包 CLAIM 的「占位扣 fee」）：一笔动作在**共识层**是合法的自转烧币交易，`burn` 真实进虚空；但 `parseFarm` 在**入块后**结合彼时链状态判定其是否「入账」。两者可能不一致——**链拒绝的那笔，烧费照样进虚空、不退**（不破零增发，但用户视角是「白烧」）。两处会发生：

- **H1 · 买地价格竞态**：`landPrice` 随行情上涨（别人买地 → `soldTotal++` / 近窗 velocity↑）。若客户端按「拿价时的快照价」烧币，确认前涨价就会使 `burn < price` → `parseFarm` 忽略这笔买地，玩家烧了币却没拿到地、币不退。
  **缓解（已实现）**：客户端买地烧 `ceil(landPrice × 1.05)` 的 **buffer**——`parseFarm` 只要求 `burn ≥ price`，故 5% 内涨价仍被接受，多烧部分照样进虚空（合法、不破零增发）。UI 文案标明「含市场波动缓冲」。注：`pricePaid` 记的是**当时权威地价**（非多烧额）。超过缓冲幅度的剧烈涨价仍可能被拒——这是 burn 模型的固有边界（彻底退款需共识级托管，超出 MVP）。
- **H2 · 同格并发种植/收获**：同一 `(zoneId, slot)` 若有两笔 `PLANT`（多标签页 / 连点），或两笔 `HARVEST` 抢同一 plant，`parseFarm` 用**链序首胜**裁决（同块内按交易数组顺序、跨块按区块序）——只第一笔入账，**败者那笔被忽略、其 `SEED_COST`/`HARVEST_BURN` 烧费不退**。
  **语义**：抢占失败烧费不退，鼓励避免冲突（与红包 CLAIM 同构）。**缓解**：客户端尽量前置校验（按 `farm.plants` 快照判该格已占用则不放种植交互点 / 提交后本地标记 pending 禁重复点），降低自撞概率；单人自家农场需手速并发才触发，属低概率 MVP 限制。

> 共性：**「上链动作可能被链状态拒绝，且因 burn 模型烧费不退」**。`parseFarm` 的裁决纯函数、确定性、全网一致（不是分叉），但调用方/UI 应让用户知情，并尽量前置校验减少发生。
