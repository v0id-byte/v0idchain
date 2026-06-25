# 代码审查报告 · v0idChain 游戏层（钓鱼 / 农场 / 消息命名空间）

> 范围：本会话新增的 `fishing.ts` / `farm.ts` / `messages.ts(isProtocolMemo)` + game-server `/api/fish`·`/api/farm` + game-web `FishingModal`·`FarmPanel`·`buildFarm`·`crop-render`·`fish-render`，对照范式 `pets.ts` / `redpacket.ts`。
> 性质：**只读审查**，未改任何代码、未 commit。
> 审查日期：2026-06-23 · 审查者：Claude（Opus 4.8）

## 结论速览（铁律层面）

- ✅ **系统零增发 —— 通过**。钓鱼/农场四种动作在共识层全部落到 `applyTx`/`applySelect` 的「普通交易」分支（`blockchain.ts:206-211 / 260-263`）：自转 `credit(from, -(0+fee+burn))`、`credit(to=from, 0)`、`credit(NULL_ADDRESS, burn)`。净效果 = 发起人失去 `fee+burn`、虚空得 `burn`、矿工得 `fee`（走 coinbase）。**没有任何凭空发 $V0ID 的路径**；`from===owner` / `burn>0` / 自转校验齐全，与 `parsePets` 一致。
- ✅ **未触碰共识/创世/checkpoint/txid 哈希**。`blockchain.ts` 对 `FISH|LAND|ZONE|PLANT|HARVEST|CROPX` **零引用**（已 grep 确认）；这些 memo 对共识完全惰性，仅被上层 `parseFish`/`parseFarm` 解释。`payloadHash` 未动，创世/checkpoint 不变。
- ✅ **faucet/央行私钥未被误用**。游戏写动作全部走客户端本地签名 `createMessage` → `/api/tx` 转发；faucet 仍是央行池**搬运**（限额+限速+全局上限），不造新币。
- ✅ **随机源不可伪造**。`catchHash`/`cropHash` = `sha256(owner|出块后区块hash|txid)`，与 `redSeed` 同源：掺入出块后才定的区块 hash → 事前不可预测、不可「挑 txid」、重试须再烧币落进新区块。
- ✅ **确定性可复算 / reorg 安全**。`parseFish`/`parseFarm` 纯函数、只依赖链、同块内按交易数组顺序定胜负。动态地价是纯链上状态函数。
- ✅ **memo 命名空间无误伤**。`isProtocolMemo` 覆盖 PET/PETX/RED/CLAIM/REFUND/FISH/LAND/ZONE/PLANT/HARVEST/CROPX 全部 11 个前缀；刻意排除 `ENC|`（私信正文，须进收件箱）与 `NAME|`（burn=0 自转，`isMessageTx` 已天然排除）—— 排除理由正确。

**未发现任何违反「零增发 / 共识不变」铁律的问题。** 下列为正确性/体验/一致性层面的发现，无一动摇铁律。

---

## High（应修：真实可触发的资金/正确性问题）

### H1 · 买地价格竞态 → 玩家烧币但买地被静默拒绝、币不退
**文件**：`packages/game-web/src/FarmPanel.tsx:123,161` + `packages/core/src/farm.ts:277-280`

**问题**：客户端用 `GET /api/farm` 时刻快照的 `farm.landPrice` 作为 `burn` 烧币（`burnFor()` 返回 `farm.landPrice`）。但 `parseFarm` 在交易**入块时**用「截至该交易之前」的全网状态**重算**地价（`farm.ts:278-279`），并要求 `burn >= price`（`farm.ts:280`）。在「拿价」与「入块」之间，只要别处有人买地（`soldTotal++`）或近窗成交密度上升（velocity↑），重算价就会 **高于** 玩家烧的旧价 → `parseFarm` 走 `continue` 忽略这笔买地。

**后果**：交易在**共识层照样合法**（自转+burn 是合法普通交易），`burn` 已被 `credit(NULL_ADDRESS, burn)` **真实烧掉**，但 `parseFarm` 不认这块地 → **玩家烧了币、没拿到地、币不退**。这不是分叉（全网一致地拒），但是真实的用户资金损失。并发越高越易触发。

**建议修法**（择一，按代价排序）：
1. 客户端按当前价 **加一点 buffer 烧**（如 `Math.ceil(landPrice * 1.05)`）。`parseFarm` 只要求 `burn >= price`，多烧合法、被接受；代价是偶尔多烧几个币（仍全进虚空，不破零增发）。**最小改动，推荐先上**。
2. UI 文案明确提示「地价可能在确认前上涨，届时本次开垦无效且烧币不退」，让用户知情。
3. （重设计，Phase 2）让买地把币转**央行托管**而非烧掉，`parseFarm` 拒绝时理论上可退 —— 但当前是 burn 模型，退款需要共识级托管状态机（像红包那样），超出 MVP。

> 注：钓鱼/建区块/种植/收获**无此问题**——它们的 burn 是固定常量（`FISH_BURN`/`ZONE_COST`/`SEED_COST`/`HARVEST_BURN`），`parseFarm` 用 `===` 精确比对，客户端烧的与校验的恒等。**只有动态地价的买地受影响。**

### H2 · 同格并发种植：两笔 PLANT 抢同一空格，败者烧币但作物不入账
**文件**：`packages/core/src/farm.ts:312-318`

**问题**：`parseFarm` 用全局 `occupied` Set 判空格，同块内/跨块靠交易序定胜负——逻辑本身**正确且确定**。但客户端 `buildFarm` 从 `farm.plants`（快照）算空格，两个标签页/两次快速点击可能对**同一个 `(zoneId, slot)`** 各发一笔 PLANT。入块后 `parseFarm` 只认第一笔，第二笔 `occupied.has(key)` → `continue` 忽略。

**后果**：与 H1 同构——败者那笔 PLANT 在共识层合法、`SEED_COST` 已烧，但作物不入账、**种子费不退**。HARVEST 同理（两笔抢收同一 plant，败者烧 `HARVEST_BURN` 但无收成）。

**建议修法**：MVP 阶段属低概率（单人自家农场、需手速并发），可接受。建议：
1. 客户端提交后乐观锁该 slot（本地标记 pending，禁止再点）直到确认/超时，降低自撞概率。
2. 文案提示「同格重复种植/收获只有第一笔生效，重复操作的费用不退」。
3. 标注为已知 MVP 限制，写进 GAME-PROTOCOL §7 的「边界与已知限制」。

> 这是 burn 模型 + 「乐观提交、事后裁决」架构的固有特性，与红包 CLAIM 的「占位扣 fee」异曲同工。**不违反零增发**（败者的币进了虚空），但用户视角是「白烧了」。H1/H2 建议在文档里统一交代这条「上链动作可能被链状态拒绝，烧币不退」的语义。

---

## Med（应改：边界/一致性/健壮性）

### M1 · `nextPlotN` 每笔买地都 O(n) 全表扫 → `parseFarm` 整体 O(地块数²)
**文件**：`packages/core/src/farm.ts:236-240,276`

`nextPlotN(plots, owner)` 遍历整个 `plots` Map 求某 owner 的最大块号；每遇一笔 `LAND|` 调一次。全网地块总数 N 时，买地解析是 O(N²)。教学链 N 不大，但 `parseFarm` 在 `/api/farm` **每次请求**都全链重算（无记忆化），地块多了会拖慢服务端。

**建议**：维护一个 `Map<owner, number>`（owner → 已解锁最大块号）增量更新，把 `nextPlotN` 降到 O(1)。纯内部优化，不改协议、不改结果。低优先（功能正确，仅性能）。

### M2 · `landPrice` 浮点 `Math.pow` 进入「共识可复算」路径 —— 跨引擎一致性的理论风险
**文件**：`packages/core/src/farm.ts:80-84,278-279`

`landPrice` 用 `Math.pow(1+soldTotal/K, 1.15)` 后 `Math.ceil`。这是**买地是否合法的判定输入**（`farm.ts:280` 的 `burn < price`），即已进入「全网必须算出同一结果」的路径。JS 内 `Math.pow` 在同一 V8 上确定，但若将来有**别的语言/运行时实现的客户端**（项目正在做原生轻客户端，见 CLIENT-PROTOCOL.md）参与判定，`pow` 的最后一位 ulp 差异可能让两端对 `price` 取整后差 1 → 对同一笔买地的合法性产生分歧。

**对比**：`redpacket.computeShare` 刻意**全整数运算**（注释明说「杜绝浮点撕裂共识」），农场地价偏离了这条既有纪律。

**建议**：当前单实现（TS）下**不是现实 bug**，标记为「跨实现互操作前必须解决」。修法：要么把 `landPrice` 改成定点/整数近似（如查表或整数幂展开），要么在 CLIENT-PROTOCOL 明确规定 `landPrice` 的权威实现与 golden 向量，要求所有客户端 bit-for-bit 复现。**农场的「确定性」目前依赖 JS `Math.pow`，文档应点明这一前提。**

### M3 · `parseFarm` 的 ZONE/PLANT 没限制「每地块只能有一个 farmland 区块」
**文件**：`packages/core/src/farm.ts:288-298` + `buildFarm` `scene.ts:404-405`

`parseFarm` 允许同一 `plotN` 上建任意多个 `farmland` 区块（每个 `ZONE_COST`，都合法入账）。但渲染端 `buildFarm:405` 用 `zonesByPlot` **只取第一个** farmland zoneId（`!zonesByPlot.has(z.plotN)` 守卫）。于是玩家可以重复建区块、重复烧 `ZONE_COST`，但第 2+ 个区块在农场场景里**根本不可见、不可种** → 烧币无对应可玩内容。

**后果**：不破坏数据一致性（多余 zone 确实存在于 `farm.zones`），但是「花了钱看不到东西」的体验坑 + 潜在困惑。

**建议**：要么 `parseFarm` 在 ZONE 分支加「该 plotN 上已无 farmland 区块」校验（拒绝重复建造，与买地的「禁跳号」纪律一致）；要么客户端 `buildFarm` 在已建区块的地块上不再暴露 `plot`(建造)交互点（避免诱导重复建造）。检查 `scene.ts` 发现：已建区块的地块走 `for slot` 分支，**不会**再放建造交互点——所以正常玩法走不到重复建造，**风险仅限手搓交易**。降为提示级。

### M4 · `makeZone` 暴露 `orchard` 类型，但 `parseFarm` 种植只认 `farmland` → 可建一个永远不能种的区块
**文件**：`packages/core/src/farm.ts:43-44,169-172,311` + `FarmPanel.tsx:139`

`ZONE_TYPES = ['farmland','orchard']`，`makeZone` 接受 `orchard` 并构造合法 memo；`parseFarm` ZONE 分支也接受 `orchard` 入账。但 PLANT 分支硬性要求 `z.type !== 'farmland' → continue`（`farm.ts:311`）。于是 `orchard` 区块能建（烧 `ZONE_COST`）却永远种不了东西。

**现状**：客户端 `FarmPanel.tsx:139` 写死 `makeZone(plotN, 'farmland')`，正常 UI 走不到 orchard——**实际不可触发**。但 core 把 orchard 标为「先列举不强用」却放进 `ZONE_TYPES` 让 `makeZone`/`parseFarm` 都放行，是个会咬人的预留口（手搓 `ZONE|n|orchard` 能烧币建废区块）。

**建议**：Phase 2 真正实现 orchard 前，`makeZone` 应拒绝非 `farmland`（或 `parseFarm` 拒收 orchard），把「列举」与「放行」解耦。低优先（注释已自承「先列举不强用」）。

---

## Low（可选：清晰度/微优化/文档）

### L1 · `parseFish` 同地址多次 `fishOf` 触发重复整链扫描
**文件**：`packages/core/src/fishing.ts:129-131` + `farm.ts:366-380`

`fishOf` / `farmOf` 各自调一次 `parseFish`/`parseFarm`（全链扫）。server.ts 单次请求只调一次，无放大；但若同一请求里既要全网又要某地址会扫两遍。当前调用点无此模式，**仅留意**。与既有 `petsOf` 同款写法，一致。

### L2 · `FishingModal` 的张力条结算 effect 依赖 `tension` → 每帧 setState 重建 interval
**文件**：`packages/game-web/src/FishingModal.tsx:124-144`

结算 `useEffect` 依赖 `[phase, tension]`，而 `tension` 每帧 `setTension` 变化 → 该 effect 每帧 teardown+重建 `setInterval`。功能正确（60ms interval 照常判定），但每帧重建定时器是浪费。可改为只依赖 `[phase]`，interval 内读 ref（`tensionRef`）而非闭包 state。纯客户端性能微优化，不影响链。

### L3 · `crop-render` 生长中占位 hash 用 `plant.id`（txid），与成熟后的 `cropHash` 不同源
**文件**：`packages/game-web/src/engine/scene.ts:445` + `FarmPanel.tsx:230`

生长中的作物用 `plant.id`（种植 txid）当渲染 hash（注释明说「仅决定生长中外观个体差异，不剧透品质」），收获后切到真 `cropHash`。这是**有意设计**（防提前剧透品质），但意味着同一株作物「生长中长相」与「成熟后长相」的个体特征（hue 等）会在收获瞬间跳变。属可接受的设计取舍，注释已交代。仅记录，非问题。

### L4 · `server.ts` `/api/fish`·`/api/farm` 不带 address 时返回全网 `parseFish`/`parseFarm`，无分页/无上限
**文件**：`packages/game-server/src/server.ts:87-99`

不带 `address` 的全网查询随链增长无界返回。教学链规模无虞，但若渔获/地块累积到很大，单次响应会很重（且每次现算）。与 `/api/pets` 同款，一致。建议 Phase 2 加缓存或分页。低优先。

### L5 · 输入校验 / SSRF / 注入 —— 已检查，无问题
- `server.ts` 所有写动作（`/api/tx`）只转发**已签名**交易，节点侧 `verifyTransaction` 兜底；服务端不持私钥，CORS `*` 安全（注释已论证）。
- `/api/farm`·`/api/fish`·`/api/balance` 的 `address` 走 `isValidAddress` 正则校验（farm/fish 的 address 用于 `.filter`，即便非法也只是空结果，无注入面）。
- `chain.ts` 的 `nodeGet` 只拼到固定 `NODE_URL`（环境变量，非用户输入），`encodeURIComponent` 包裹 query → **无 SSRF**。
- 前端私钥只存 `localStorage`、`exportPrivateKey` 仅本地复制，**永不上送** —— 符合自托管钱包纪律。

---

## 与既有范式（pets/red）的一致性评估

- `parseFish` 对照 `parsePets` 孵化校验（`from===to && burn>0`）：**完全一致**。
- `fishRarity`/`cropQuality` 直接复用 `petRarity`（前导 0 比特门槛）：**复用正确**，无重复实现。
- `cropHash`/`catchHash` 对照 `redSeed`（区块 hash 随机源）：**同源同纪律**。
- `crop-render`/`fish-render` 对照 `pet-render`（32×32 离屏→放大、`RARITY_GLOW` 同一套蓝/紫/金）：**一致**。
- `FarmActionModal`/`FishingModal` 的签名上链对照 `App.hatch`（nonce→createMessage→submitTx→waitConfirmed）：**照搬正确**。
- **唯一偏离**：`landPrice` 用浮点 `Math.pow` 进了「可复算」路径，偏离了 `computeShare` 全整数的既有纪律（见 M2）。

## 死代码 / 重复 / 命名

- 未见明显死代码。`CROPX_PREFIX` 是有意预留（Phase 2 P2P 转让，`parseFarm` 显式注释「即便出现也忽略」），合理。
- `ZONE_TYPES` 含未实现的 `orchard`（见 M4），属「列举但放行」的预留口，建议解耦。
- `App.tsx:269-277` 的 `__dir`/`__visit` 调试钩子注释自承「部署前删」——**提醒部署前移除**（非本次新增，但游戏层一并提一句）。

---

## 附：审查覆盖的文件

core：`fishing.ts` `farm.ts` `messages.ts` `pets.ts` `redpacket.ts` `transaction.ts` `config.ts` `crypto.ts` `names.ts` `blockchain.ts`(applyTx/applySelect/addTransaction 路径) `index.ts` `browser.ts`
game-server：`server.ts` `chain.ts` `faucet.ts` `config.ts` `rooms.ts`
game-web：`App.tsx` `FishingModal.tsx` `FarmPanel.tsx` `api.ts` `wallet.ts` `crop-render.ts` `fish-render.ts` `engine/scene.ts`
docs：`FISHING-DESIGN.md` `ECONOMY-LAND-DESIGN.md` `GAME-PROTOCOL.md`
