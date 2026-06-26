# 钓鱼小游戏 · 实现规范（FISHING-DESIGN）

> 触发点：镇中心西端开放式鱼摊（`buildTown()` 的 `place('fishstall', …)`，`drawStall` 已画好）。
> 一句话定位：**像 pets/红包一样的纯 memo 约定层**。链只当"不可伪造随机源 + 可验证渔获账本"，**钓鱼只烧币、绝不发币**。不改共识、无软分叉。

## 0. 架构红线（必须遵守）
- 价值只在链上；服务器/客户端**不能凭空生成 $V0ID**（钓鱼是 hash 抽稀有度标签，不是产币）。
- 上链铸造只能玩家**本地签名**发起（`@v0idchain/core/browser`），服务器只转发。
- 不碰 faucet / 央行私钥；**零新发币路径**。
- 与 pets/昵称/红包同级：建在既有 `amount=0 + burn>0 + memo`（`MAX_MEMO=512`）交易形态上，共识层/`txid` 哈希/创世/checkpoint 一字不动。

## 1. 链上协议（`packages/core/src/fishing.ts`，新增·纯函数）
```
FISH_PREFIX = 'FISH|'      FISH_BURN = 2   // 很小,高频娱乐;最终由 v0id 拍板
makeFishCatch(bait?) -> memo 'FISH|<bait>'                 // 仿 makePetMint
渔获交易 = createMessage(wallet, wallet.address /*自转*/, makeFishCatch(), nonce, FISH_BURN, MIN_FEE)
  约束: from===to 且 burn>0（仿 parsePets 对孵化的校验）

catchHash = sha256(owner + '|' + 该交易所在区块hash + '|' + txid)   // 与 redSeed 同源:事前不可测、事后全网一致、不可伪造
fishRarity = petRarity 复用同门槛: 前导0比特 ≥12 传说 / ≥8 史诗 / ≥5 稀有 / else 普通
fishTraits(catchHash) = { rarity, species=geneByte(h,0)%N[rarity], hue, bellyHue, finStyle, sizeCm, shiny }  // 仿 petTraits,同 hash 处处同鱼

parseFish(chain) -> Catch[]:   // 纯函数,仿 parsePets;服务端预算给 /api/fish
  对每 block b、每 tx: if memo startsWith 'FISH|' && tx.from===tx.to && (tx.burn??0)>0:
    push { id: txid, owner: from, catchHash: sha256(from+'|'+b.hash+'|'+txid), traits: fishTraits(catchHash), height, ts, burn }
```
鱼种表（像素可画，`ellipse 身 + 三角尾 + 1px 眼`，同 drawStall 范式）：普通=鲫/鲈/泥鳅/虾；稀有=锦鲤/鳟/河豚(蓝光#54a8ff)；史诗=金龙/电鳗/月鱼(紫光#b66bff)；传说=**虚空鲸**(深身+体内星点,呼应烧币进虚空)/星之鲟(金光#ffce3d)。概率=2⁻ᵏ，同崽。

## 2. ⚠️ 必修的潜在真 bug
`messages.ts` 的 `isMessageTx` 把任何 `amount=0 且 burn>0` 都当**链上私信** → `FISH|`（以及现有 `PET|`/`PETX|`/`RED|`）会被 `parseMessages` 误收进收件箱。
**修法**：`parseMessages` 跳过协议前缀 memo——加 `isProtocolMemo(memo)` 集中判定（含 `FISH|`/`PET|`/`PETX|`/`RED|`…）。**孵崽/红包可能已被误判，顺手一起修**。

## 3. 玩法（纯客户端 QTE，零延迟，不触链）
状态机：`idle →(E)→ casting →(300ms)→ waiting →(随机1.5–5s 咬钩)→ bite →(900ms 窗口内响应)→ reeling →(张力条 QTE)→ caught / missed`。
**张力平衡条**（推荐）：按住 E/鼠标=收线(指针右移)，松开=放线(左移)；把指针稳在绿区累计 `HOLD_MS≈450ms` → caught；指针顶右(线崩)或 `REEL_DURATION≈2600ms` 耗尽 → missed。绿区宽/指针速可做难度。MVP 可先做更简单的"指针进绿区点一下"。

## 4. 奖励 = B 为主 + A 的即时反馈（推荐）
QTE 成功 → **立刻本地动画庆祝**（零延迟，图鉴预览）→ 结算卡两按钮：
- **留作纪念（不上链）**：仅本地战绩计数。
- **铸成链上藏品（烧 FISH_BURN）**：走 §1 签名上链，鱼种由 catchHash 事后确定 → 不可伪造、可炫耀、跨端、reorg 安全（第二种链上社交藏品，继崽之后）。
日常瞎钓不烧币，想收藏才上链。

## 5. 防作弊（随机源）
`catchHash` 掺入**出块后才确定的区块 hash** 是关键：玩家抛竿/改 JS 都改不了链上 txid 与区块 hash → 伪造不出传说鱼；重试要再烧 `FISH_BURN`+fee + 落进新的不可控区块 → 刷传说期望成本 ≈ 数万币，经济自带反作弊。**被否决**：客户端 RNG（可改）、服务器掷骰（非权威）、只用 txid（签名时已固定→可穷举挑）。

## 6. MVP 文件改动清单
| 文件 | 改动 |
|---|---|
| `packages/core/src/fishing.ts` | 新增：`FISH_PREFIX/FISH_BURN/makeFishCatch/fishCatchHash/fishTraits/fishRarity=petRarity/parseFish` |
| `packages/core/src/index.ts` + `browser.ts` | 各 `export * from './fishing.js'` |
| `packages/core/src/messages.ts` | `parseMessages` 加 `isProtocolMemo` 排除（修 §2 bug） |
| `packages/game-web/src/engine/scene.ts` | `InteractType` 加 `'fishing'`；`place()` 开放式摊位用 `type:'fishing'`（现在是 `'board'`，与名册冲突） |
| `packages/game-web/src/fish-render.ts` | 新增：镜像 `pet-render.ts`（32×32→放大，复用 `RARITY_GLOW`） |
| `packages/game-web/src/FishingModal.tsx` | 新增：QTE 浮层 + 状态机 + 结算卡；签名逻辑照搬 `App.tsx` `hatch()`（nonce→createMessage→submitTx→waitConfirmed） |
| `packages/game-web/src/api.ts` | 加 `fish(address)` → `/api/fish` |
| `packages/game-web/src/App.tsx` | `onInteract` 加 `'fishing'` 分支开 Modal；菜单加"鱼篓"Tab（仿 PetsPanel）；渲染 `<FishingModal/>` |
| `packages/game-server` | 加只读端点 `GET /api/fish?address=`（`parseFish` 过滤，仿 `/api/pets`）；**无写端点新增** |
| `docs/GAME-PROTOCOL.md` | 加 §6：钓鱼 memo 约定 + 鱼 Render Spec v1 + 经济参数（纳入版本化纪律） |

**落地顺序**：① core/fishing.ts（自包含·可单测）→ ② messages.ts 修 bug → ③ fish-render.ts → ④ FishingModal.tsx（QTE）→ ⑤ scene/App/api 接线 → ⑥ /api/fish 端点 → ⑦ GAME-PROTOCOL §6。

**实现参照**：`core/pets.ts`（memo-NFT 范式）、`core/redpacket.ts`（`redSeed` 区块-hash 随机源）、`core/transaction.ts`（`createMessage`）、`core/messages.ts`（`isMessageTx` 误收坑）、`game-web/pet-render.ts`、`game-web/App.tsx`（`hatch()` 模板 + `onInteract`）。
