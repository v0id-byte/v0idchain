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
