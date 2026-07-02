# v0idChain 中继激励协议（INCENTIVE-PROTOCOL）

> 配套 [HS-PROTOCOL.md](./HS-PROTOCOL.md)。本文档讲**为什么有人愿意跑中继**——质押抗女巫、可信测量、国库奖励、掉线罚没——以及它**诚实地不防什么**、迭代去哪。所有共识改动遵循软分叉纪律（§2.4）。
>
> 实现：共识 = PR #13（`packages/core`）；链下工具 = PR #17（`measurer.ts` + CLI）。

## §0 定位与威胁模型

匿名网络的强度 = 诚实中继数 × 活跃用户数。**激励机制的唯一目的是把「诚实中继数」做上去（冷启动），同时不被女巫薅垮。它不是匿名性本身。**

**v1 激励防：**
- **冷启动**（没人跑中继）→ 质押 +（未来）奖励给一个理由。
- **女巫薅羊毛**（一人刷大量假节点）→ 质押门槛 + 奖励绑定不可伪造的在线度量。
- **失职中继**（收激励却长期掉线）→ 掉线罚没。

**v1 明确不防（诚实声明，须在客户端显眼处保留）：**
- **可信测量方是中心化的**：v1 由单一可信「度量者」（运营者/种子）裁决谁在线、发多少、罚不罚。**不是信任最小化的**。去中心化测量是迭代终局（§8）。
- **不测带宽**：v1 仅测活性/可达。自报带宽必被刷；抽样带宽易被针对探针优待、抗女巫价值有限。
- **奖励池有限**：v1 奖励来自有限国库预挖（~1000 $V0ID），是**引导池**而非永续。可持续闭环靠客户端概率支付（§8）。
- 不防应用层去匿名、端点攻陷、资金图谱自我去匿名（同 HS-PROTOCOL §0）。

## §1 设计目标与文献对齐

冷启动 → 抗女巫 → 激励质量非数量 → 角色风险差异 → 可持续闭环。与既有研究对齐（§11 署名）：
- **Tor**：guard + 目录权威 + bandwidth authority（bwauth）测量。v1 的「可信测量方」= 极简诚实版 bwauth。
- **Nym / Loopix**：mixmining（按可验证工作发币）+ 质押 + Sphinx。
- **Orchid / HOPR**：概率纳米支付（客户端按流量签彩票、中继兑中奖票上链）——v1 的迭代终局。

## §2 质押托管（STAKE / UNSTAKE / SLASH）

完全镜像已上线的红包托管状态机：共识权威在 `applyTx`，`computeState` 与 `validateChain` **共用** → 杜绝分叉。

### §2.1 三种操作
- **STAKE** `STAKE|<role>`：转 ≥ `STAKE_MIN[role]` 给 `STAKE_ESCROW_ADDRESS`（`0x…2`）。共识开一个以该交易 txid 为 id 的质押池，锁本金至 `height + STAKE_LOCK_BLOCKS`。`role ∈ {guard, middle, hsdir}`（v1 无 exit，见 §8）。
- **UNSTAKE** `UNSTAKE|<stakeId>`（amount=0）：仅质押人、过锁定期后取回 `本金 − 已罚没`，一次。
- **SLASH** `SLASH|<stakeId>|<金额>|<epoch>`（amount=0）：**仅 `MEASURER_ADDRESS`** 签发；扣减 `min(金额, 剩余本金)`，移交国库。

### §2.2 角色分层押金
押金高低 = 去匿名风险（守卫看客户端 IP、风险最高）：`STAKE_MIN = { guard:12, hsdir:8, middle:4 }`（小网络起步值，可上调）。

### §2.3 目录质押门控
中继描述符 `RELAY|…|<stakeTxid>` 引用其质押交易。`parseRelaysFiltered(chain, requireStake)`：`true` 时只把「有有效质押（自己的、未赎回、未罚殆尽）」的中继纳入选路。**默认 `false`（软分叉，老节点照收无质押中继，当前网络零行为变化）。**

### §2.4 软分叉 + 激活高度（关键）
- STAKE = 向托管地址的普通转账，旧节点同样锁币、余额效果一致 → 不静默分叉；UNSTAKE/SLASH 是 amount=0 新边界，旧节点直接拒（同红包 CLAIM/REFUND 边界）。
- **`STAKING_ACTIVATION_HEIGHT = 16000`**：该高度前，`STAKE|`/`UNSTAKE|`/`SLASH|` 备注与 `0x…2` 托管地址一律按历史普通交易处理——防止升级节点重放老链时把历史普通 memo/转账 **retroactive** 误判成质押操作。选 16000：晚于公网种子约 #13711 + `POW_V2_HEIGHT=15000`，给升级留窗口。

## §3 可信测量方（Measurer）

一个**中心化、诚实**的链下守护：单进程、单签名密钥，其判断即权威。它不改链，只产出可供奖励/罚没消费的证明。

### §3.1 测量 = 仅活性/可达
每 epoch（`EPOCH_BLOCKS` 块）对每中继探测 K 次：**穿过该中继建一条短测试电路 + 一次 DATA 往返校验回显** → 证明它「真的在转发 cell」（完成 ntor + 转发 EXTEND/CREATE + 双向转发 DATA），而非只 TCP 接受。`uptime = 成功/K`，`online = uptime>0`。**不测带宽。**

### §3.2 探测拓扑（部署前提，须如实写明）
把 target 放第 1 跳、prober 自控的 **sink 作出口**（生产中继默认 deny-all 无 exitHandler，直接探 target 会被静默丢 DATA → 误判掉线）。因 EXTEND 由转发方中继用自己的目录解析下一跳，**度量者须把其 sink 作为一个上链中继发布**，使被探中继能拨到它。这是中心化度量者的固有部署前提。

### §3.3 度量证明（attestation）
`{epoch, relayId, uptime}` 由度量者 ed25519 私钥对**规范化 payload**（uptime 定点 6 位小数、不含本地时钟）签名 → 任何人可用 `MEASURER_ADDRESS` 公钥验签。

### §3.4 密钥纪律
`MEASURER_ADDRESS` 是固定常量，**其私钥不进仓库**（同国库 `GENESIS_PREMINE_ADDRESS` 纪律）。度量者从钱包文件加载签名密钥；只有加载到的钱包 `.address === MEASURER_ADDRESS`，链才接受其 SLASH。**部署前必须 rotate 到运营者本机生成的新地址。**

## §4 奖励（国库出资 · 默认只预览）

### §4.1 公式
`weight_i = uptime_i × ROLE_REWARD_MULT[role_i] × bootstrapBonus(height)`；
`amount_i = floor(REWARD_EPOCH_POOL × weight_i / Σ weights)`。`floor` 保证 `Σ amount ≤ REWARD_EPOCH_POOL`（**绝不超发**，余数留国库）。只有「有有效质押 + 本 epoch online + uptime>0」参与。`bootstrapBonus`：前 `BOOTSTRAP_BONUS_UNTIL_HEIGHT` 为 `BOOTSTRAP_BONUS_MULT`，之后 1（它是公因子，归一化后不改相对份额，仅文档意图）。

### §4.2 发放 = 普通国库转账（不改共识 · 任何高度可用）
`v0id reward-epoch` 吃 attestation + 链上质押算分配。**默认只打印预览表、不发任何币**；`--send`（响亮警告）才从国库（`GENESIS_PREMINE_ADDRESS`，私钥运营者持有）发 `REWARD|<epoch>` 转账。

### §4.3 v1 取向：建好但先不发
国库预挖有限（~1000）。v1 把测量 + 奖励计算 + 罚没工具建好测好，**暂不实际发奖、不烧国库**——质押门控（必须质押才被选路）本身已是女巫成本。等激活 + 外部运营者来了再开发放；可持续闭环靠 §8 客户端付费 —— 现由**央行电子现金铸币厂**（[MINT-PROTOCOL.md](./v0idnet/MINT-PROTOCOL.md)）落地：用户为真实服务（网站/中继/交易）付费，铸币厂兑现时**抽成回流国库** → 国库被真实用量自动回填 → 发奖不再只烧有限引导池。

## §5 罚没（只罚掉线 · 保守）

`v0id slash-epoch`：按连续掉线历史，对 `consecutiveOffline ≥ SLASH_AFTER_EPOCHS`（默认 3）的质押罚 `floor(SLASH_FRACTION × 剩余本金)`（默认 10%）。**默认只预览**；`--send` 才从度量者钱包成形并提交 SLASH（链高 <16000 时警告会被共识拒）。链侧另有「至多剩余本金」封顶。只罚掉线（客观、measurer 可证）；可证作恶 = 迭代（§8）。

## §6 参数表

| 常量 | 值 | 含义 |
|---|---|---|
| `STAKING_ACTIVATION_HEIGHT` | 16000 | 质押共识激活高度 |
| `STAKE_ESCROW_ADDRESS` | `0x…2` | 质押托管地址 |
| `STAKE_MIN` | guard 12 / hsdir 8 / middle 4 | 角色最低押金 |
| `STAKE_LOCK_BLOCKS` | 12 | 赎回锁定期 |
| `ROLE_REWARD_MULT` | guard 3 / hsdir 2 / middle 1 | 角色奖励倍率 |
| `EPOCH_BLOCKS` | 10 | 奖励/测量 epoch 长度 |
| `REWARD_EPOCH_POOL` | 5 | 每 epoch 奖励池（$V0ID） |
| `BOOTSTRAP_BONUS_UNTIL_HEIGHT` / `_MULT` | 50000 / 2× | 引导期加倍窗口 |
| `SLASH_AFTER_EPOCHS` | 3 | 连续掉线罚没阈值 |
| `SLASH_FRACTION` | 0.1 | 单次罚没比例 |
| `MEASURER_ADDRESS` | `0x7f2d…` | 度量者地址（私钥离线） |

（均为小网络起步值、可调；改共识常量须全网一致。）

## §7 诚实边界（须在客户端首屏/文档显眼处保留）

1. **中心化测量方**：v1 信任单一度量者；非信任最小化。
2. **有限国库**：奖励是引导池，非永续。
3. **不测带宽**：仅活性。
4. **女巫上限**：质押抬高成本，但「奖励 > 质押机会成本 + 工作可伪造」时仍可被薅 → 故 v1 绑定不可伪造的在线度量、且先不发奖。
5. **部署门槛**：① rotate `MEASURER_ADDRESS`；② 度量者 sink 作上链中继发布；③ 质押 height 16000 才激活。
6. **匿名集小 = 弱匿名**（与密码学无关）。

## §8 迭代路线

1. **客户端付费闭环（央行电子现金铸币厂）**：见 [MINT-PROTOCOL.md](./v0idnet/MINT-PROTOCOL.md)。**离散付款**（网站/买东西/打赏）= 盲签代金券；**连续计量**（中继按流量）= 支付通道 / 概率彩票（Orchid：签票、兑中奖票上链）。两者都在央行结算、用量抽成回流养中继 = 真经济闭环；盲签（Phase B）→ 密码学抗女巫 + 无需中心测量方（去中心化测量终局）。
2. **电路贡献 + 性能评分**：按转发流量/电路数 + 延迟/丢包/在线史/反馈打分。
3. **Exit 节点**：加 exit 角色 + 最高倍率 + 法律风险告知 + 出口策略。
4. **可证作恶 slashing**：丢弃电路 / 虚报带宽 / spam 欺诈证明。
5. **去中心化测量**：单测量方 → 多测量方中位数 / 全客户端付费。
6. **早期中继 NFT / 徽章**：早期参与者徽章 + 后期更高权重。

## §9 验证

- `scripts/staking-selftest.ts`：质押状态机（开池/锁定/赎回/罚没）+ 分叉安全（`computeState ≡ validateChain ≡ replaceChain`）+ 软分叉激活门控 + 门控过滤。
- `scripts/measurer-test.ts`：杀一个中继 → 标记离线、其余在线；attestation 签验 + 篡改拒。
- `scripts/reward-epoch-test.ts`：奖励 ∝ uptime × 倍率、池上限、引导加成、预览不发币。
- `scripts/slash-decide-test.ts`：阈值/比例/边界 + SLASH 成形 + 非度量者被拒。
- 多轮对抗 agent review：质押 8 向量全 HOLDS（罚没伪造 / 超额赎回 / 供给守恒 / 分叉 / 软分叉超集 / 选包一致 / 门控绕过 / 解析健壮性）。

## §10 实现位置

- **共识**：`packages/core/src/{config,staking,blockchain,relays,messages,transaction}.ts`（PR #13）。
- **链下工具**：`packages/node/src/relay/measurer.ts` + CLI `measure` / `reward-epoch` / `slash-epoch`（PR #17）。
- **节点助手**：`node.stake / unstake / stakes`。

## §11 先行者与署名

- **Tor**（guard / 目录权威 / bandwidth authority）— BSD-3-Clause。
- **Nym / Loopix**（mixmining / 质押 / Sphinx）。
- **Orchid / HOPR**（概率纳米支付）。

本激励机制为重新实现，思想借鉴上述、无代码拷贝；具体密码学复用 `@noble/*`（见仓库 attribution 文档）。
