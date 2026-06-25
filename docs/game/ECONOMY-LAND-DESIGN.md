# 土地 / 农场 / 经济系统 · 实现规范（ECONOMY-LAND-DESIGN）

> Stardew 式链上农场。与 pets/fish/红包同级：**纯 memo 约定层，不改共识、无软分叉、系统零增发**。
> 经济闭环：**花币(烧/进央行池) → 建造/种植 → 收获链上收藏作物 → 想回血只能 P2P 卖给别的玩家**。系统永不凭空发币——"收入"全来自其他玩家的需求，自带反通胀。

## 0. 已定决策（v0id 拍板）
1. **土地=混合**：玩家专属农场为主（MVP）；镇上少量公共商业地块可竞拍/转让（后置 Phase 2）。
2. **作物=收藏品 + 可 P2P 交易**：链上 NFT 式物品，玩家间转手(买方付币给卖方)，系统不增发；挂现有集市卖。
3. **买地付谁=烧进虚空 / 进央行池**：向系统买新地=烧币(通缩)或转入央行池(可被 faucet 再分发)；已有地玩家间 P2P 转让。
4. **MVP 首块=最小闭环**：买地 → 建田地区块 → 种一种作物 → 按区块高度成长 → 收获为链上物品。
5. **链上 vs 客户端的边界**：**大而不频**的动作（买地/买卖/建区块/收获）走链上签名交易；**频繁小事**（钓鱼 QTE、走动、装修预览）留客户端，只在"落定"时上链一次。
6. **Gas**：每笔链上买卖都收网络 gas（`MIN_FEE`，现行→矿工）；动作成本部分（地价/建造/种子）= **烧进虚空 或 转央行池**（可配，二者皆可，零增发）。
7. **地价随行情浮动**（不是固定公式）：见 §1/§4 的动态定价（bonding curve）。

## 1. 链上协议（`packages/core/src/farm.ts`，新增·纯函数，仿 pets/fish）
所有动作 = 玩家本地签名的一笔交易（自转或转央行 + 烧/付币 + memo）。`parseFarm(chain)` 纯函数重放还原全局农场状态。
```
// —— 买地(解锁专属农场地块 n；价随"行情"动态浮动) ——
LAND|<n>  付 landPrice(链上状态)  地价部分 burn 或转 TREASURY + 网络 gas MIN_FEE→矿工   // parseLand: owner 的已解锁地块集合
// —— 建造区块(在已解锁地块上建一个功能区) ——
ZONE|<plotN>|<type>  burn=ZONE_COST   type ∈ {farmland 田地, orchard 树场, …}  // 校验 plotN 属于该 owner
// —— 种植(在田地区块某格种作物，记录所在区块高度) ——
PLANT|<zoneId>|<crop>|<slot>  burn=SEED_COST(crop)                            // 记 plantHeight=该交易所在区块号
// —— 收获(成熟后) → 产出链上收藏作物(NFT 式) ——
HARVEST|<plantId>  burn=HARVEST_BURN                                          // 校验已成熟; 收成品质由区块hash随机源定(见§3)
// —— P2P 交易(Phase 2，仿 PETX/集市) ——
CROPX|<cropId>|<toAddr>   或挂现有集市；买方付币给卖方，系统不增发
```
> 校验铁律(仿 parsePets)：每个 memo 动作必须 `from===owner`、`burn>0`/`付费正确`、且引用的地/区块/作物**确属该 owner 且状态合法**，否则忽略。地块/区块/作物 id 用 owner+序号确定性派生，防伪造/越权。

## 2. 成长 = 区块高度确定性（无需"浇水"交易）
作物 `plantHeight` 记在种植交易所在区块号。当前链高 `H` 时成熟度 = `clamp((H - plantHeight) / GROW_BLOCKS[crop], 0, 1)`。
- 0 = 种子，<1 = 幼苗/生长中（分 2–3 视觉阶段），≥1 = 成熟可收。
- 纯由链高算，全网/跨端一致、reorg 安全（链重组就重算，同 parsePets）。无"时间"歧义。

## 3. 收成品质（不可伪造随机源，仿红包/鱼）
`cropHash = sha256(owner + '|' + HARVEST交易所在区块hash + '|' + 该txid)` → 品质/变异(普通/优质/稀有/金，前导0比特，同崽)。
玩家改不了链上 txid/区块hash → 伪造不出金作物；想刷好品质要再花种子+收获成本+落进不可控区块 → 经济自带反作弊。

## 4. 动态地价（随行情浮动）+ 经济参数(草案，最终 v0id 拍板)
**地价 = 全网供需的确定性函数（bonding curve），人人同价、链上可复算、随行情走**：
```
landPrice = BASE * (1 + soldTotal / K)^P * (1 + recentVelocity)    // 纯由链上状态算
  soldTotal      = parseFarm 还原的"全网已售地块总数"（卖得越多越稀缺→越贵）
  recentVelocity = 最近 W 个区块内售出地块数 / W（最近抢得越凶→越贵，体现"行情热度"）
  BASE=200, K=50, P=1.15, W=720块
  // 二级市场(已有地 P2P 转让 CROPX/LANDX)由卖方自由定价 → 直接的自由市场行情
```
其余：`ZONE_COST=100` · `SEED_COST` 因作物(普通菜 10、稀有种 50) · `HARVEST_BURN=2` · `GROW_BLOCKS` 因作物(快菜 30 块、果树 200 块)。**全部只烧/进央行池/玩家间转，零增发**；每笔再叠网络 gas `MIN_FEE`→矿工。

## 5. 渲染 / 交互（game-web）
- **专属农场=新场景** `buildFarm(owner, farmState)`（仿 `buildRoom`/`buildTown`，户外草地+泥畦）。入口：房间或镇上加一道"去农场"的门(`InteractType` 复用 'door'，target='farm')。
- **作物=程序化像素**（新 `crop-render.ts`，仿 pet/fish-render）：按 `crop`×成熟阶段画（种子点→幼苗→成株/果），稀有品质加 `RARITY_GLOW`。
- **交互**：空地块→建区块；田地空格→种植(选作物)；成熟作物→收获。新 `InteractType:'plot'|'crop'`，`App.tsx onInteract` 分发到对应面板/动作，签名上链照搬 `hatch()`。
- 农场状态由服务端 `parseFarm` 预算给 `/api/farm?address=`（仿 /api/pets）。

## 6. MVP 范围（让 agent 先做这条闭环；其余标 Phase 2）
**做**：`core/farm.ts`(LAND/ZONE/PLANT/HARVEST + parseFarm + 成长 + cropHash/quality) → `crop-render.ts` → `buildFarm` 场景 + 农场入口门 → 建区块/种植/收获三个交互 + 面板 → `/api/farm` 端点 → `GAME-PROTOCOL.md` 加 §7。
**Phase 2（先不做，留接口）**：公共商业地块竞拍/转让、作物 P2P 集市交易(CROPX/挂集市)、树场/更多区块类型、多作物图鉴、灌溉/施肥增益。

## 7. 文件清单（MVP）
| 文件 | 改动 |
|---|---|
| `packages/core/src/farm.ts` | 新增：常量 + `makeLandBuy/makeZone/makePlant/makeHarvest` + `parseFarm` + 成长/品质纯函数 |
| `packages/core/src/index.ts`+`browser.ts` | 导出 farm |
| `packages/game-web/src/crop-render.ts` | 新增：作物像素渲染(crop×阶段×品质) |
| `packages/game-web/src/engine/scene.ts` | 新增 `buildFarm()` + `InteractType` 加 'plot'/'crop'；镇上/房间加农场入口门 |
| `packages/game-web/src/FarmPanel.tsx`(或浮层) | 建区块/选作物种植/收获 UI；签名上链仿 `hatch()` |
| `packages/game-web/src/api.ts` | 加 `farm(address)` → `/api/farm` |
| `packages/game-web/src/App.tsx` | onInteract 接 plot/crop；农场场景切换；菜单加"农场/仓库"入口 |
| `packages/game-server` | 只读 `GET /api/farm?address=`（parseFarm 过滤） |
| `docs/GAME-PROTOCOL.md` | 加 §7：土地/农场 memo 约定 + 作物 Render Spec + 经济参数 |

**实现参照**：`core/pets.ts`(memo-NFT)、`core/redpacket.ts`(区块hash 随机源)、`core/transaction.ts`(createMessage)、`room.ts`/`buildRoom`(个人空间+发布)、`pet-render.ts`、`App.tsx`(hatch 模板)。
**铁律自检**：系统零增发；所有动作只烧币/进央行池/玩家间转；不碰 faucet 私钥；不改共识。
