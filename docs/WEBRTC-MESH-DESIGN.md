# v0idChain WebRTC 网状传输设计（WS Hub + WebRTC Mesh 混合）

> 目标：让任意在线用户（含前台手机）成为别人可达的节点，使冗余来自用户而非中心服务器。
> 范围铁律：**只动传输层**——不碰共识、不碰 canonical-JSON 的 txid / 签名规则。
> 文档基于实代码 `packages/node/src/p2p.ts`、`packages/node/src/node.ts`，并吸收一轮多 agent 研究的 6 个维度与 5 条对抗式裁决 [V1]–[V5]。

---

## 1. 结论先行（TL;DR）

**能做到的：** 把 WebRTC DataChannel 作为 WebSocket 之外的**第二条传输**，叠加在现有 transport-agnostic 的 `P2PMessage` 层上。约 **70–90%** 的对等对（主要是桌面 / 家庭 Wi-Fi、EIM/锥形 NAT）能靠**免费公共 STUN** 直接打洞、点对点互联，无需任何新的服务器进程 [1][7][8][V1]。这就让"用户成为可达节点"对这大半人群**真实成立**——冗余确实来自用户。

**iOS 后台的真相（必须先讲清）：** iOS 在 App 退到后台 / 锁屏后约 **30 秒**挂起进程并回收套接字，DataChannel 对等连接随之断开；没有任何通用后台模式能保活一个 P2P 数据套接字 [11][12][13]。想用 VoIP/PushKit 给一个非通话 App 续命，**违反 App Review 2.5.4**，结果是拒审 / 吊销 VoIP token [11][16][V2]。所以 **iOS 客户端只能是"前台在线时的临时节点"（foreground-only ephemeral）**。Android 可用"用户主动开启的前台服务 + 常驻通知"保活，但受 Doze 限流，且多数蜂窝是对称 CGNAT、入站不可拨 [22][23][V2]。

**单一最大决策：TURN 托管。** STUN 打不通的那 **~10–30% 少数派**（对称 NAT / CGNAT，集中在蜂窝手机上）无法直连 [4][5][6][V1]。生产服务器**不允许**跑新的实验服务（无 coturn / 无 signaling）。两条路：
- **v1：不上 TURN。** STUN 直连 + 对称 NAT 节点优雅降级为 **WS 叶子**（继续连种子、走 WS gossip）——**零成本、相对今天零回退**。
- **后续：加 Cloudflare Realtime TURN**（免费 ~1000 GB/月，超出 ~$0.05/GB，独立于 SFU、2026 年中实测可用），把那道缺口补上 [25][26][V3]。Twilio 贵约 8 倍，**不推荐** [27][V3]。

**诚实红线（写进 UX，别让用户误会）：** **不是每一台手机都能成为 24/7 可拨达的节点。** 蜂窝 CGNAT 对称 NAT 上的手机，在没有 TURN 时**结构上无法入站可达**；它们仍能作为出站 WS 叶子参与（收发交易/区块、转发），但不是"常驻骨干"。常驻骨干角色仍由至少一个长在线的服务器级节点（现有种子）承担——手机在其上**叠加机会性冗余**，而非充当always-on 基础设施。

---

## 2. 目标与现实边界

### 设备 / 网络 → 可达角色

| 设备 / 网络 | 直连可行性 | 可达角色 | 依据 |
|---|---|---|---|
| 桌面 + 家庭 Wi-Fi（EIM/锥形 NAT） | STUN 直连 ~70–90% | **全节点**：WS + WebRTC 双向，点对点 | [1][7][V1] |
| 桌面 + 公网 IP / IPv6 | 无需打洞（IPv6 仅防火墙开孔） | **全节点 / 骨干**，最佳 | [9] |
| 桌面 + 企业/校园（对称 NAT、封 UDP） | 直连常失败（企业环境可达 ~85% 需 relay） | **WS 叶子**（无 TURN 时） | [3][V1] |
| Android 前台 / "Run-as-node" 前台服务 | 取决于 NAT；蜂窝多为对称 | 前台在线时**可作节点**；蜂窝下常退化为 WS 叶子 | [22][23][V2] |
| Android 后台（无前台服务） | Doze 限流、套接字不保证存活 | 不可靠，视作**临时叶子** | [23][V2] |
| **iOS 前台** | 取决于 NAT | **前台临时节点**（App 开着时是 live node） | [11][12][V2] |
| **iOS 后台 / 锁屏** | 进程 ~30s 被挂起、套接字被回收 | **掉线**（peer drop）——这是平台硬限制，不是 bug | [11][12][13][16][V2] |
| 任意手机 + 蜂窝 CGNAT（对称 vs 对称） | 几乎必须 relay；无 TURN 则失败 | **WS 叶子**（无 TURN 时入站不可达） | [4][5][6][V1] |

### 被 [V1]/[V4]/[V5] 修正 / 下调的原始假设

- **[V1] 修正"STUN 就够了"。** STUN-only 会**静默排除** ~10–30% 的对称 NAT / CGNAT 少数派（集中在蜂窝手机）。他们不是消失，而是降级为 WS 叶子——但必须显式承认，别在文案里假装"人人直连" [4][5][6][V1]。
- **[V4] 推翻"现有 JSON 帧可原样跑 DataChannel"。** 对 **BLOCKS** 帧**证伪**：SCTP DataChannel 安全互操作上限 16 KiB，>256 KiB 会让 Chromium/libwebrtc 硬关通道，libdatachannel/pion 单写约 64KB 上限。现有 `BLOCKS` 路径 `CHUNK=500`（≈500KB/条，外加 `chain.length <= CHUNK` 整链快捷）**远超**该限。**RTC 路径必须改小分片**（见 §3.5）。这是**强制代码改动**，不是"只加信令" [V4]。
- **[V5] 推翻"一套 libdatachannel 通吃 Node+Swift+Kotlin"。** **证伪**：只有 Node 侧成立（node-datachannel）；移动端 libdatachannel 封装（swarm-cloud/datachannel-native）停更于 2023-08、~28 星、无 SPM/AAR。必须**混合栈**：Node 用 libdatachannel，iOS/macOS/Android 用 Google libwebrtc。三者都实现 RFC 8831/8832 标准 DataChannel，**线上互通**，只是不共享代码 [V5]（见 §5）。

---

## 3. 架构设计（WS Hub + WebRTC Mesh 混合传输）

### 3.0 嫁接点：现有层已 90% transport-agnostic

`p2p.ts` 的 `handle()`（`p2p.ts:228`）是纯 JSON 分发，**零改动**即可复用；唯一与 WS 耦合的是三处：
1. `send(ws, msg)` 直接吃 `ws.WebSocket`（`p2p.ts:319`）；
2. `peers` / `chunkBuffers` 两个 Map 以 `WebSocket` 对象为键（`p2p.ts:90`、`p2p.ts:92`）；
3. **对等寻址 / 拨号**用 `ws://` URL（`knownUrls`/`pinnedUrls`/`dialedUrls` + `isPublicWsUrl`，`p2p.ts:44`、`p2p.ts:94-98`）。

`node.ts` 的 `onBlocks`/`onTx` 拿到 `from: WebSocket` 后**只当不透明句柄用**（`this.p2p.send(from, …)` / `broadcast(…, from)`，`node.ts:410`、`node.ts:406`、`node.ts:424`）——所以一旦 `from` 变成抽象句柄，它们无需改动即可工作 [V5-finding]。

### 3.1 `Conn` 传输句柄抽象

引入最小接口，让 `send/broadcast/handle/setupSocket` 与 `peers`/`chunkBuffers` 都改用它：

```ts
interface Conn {
  id: string;          // 稳定的 peerId = ed25519 钱包地址（见 §3.2）
  send(msg: P2PMessage): void;
  close(): void;
  isOpen(): boolean;
  kind: 'ws' | 'rtc';  // 仅用于 §3.5 选择分片策略
}
```

- `WsTransport`：包住现有 `WebSocketServer` + 拨号逻辑（`p2p.ts:112-129`、`connect()` `p2p.ts:176`），产出 `Conn`。`send()` = `ws.send(JSON.stringify(msg))`（同 `p2p.ts:320`）。
- `RtcTransport`：见 §3.4，把一个 DataChannel 包成 `Conn`，`send()` = `dc.sendMessage(JSON.stringify(msg))`。
- `P2PHandlers.onBlocks/onTx/onPeer` 的 `from: WebSocket` → `from: Conn`（`p2p.ts:22-24`、`node.ts:396`、`node.ts:420`）。

`handle()` 的 switch（`p2p.ts:239-313`）**一行不改**。`MAX_WS_PAYLOAD`（64MB，`p2p.ts:87`）、`MAX_KNOWN`（512，`p2p.ts:80`）、`maxPeers`（8，`p2p.ts:103`）、广播去回声（`broadcast(msg, except)`，`p2p.ts:324`）原样沿用。

### 3.2 寻址：从 `ws://` URL 迁到 peerId（= HELLO.address）

peerId **复用现有 ed25519 钱包地址**——它已在 `HELLO.address` 里交换（`p2p.ts:8`、`setupSocket` `p2p.ts:212-217`），且**已被用作确定性 tie-break**：重复连接时 `this.handlers.getAddress() > msg.address` 决定哪一侧关闭（`p2p.ts:252`）。

- `peers` Map 改以 peerId 为路由键；去重/`isConnectedTo`（`p2p.ts:132`）从比对 `listen` URL 改为比对 peerId。
- **单一身份空间**：一个既能 `ws://` 又能 WebRTC 到达的节点，是**同一个 peer**，按地址去重——避免双栈把同一人记成两个。
- 该地址也用于 §3.4 的 perfect-negotiation 礼让角色和 §6 的签名信令——**一套密钥贯穿链上身份与网络身份**，对教学链最简洁 [V5-finding][2]。

### 3.3 三个新信令消息类型（经现有 WS 1-hop 中继 + 签名）

在 `P2PMessage` 联合（`p2p.ts:7-14`）里新增三类，**只走中继**，由现有 WS 连接 / 种子转发——**生产服务器不需要任何新守护进程**，它只是转发本就在路由的 JSON：

```ts
| { type:'SIGNAL_OFFER';  to:string; from:string; sdp:string;  sig:string; ts:number }
| { type:'SIGNAL_ANSWER'; to:string; from:string; sdp:string;  sig:string; ts:number }
| { type:'SIGNAL_ICE';    to:string; from:string; candidate:string; mid:string; sig:string; ts:number }
```

路由规则（加进 `handle()` 的 switch）：
- 收到 `SIGNAL_*` 且 `to` **不是自己** → 转给 peerId == `to` 的那条连接（**1-hop**，经种子或任意双方都连着的节点）。
- `to` **是自己** → 把 sdp/candidate 喂进本地 `RTCPeerConnection`。
- **每条都用 `from` 的 ed25519 私钥签名（`sig`）**，转发前校验签名 + `ts` 时窗——杜绝伪造 offer 与放大攻击；签名复用现有 crypto，零新依赖 [V2-finding][2]。
- **跳数封顶 1、按源限速**，防止种子沦为信令洪泛放大器（见 §6）。
- 种子的 WS server 本就接受所有人入站 HELLO（`p2p.ts:123`），是天然会合点；手机**保持对种子的出站 WS 连接常开**（现有 `reconnect()` 每 5s 自愈，`p2p.ts:126`、`p2p.ts:198`），以便在 NAT 后仍能接收入站 `SIGNAL_OFFER` 中继。

### 3.4 perfect-negotiation + trickle-ICE

用 MDN 标准 **perfect negotiation**，礼让角色由**确定性 ed25519 地址比较**决定（与 `p2p.ts:252` 现有去重 tie-break 同一招，保证两侧无需协调即达成一致）[19][20]：

- **polite**（地址较小一方）：遇到冲突的远端 offer（offer 到达时 `signalingState != 'stable'` 或本地有 pending offer）→ 隐式 rollback、接受对方。
- **impolite**（地址较大一方）：忽略冲突 offer（`ignoreOffer=true`），并丢弃该侧后续 ICE 直到回到 stable。
- **trickle ICE**：`onLocalCandidate` 一产生就立刻发 `SIGNAL_ICE`，不等收集完；收到 `SIGNAL_ICE` 就 `addRemoteCandidate`。
- 两节点学到彼此 peerId 后**可能同时**互发 offer——正是现有 duplicate-HELLO 已处理的同一竞态，perfect-negotiation 对此 glitch-free [19][20]。
- Node 侧用 node-datachannel：`new PeerConnection(name, { iceServers:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302'], disableAutoNegotiation:true })`，配合手动 perfect-negotiation 控制 [17][18]。

### 3.5 ⚠️ 强制：DataChannel 分片改动（仅 RTC 路径）[V4]

**[V4] 证伪了"BLOCKS 帧可原样跑 DataChannel"。** SCTP DataChannel 安全互操作上限 **16 KiB**；>256 KiB 触发 Chromium/libwebrtc 硬关通道。现有 `QUERY_ALL` 分片（`p2p.ts:268-284`）：

```ts
const CHUNK = 500;
if (chain.length <= CHUNK) {            // ← 整链快捷：单条消息发全链
  this.send(ws, { type:'BLOCKS', blocks: chain });
} else { /* 每片 500 块 ≈ 500KB */ }
```

`CHUNK=500`（≈500KB/条）与那条 `chain.length <= CHUNK` 整链快捷**都远超 16 KiB**。**改动（只在 RTC 路径生效，WS 路径 `CHUNK=500` 不变）：**

- 新增 `CHUNK_RTC ≈ 12`（约 12 块 × ~1KB ≈ 安全落在 16 KiB 以内）。
- **RTC 路径丢掉 `chain.length <= CHUNK` 整链快捷**——整链必须分片发，绝不单条发全链。
- 实现上：`QUERY_ALL` 分支按 `from` 连接的 `conn.kind` 选 `CHUNK_RTC`（rtc）或 `CHUNK`（ws）。接收端的分片缓冲（`chunkBuffers`，`p2p.ts:285-300`）逻辑不变——它本就按 `from`/`total` 攒齐。
- SCTP 保留消息边界，故 `BLOCKS`/`from`/`total` 攒片协议无需改协议、只需改分片大小与去掉快捷。

WS 路径（种子整链同步、`MAX_WS_PAYLOAD=64MB`）**完全不变**。

### 3.6 两平面 PEX

| 平面 | 学到什么 | 过滤 / 准入 | 说明 |
|---|---|---|---|
| **WS 平面** | `ws://` URL（HELLO.listen / PEERS） | **保留 `isPublicWsUrl`**（`p2p.ts:44`）——只放行公网可路由，防被诱导拨内网 SSRF | 与今天完全一致（`p2p.ts:261`、`p2p.ts:305-312`） |
| **RTC 平面** | `{ peerId, reachableVia: ['ws://…'] \| ['rtc'] }` | **不拨 URL**→ `isPublicWsUrl` 不适用；准入靠**身份**：先证明控制 peerId 才计入 maxPeers / 才能广播 | 要连 RTC-only 节点不是"拨号"，而是挑一个也认识该 peerId 的已连节点去中继 OFFER |

`isPublicWsUrl` 的 SSRF 防护在 RTC 平面**结构上失去意义**（ICE 候选由本机 OS/STUN 产生，没有"被喂一个拨号目标 URL"这回事）；取而代之的是 §6 的签名信令 + 远端 ICE 候选计数封顶 [V2-finding]。

### 3.7 拓扑速写

```
                         ┌──────────────────────────────────────┐
                         │   SEED（生产/部署种子）                │
                         │   = 常驻骨干 + 1-hop 信令会合点         │
                         │   WS server，接受所有入站 HELLO         │
                         │   转发 SIGNAL_OFFER/ANSWER/ICE（签名校验）│
                         │   ★ 不跑 coturn / 不跑新 signaling 守护  │
                         └──┬───────────────┬───────────────┬─────┘
              WS（信令中继） │      WS（信令中继）│      WS（出站常开）│
                            │               │               │
             ┌──────────────┴──┐   ┌────────┴────────┐   ┌──┴─────────────────┐
             │ DESKTOP A        │   │ DESKTOP B        │   │ 前台手机（iOS/安卓） │
             │ WS + RTC         │   │ WS + RTC         │   │ WS + RTC（前台时）   │
             │ EIM/锥形 NAT     │   │ EIM/锥形 NAT     │   │ 锥形→直连；CGNAT→叶子│
             └────────┬─────────┘   └────────┬─────────┘   └──────────┬─────────┘
                      │                       │                        │
                      └────── WebRTC DataChannel（STUN 打洞，点对点直连）──────┘
                               DTLS 加密 · 承载同一 JSON P2PMessage 帧
                               （RTC 路径用 CHUNK_RTC≈12，去整链快捷）

  对称 NAT / 蜂窝 CGNAT 节点（无 TURN 时）：打洞失败 → 退回 SEED 的 WS 叶子，走 WS gossip。
  —— 优雅降级，绝不差于今天的星型拓扑。
```

---

## 4. TURN + 信令托管选型矩阵

> **信令永不是新 SPOF：** 复用现有 WS gossip 中继 SDP/ICE（§3.3），随节点数增长，无需任何托管信令服务 [33][34][V3]。所有托管 TURN **都不附带信令**，故信令始终自供——正好就是上面的 gossip 中继。

| 方案 | 免费额度 | 超出价 | 适合 | 裁决 |
|---|---|---|---|---|
| **Cloudflare Realtime TURN** | **~1000 GB/月**（与 SFU 共一条计费） | **~$0.05/GB** | **推荐的后续 TURN** | ✅ 最大免费额度 + 最便宜；独立于 SFU、2026 中实测可用 [25][26][V3] |
| metered.ca Open Relay | 20 GB/月 | 免费页未公布 | 小流量快速试 | ⚠️ 免费额度仅 Cloudflare 的 1/50 [28] |
| 自建 coturn @ Oracle Always Free | 10 TB/月出口（永久免费 VM） | $0 | 想自托管、不怕运维 | ⚠️ 实例回收风险 + 运维负担；ARM 额度 2026-06-12 砍至 2 OCPU/12GB [29] |
| 自建 coturn @ Hetzner CX22 / fly.io | CX22 含 20 TB 流量 | CX22 ~€3.79/$4.35/月；fly.io $0.02/GB | 想自托管、要可控 | ⚠️ 允许（受限的是**生产**服务器，不是所有主机），但需自管 coturn 安全（见 §6）[30][31] |
| Twilio Network Traversal | 无免费 TURN（STUN 免费） | $0.40/GB（美/德）起 | —— | ❌ **不推荐**，约贵 8 倍 [27][V3] |

### 这是 owner 必须拍板的那个决策

- **v1 直接发布——不上 TURN。** 免费公共 STUN 打洞（覆盖 ~70–90%）+ 对称 NAT 节点退回 WS 叶子（= 今天的行为）。**零成本、零信用卡、相对今天零回退** [4][32][V1][V3]。这是稳妥的概念证明基线。
- **后续补缺口——挂 Cloudflare Realtime TURN。** 用其 ~1000 GB 免费层（你已自供信令）；零信用卡快速演示可走 Hugging Face token 路径（~10 GB）[25][26][V3]。
- **不要 Twilio。** 若坚持自托管，选 Hetzner CX22（非生产箱，允许），并按 §6 加固 coturn。
- **决策点：** owner 是否接受"v1 阶段对称 NAT/CGNAT 手机入站不可达、退化为 WS 叶子"？若可接受 → v1 不上 TURN；若"人人可达"是硬需求 → 必须托管 TURN（生产箱被禁，只能 Cloudflare 或外部自托管）。**诚实答案是：无 TURN = 部分覆盖。**

---

## 5. 各平台 WebRTC 库选型（混合栈，[V5]）

> **[V5] 证伪"单一 libdatachannel 通吃"。** 只有 Node 侧成立；移动端唯一的 libdatachannel 封装停更。**采用混合但线上兼容的栈**——三者都实现 RFC 8831/8832 标准 DataChannel，互通无虞，只是不共享代码 [V5][8]。

| 平台 | 选用库 | 引擎 | 状态（2026 中） | 备注 |
|---|---|---|---|---|
| **Node 全节点 / macOS 桌面助手** | **node-datachannel** | libdatachannel（C++17） | v0.32.x 活跃，N-API 8，Node ≥18.20，datachannel-only，ESM | 轻量、自带 WS 可作信令、干净嫁接现有 JSON 层 [17][18][35] |
| Node（避免原生预编译的备选） | werift（纯 TS） | 纯 JS SCTP | 维护模式，吞吐较弱 | 仅在"不想要原生构建"时用；否则 node-datachannel 更快更新 [37] |
| **iOS + macOS 客户端** | **stasel/WebRTC**（SPM） | Google libwebrtc | ~147.x，5 年 52 次发布 | 标准 `RTCDataChannel`；与现有 CryptoKit 签名共存；Google 自家 pod 在 M80 后已弃 [38][39] |
| **Android 客户端** | **GetStream/webrtc-android**（AAR） | Google libwebrtc | 1.3.x（跟 m125），Maven | LiveKit/Daily/Agora 同款引擎，DataChannel 行为成熟 [40][41] |
| ❌ 不采用 | swarm-cloud/datachannel-native | libdatachannel 移动封装 | **停更 2023-08，~28 星，无 SPM/AAR** | 用它=自己背 C-FFI+JNI 桥，与 solo-dev/教学链约束冲突 [V5] |

线上互通由标准保证：libdatachannel 显式为与浏览器/Google 栈互操作而建 [8]。因此混合栈**不威胁** consensus 与 canonical-JSON——WebRTC 只替换传输，签名负载分毫不动。

---

## 6. 安全考量（按教学玩具尺度）

| 关注点 | 今天（WS） | WebRTC 平面之后 |
|---|---|---|
| **SSRF（被诱导拨内网）** | `isPublicWsUrl` 白名单过滤 gossip 学来的 URL（`p2p.ts:44-70`） | **在 RTC 平面失效**——不拨任何 URL，ICE 候选由本机 OS/STUN 产生，"被喂拨号目标"这回事结构上不存在 [V2-finding] |
| **替代准入** | URL 公网可路由 | **签名信令 + 身份证明**：`SIGNAL_*` 由 `from` ed25519 私钥签名、转发前校验；首条 DataChannel 消息须证明控制所声明的钱包地址，才计入 maxPeers / 才能广播（类比 libp2p 的 Noise-over-WebRTC）[14][15][2] |
| **传输加密** | 明文 ws:// 帧 | **DTLS 强制加密**——相对今天的明文 JSON-over-WS 是**实打实的升级** [10][V2-finding] |
| **每消息校验** | `JSON.parse` in try/catch + 逐字段 typeof 守卫 + 64MB 上限（`p2p.ts:228-317`、`p2p.ts:87`） | **transport-agnostic，原样沿用**——DataChannel.onmessage(text) 喂进同一 `handle()` |
| **信令洪泛 / 放大** | —— | 跳数封顶 1；**按源限速**（如 ≤1 信令/5s/源）；签名拒伪造；`ts` 时窗拒重放；远端 ICE 候选**计数封顶**防内网探测 [21][V2-finding] |
| **Sybil** | maxPeers=8（`p2p.ts:103`） | WebRTC/DTLS **不提供** Sybil 防护；保持小 maxPeers + 按源限速；**关键：共识是 PoW，假节点改不了历史，只能浪费连接槽/带宽**——记为**已接受的限制**，不过度工程化信誉系统 [14][15][V2-finding] |
| **TURN 滥用（若启用）** | n/a | **时限凭证**（REST API ephemeral cred）防开放中继；自托管 coturn 还需 `no-udp`/`denied-peer-ip`（RFC1918/环回/链路本地——SSRF 在 relay 重生）/`no-multicast-peers`/配额；STUN Binding 仍可被反射放大 ~2x，需网络层限速 [21][V3]。用托管 TURN（Cloudflare）则免去这些运维负担 |

诚实承认的限制：对教学玩具，Sybil 槽位耗尽与信令 DoS 用"小 maxPeers + 限速 + PoW 保共识"挡住即可，不引入信誉/质押。

---

## 7. 分阶段落地计划

> 每阶段都有**可验证的成功判据**。先做最便宜的概念证明，再碰任何 Swift/Kotlin。

**阶段 0 — `Conn` 抽象重构（纯重构，零行为变化）。**
引入 `Conn` 接口，把 `send/broadcast/handle/setupSocket` 与 `peers`/`chunkBuffers` 改用 `Conn`；`onBlocks/onTx/onPeer` 的 `from` 改为 `Conn`；把现有 WS 包成 `WsTransport`。`peers` 去重改按 peerId（地址）。
✅ **判据：** 现有测试 + golden 向量全绿；两节点 WS 同步行为与重构前逐字节一致（无共识/签名变化）。

**阶段 1 — Node↔Node WebRTC 打洞（最便宜的概念证明，先于任何移动端）。**
在 **JS node 包内**用 node-datachannel 实现 `RtcTransport`；信令走**现有种子的 1-hop 中继**（新增三个 `SIGNAL_*`，签名 + 限速）；STUN 用免费公共服务器；承载**现有 JSON 帧**，并落地 **§3.5 的 `CHUNK_RTC` 修复 + 去整链快捷**。
✅ **判据：** 两个本地 Node（一个在另一台机/容器、走真实 NAT 或模拟锥形 NAT）经种子信令建立 **DataChannel 直连**，完成一次整链 `QUERY_ALL` 同步且高度追平；抓包确认 DTLS 加密、单条 DataChannel 消息 ≤16 KiB；WS 路径回归无变化。

> **✅ 阶段 0+1 已落地并验证（2026-06-22）。** 代码：`packages/node/src/transport.ts`（`Conn` 抽象 + `WsConn`）、`packages/node/src/rtc.ts`（`RtcTransport`：node-datachannel 动态加载、签名信令、perfect-negotiation 简化版=地址大者发起、trickle ICE）、`p2p.ts`（`Conn` 贯穿 + 3 个 `SIGNAL_*` 1-hop 中继 + `PEER_ANNOUNCE` 介绍 + `CHUNK_RTC=12` 分片）、`node.ts`/CLI `--webrtc`。node-datachannel 为 **optionalDependency + 动态导入**（加载失败→自动降级 WS-only，绝不崩；中和了 §8(1) 的种子 aarch64 预编译风险——纯中继种子根本不需要它）。**实现中新增 `serveChain` 选项**（默认 true；false = 纯信令中继，不服务整链同步）——让“只做信令、不存链”的轻中继成为一等角色，也用于测试隔离 RTC 同步路径。验证：`corepack pnpm rtc:proto`（`scripts/rtc-proto.ts`）13/13 稳定通过——A↔B 经种子信令打洞、**杀掉种子后** A 的新块仍经 RTC 点对点到达 B；新节点 Q 经 RTC 分片同步 16 块整链（>CHUNK_RTC），对照组 Q2（无 RTC）经纯中继永远停在创世 → 证明同步走的是 RTC 而非 WS。`enableRtc`/`relaySignaling` 默认 false ⇒ 现网 WS 行为零变化（integration + smoke + golden 全绿）。**默认关闭、需 `--webrtc` 显式开启**，对现有节点/种子无影响。

**阶段 2 — 桌面 App 接入。**
桌面客户端（macOS 助手用 node-datachannel）以 `Conn` 同时跑 WS+RTC；两平面 PEX（§3.6）上线。
✅ **判据：** 两台真实家庭网络的桌面机互相**点对点直连**（无种子转发数据，仅信令经种子）；种子下线后两机仍能继续 P2P 交换区块/交易。

**阶段 3 — 前台移动端。**
iOS（stasel/WebRTC）+ Android（GetStream/webrtc-android）作为**前台临时节点**接入；复用各自对种子的 WS 连接作信令中继；Android 提供"Run-as-node"前台服务开关（`foregroundServiceType=specialUse`，诚实文案）。UX 加"节点状态"指示（绿=App 开着 live node / 灰=已退后台、暂不作节点）。
✅ **判据：** 前台 iOS/Android 各与一个桌面节点建立 DataChannel 并收发交易；锁屏后 iOS peer 在 ~30s 内如期掉线、再开 App 自动重连——行为与文案一致，App Review 不踩 2.5.4。

**阶段 4 — 可选 TURN（补对称 NAT 缺口）。**
挂 Cloudflare Realtime TURN（免费层），把对称 NAT/CGNAT 节点从 WS 叶子升级为可中继直连；TURN 凭证用时限 cred。
✅ **判据：** 一对人工置于对称 NAT 后的节点（STUN-only 必失败）经 TURN 成功建立 DataChannel；关掉 TURN 配置后优雅退回 WS 叶子，无崩溃。

---

## 8. 风险与未决问题

1. **node-datachannel 原生 addon 在种子架构上的预编译（最大运营风险）。** 种子/部署箱是 Raspberry Pi **aarch64/Debian**；项目是 corepack-pnpm + tsx、且有"加 core 依赖后部署必须先 `--frozen-lockfile` 再重启、否则静态 import 崩"的纪律。**须先确认 aarch64 预编译二进制存在**，否则部署需带构建工具链。
2. **无 TURN = 部分覆盖。** 对称/CGNAT 群体（~10–30%，含多数蜂窝手机，正是 owner 想纳入的）在 v1 无法入站可达，只能 WS 叶子。这是否满足"人人可达"目标，需 owner 拍板（§4 决策点）。
3. **iOS 后台硬限制不可绕。** 若"iOS 后台可达"是硬需求，WebRTC-on-mobile **做不到**（除非违反 App Review）。文案必须诚实，否则用户预期落空 [V2]。
4. **信令信任 / DoS。** 任何节点都能请种子把 `SIGNAL_OFFER` 中继给任意 peerId——已用签名 + 限速 + 1-hop 封顶缓解，但需实测种子在恶意信令洪泛下的表现。
5. **本项目真实用户的 NAT 分布未知。** STUN-only 成功率在 ~90%↔<50% 间摆动，取决于桌面/Wi-Fi 与蜂窝手机的占比。**上 relay 设计前，先用一个 ICE-候选类型遥测 ping 实测**，别迷信文献里的笼统百分比 [V1-finding]。
6. **是否统一 PEX。** 当前保两平面并行（WS URL vs peerId+brokerable）以保持手术式改动；长期统一到 peerId+transport hints 更干净，但改动面更大（动 knownUrls/pinnedUrls/peers.json 机制）。
7. **node-datachannel 单条消息上限须实测确认** ≤ §3.5 假设，且分片同步在真实 SCTP 下逐片重组无误。
8. **知识图谱归档。** 研究专属笔记此前因本机磁盘满（ENOSPC）未能完成 vault 交叉链接（总览 / P2P 笔记 / 研发日志），磁盘清出后需补做，避免图谱不一致。

---

## 9. 参考文献

> 可信度 tier：`standard-rfc`（RFC/学术测量）> `official-docs`（厂商/项目官方文档）> `reputable-engineering`（知名工程博客/项目）> `vendor`（厂商营销页）> `community`（社区/论坛/维基）。
> 裁决标记：[V1]–[V5] 见下方"对抗式裁决"。

1. How NAT traversal works（DERP/STUN/birthday-paradox；IPv6；EIM vs EDM；两对称需 relay）— Tailscale, 2020. https://tailscale.com/blog/how-nat-traversal-works — *reputable-engineering*
2. v0idChain `docs/CLIENT-PROTOCOL.md` §1（address = 0x + ed25519 pubkey hex，全局唯一身份）— 2026. file:///Users/v0id/Documents/v0idchain/docs/CLIENT-PROTOCOL.md — *official-docs*
3. WebRTC TURN Server Setup: Production Guide（ICE 占比；企业 ~85% 需 relay）— Celloip, 2026. https://celloip.com/blog/webrtc-turn-server-production-guide/ — *vendor*；并 BlogGeek.me, 2023. https://bloggeek.me/webrtc-turn/ — *reputable-engineering*
4. WebRTC STUN vs TURN（对称 NAT 需 TURN，~20% 需 relay）— GetStream, 2025. https://getstream.io/resources/projects/webrtc/advanced/stun-turn/ — *vendor*
5. Mass Adoption of NATs: Survey and experiments on carrier-grade NATs（蜂窝 ~40% 对称）— Kanaris & Pouwelse, TU Delft, 2023. https://ar5iv.labs.arxiv.org/html/2311.04658 — *standard-rfc*
6. A Multi-perspective Analysis of Carrier-Grade NAT Deployment — Richter et al., IMC, 2016. https://www.prichter.com/imc176-richterA.pdf — *standard-rfc*
7. Introduction to WebRTC protocols（ICE/STUN/TURN 候选排序）— MDN, 2024. https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols — *official-docs*
8. Data channels（标准 SCTP DataChannel；与浏览器/原生互通）— WebRTC.org, 2026. https://webrtc.org/getting-started/data-channels — *official-docs*；libdatachannel.org, 2026. https://libdatachannel.org/ — *official-docs*
9. UDP hole punching — Wikipedia, 2025. https://en.wikipedia.org/wiki/UDP_hole_punching — *community*
10. RFC 8827 — WebRTC Security Architecture（DTLS 强制）— IETF, 2021. https://datatracker.ietf.org/doc/html/rfc8827 — *standard-rfc*；RFC 5763, 2010. https://datatracker.ietf.org/doc/html/rfc5763 — *standard-rfc*；Securing | WebRTC for the Curious, 2024. https://webrtcforthecurious.com/docs/04-securing/ — *reputable-engineering*
11. App Store Review Guidelines — 2.5.4（后台服务仅限既定用途；PushKit 仅 VoIP）— Apple, 2026. https://developer.apple.com/app-store/review/guidelines/ — *official-docs*
12. About the background execution sequence（挂起；beginBackgroundTask ~30s）— Apple, 2026. https://developer.apple.com/documentation/uikit/about-the-background-execution-sequence — *official-docs*；Extending background execution time. https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time — *official-docs*
13. iOS Background Execution Limits（DTS：挂起、回收套接字、~30s 窗口）— Apple Developer Forums, 2024. https://developer.apple.com/forums/thread/685525 — *official-docs*
14. libp2p specs — webrtc.md（Noise 握手把连接绑定到 PeerId）— 2024. https://github.com/libp2p/specs/blob/master/webrtc/webrtc.md — *official-docs*；libp2p WebRTC docs. https://docs.libp2p.io/concepts/transports/webrtc/ — *official-docs*
15. WebRTC (Browser-to-Server) in libp2p（fingerprint 经不可信信道 → 需第二次 Noise 证明身份）— libp2p blog, 2023. https://blog.libp2p.io/libp2p-webrtc-browser-to-server/ — *official-docs*；RFC 8842（tls-id 缓解 fingerprint 替换）, 2021. https://datatracker.ietf.org/doc/html/rfc8842 — *standard-rfc*
16. iOS PushKit/VoIP Push（非通话 PushKit 拒审；缺 reportNewIncomingCall 终止 App + 吊销 token）— CallSphere, 2026. https://callsphere.ai/blog/vw4e-ios-pushkit-voip-push-ai-inbound-2026 — *community*；iOS Silent Push Limits, 2026. https://medium.com/@shobhakartiwari/ios-silent-push-limits-7d0c65b642f4 — *community*
17. node-datachannel API.md（PeerConnection iceServers / onLocalDescription / onLocalCandidate / addRemoteCandidate / createDataChannel / disableAutoNegotiation）— 2026. https://github.com/murat-dogan/node-datachannel/blob/master/API.md — *reputable-engineering*
18. node-datachannel — npm（v0.32.1，N-API 8，Node ≥18.20，Linux/Win/macOS，prebuilt）— 2026. https://www.npmjs.com/package/node-datachannel — *official-docs*；GitHub murat-dogan/node-datachannel. https://github.com/murat-dogan/node-datachannel — *reputable-engineering*
19. Perfect negotiation（polite/impolite、ignoreOffer、隐式 rollback、trickle ICE）— MDN, 2025. https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation — *official-docs*
20. Perfect negotiation in WebRTC（角色由来）— Mozilla WebRTC blog, 2024. https://blog.mozilla.org/webrtc/perfect-negotiation-in-webrtc/ — *reputable-engineering*
21. Securing coturn: Configuration Guide（no-udp / denied-peer-ip / quota / no-multicast-peers；时限 REST cred）— Enable Security, 2020. https://www.enablesecurity.com/blog/coturn-security-configuration-guide/ — *reputable-engineering*；TURN Server Security Threats. https://www.enablesecurity.com/blog/turn-server-security-threats/ — *reputable-engineering*；Mitigating TURN Amplification Attacks — L7mp, 2021. https://medium.com/l7mp-technologies/mitigating-turn-amplification-attacks-2676bdcb268c — *reputable-engineering*；coturn turnserver wiki, 2024. https://github.com/coturn/coturn/wiki/turnserver — *official-docs*
22. Foreground service types are required（connectedDevice/specialUse 可保活 P2P；dataSync 限时；Play 审 specialUse）— Android Developers, 2025. https://developer.android.com/develop/background-work/services/fgs/service-types — *official-docs*
23. Optimize for Doze and App Standby（Doze 限流；Play 禁为保活申请电池豁免；FCM 共享连接）— Android Developers, 2025. https://developer.android.com/training/monitoring-device-state/doze-standby — *official-docs*
24. Challenging Tribal Knowledge — Large Scale Measurement Campaign on Decentralized NAT Traversal（DCUtR ~70%±7%，4.4M+ 次，TCP≈QUIC）— Trautwein et al., 2026. https://arxiv.org/abs/2604.12484 — *standard-rfc*；libp2p Hole Punching (DCUtR), 2024. https://libp2p.io/docs/hole-punching/ — *official-docs*；libp2p punchr, 2023. https://github.com/libp2p/punchr — *reputable-engineering*
25. Pricing · Cloudflare Realtime docs（TURN 免费 ~1000 GB/月，之后 $0.05/GB）— 2026. https://developers.cloudflare.com/realtime/sfu/pricing/ — *official-docs*；TURN Service. https://developers.cloudflare.com/realtime/turn/ — *official-docs*
26. TURN FAQ · Cloudflare Realtime docs — 2026. https://developers.cloudflare.com/realtime/turn/faq/ — *official-docs*；No-CC TURN free tier（HF token ~10 GB）— Cloudflare Community, 2026. https://community.cloudflare.com/t/no-cc-turn-free-tier/846152 — *community*
27. Network Traversal Service Pricing（TURN $0.40/GB 起，无免费 TURN，~8x 于 Cloudflare）— Twilio, 2026. https://www.twilio.com/en-us/stun-turn/pricing — *vendor*
28. Open Relay Project — Free WebRTC TURN Server（20 GB/月免费）— Metered, 2026. https://www.metered.ca/tools/openrelay/ — *vendor*
29. Always Free Resources（10 TB/月出口；ARM 2026-06-12 砍至 2 OCPU/12GB）— Oracle Cloud, 2026. https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm — *official-docs*
30. Hetzner Cloud / Price Adjustment（CX22 ~€3.79/月含 20 TB）— 2026. https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ — *vendor*
31. Fly.io Resource Pricing（出口 $0.02/GB，入口免费）— 2026. https://fly.io/docs/about/pricing/ — *vendor*
32. STUN-only 成功率 ~75–80%；对称 NAT 需 TURN — VideoSDK, 2025. https://www.videosdk.live/developer-hub/stun-turn-server/stun-server-free — *vendor*；STUN — Wikipedia, 2025. https://en.wikipedia.org/wiki/STUN — *community*
33. WebRTC Swarms: Decentralized, Incentivized, Privacy-Preserving Signaling — MDPI Future Internet, 2025. https://www.mdpi.com/1999-5903/18/1/13 — *reputable-engineering*；webrtc-signaling-mesh — chr15m, 2025. https://github.com/chr15m/webrtc-signaling-mesh — *community*
34. Decentralized Bootstrapping for WebRTC-based P2P Networks — ThinkMind, 2017. http://www.thinkmind.org/articles/web_2017_1_30_40029.pdf — *reputable-engineering*
35. paullouisageneau/libdatachannel（v0.24.5, 2026-06-12, ~2.6k 星，C++17 SCTP/DTLS）— GitHub, 2026. https://github.com/paullouisageneau/libdatachannel — *reputable-engineering*
36. @roamhq/wrtc（node-webrtc 维护分支，包 libwebrtc）— npm, 2026. https://www.npmjs.com/package/@roamhq/wrtc — *official-docs*
37. shinyoshiaki/werift-webrtc releases（纯 TS，维护模式，吞吐弱）— GitHub, 2026. https://github.com/shinyoshiaki/werift-webrtc/releases — *reputable-engineering*；Datachannel performance Issue #55, 2024. https://github.com/shinyoshiaki/werift-webrtc/issues/55 — *community*
38. stasel/WebRTC（Google libwebrtc 经 SPM，~147.x）— GitHub, 2026. https://github.com/stasel/WebRTC — *reputable-engineering*
39. WebRTC — Swift Package Index — 2026. https://swiftpackageindex.com/stasel/WebRTC — *reputable-engineering*
40. GetStream/webrtc-android（libwebrtc AAR，跟 m125，1.3.x）— GitHub releases, 2026. https://github.com/GetStream/webrtc-android/releases — *reputable-engineering*
41. WebRTC in Android: SDKs (2026) — Forasoft, 2026. https://www.forasoft.com/blog/article/webrtc-in-android-520 — *vendor*
42. swarm-cloud/datachannel-native（移动 libdatachannel 封装，停更 2023-08，~28 星，无 SPM/AAR）— GitHub, 2023. https://github.com/swarm-cloud/datachannel-native — *community*
43. webrtc-kmp — WebRTC Kotlin Multiplatform（Android/iOS，Maven Central）— GitHub, 2025. https://github.com/shepeliev/webrtc-kmp — *community*
44. WebRTC 应用真实成本（relay 带宽 / 移动端电量 / CPU）— WebRTC.ventures, 2025. https://webrtc.ventures/2025/10/how-much-does-it-really-cost-to-build-and-run-a-webrtc-application/ — *reputable-engineering*；What is a TURN server — Nabto, 2025. https://www.nabto.com/what-is-a-turn-server-ensuring-reliable-webrtc-connections/ — *vendor*
45. v0idChain `packages/node/src/p2p.ts`（handle / send / broadcast / setupSocket；peers Map<WebSocket>;isPublicWsUrl;CHUNK=500 整链快捷;MAX_WS_PAYLOAD=64MB;MAX_KNOWN=512;HELLO 携 address+listen;QUERY_PEERS/PEERS）— 2026. file:///Users/v0id/Documents/v0idchain/packages/node/src/p2p.ts — *official-docs*
46. v0idChain `packages/node/src/node.ts`（P2PHandlers onBlocks/onTx/onPeer，from: WebSocket 仅作不透明句柄）— 2026. file:///Users/v0id/Documents/v0idchain/packages/node/src/node.ts — *official-docs*
47. WebRTC Signaling Server: How it Works — GetStream, 2024. https://getstream.io/resources/projects/webrtc/basics/signaling-server/ — *vendor*；Understanding WebRTC Security — fsjs.dev, 2024. https://fsjs.dev/understanding-webrtc-security-protecting-real-time-communications/ — *community*
48. Why torrent clients don't work well on iPhone（iOS 挂起网络密集后台 App；MultipeerConnectivity ~3min 被杀；BitChat 为 BLE）— webtor.io, 2025. https://blog.webtor.io/en/post/torrent-clients-iphone/ — *community*

### 对抗式裁决（[V1]–[V5]）

- **[V1] TURN 是否真必需 / STUN-only 是否够 — 裁决：NUANCED。** 免费公共 STUN 让 ~70–90%（EIM/锥形 NAT，主要是桌面/家庭 Wi-Fi）直接打洞；STUN-only **静默排除** ~10–30% 对称 NAT/CGNAT 少数派（集中在蜂窝手机），他们仍可作 WS 叶子参与。依据 [1][4][5][6][32]。
- **[V2] iOS 能否后台保活 WebRTC DataChannel 且 App-Store 可接受 — 裁决：CONFIRMED/NUANCED。** iOS 后台/锁屏 ~30s 挂起并回收套接字 → DataChannel 掉线；VoIP/PushKit 续命违反 2.5.4 → 拒审/吊销 token。**iOS = 前台临时节点**。Android 可用用户主动前台服务保活但受 Doze 限流、且蜂窝多为对称 CGNAT 入站不可拨。依据 [11][12][13][16][22][23][48]。
- **[V3] 是否存在避开生产服务器的免费/近免费 TURN+信令 — 裁决：CONFIRMED。** Cloudflare Realtime TURN（免费 ~1000 GB/月，之后 ~$0.05/GB，独立 SFU、2026 中实测可用）；Twilio 贵 ~8x，不推荐；信令可经志愿节点去中心化（复用现有 WS gossip），非新 SPOF。依据 [25][26][27][33][34]。
- **[V4] 现有 JSON P2PMessage 帧能否原样跑 DataChannel — 裁决：REFUTED（对 BLOCKS 帧）。** SCTP DataChannel 安全互操作上限 16 KiB，>256 KiB 触发硬关；现有 `CHUNK=500`（≈500KB）+ `chain.length<=CHUNK` 整链快捷**超限**。RTC 路径**必须**用 `CHUNK_RTC≈12`（~1KB/块 → 安全落在 16 KiB 内）并**去掉整链快捷**——强制代码改动；WS 路径 `CHUNK=500` 不变。依据 [8][35][45]。
- **[V5] 一套 libdatachannel 通吃 Node+Swift+Kotlin — 裁决：REFUTED。** 仅 Node 侧成立（node-datachannel）；移动 libdatachannel 封装（swarm-cloud/datachannel-native）停更 2023-08、~28 星、无 SPM/AAR。须**混合栈**：Node=libdatachannel，iOS/macOS/Android=Google libwebrtc（stasel/WebRTC、GetStream/webrtc-android）；皆实现 RFC 8831/8832，线上互通、不共享代码。依据 [17][18][35][38][39][40][42]。
