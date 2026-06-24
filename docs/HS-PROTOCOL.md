# HS-PROTOCOL — .v0id 匿名隐藏服务网络协议规范

**状态**：Phase 1（洋葱路由传输层）已实现并验证。Rendezvous（双向隐藏服务）、概率支付、entry guards、Mixnet 模式为后续阶段。
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
| 服务描述符 / intro points | **链下 DHT**（盲化索引；Phase 2） |
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
出口默认 **deny-all**；要作出口需显式 `--exit-allow host:port,…`。**隐藏服务（.v0id 双向匿名）仍需 rendezvous（Phase 2）**——当前是客户端匿名出网，不是隐藏服务。

**待办**：
- **DoS 加固（公网暴露前的门槛）**：按 IP/连接限速、电路 TTL + 空闲清扫、失败/死 `nextConn` 清理、`handleExtend` 连接超时（当前死下一跳会留半开电路 + 客户端 `extend()` 挂起）。
- **Entry guards**（钉住入口抗统计去匿名）—— v1 每电路自选入口，使用越多越弱，**真实部署前必做**。
- **后向严格防重放窗口**；**客户端响应按 circId/cmd 关联**（当前单 pending+FIFO，注入/乱序后向 cell 会让请求错配→电路 DoS）。
- **双向 rendezvous**（隐藏服务：intro points + RP + 盲化 DHT 描述符）—— Phase 2。
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
corepack pnpm --filter @v0idchain/core typecheck && corepack pnpm --filter @v0idchain/node typecheck
```

---

## 11. 先行者与署名

借鉴并须在相应文件头署名：**Tor**（ntor proposal 216 / tor-spec §5.1.4、定长 cell、telescoping、guard spec）、**Sphinx**（Danezis-Goldberg，定长包思想）、**Nym/Loopix**（Mixnet 延迟+cover，Phase 5）、**Orchid/HOPR**（概率支付，Phase 4）。实现前应研读 **Lokinet/Oxen**（区块链+洋葱+质押 Service Nodes，最接近的先行者）。
