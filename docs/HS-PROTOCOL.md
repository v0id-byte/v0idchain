# HS-PROTOCOL — .v0id 匿名隐藏服务网络协议规范

**状态**：Phase 1（洋葱路由传输层）+ Phase 2（双向 rendezvous 隐藏服务）+ Phase 2A（entry guards + 中继 DoS 加固 + 描述符 anti-rollback，见 §19）已实现并验证。概率支付、Mixnet 模式为后续阶段。
**与 Tor 不互通**：本网络借用 Tor 的成熟设计（ntor / 定长 cell / telescoping），但用本链自己的 PROTOID、原生 x25519 与链上目录，是独立网络。
**设计与批判背景**见 `~/.claude/plans/tor-v0idchain-purring-pixel.md`。

---

## 0. 威胁模型（先读）

- **保护对象**：客户端（读者）与服务端（发布者）的网络身份（IP），对**彼此**和对**中继**都隐藏。
- **Phase 1（洋葱）对抗**：运行部分中继的主动对手；单端本地网络观察者（ISP）；能完整读取公开链者。
- **Phase 1 明确不防**：全局被动对手的端到端**流量/时序关联**（Tor 亦不防——低延迟洋葱的根本局限，由后续 Mixnet 模式缓解）。
- **始终不防（应用层）**：浏览器指纹 / JS / 内容回连；端点被攻陷；$V0ID 资金图谱自我去匿名。
- **匿名集诚实声明**：匿名性上限 = 诚实中继数 × 活跃用户数。**网络小 = 匿名弱**，与密码学无关。

---

## 1. 区块链分工

| 职责 | 位置 |
|---|---|
| 中继目录（替代 Tor 目录权威） | **链上** `RELAY\|` memo 约定（§5） |
| 服务描述符 / intro points | **链下 DHT**（中继即 HSDir，盲化索引；Phase 2，§13–14） |
| 电路 / rendezvous / 内容 | **链下**（cell 平面，本规范 §3–4） |
| staking·slashing·支付·可选命名 | **链上**（Phase 3+） |

cell 平面与共识 P2P **完全隔离**：独立端口、独立 WebSocketServer、匿名连接（不交换身份），绝不混入 gossip/HELLO。

---

## 2. 身份与密钥

- **中继身份 ID** = 其 ed25519 钱包地址（`0x` + 64 hex）。ntor 里作 `relayId` 绑进握手转录。
- **中继 onion 静态密钥** = **独立** x25519 密钥对（**不**复用钱包私钥转 Montgomery——否则钱包私钥泄漏即追溯破解所有历史电路）。公钥 `B` 作 `okey` 写进 `RELAY\|` 描述符；私钥 0600 持久化。
- 实现：`packages/core/src/onion.ts` `generateOnionKeypair` / `onionKeypairFromSecret`。

---

## 3. ntor 握手（每跳密钥协商）

单向认证：客户端验证中继握有 `B`；客户端保持匿名（不签名）。给出前向保密 + 中继认证 + 转录绑定。

```
PROTOID  = "ntor-v0idchain-x25519-sha256-1"
H(m, t)  = HMAC-SHA256(key=t, msg=m)
t_key    = PROTOID|":key_extract"   t_verify = PROTOID|":verify"
t_mac    = PROTOID|":mac"           m_expand = PROTOID|":key_expand"

客户端: 临时密钥 (x, X=x·G) → 发 CREATE{X}
中继(静态 b,B; ID): 临时 (y, Y); 收 X →
  secret_input = EXP(X,y) ‖ EXP(X,b) ‖ ID ‖ B ‖ X ‖ Y ‖ PROTOID
  KEY_SEED = H(secret_input, t_key);  verify = H(secret_input, t_verify)
  AUTH     = H(verify ‖ ID ‖ B ‖ Y ‖ X ‖ PROTOID ‖ "Server", t_mac)
  → 发 CREATED{Y, AUTH}
客户端: EXP(Y,x)‖EXP(B,x) → 同 secret_input → 重算 AUTH，**恒定时间比对**，不符即中止换中继。
密钥派生: HKDF-Expand(SHA256, PRK=KEY_SEED, info=m_expand, 128B) →
  encForward(32) ‖ encBackward(32) ‖ macForward(32) ‖ macBackward(32)
```

**金标准向量**（`scripts/onion-selftest.ts`，固定输入）：

```
relayId    = d63300cb79b682979a5c62bad419a2a1147da9be4111736d52c636523a20cefb
onionSec b = 3333..(×32)        onionPub B = 7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14
clientEphX = 7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13   (x = 1111..×32)
serverEphY = 0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20   (y = 2222..×32)
AUTH       = c3beb1a821396cdaf2dfee2a7f52ca505b1280b1c69905f5b208de65cd38656c
encForward = c539217920fb7679a6c007eb41f257f6d52332cd7a912a623a7193f8c056fa27
encBackward= 94b80d92c92191fe90c5301e951513f9f4230548e9763515a4174e4d54520480
macForward = 47b7bac7d52e0807cf17e9c75480991cbd81533602a7f0fa35d758d07957680b
macBackward= ac766d9b342a639b19aeabb75b1451b9b7e00c1aa11a80cc575ffc0ca50071cb
```

---

## 4. 定长 Cell

### 4.1 为什么定长 + 流加密 + 端到端 MAC
两条硬约束：**①定长 512B**（Mixnet 无法 mix 变长包 → 改尺寸=硬 wire break）；**②真实工具级完整性**。
AEAD 逐层会随剥层缩短→泄露跳位，违反①。故用 **XChaCha20 裸流逐层套/剥（不扩长）+ 端到端 HMAC**（Tor 的做法）。

### 4.2 Body 布局（恒 512 字节，`packages/core/src/onioncell.ts`）
```
recognized(8) ‖ cmd(1) ‖ len(2) ‖ data(485, 补零) ‖ MAC(16)
```
- `recognized` = 8 个 0 → 本跳是该 cell 的终点。
- `MAC` = HMAC-SHA256(目标跳方向 mac 密钥, recognized‖cmd‖len‖data) 截断 16B。
- `cmd`：`1=DATA`（到/来自出口）、`2=EXTEND`（data=nextHopId(32)‖clientEphX(32)）、`3=EXTENDED`（data=Y(32)‖AUTH(32)）。
- **终点识别**：中继剥本跳一层后，若 recognized==0 且 MAC 通过 → 认领（按 cmd 处理）；否则（深层密文几乎必非 0）→ 转发下一跳。
- **nonce**：24B，把计数器写末尾。同一 cell 全程同一 nonce，流加密层才可组合。前向 nonce 计数器由客户端单调递增；后向由发起跳的随机 base 命名空间化（§4.4）。

### 4.3 线缆消息（`packages/node/src/relay/cells.ts`）
仅 4 种：`CREATE{c,x}` / `CREATED{c,y,a}` / `RELAY{c,d,n,b[,dl,cv]}` / `DESTROY{c,r?}`。
`RELAY.b` 恒 1024 hex（512 字节）。`dl`(delayMs) 与 `cv`(cover) 为 **v2 Mixnet 预留**，v1 恒缺省。
EXTEND/EXTENDED **不是线缆消息**——是加密 RELAY body 内命令（否则拓扑泄露）。

### 4.4 金标准向量（`scripts/onioncell-selftest.ts`）
3 跳密钥 = `fill(0x10/0x40/0x70)` 的 enc/mac×双向；`wrapForward(t=2, CMD_DATA, "golden", ctr=1)` 的 512B body：
```
sha256(body) = 37292c4fdcbc96fe6f2238ffbedaaaec48126ce6ae9988161c2f3da42d7b1391
```

---

## 5. 链上中继目录（`RELAY|` 约定，`packages/core/src/relays.ts`）

发布 = **自转**（from==to）burn=0，memo：
```
RELAY|<okey:64hex x25519 onion 公钥>|<host:port>|<bw:1 char>|<stake:0|64hex txid>
```
- 身份 = `tx.from`（隐式）；签名 = tx 签名（共识已验，证明地址归属）。
- `parseRelays(chain)` 回放全链，**latest-wins**（每地址最后一条有效描述符胜出 → 可换 host/轮换 onion 公钥）。纯函数 → reorg 安全。
- 与 `NAME|` 一致，是 burn=0 自转 → `isMessageTx` 天然排除，**不进** `isProtocolMemo`、不进私信收件箱。
- `okey` 归属无需链上单独证明：谎报别人 okey 只造出**无法完成 ntor** 的中继（无对应私钥→客户端 AUTH 失败换中继），损人不利己。
- ≈193 字符，远低于 `MAX_MEMO=512`。

---

## 6. 电路构建（telescoping，Tor 式）

客户端按目录选 3 跳 `[G0 守卫, G1, G2 出口]`：

1. **第 1 跳（直接）**：连 G0 cell 端口 → `CREATE{c0, X0}` → `CREATED{c0, Y0, AUTH0}` → `ntorClientFinish` 得 keys0。
2. **延伸（经部分电路）**：客户端造 EXTEND（面向当前终点跳 t），data=`G1.id‖X1`，`wrapForward(keys[0..t], t, EXTEND, …)` → `RELAY{c0,f}`。
   - 终点跳收到（剥到 recognized==0）→ 解析 → 拨号下一跳、铸 nextCirc、发 `CREATE{nextCirc, X1}`。
   - 下一跳 `CREATED` → 该终点跳包成后向 `EXTENDED` 还给客户端 → `ntorClientFinish` 得 keys1。
   - 重复延伸到 G2。**中继永不知更深各跳密钥**：它只转发客户端与下一跳之间的握手。
3. **数据**：`wrapForward(keys, t=出口, DATA, payload)` → 出口剥到明文投递；回包走后向。

**防 SSRF/放大**：中继 EXTEND 只拨号**目录解析得到的已知中继**（`relaynode.ts handleExtend` 的 `resolve(nextId)`）。

---

## 7. 每跳所见（匿名性分析）

| | 客户端 IP | 出口/目标 | DATA 明文 | 全路径 |
|---|---|---|---|---|
| 守卫 G0 | ✅ 知（直连） | ❌ | ❌（盲转发） | ❌ |
| 中继 G1 | ❌（只见 G0） | ❌（只见 G2） | ❌ | ❌ |
| 出口 G2 | ❌（只见 G1） | ✅ | ✅ | ❌ |

没有任何单跳同时知道客户端 IP 与明文/目标。集成测试 `scripts/relay-integration.ts` 实测：3 跳往返正确，且 **exitHandler 只在出口触发，守卫/中继全程盲转发**。

---

## 8. 计数器 / 防重放

- **前向**：客户端单调 `fwdN`（首个 cell n=0），每前向 cell `n=fwdN++`；全程各跳用同一 `n`。中继 `maxFwdCtr` 初始 **-1**，按 `n > maxFwdCtr` 严格递增放行（首个 n=0 接受、之后 n=0 重放即丢——修复了早期 `maxFwdCtr!==0` 留下的 n=0 重放洞）。前向密钥不重用。
- **nonce 上限**：`nonceFromCounter` 用 JS 浮点，超 2^53 丢精度→nonce 重用。中继硬拒 `n > 2^48`（`MAX_CELL_CTR`）。
- **后向**：发起跳取随机 24-bit `base`，`n = base·2²⁰ + 本跳本地计数`（< 2^44）。不同发起跳 base 几乎不相撞 → 杜绝 `(encBackward_i, nonce)` 重用，且无需全局跳位（中继本就不知自己跳位）。
- **v1 限制（诚实声明）**：**后向**防重放为 best-effort（MAC 防伪造；重放只是把同样数据重投，客户端按自身电路态去重）。后向严格防重放窗口属 Phase 2。

---

## 9. Phase 1 已交付 vs 待办

**已交付（全部 selftest + 集成测试通过）**：ntor 握手、定长 cell 洋葱、链上中继目录、telescoping 多跳电路、独立 cell 平面、SSRF 防护、前向防重放（n=0 边界已修）、nonce 上限、粗粒度电路数上限（`MAX_CIRCUITS=2048`）、**TCP 流层（出口 CONNECT + 双向字节流 + 默认 deny-all 出口策略）**、**本地 SOCKS5 前端**、**接入 node 守护**（`v0id start --relay/--socks`：onion 密钥持久化、上链发布 `RELAY|` 描述符、`parseRelays` 选路、`GET /relays` 目录）。

**已可作真实网络加入**（客户端匿名代理，Tor-exit 式）：
```
v0id start --name r1 --p2p-port 6001 --relay --relay-port 6011 --mine     # 跑一个中继（自动上链发布描述符）
v0id start --name me --p2p-port 6002 --peers ws://… --socks --socks-port 9050   # 客户端：本地 SOCKS5
curl --socks5 127.0.0.1:9050 http://example.com/                          # 经 3 跳洋葱电路出网（需链上 ≥3 中继）
```
出口默认 **deny-all**；要作出口需显式 `--exit-allow host:port,…`。这是**客户端匿名出网**（Tor-exit 式）。**双向匿名的隐藏服务（.v0id）见 Phase 2（§12–18）——已交付**。

**已交付（Phase 2，详见 §12–18）**：**双向 rendezvous 隐藏服务**——自认证 `.v0id` 地址、ed25519 周期密钥盲化、加密描述符 + 盲签名、中继即 HSDir 的盲化 DHT、intro points + 会合点(RP) 拼接、端到端 ntor（服务认证、客户端匿名）、`v0id start --hs-target` 托管 + `--socks` 经 rendezvous 连 `.v0id`。

**Phase 2A 已交付（公网暴露前的门槛，见 §19）**：entry guards（钉住入口）、中继 DoS 加固（TTL/空闲清扫 + cell 限速 + EXTEND 超时 + 按连接/按源 IP 上限）、描述符 anti-rollback（签名 revision）、客户端后向严格防重放。

**待办**：
- **HSDir 发布速率限制**（PoW / stake 门槛；HSDir 看不到匿名发布者，按源限速对其不适用）。
- **Mixnet 模式**（每跳延迟 + cover traffic，抗流量关联）—— cell 已留 `delayMs`/`cover`，Phase 5。
- **概率支付 / staking·slashing**（$V0ID 激励，不按电路上链）—— Phase 3–4。

> **独立对抗式验证（2026-06-24）**：派 general-purpose agent 复跑全部测试 + 审查密码学。结论：claims (a)–(d)（ntor 前向保密/认证、定长流加密洋葱、(key,nonce) 不重用、跨跳不可关联）**HOLDS**；测试全过；3 跳不可关联性真实成立。修复其发现的 n=0 前向重放洞与 nonce 悬崖、补粗粒度电路上限。其余（DoS 细加固 / guards / 后向严格防重放 等）按上表纳入 Phase 2，均**已在本节诚实披露、非隐藏**。（agent 当时指出的“接入守护 / 客户端解复用健壮性”已在本轮补齐：守护接线 + 流阶段按 cmd 路由 + MAC 校验。）

---

## 10. 如何验证

```
corepack pnpm exec tsx scripts/onion-selftest.ts        # ntor 往返 + 认证负例 + 金标准向量
corepack pnpm exec tsx scripts/onioncell-selftest.ts    # 三跳剥层 + 定长 + 篡改拒收 + 向量
corepack pnpm exec tsx scripts/relays-selftest.ts        # 目录 latest-wins + 字段校验
corepack pnpm exec tsx scripts/relay-integration.ts      # 真实 3 中继 + 客户端 e2e + 匿名属性 + 前向防重放
corepack pnpm exec tsx scripts/relay-stream-test.ts      # TCP 流经电路（小/大分片 + 出口策略）
corepack pnpm exec tsx scripts/socks-demo-test.ts        # 真实 curl 经 SOCKS5 + 洋葱出网
corepack pnpm exec tsx scripts/relay-daemon-smoke.ts     # 守护接线：挖矿→上链发布描述符→自我发现→绑端口
# ---- Phase 2（隐藏服务 / rendezvous）----
corepack pnpm exec tsx scripts/hsdesc-selftest.ts        # 描述符密码学：地址往返 + 盲化两端一致 + 盲签名铁锚 + 跨周期不可关联 + 金标准向量
corepack pnpm exec tsx scripts/hsrend-selftest.ts        # INTRODUCE 信封 / e2e RDV 封往返 + 错钥/篡改拒收 + 金标准向量
corepack pnpm exec tsx scripts/hs-dht-test.ts            # 真实电路上发布/取回描述符 + 越键/篡改发布被 HSDir 拒
corepack pnpm exec tsx scripts/hs-rendezvous-test.ts     # 仅凭 .v0id 地址建端到端会合 + 双向数据 + 匿名/无 IP 泄露 + RP 见密文
corepack pnpm exec tsx scripts/hs-socks-test.ts          # 真实 curl --socks5-hostname <地址>.v0id → rendezvous → 本机隐藏服务
corepack pnpm --filter @v0idchain/core typecheck && corepack pnpm --filter @v0idchain/node typecheck
```

---

## 11. 先行者与署名

借鉴并须在相应文件头署名：**Tor**（ntor proposal 216 / tor-spec §5.1.4、定长 cell、telescoping、guard spec；**v3 隐藏服务 rend-spec**——密钥盲化、加密描述符布局、HSDir 环、intro/rendezvous 流程，由 Phase 2 借用）、**Sphinx**（Danezis-Goldberg，定长包思想）、**Nym/Loopix**（Mixnet 延迟+cover，Phase 5）、**Orchid/HOPR**（概率支付，Phase 4）。实现前应研读 **Lokinet/Oxen**（区块链+洋葱+质押 Service Nodes，最接近的先行者）。密码学原语来自 **@noble/curves · @noble/hashes · @noble/ciphers**（Paul Miller，MIT）。

---

# Phase 2 — 隐藏服务（双向 rendezvous）

**状态**：已实现并验证（5 个新测试全 ALL PASS + 金标准向量锁死 + 两轮独立对抗式审查）。这一层把 Phase 1 的“客户端匿名出网”补成**双向匿名**：客户端与服务**互不知对方 IP**，全靠一个自认证的 `.v0id` 地址会合。

复用 Phase 1 的全部传输层（ntor §3 / 定长 cell §4 / telescoping §6 / 链上中继目录 §5），不改其线格式；新增的只是 cell 内命令 `CMD_* = 11–19`、一组密码学原语（`hsdesc.ts` / `hsrend.ts`）、中继上的三类会合状态（`relaynode.ts`）、以及两个守护接线点。**不与 Tor 互通**：盲化/信封/描述符全用本链自己的域分隔串与参数。

## 12. 威胁模型增量（在 §0 基础上）

| 角色 | 它学到什么 | 它**学不到**什么 |
|---|---|---|
| **客户端** | 服务身份 A（来自描述符，经 ntor AUTH 验证）| —（客户端始终匿名） |
| **服务** | 只有端到端应用字节 | 客户端身份 / IP / 来源电路（**从不**认证客户端、从不见其 IP） |
| **引入点 IP** | 一个不透明 `authKey` + 一团密封 blob | 客户端、RP、blob 内容（单向 DH 信封，只有服务能解） |
| **会合点 RP** | 两条匿名终端电路 + 一个 cookie + 不透明 e2e 密文 | 任一方身份/IP；**解不开**密文 |

- **客户端对服务匿名**：服务从不验证、也看不到客户端——它只通过 e2e 字节 + RP 与对方交互（`hs-rendezvous-test` 断言 `serverGotPlaintext` 是纯应用字节）。
- **服务对客户端认证**：会合 ntor 的 AUTH 把描述符里的服务身份 `A` 绑进握手转录 → 中间人无法冒充（`ntorClientFinish` 验 AUTH 失败即抛错，见 §15）。
- **双方都不发自己的 host:port**：服务只发布描述符（引入点 + 服务静态 onion 公钥），客户端只持 `.v0id` 地址；会合在第三方 RP 上完成。

## 13. 密码学：自认证地址 + 密钥盲化 + 描述符（`packages/core/src/hsdesc.ts`）

### 13.1 秘密 `.v0id` 地址（自认证，**不上链**）
```
地址 = base32lower( A(32) ‖ checksum(2) ‖ version(1) ) + ".v0id"
checksum = sha256( ".v0id checksum" ‖ A ‖ [VERSION] )[:2]      VERSION = 0x01
```
- `A` = 服务的 ed25519 身份公钥；地址**本身即公钥**（self-authenticating），不依赖任何目录服务。
- **不在链上注册**，**带外**分发（贴出来 / 私信 / 二维码）。这正解决了 v1 设计里“链上命名注册=可被枚举”的矛盾：链上注册等于把全部隐藏服务地址公开可遍历，与匿名相悖。
- base32 严格解码（末尾冗余 bit 必须为 0 → 拒非规范编码，防地址延展性）；`decodeV0idAddress` 校验长度/版本/校验和，任一不符 → null。

### 13.2 ed25519 按时间周期密钥盲化
时间周期 `TP = floor(unixSec / 86400)`（一天一期）。
```
h  = leBytesToScalarModL( sha512( "v0id-blind-v1" ‖ A(32) ‖ u64le(TP) ) )   // 盲化因子，只依赖公钥 A 与周期
Ap = h · A          (客户端侧，只需 A：blindPublic)
aprime = (h · a) mod L ;  Ap = aprime · G    (服务侧，需种子：blindSecret)
```
- 两种算法得**同一点**（`h·(a·G) == (h·a)·G`）——selftest 断言 `blindSecret.Ap == blindPublic(A)`。
- 服务用盲私钥 `aprime` 签描述符，产出的是**标准 ed25519 签名**——能被库的 `ed25519.verify(sig, msg, Ap)` 通过（这是盲化数学正确的唯一证明，`hsdesc-selftest` 的“★铁锚”）。
- **效果**：① 跨周期不可关联（每期 `Ap` 不同，外人无法把不同周期的描述符串到同一身份）；② 不可枚举（没有 `A` 就推不出 `Ap` / 推不出 `h`）。

### 13.3 描述符（加密引入点 + 盲签名）
```
credential = sha256( "v0id-cred-v1" ‖ A )                 // 只能由 A 导出
descKey    = HKDF-SHA256( ikm=credential, salt=u64le(TP), info="v0id-descenc-v1", 32 )
blob       = nonce(24) ‖ XChaCha20-Poly1305(descKey, nonce).encrypt( JSON{introPoints, serviceOnionPubHex} )
signBytes  = "v0id-hsdesc-v1" ‖ u64le(TP) ‖ Ap ‖ blob     // 周期+盲身份+密文一并钉进签名
Descriptor = { v, tp, ap=hex(Ap), enc=hex(blob), sig=hex(signBlinded(seed,TP,signBytes)) }
descId     = sha256( "v0id-hsdir-v1" ‖ Ap ‖ u64le(TP) )   // DHT 索引键
```
- 内层（引入点列表 + 服务静态 onion 公钥）**加密**，密钥只能由 `A` 派生 → 只有知道 `.v0id` 地址的客户端能解。
- `parseDescriptor(addr, desc)`（客户端，持地址）：① 地址→A；② `blindPublic(A,tp)` 必须等于 `desc.ap`；③ 标准 ed25519 验签；④ 派生 descKey 解密；⑤ JSON 解析。任一步失败 → null。
- `verifyDescriptorPublishable(desc)`（HSDir，**不持 A、不解密**）：只验外壳形状 + 盲签名在 `desc.ap` 下成立。签名成立即证明此描述符确由该周期盲私钥签发 → 据此拒绝未签名/被篡改的垃圾，而**无法窥探明文引入点**。
- `responsibleHsDirs(descId, relays, n=3)`：按 `|sha256(addr) XOR descId|`（大端 bigint）升序取前 n 个去重——确定性 HSDir 环（DHT 路由）。
- **金标准向量**锁在 `hsdesc-selftest.ts`（固定 `SEED=0x07×32, TP=20000`）：
  ```
  address = 5jfgyy7ctrjavpxvkb5rglwf7gkuo5vox27hxescd3vgsfcg2iwifoab.v0id
  Ap@TP   = 1b142c345a835f7af884fe3ae3ed7cb86a0063d51e7cfb51ab96a61c00a28304
  descId  = 2fc52b1d23c1b601061139371260207a81318ffec1903537053577073acab9cb
  ```

## 14. 描述符 DHT（中继即 HSDir，`relaynode.ts`）

中继**同时**充当 HSDir：内存 `Map<descId, {json, exp}>`，上限 `MAX_HSDESCS=10000`，TTL = `2 × PERIOD_LEN`（两个周期）。服务发布、客户端取回都**经 3 跳电路**完成 → 双方 IP 都不向 HSDir 暴露。

```
CMD_HS_PUBLISH(7)  客户端→HSDir：分帧块（首块 4B 总长 + descIdHex(64) ‖ JSON）
CMD_HS_FETCH(8)    客户端→HSDir：分帧块（descIdHex(64)，单 cell 即够）
CMD_HS_RESP(9)     HSDir→客户端：应答体（发布="OK"；取回=描述符 JSON），分帧分片
CMD_HS_END(10)     HSDir→客户端：一次应答结束（PUBLISH 失败时不带 RESP 直接 END = 失败）
```
- **4 字节长度前缀分帧**：描述符 JSON（带 2 个引入点）超过单 cell 净荷 485B → 必须跨多 cell（`encodeFramed` / `FrameReassembler`）。
- **防抢注/越键写入**：`handleHsPublish` 仅在**两条都成立**时存储——① `verifyDescriptorPublishable(desc)`（盲签名自洽）**且** ② `descIdHex === descriptorId(desc.ap, desc.tp)`（存储键钉死到被签名的盲公钥）。没有受害者的盲私钥，攻击者既造不出合法签名，也无法把垃圾写到受害者的 descId 上（`hs-dht-test` 实测：篡改发布被拒且不污染原存储；越键发布被拒）。

## 15. 引入点 + 会合（`hsservice.ts` / `hsclient.ts` / `relaynode.ts`，命令 11–19）

### 15.1 完整流程
```
服务启动：对 numIntros 个中继各建电路 → CMD_ESTABLISH_INTRO(authKey) → 候命监听 INTRODUCE2；
          构造描述符（引入点 = {relayId, authKey, …}）→ 发布到负责的 HSDir。
客户端连接 <addr>.v0id：
  1. 取回+解密描述符 → 引入点列表 + 服务静态 onion 公钥 B。
  2. 建到 RP 的电路，留一次性 cookie(20) → CMD_ESTABLISH_RENDEZVOUS → 等 RENDEZVOUS_ESTABLISHED（电路常开）。
  3. ntorClientStart(A, B) → 客户端 ntor 临时公钥 X；把 {rpRelayId, cookie, X} 用 B 密封成 INTRODUCE 信封；
     建到引入点的电路 → CMD_INTRODUCE1( authKey(32) ‖ ephPub(32) ‖ ct )。
  4. 引入点据 authKey 找到服务的引入电路，把信封（去掉 authKey）后向转为 CMD_INTRODUCE2。
  5. 服务 introduceOpen 解信封 → ntorServer(A, onion, X) → (Y, auth, keys)；建一条到 RP 的电路 →
     CMD_RENDEZVOUS1( cookie(20) ‖ Y(32) ‖ auth(32) )。
  6. RP 据 cookie 把“服务的会合电路”与“客户端的会合电路”**拼接**（splice，一次性消费 cookie），
     并把 Y‖auth 后向转为 CMD_RENDEZVOUS2 给客户端。
  7. 客户端 ntorClientFinish(X, A, B, Y, auth) 验 AUTH → 端到端密钥 keys（**验不过即抛错，杜绝 MITM**）。
  8. 此后双方 CMD_RDV_DATA(19) 走拼接电路；净荷用会合 ntor 密钥 rdvSeal 封死 → RP 只透传它读不懂的密文。
```

### 15.2 关键密码学
- **INTRODUCE 盲信封**（`introduceSeal`/`introduceOpen`）：单向 x25519 ECDH（客户端临时钥 e × 服务静态 onion 公钥 B）→ HKDF(info="v0id-introduce-v1") → XChaCha20-Poly1305。引入点既无 `e.priv` 也无 `b` → 解不开（纯路由）。明文 = `rpPub(32) ‖ cookie(20) ‖ clientNtorEph(32)` = 84 字节定长。
- **端到端 RDV 数据封**（`rdvSeal`/`rdvOpen`）：cell data = `ctr(8 大端) ‖ XChaCha20-Poly1305(key, nonceFromCounter(ctr)).encrypt(bytes)`。方向密钥来自会合 ntor（客户端发 `encForward`/收 `encBackward`，服务镜像）。每方向单调计数器，收端按 `ctr` 单调去重。**RP 持有的只是它无法解密的密文**（`hs-rendezvous-test` 断言 `CMD_RDV_DATA` 净荷不含明文）。
- **AUTH 即服务认证**：ntor 转录绑入服务身份 `A`（来自被验证的描述符）→ 任何冒充服务者无法产出正确 `auth` → 客户端 `ntorClientFinish` 返回 null → 抛“会合 ntor 认证失败”。这是“无 MITM”的根。

### 15.3 拼接完整性（RP 侧）
`handleRendezvous1` 一次性消费 cookie（防第二个 RENDEZVOUS1 重复拼接同一客户端槽）；拒绝同一电路自拼、拒绝已被拼接的槽；任一端电路销毁 → 连带销毁对端并解链（`splice` 双向表）。引入/会合/拼接三类登记均随电路销毁清理。

## 16. 守护可用性（`hsbridge.ts` + `packages/cli/src/index.ts`）

- **托管**：`v0id start --hs-target <host:port>` 托管一个隐藏服务——建引入电路 + 发布描述符，把每条进来的会合通道桥接到本机 `host:port`，启动后打印 `.v0id` 地址。hs 身份种子 + 服务静态 onion 私钥持久化到 `<dataDir>/hs.json`（`0600`，与 `onion.json` 同纪律）→ 重启地址不变。需链上 ≥3 中继（不足时给一行友好提示，不崩进程）。
- **访问**：`v0id start --socks` 时，本地 SOCKS5 前端遇到 `<地址>.v0id`（ATYP=domain）→ 走 rendezvous 连隐藏服务而非 clearnet 出口（`connectHs` 封 30s 总超时，杜绝半死服务把连接吊死）。
- **配方**：
  ```
  curl --socks5-hostname 127.0.0.1:9050 http://<addr>.v0id/
  ```
  **必须 `--socks5-hostname`**（不是 `--socks5`）：让 curl 把主机名作为 ATYP=domain 透传给 SOCKS、不本地 DNS 解析 `.v0id`（本地 DNS 必失败）。

## 17. 验证与对抗式审查

**5 个新测试全部 ALL PASS**（命令见 §10）：
- `hsdesc-selftest.ts` — 地址往返、盲化两端一致、盲签名★铁锚（`ed25519.verify` 通过 + 篡改即 false）、跨周期不同 `Ap`/`descId`、HSDir 环确定性、**金标准向量**。
- `hsrend-selftest.ts` — INTRODUCE 信封往返 + 错钥/篡改→null、84B 定长编解码、e2e RDV 封往返 + 篡改 ctr/密文→null、**金标准向量**。
- `hs-dht-test.ts` — 真实电路上发布/取回（含多 cell 分帧）、篡改发布被拒且不污染、越键发布被拒。
- `hs-rendezvous-test.ts` — 仅凭 `.v0id` 地址建端到端会合、双向数据、服务只见 e2e 字节（无客户端 IP）、客户端不知服务 IP、`CMD_RDV_DATA` 净荷为密文、未发布地址干净抛错。
- `hs-socks-test.ts` — 真实 `curl --socks5-hostname <addr>.v0id` → SOCKS5 → rendezvous → 本机隐藏服务取回 HTTP body；未发布地址干净失败、不卡死。

**两轮独立对抗式审查**（派独立 agent 在活体攻击下复核）：
- **§13 描述符密码学 = SOUND**：密钥盲化经两套独立 ed25519 实现交叉验证；伪造 / 篡改 / 用错地址 / 跨周期 重放全被拒。
- **§15 rendezvous = 所有安全关键属性在活体攻击下 HOLD**：客户端认证 / 无 MITM、对 RP 的端到端机密性、匿名性 / 无 IP 泄露、拼接完整性。
- **两个 MED 级 DoS 发现已修**：① INTRODUCE2 重放放大——半可信引入点重放一条 INTRODUCE1 即可逼服务反复建 RP 电路 → 修：按客户端 ntor 临时钥做防重放缓存（`seenIntros`，5 分钟 TTL，上限 4096 逐出最旧），重放即丢不做昂贵动作；② 服务 `rpCircs` 无界增长 → 修：并发会合上限 `MAX_RDV_CIRCS=256` + 会合电路死亡自动移除。

## 18. 诚实边界（**不软化**；Phase 2A 已消化掉的项见 §19）

- **仍不防全局被动对手的端到端流量/时序关联**（与 Tor 相同——低延迟洋葱的根本局限，待 Mixnet 阶段缓解）。
- **HSDir 垃圾发布无按源限速**：按设计 HSDir 看不到匿名发布者，无法对其限速；对 PUBLISH 加 PoW/stake 门槛是未来选项。当前由存储上限（`MAX_HSDESCS=10000` + TTL）+ 反抢注绑定兜底。（注：§19 的按源 IP 上限作用在中继/电路层，非 HSDir 发布层。）
- **`IntroPoint.relayOnionPubHex` 在当前测试 harness 里是占位符**（填 `00…`）：连接不依赖它（客户端用 authKey 寻址引入点、用服务静态 onion 公钥封信封），但**真实部署必须**从链上中继 `okey` 填真实值。
- **低残留**：客户端不对伪造的 RENDEZVOUS2 重试（只有真正的 RP 能注入一条 → 退化为“恶意 RP 拒绝服务”，不构成认证绕过）。
- **`hsservice` 暂以 `rev=0` 发布、重发不自增**：anti-rollback 机制已就位（§19），但要真正用 intra-period 更新需让 `hsservice` 每次重发自增 `rev`。

---

## 19. Phase 2A — 公网暴露前的加固（entry guards + DoS + anti-rollback）

> 已实现并经独立对抗 agent 复核（guards/DoS/anti-rollback 三项要害**全 HOLDS**，未发现新的 CRITICAL/HIGH 绕过）。脚本 `scripts/{guards-test,relay-dos-test,backward-replay-test}.ts` 全 ALL PASS。

- **Entry guards（`guards.ts`，§18 旧 TODO 已消化）**：钉住一个持久采样守卫集（`sampleSize=3`，落 `.data/guards.json` 0600，寿命 ~30 天轮换）跨所有电路（SOCKS + HS 的引入/会合/HSDir 电路共享）复用作 hop0 → 只有这固定几个中继见过你作入口。**只在钉住集内选、绝不退化随机**（"无守卫→随机"仅在目录空=网络死时触发；**对抗复核确认：链上目录无删除交易，攻击者无法把你的已发布守卫从目录里挤掉来逼随机**）。死守卫→`markUnreachable` 瞬态冷却(10min)切**钉住的备份**、到点自动恢复主守卫（不永久轮换、不退随机）。简化处（vs Tor）：均匀采样无带宽加权、无守卫可达性探测。
- **中继 DoS 控制（`relaynode.ts`/`circuit.ts`）**：① 电路 TTL + 空闲清扫（`lastSeen`，空闲>10min/寿命>1h 回收，max-age 对活跃电路也生效→堵廉价保活）；② 每电路 cell 令牌桶限速（`CELL_RATE=500/s` 桶 1000，洪泛→销毁；桶数学经核：大 elapsed 经 `min(burst,…)` 不溢出）；③ EXTEND 连接超时(10s，堵黑洞跳半开挂起，timer 不泄漏)；④ 按连接电路上限(512) + **按源 IP 上限(256)**（堵"4 条连接占满整中继"）。
- **描述符 anti-rollback（`hsdesc.ts`/`relaynode.ts`，§18 旧项已消化）**：描述符加**被签名覆盖**的 `rev`；HSDir 按 descId 只留最高 rev、`existing.rev >= new` 即拒 → 重放旧描述符压不掉新版。`rev` 只能由盲私钥签 → 攻击者无法冒名抬高 rev 卡死受害者更新。
- **客户端后向严格防重放（`client.ts`/`hsclient.ts`，§18 旧 best-effort 已收紧）**：rdv / stream / hs-request 三条客户端后向消费路径均加严格单调 `n<=bwdMax`→丢（仅 MAC 通过才推进）。中继后向路径仍 best-effort（telescoping 多源 EXTENDED 计数命名空间不同，无单调序——故防御落在客户端）。

**2A 诚实残留**：① **跨多连接的按源 IP 之外无更细计量**——per-IP 上限的入站侧会把同一对端中继多路复用的电路计入其 IP（256 默认对中小中继无碍；高流量中继可后续按链上中继 host 集豁免）；② 守卫均匀采样的女巫残留照旧（对手控 K/N 中继即约 K/N 概率成你主守卫，女巫需余额+挖块成本）；③ cell 限速仅前向（恶意下一跳后向洪泛由客户端去重 + 逐 cell 加密兜底）。

---

## 20. Phase 2C — Mixnet 模式（每跳延迟 + cover traffic，opt-in）

> 补洋葱单独关不上的最后一个根本性口子 = **全局被动对手的流量/时序关联**。**默认关**（Mixnet 加延迟，opt-in；关时现网行为逐字节不变，14 回归全过）。已实现并验证；**v1 基础≠完整 Loopix**（见诚实残留）。

- **逐跳混入延迟（`mixnet.ts`/`relaynode.ts`，relay-sampled，双向）**：中继开 Mixnet 时对每个转发('f')与后向套层('b') cell 各 hold 一个随机**指数延迟**（均值默认 80ms，clamp 2000ms）再发 → 打散 输入↔输出 时序关联。held cell 按电路 Set 追踪、`destroyCircuit` 清、全局 cap 50k 兜底（入流已被 2A 令牌桶限速）。
- **cover traffic（`CMD_DROP=20`，加密不可区分）**：cover cell 在线缆上是普通 512B 加密 RELAY cell（cmd 在洋葱密文内，唯**终点**剥层后见并**静默丢**，中继盲转发分辨不出）。客户端 `sendCover()/startCover(rate)` 按 **Poisson** 间隔发环路 cover → 电路常活、观察者分不清真假流量。**刻意不用会泄露的 wire `cv?` 字段。**
- **滑窗防重放（`antireplay.ts`，让 Mixnet 与流式兼容）**：mixnet 需要能容忍合法乱序（否则独立延迟/网络抖动会被旧严格单调 n 误判重放），但 TCP/HS 分帧又要求同一电路同一方向按序交付。实现采用两层约束：**RFC 6479 式滑动窗口 anti-replay**（W=8192，定长 1024B/窗口）允许窗口内乱序但拒重复/太老/nonce 悬崖；同时中继 mixnet 延迟队列对同一电路同一出方向 **FIFO**，随机化间隔但不打乱流字节序。验证：`antireplay-test`(32 项含 6000 乱序 fuzz)、`mixnet-test §⑦`(多 cell TCP 流经 mixnet 后全字节按序抵达)。

**2C 诚实残留**：① **v1 基础，非完整 Loopix**——无 Sphinx sender-chosen 逐跳延迟、无中继环路 cover、无投递随机目标的 drop cover、无 SURB 应答、未调优 Poisson 参数、无正式匿名度量；只声称机制存在且可用，**不声称已达流量分析免疫**。② CLI `--mixnet` 目前仅接中继侧延迟，客户端 cover 接进 SOCKS/HS 路径是 follow-up。③ 滑窗 anti-replay 的**远期回绕**：持密钥的在径跳注入一个 MAC 有效的远期 n 可滚窗逐出在途 cell → 单电路 drop-DoS（**非重放接受**；该跳本就能丢/伪造，且受令牌桶限速）——所有窗口式 AR（含 IPsec）固有。④ cover 调度器是独立 Poisson 过程，理论上终点侧统计可分离两速率（真 sender-unobservability 需本 v1 未做的调优混合）。
