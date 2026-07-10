# v0idChain Roadmap

> **Ecosystem thesis** — **$V0ID is the shared economic layer of a multi-product chain OS**: gas, burn, escrow, and settlement across **privacy (v0idnet), on-chain game, social, and payments (mint)** — not a single-app coin.
>
> **生态总纲** —— **$V0ID 是多产品链上操作系统的共享经济层**：在 **隐私网 · 链上游戏 · 社交 · 支付（Mint）** 之间统一承担 gas / 燃烧 / 托管 / 结算，而不是「只能解释匿名」的单用途币。
>
> **Privacy track (still core)** — On the anonymity branch, $V0ID is still the layer that resists abuse, Sybils, and censorship *without surveillance* (cost instead of identity). That track is **旗舰分支，不是唯一叙事**.
>
> **隐私主线（仍是旗舰）** —— 在匿名分支上，$V0ID 仍是不靠监控、用成本抵御滥用/女巫/审查的经济层。这是旗舰能力，**并列于**游戏与社交，而非生态的唯一故事。

This document is the source of truth for where the project is going. It is intentionally opinionated. Nothing here is a promise of delivery dates — it's a direction and a menu of work. Contributions against any item are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

本文件是项目方向的权威来源,刻意带有观点。这里没有交付日期承诺,只是方向和一份「可做的工作清单」。欢迎针对任何一项贡献,见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## Product pillars / 产品支柱

| Pillar | Role | Docs |
|---|---|---|
| ⛓ Chain + $V0ID | Shared ledger, memo conventions, wallets | `docs/blockchain/` |
| 🧅 v0idnet | Flagship anonymity network + browser | `docs/v0idnet/` |
| 🎮 On-chain game | Fun surface, collectibles, onboarding | `docs/game/` |
| 💬 Social (mini-X) | Public timeline, follows, DMs (off-chain) | **[v0id-social](https://github.com/v0id-byte/v0id-social)** (private product repo) |
| 💳 Mint / pay | E-cash tickets, future paywall | `docs/v0idnet/MINT-PROTOCOL.md` |

---

## Why the token isn't "single-purpose" — and why that's not the point

$V0ID already has real sinks today: burning to post on-chain messages, hatching/breeding pets, buying farmland, catching fish, claiming nicknames, red packets, relay staking, and mint redemption fees. Upcoming **social posts/follows** add another public-square sink. The gap was never only *features* — it was a **narrative** that ties pillars together: one coin, four roles (gas / burn / escrow / settlement).

$V0ID 今天已有一串消耗场景(消息、宠物、买地、钓鱼、昵称、红包、中继质押、mint 抽成)；规划中的**社交发帖/关注**再加公域 sink。缺的不只是功能清单,而是把多支柱串起来的叙事:**一个币,四种用法**。

The L1–L3 tracks below remain the **privacy-branch** value design (what only chain × anonymity does well). They do **not** demote game or social — those pillars have their own burn/UX loops documented in their modules.

下列 L1–L3 仍是**隐私分支**的价值设计(链×匿名才做得好的事)。它们**不**压过游戏或社交——后两者在各自模块里有独立的 burn/体验闭环。

---

## Token value tracks / 代币价值三主线

### L1 — Anti-abuse & anti-Sybil fuel (primary) / 反滥用 · 反女巫燃料(主推)

The unsolved problem of every anonymity network is Sybil attacks and flooding: one actor forges thousands of identities, or drowns a service in traffic. The classic defenses all require *identifying* users. We use economic cost instead.

每个匿名网络最难的问题都是女巫攻击和洪泛:一个人伪造成千上万个身份,或用流量淹没服务。经典防御全都要求「识别」用户,我们改用经济成本。

| Feature | Idea | Implementation path | Status |
|---|---|---|---|
| Staked pseudonymous identity | An identity requires a stake — forging many is expensive, but the real person stays hidden | memo convention + escrow, modeled on `packages/core/src/staking.ts` & `names.ts` | design |
| Pay-to-host hidden services | Burn/pay to keep a `.v0id` site pinned & served (couples with L2) | memo convention + escrow, see `relays.ts` | design |
| Anti-spam DMs / service requests | Per-message burn so bots can't afford to flood | extends existing message burn in `config.ts` / `messages.ts` | design |

Unifying story: the existing message-burn and relay-stake are already the seed of this — L1 just names the pattern and grows it. Selling point: **"privacy, but not a free-for-all for abuse; censorship-resistant, but not by de-anonymizing anyone."**

统一叙事:现有的「发消息烧币」「当中继质押」本就是它的雏形,L1 只是给这个模式命名并让它长大。卖点:**「隐私,但不放任滥用;抗审查,但不靠人肉。」**

### L2 — Ticket to a censorship-resistant hosting platform / 抗审查托管平台门票

The anonymity network + on-chain relay directory = a platform that can't be taken down. The token pays relays to pin and serve content — a concrete service (keep my anonymous site alive), not an abstract "bandwidth market". This gives relay operators **real revenue** and deepens the existing incentive loop (`staking.ts` + reward-epoch + mint fee recycling).

匿名网 + 链上中继目录 = 一个拿不下来的托管平台。代币付费让中继 pin/serve 内容——这是具体服务(帮我保活匿名站点),而非抽象的「带宽市场」。它给中继运营者**真实收入**,并强化现有激励闭环(`staking.ts` + reward-epoch + mint 抽成回流)。

### L3 — On-chain governance / 链上治理权

Stake-weighted voting over the things the network actually needs to decide: which relays are trusted, protocol parameters, slashing decisions, soft-fork activation. The token becomes governance power over the anonymity network itself. Minimal first version: off-chain vote counting anchored on-chain, before full on-chain tallying.

质押加权投票,决定网络真正需要拍板的事:哪些中继可信、协议参数、罚没决定、软分叉激活。代币成为对匿名网络本身的治理权。最小首版:链下计票 + 链上锚定,再演进到完整链上计票。

### Cross-cutting (under discussion, not committed) — scarcity / 横切(待议,未承诺)——稀缺性

Emission today is 1 coin/block forever, no halving, no cap — purely inflationary, with no "why hold" answer. A clear monetary policy (halving/cap + usage-burn, so the more the network is used the more is burned) is itself a value lever and can stack on any track above. Listed here for discussion; **not a commitment**.

当前发行是每块 1 币、永不减半、无上限——纯通胀,没有「为什么持有」的答案。一个清晰的货币政策(减半/上限 + 使用即燃烧,用得越多烧得越多)本身就是价值杠杆,可叠加在上面任一主线上。此处仅供讨论,**不作承诺**。

---

## Module roadmaps / 模块路线

### ⛓ Blockchain ($V0ID)
- Wire the L1/L2 memo conventions above onto the existing `applyTx` / `computeState` path (reuse the red-packet & staking escrow patterns).
- A clear monetary-policy decision (see cross-cutting).
- Broaden the standalone test scripts toward a discoverable suite (they already run under `tsx`).

### 🧅 v0idnet (anonymity network)
- Deepen relay incentives into the L2 pay-to-host service.
- Continue hidden-service resilience work (self-healing circuits, descriptor refresh).
- Windows/Linux builds of the v0id Browser (currently macOS-only).

### 🎮 On-chain game
- The token's social/collectible economy as a low-risk, fun surface that showcases memo-convention design.
- Pixel-art assets and content (great for non-protocol contributors — see good first issues).
- Keep **game activity feed** separate from the public social timeline (see social pillar).

### 💬 Social (mini-X) — design phase
> **Authority (product + design):** **[v0id-byte/v0id-social](https://github.com/v0id-byte/v0id-social)** (private) · local `~/Documents/v0id-social`  
> **Pointer only in this repo:** [docs/social/README.md](docs/social/README.md)

- **Phase A (docs):** moved to v0id-social — protocol, storage, security, performance, S1–S5 roadmap; open-source policy note (default private product).
- **Phase B (after review):** app code in v0id-social; thin memo parser (`VPOST|` …) lands here via PR to `packages/core`.
- Independent of game `deriveFeed`; reuses `NAME|`; burn on public actions; off-chain DMs by default.

### 💬 社交（迷你 X）— 设计阶段
> **权威文档 / 产品仓：** [v0id-social](https://github.com/v0id-byte/v0id-social)（私有）

- Phase A 文档已迁至社仓；本仓只留指针。链上 memo 实现仍以 PR 进本仓 `core`。
- 产品默认**不必开源**（先私有，稳定后再决定）；见社仓 `docs/OPEN-SOURCE.md`。

---

## Community & infra / 社区与基础设施
- ✅ CI (typecheck + smoke + core selftests), Docker one-command node, issue/PR templates, CONTRIBUTING, Code of Conduct — *this batch*.
- ⏳ A hosted docs site (GitHub Pages) so docs are readable without `git clone`.
- ⏳ Full English mirrors of the module docs / this roadmap (good i18n first issues).
- ⏳ A short demo GIF/asciinema in the README (mining a block, sending a message).

---

## Good first issues / 新人友好任务

You do **not** need to understand consensus to help. Great entry points:

不需要懂共识也能贡献,推荐的入口:

- **Docs & i18n** — English mirrors of docs, fix typos, clarify `RUNNING-A-NODE`.
- **Tests** — convert a `scripts/*-test.ts` into a documented, easy-to-run check; add edge-case coverage to `scripts/smoke.ts`.
- **Docker/DX** — slim the image, add a `docker compose` for a 2-node local net.
- **Game/pixel art** — assets and content under `packages/game-web` (see `docs/game/`).
- **Web wallet UX** — small usability fixes in `packages/web`.

Look for issues labeled `good first issue`. New to the codebase? Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the module map there.

找带 `good first issue` 标签的 issue。第一次接触代码库?从 [CONTRIBUTING.md](CONTRIBUTING.md) 和里面的模块地图开始。
