# v0idChain 攻防实验手册（LABS）

> 把散落在源码注释里的「为什么这么防」，组织成一组**可复现的动手攻防实验**。
> 每个实验都是「**当一次攻击者** → 看防御**如何把你拒掉** → 读懂**为什么**」。
> 适合直接搬进大学**分布式系统 / 密码学**课当 lab，也是「教学链 / 安全靶场」定位的落地。

这条链相对网上「200 行手搓链 demo」的真正价值，是它把**比特币级别的防御真做对了**：自适应难度、最大累计工作量选链、未来时间戳上限、整链 txid/merkleRoot/PoW 锚定、nonce 防重放、checkpoint 冻结历史、坏文件不静默清空……下面每个实验都让你**亲手发起对应攻击**，并实测看到它被拒。

---

## 0. 准备

```bash
# 一次性安装依赖（Node ≥ 22.13）
corepack pnpm install --frozen-lockfile

# 每个实验 = 跑一条命令（纯本地、零网络、秒级，不碰公网种子）
corepack pnpm tsx scripts/labs/01-tamper-amount.ts
```

| # | 实验 | 攻击 | 被什么拒 |
|---|------|------|----------|
| 1 | [篡改交易金额](#实验-1篡改区块里的交易金额) | 改掉某区块里一笔交易的 `amount` | `txid → merkleRoot → 区块hash → PoW → 签名` 逐层拦截 |
| 2 | [廉价长 fork](#实验-2压低难度靠长度凑数的-fork) | 压低难度、狂塞空块凑长度想反超 | **最大累计工作量**规则（`chainWork = Σ2^difficulty`） |
| 3 | [未来时间戳压难度](#实验-3把时间戳设到远未来想压难度) | 把时间戳设到远未来拉长重定向窗口 | `MAX_FUTURE_DRIFT_MS` 上限 |
| 4 | [双花 / 超额 / 乱序 nonce](#实验-4双花--超额--乱序-nonce) | 超额、跳号、重放已花交易 | nonce 自增 + 余额校验（mempool + 整链双层） |
| 5 | [改坏 chain.json](#实验-5改坏-chainjson-一个字节) | 改掉落盘链文件一个字节 | 加载失败 → **备份坏文件 + 从创世重建**（不静默清空） |
| 6 | [越过 checkpoint 的深 reorg](#实验-6越过-checkpoint-的深度-reorg) | 凑更大工作量回滚已确认历史 | `CHECKPOINTS` 冻结 + `replaceChain` 深度防线 |

> 每个 lab 脚本都是**独立、自解释**的：打开任意一个，从上到下就能读懂攻击与防御。下面正文里的「实测输出」都是直接跑脚本得到的真实结果。

---

## 共识「强约束」 vs memo「社会共识」——先分清两层

这条链上的功能分两类，**安全模型完全不同**，做实验和上真钱前必须分清（详见 [README「设计说明 & 已知边界」](README.md#设计说明--已知边界玩具链别上真钱)）：

- **共识强约束**（节点**拒绝**违反者的区块 / 交易，靠 PoW + 签名 + 状态机钉死）：
  - **PoW / 难度 / 最大工作量选链 / 未来时间戳上限**（实验 2、3）
  - **每笔交易 `txid === 内容哈希` + merkleRoot + 签名**（实验 1）
  - **nonce 防重放 + 余额防双花/超额**（实验 4）
  - **coinbase 金额 = 出块奖励 + 手续费**（钉死、不可凭空增发）
  - **🧧 红包托管状态机**（`RED/CLAIM/REFUND`：转给托管地址、共识级条件支付、过期退款）——**这是唯一一个「带共识级强约束」的应用层功能**：金额真锁进托管、派发额由 `computeState`/`validateChain` 共用 `applyTx` 钉死，矿工和校验方算出的份额必须逐分一致，否则分叉。

- **仅 memo 社会共识**（**不改共识**：这些交易在旧节点眼里只是合法的「自转 / 转账 + 一段 memo」，全网照收。「含义」只活在愿意解析 memo 的客户端里，链本身**不强制**任何人认）：
  - **🛒 集市**（`MKT|价格|标题` / `BUY|` / `DEL|`）、**🪪 昵称**（`NAME|名字`，先到先得是**解析约定**而非共识）、**✉️ 明文/加密消息**（`burn>0 + memo`，`ENC|` 端到端加密）。
  - 这些是「在转账之上叠一层含义」的纯约定。安全性来自**底层转账本身是强约束的**（钱真的扣了、签名真的验了），但**「谁拥有 @alice」「这条 BUY 是否构成成交」只是大家约定俗成的读法**，不是节点会为你强制执行的规则。

> 一句话：**红包是「合约」，集市/昵称/消息是「便利贴」**。实验 1–6 攻击的全是**强约束层**——因为那才是「拒绝信息」的来源。

---

## 实验 1：篡改区块里的交易金额

**目标**：理解「交易内容如何经由 `txid → merkleRoot → 区块 hash → PoW` 被层层锚定，最后由 ed25519 签名封死」——攻击者每补一层漏洞，就被更深一层拦下。

**攻击**：在一条诚实链上，把某区块里一笔 `bob → alice` 转账的金额从 `1` 偷偷改成 `999999`，并逐层「补漏」（重算 txid、补 merkleRoot、补区块 hash、甚至重新挖出合法 PoW）。

```bash
corepack pnpm tsx scripts/labs/01-tamper-amount.ts
```

**预期拒绝信息（实测输出）**：

```
诚实链合法？ true（bob→alice 这笔在区块 #3）

攻击者想把这笔转账金额从 1 偷偷改成 999999，逐层“补漏”：

  [1] 只改 amount        → #3 交易签名无效或手续费过低
  [2] 再重算 txid        → #3 merkleRoot 不匹配
  [3] 再补 merkleRoot    → #3 区块 hash 被篡改
  [4] 再补区块 hash      → #3 未满足 PoW 难度
  [5] 甚至重新挖出合法PoW → #3 交易签名无效或手续费过低

根因：被篡改交易的签名仍是对“旧 txid”签的，verifyTransaction = false
```

**为什么**：金额被一条**承诺链**牢牢钉住，攻击者每修一层都会触发下一层：

1. **改金额** → 交易的 `txid` 是对 `[from,to,amount,fee,nonce,timestamp,memo,(burn)]` 的 SHA-256（`transaction.ts` 的 `payloadHash`），`payloadHash(t) !== t.txid` → `verifyTransaction` 直接判假。
2. **重算 txid** → 区块的 `merkleRoot` 承诺的是**旧 txid 集**（`crypto.ts` 的 `merkleRoot`），校验 `b.merkleRoot !== merkleRoot(交易txid)` 不符。
3. **补 merkleRoot** → 区块 `hash` 覆盖了 `merkleRoot`（`block.ts` 的 `calcBlockHash`），`calcBlockHash(b) !== b.hash`。
4. **补区块 hash** → 新 hash 几乎不可能恰好有 16 个前导 0 比特 → `meetsDifficulty` 不过，等于要**重新做 PoW**。
5. **重新挖矿**（难度 16，本地秒级）→ 终于过了 PoW……但**签名**是对**旧 txid** 签的，`verify(签名, 新txid, bob公钥)` 失败。攻击者**没有 bob 的私钥**，到这里彻底走不下去。

> **教学点**：这就是「区块 hash 承诺交易」的真正含义——不是「区块里写了交易」，而是**交易内容经由 txid 被 PoW 真正锚定**。改金额/改收款方都会被识破，且最终的不可伪造性来自**私钥签名**，不是哈希本身。
> **源码**：`packages/core/src/blockchain.ts` `validateChain()`（merkleRoot/难度/区块hash/PoW/签名 五道）、`transaction.ts` `verifyTransaction()` + `payloadHash()`、`block.ts` `calcBlockHash()`。

---

## 实验 2：压低难度、靠长度凑数的 fork

**目标**：理解为什么选链规则是「**最大累计工作量**」而非「最长链」——长度可以廉价伪造，工作量不能。

**攻击**：造一条「廉价长 fork」——把难度压到 `1`，狂塞 30 个空块凑长度，喂给诚实节点想让它 reorg 过去。

```bash
corepack pnpm tsx scripts/labs/02-cheap-long-fork.ts
```

**预期拒绝信息（实测输出）**：

```
  诚实链   长度 5 块、难度 16  → chainWork = 327680
  廉价fork 长度 31 块、难度 1   → chainWork = 65596

  把廉价长 fork 喂给诚实节点：replaced = false（false = 拒绝，不采纳）
  诚实节点链高仍是 4 —— 长 fork 工作量更小，被无声拒绝（不是报错，是“你不够格”）。

  对比：2 个难度20的块 chainWork=2097152 > 20 个难度8的块 chainWork=5120
```

> ⚠️ **注意「拒绝」的形态**：这里**不是抛错误字符串**，而是 `replaceChain` 返回 `replaced: false`——「你的链工作量不够大，我不采纳」。共识层很多「拒绝」是这种**静默不采纳**，而不是报错。

**为什么**：`chainWork = Σ 2^difficulty`（`blockchain.ts` 的 `chainWork`，用 BigInt 因为难度可达数百 bit）。`replaceChain` 只在 `chainWork(incoming) > chainWork(本链)` 时才替换。一条难度 1 的块只贡献 `2^1 = 2` 工作量，塞 30 个也才 60，远小于 4 个难度 16 真块的 `4×2^16`。**「凑长度」是免费的，「凑工作量」要真算哈希**——这正是中本聪选 longest-**work** chain（而非 longest chain）的原因。

> **源码**：`packages/core/src/blockchain.ts` `chainWork()`、`replaceChain()`（工作量门）。

---

## 实验 3：把时间戳设到远未来想压难度

**目标**：理解「最大工作量规则单独**挡不住**压难度双花」，以及补上它的关键防线——**未来时间戳上限**。

**攻击**：自适应难度按「过去窗口实际耗时」重定向——出块越慢、难度降越多。攻击者想把区块时间戳**调到远未来**，伪装成「出块很慢」，把难度压到地板，从而廉价地造块。

```bash
corepack pnpm tsx scripts/labs/03-future-timestamp.ts
```

**预期拒绝信息（实测输出）**：

```
本地时钟容忍上限 MAX_FUTURE_DRIFT_MS = 120000ms（120s）

  (A) 整链校验一条“链顶时间戳来自未来”的链：#4 时间戳来自未来

  fork 工作量 1074069504 > 诚实链 327680（越过了“最大工作量”门）
  (B) replaceChain：replaced = false，error = #5 时间戳来自未来
```

**为什么**：

- **(A)** 校验时拒绝 `timestamp > now + MAX_FUTURE_DRIFT_MS`（默认 2 分钟，`config.ts`）。这是**唯一一处与本地时钟相关**的上下文校验。2 分钟远松于真实 NTP 偏差（不误杀诚实块），又远紧于攻击所需的「小时级」伪造。
- **(B)** 是**真实攻击形态**：一条「更长 + 累计工作量**更大**」但含未来时间戳的 fork。它的工作量门是过得去的（继承了诚实链高难前缀、又多压一个高难块）——**光靠最大工作量规则拦不住它**。真正挡下它的是未来时间戳上限：时间戳校验**先于** PoW 校验，攻击者连伪造合法 PoW 都来不及，就被「来自未来」拒了。窗口拉不长 → 难度压不下去 → 廉价块造不出来。

> **教学点**：两道防线**合力**把「压难度双花」**收敛**为「真·≥51% 算力攻击」——后者是**任何** PoW 链都无法靠选链规则防住的固有上限（低算力链尤其脆弱，见 [摩擦点](#摩擦点--教学点)）。
> **源码**：`packages/core/src/blockchain.ts` `validateChain()`（未来时间戳判定）+ `expectedDifficulty()`（重定向数学）、`config.ts` `MAX_FUTURE_DRIFT_MS`。

---

## 实验 4：双花 / 超额 / 乱序 nonce

**目标**：理解「每个发送方有自增 `nonce`（防重放）+ 余额校验（防双花/超额）」，且这两层在 **mempool**（第一道礼貌拦截）和 **整链校验**（最终权威）**各拦一遍**。

**攻击**：四连击——超额转账、跳号 nonce、重放已花交易、最后**绕过 mempool** 自己挖块把重复交易硬塞进链。

```bash
corepack pnpm tsx scripts/labs/04-double-spend-nonce.ts
```

**预期拒绝信息（实测输出）**：

```
—— mempool 层（交易广播即被拦，给出明确报错）——
  (1) 超额转账        → 余额不足：可用 2，需要 1000000（含手续费 1）
  (2) 乱序/跳号 nonce → nonce 错误：期望 0，收到 5
  (3) 重放已花交易    → nonce 错误：期望 1，收到 0

—— 整链校验层（攻击者绕过 mempool，手工把重复交易塞进新区块）——
  (4) 重复交易塞进链   → #4 nonce 错误（0x6a6c40ff… 期望 1）
```

> `0x6a6c40ff…` 是 bob 地址前缀，**每次跑都不同**（随机钱包）；三条 `nonce 错误：…` / `#4 nonce 错误（…）` 的判定逻辑稳定。

**为什么**：

- **超额/双花**：交易实付 = `金额 + 手续费 + 销毁额`，mempool 与整链都断言 `实付 ≤ 余额`（整链层报 `余额不足（双花/超额…）`）。**浮点会撕裂共识**，故金额强制非负整数。
- **nonce**：每个地址的 nonce = 它已上链的交易数，下一笔必须**严格等于**期望值。这让同一笔签名交易**无法被重复广播扣款**（防重放），也强制同一发送方的交易**按序**结算。
- **(4) 是关键认知**：mempool 拒绝只是「客气」（省带宽、早报错）。就算攻击者**自己挖一个块**把已花交易再塞一次、绕过 mempool，**整链校验从创世重放 nonce**，到那个块时 bob 的 nonce 已是 1，重复交易的 nonce 0 ≠ 期望 1 → 照样识破。**共识的唯一权威是整链校验，不是 mempool**。

> **源码**：`packages/core/src/blockchain.ts` `addTransaction()`（mempool 的 nonce/余额校验）、`validateChain()`（整链的 nonce/余额校验）。

---

## 实验 5：改坏 chain.json 一个字节

**目标**：理解「**坏文件不静默清空**」这条容灾纪律——否则入侵者 / 共享主机同用户 / 磁盘位翻转，**改一个字节**就能让节点重启即丢光本地链（退回创世、只剩央行 1000 起步），且无从恢复。

**攻击**：把落盘的 `chain.json` 里**链顶区块 hash 的一个十六进制位**翻掉（仅 1 字节；JSON 仍能解析，但整链校验会因 hash 不符而失败），然后重新加载。

```bash
corepack pnpm tsx scripts/labs/05-corrupt-chainjson.ts
```

**预期拒绝信息（实测输出）**：

```
落盘一条合法链：高度 3（4 个区块）→ .data/labs/lab5/chain.json
把链顶区块 hash 的 1 个十六进制位 '1' 翻成 '0'（仅 1 字节）。

重新加载 loadChain(dir)：
⚠️  chain.json 无法加载（chain.json 未通过整链校验），已备份到 .data/labs/lab5/chain.json.corrupt-1782054281847；将从创世重建并联网同步。

加载结果：高度 = 0（回退到创世，等联网再同步回来，绝不静默丢账）
坏文件已改名备份（未静默删除）：chain.json.corrupt-1782054281847
```

> `corrupt-<…>` 后缀是落盘那一刻的 epoch 毫秒，**每次跑都不同**；翻转的具体字符随链而异——但「校验不过 → 备份坏文件 → 回退创世」的行为不变。

**为什么**：`loadChain` 加载时**强制跑一遍 `validateChain`**；解析失败或校验不过，就**先把坏文件改名备份**（`chain.json.corrupt-<时间戳>`）再从创世重建，**绝不静默丢弃**。备份让你能事后取证（「谁动了我的链」），从创世重建则让节点一联网就把规范链同步回来。配套的还有**原子写**（`saveChain` 先写 `.tmp` 再 `rename`），避免崩溃中途截断文件。

> **教学点**：区块链的「不可篡改」是**共识层**的性质；**本地落盘文件**仍是普通文件，需要单独的**完整性兜底**。两者别混为一谈。
> **源码**：`packages/core/src/storage.ts` `loadChain()` / `saveChain()`。

---

## 实验 6：越过 checkpoint 的深度 reorg

**目标**：理解 checkpoint 如何**冻结已确认历史**，把低算力 PoW 链对「深度 reorg / ≥51%」的脆弱性**抬高门槛**。

**攻击**：凑一条「累计工作量**更大**、但回滚到 checkpoint **之前**」的 fork（伪造一个超高难度块越过最大工作量门），想改写已被冻结的旧账。

```bash
corepack pnpm tsx scripts/labs/06-checkpoint-reorg.ts
```

> ⚠️ 出厂 `config.ts` 的 `CHECKPOINTS` 在高度 **100/200/300**（绑定公网种子规范链）。本地秒级复现不到那么高，所以脚本临时往**内存里的** `CHECKPOINTS` 注入一个 `#2` demo 检查点（**只影响本进程，不改 `config.ts`**）；真实部署里换成 100/200/300，逻辑完全一样。

**预期拒绝信息（实测输出）**：

```
注入 demo 检查点 #2 = 0000b4a430a5d23d4b1f1d19…（真实部署是 #100/#200/#300）

  (A) 校验“#2 hash 不符”的另一条链：#2 与 checkpoint 不一致

  深 fork 长度 2（回滚到 #2 之前），工作量 1152921504606912512 > 规范链 262144
  (B) replaceChain：replaced = false，error = 拒绝越过 checkpoint #2 的 reorg
```

> `#2 = 0000b4a4…` 是本次**新挖出**的区块 hash，**每次跑都不同**（随机 nonce/钱包）；两条拒绝信息 `#2 与 checkpoint 不一致` / `拒绝越过 checkpoint #2 的 reorg` 是稳定的。

**为什么**：checkpoint 是硬编码的 `{高度, 该高度区块 hash}`，提供**两道**防线：

- **(A) 整链校验冻结**：`validateChain` 一开始就调 `violatesCheckpoint`——链在 checkpoint 高度的区块 hash **必须吻合**，否则**整链判非法**（早于 PoW/交易校验返回 `#N 与 checkpoint 不一致`）。
- **(B) reorg 深度防线**：`replaceChain` 拒绝任何「本链已越过某 checkpoint，而 incoming 却短到回滚它」的替换——**即便 incoming 工作量更大**（注意脚本里 fork 工作量确实更大，照样被拒）。

把已确认历史**钉死**：攻击者就算真凑出更大累计工作量，也改不动 checkpoint 之前的旧账。这是低算力 PoW 链对抗深度 reorg / ≥51% 的**标准缓冲**（同 Bitcoin Core 早期）。

> **代价**（见下一节）：checkpoint 是一个需要**全网一致、手动更新**的**中心化信任根**——它用「一点中心化」换「冻结历史」，是 PoW 链的工程取舍，不是纯粹去中心化。
> **源码**：`packages/core/src/blockchain.ts` `violatesCheckpoint()` / `validateChain()`（冻结）/ `replaceChain()`（深度防线）、`config.ts` `CHECKPOINTS`。

---

## 摩擦点 = 教学点

几个**有意为之的简化**——真链会做得更复杂，但把它们摊开正好是好教学素材。做实验时请把这些当「这条链诚实标注的已知边界」，而不是 bug：

- **🧧 红包拼手气的随机源有矿工 grinding 空间。** 份额由 `redSeed = sha256(区块hash + claim的txid)` 决定（`redpacket.ts`）。**打包该 claim 的矿工**能通过调整区块内容（如换 coinbase 地址 / 改 nonce）反复尝试，**部分操纵**自己抢到的份额——这叫 **grinding**。真链会用 **VRF / RANDAO / commit-reveal** 把「定随机数」和「看随机数」在时间上分开，杜绝出块者预知。本链选了最简实现，把这道缝隙**明确标注**出来。
- **低算力 PoW 的 51% 脆弱。** 实验 2、3 把「压难度双花」收敛成了「真·≥51% 算力攻击」，但**没有**消灭它——任何 PoW 链在算力不足时都防不住 51%。本链算力很低，**实验/玩具用途，别上真钱**。checkpoint（实验 6）正是对这条脆弱性的缓冲，但也只是缓冲。
- **checkpoint 是手动维护的中心化信任根。** 它要**所有节点硬编码一致**、由运营者**手动**用 `v0id checkpoint <height>` 取新高度追加并一起重启。填错会让本地链无法通过校验。这是「用一点中心化换历史冻结」的**显式取舍**，与「纯去中心化」的理想相悖——但和 Bitcoin Core 早期一致。
- **昵称 / 集市先到先得是「解析约定」而非共识。** 「谁拥有 @alice」「这条 BUY 是否成交」由**客户端扫链解析**得出，节点**不强制**。两台客户端若解析规则不同，可能看到不同的「拥有者」——底层转账强约束、上层含义靠社会共识（见[上文](#共识强约束-vs-memo社会共识先分清两层)）。
- **其它诚实标注的低危残留**（详见 [README](README.md#设计说明--已知边界玩具链别上真钱)）：P2P `HELLO` 的 `address` 字段无签名（节点身份可冒充，仅影响 peer 列表展示/去重，**盗不了币**——花钱仍需 ed25519 签名）；本机 API 的 `0600` 文件令牌只挡**别的用户**、挡不住**你自己身份**的恶意进程；无 TLS / 无 Sybil 抗性。

---

## 进阶：完整回归测试

上面 6 个实验是「单点攻防教学」。仓库里还有两套**完整回归测试**，覆盖更全的攻击向量与端到端联机，值得作为「这些防御平时怎么被持续验证」的范例阅读：

```bash
corepack pnpm smoke    # 单进程：挖矿/转账/防重放/篡改检测/最大工作量/未来时间戳/checkpoint/gas/集市/消息/加密/昵称/红包
corepack pnpm tsx scripts/integration.ts   # 多节点真 WebSocket：区块广播、迟到节点追链、畸形消息轰炸、CORS/token、chain.json 容灾
```

- [`scripts/smoke.ts`](../scripts/smoke.ts) —— 本手册多数攻击的「内联断言」原型都在这里（如「篡改区块应使整链校验失败」「最大工作量规则」「未来时间戳上限」「checkpoint」）。
- [`scripts/integration.ts`](../scripts/integration.ts) —— 实验 5 的「chain.json 损坏不静默清空」也在这里有端到端验证，另含畸形 P2P 消息健壮性、私网/SSRF 过滤等。

延伸阅读：[README「设计说明 & 已知边界」](README.md#设计说明--已知边界玩具链别上真钱)、[docs/RUNNING-A-NODE.md](RUNNING-A-NODE.md)、[TUTORIAL.md](TUTORIAL.md)。
