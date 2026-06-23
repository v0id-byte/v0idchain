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
| `FAUCET_AMOUNT` | game-server | 待定（人均多一些） | 单地址 faucet 额度。 |
| `FAUCET_GLOBAL_CAP` | game-server | 待定 | faucet 全局总额上限（央行池由矿工把出块奖励指向央行地址缓慢回补）。 |

> 央行收款地址（公开安全）：`0xd63300cb79b682979a5c62bad419a2a1147da9be4111736d52c636523a20cefb`（`GENESIS_PREMINE_ADDRESS`）。
> 往它转币 = 给 faucet 补水；faucet 用央行**私钥**（仅服务器本机）往外发。
