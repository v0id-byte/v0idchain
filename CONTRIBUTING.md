# Contributing to v0idChain / 参与贡献

First: thank you. v0idChain is a hand-rolled, read-it-end-to-end blockchain fused with an anonymity network and an on-chain game. It's meant to be understood and hacked on. This guide gets you from clone to pull request.

首先,谢谢你。v0idChain 是一套「能从头读到尾」的手搓区块链,融合了匿名网络和链上游戏,本就是给人读懂、给人魔改的。这份指南带你从 clone 走到 PR。

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).
参与即表示你同意我们的[行为准则](CODE_OF_CONDUCT.md)。

---

## Ways to contribute / 贡献方式

You do **not** need to understand consensus to help. See the **Good first issues** in [ROADMAP.md](ROADMAP.md#good-first-issues--新人友好任务):
不需要懂共识也能贡献,见 [ROADMAP.md](ROADMAP.md#good-first-issues--新人友好任务) 的新人任务:

- **Docs & i18n** — English mirrors, typo/clarity fixes.
- **Tests** — add edge cases to `scripts/smoke.ts`, document a `scripts/*-test.ts`.
- **Docker / DX** — image improvements, a `docker compose` two-node net.
- **Game & pixel art** — assets/content in `packages/game-web`.
- **Bug reports** — open an issue with the [templates](.github/ISSUE_TEMPLATE) (pick the right module).
- **Protocol / consensus** — bigger changes; please open an issue to discuss first (see soft-fork note below).

---

## Dev setup / 开发环境

Requirements: **Node.js ≥ 22.13**. The repo pins pnpm via corepack — no global install needed.
要求:**Node.js ≥ 22.13**。仓库用 corepack 固定 pnpm 版本,无需全局安装。

```bash
corepack pnpm install            # install deps (pnpm ships with the repo)

# run a local node + mine (single terminal)
corepack pnpm dev:node1
# a second peer (another terminal)
corepack pnpm dev:node2

# or join the live network and mine
corepack pnpm mine
```

Full node guide: [docs/blockchain/RUNNING-A-NODE.md](docs/blockchain/RUNNING-A-NODE.md) · walkthrough: [docs/blockchain/TUTORIAL.md](docs/blockchain/TUTORIAL.md).
There is **no build step** for development — [`tsx`](https://github.com/privatenumber/tsx) runs the TypeScript directly.
开发**无构建步骤**——`tsx` 直接跑 TypeScript。

Prefer Docker? `docker build -t v0idchain . && docker run --rm v0idchain` starts a node that joins the live net.

---

## Running the checks / 跑测试

The same checks run in [CI](.github/workflows/ci.yml). Run them before opening a PR:

```bash
corepack pnpm -r run typecheck                       # strict tsc across all packages
corepack pnpm smoke                                  # single-process end-to-end (~40s)
corepack pnpm exec tsx scripts/onion-selftest.ts     # onion routing
corepack pnpm exec tsx scripts/mint-selftest.ts      # mint / ecash layer
corepack pnpm exec tsx scripts/antireplay-test.ts    # relay anti-replay
```

`scripts/` holds many more standalone `.ts` checks (relay, hidden service, staking, mixnet…). Run any with `corepack pnpm exec tsx scripts/<name>.ts`.

`scripts/` 里还有很多独立的 `.ts` 检查(中继、隐藏服务、质押、mixnet……),都用 `corepack pnpm exec tsx scripts/<名>.ts` 跑。

---

## Repo map / 模块地图

Maintainer: [@v0id-byte](https://github.com/v0id-byte). It's a small project — when in doubt, open an issue.
维护者:[@v0id-byte](https://github.com/v0id-byte)。项目还小,拿不准就开 issue。

| Area | Path | What lives here |
|---|---|---|
| Core chain | `packages/core/src` (`block.ts` `transaction.ts` `blockchain.ts`) | blocks, PoW, tx, `applyTx`/`computeState` |
| Social/game logic | `packages/core/src` (`messages.ts` `names.ts` `redpacket.ts` `pets.ts` `farm.ts` `fishing.ts`) | memo-convention features |
| Anonymity net | `packages/core/src` (`onion*` `hs*` `mixnet.ts`) + `packages/node/src/relay/*` | circuits, hidden services, relays |
| Node / RPC | `packages/node` | P2P, local API, relay subsystem |
| CLI daemon | `packages/cli` | the `v0id` command |
| Web wallet | `packages/web` | React + Vite dashboard |
| Game | `packages/game-server` · `packages/game-web` | server + canvas pixel client |
| Native clients | `clients/desktop` (Electron) | the v0id Browser |
| Docs | `docs/{blockchain,v0idnet,game}` | protocol specs + guides |

---

## Coding style / 代码风格

- **TypeScript strict** everywhere (`tsconfig.base.json`); no new `tsc` errors.
- **Match the surrounding code** — naming, structure, comment density. Comments in this repo are often Chinese; keep the local style.
- **Prefer memo-convention soft-forks over consensus changes.** Most social/game/anonymity features are layered on `tx.memo` with deterministic validation and an activation height, so old nodes stay compatible. Reuse the existing patterns in `redpacket.ts` / `staking.ts` before touching consensus.
- Keep changes **surgical** — touch only what your change needs.

- 全仓 **TypeScript strict**,不引入新的 `tsc` 报错。
- **贴合周边代码**风格(命名/结构/注释密度),本仓注释多为中文,保持本地风格。
- **优先走 memo 约定软分叉,而非改共识**:大多数功能叠在 `tx.memo` 上,带确定性校验和激活高度,老节点保持兼容。动共识前先复用 `redpacket.ts` / `staking.ts` 的现成模式。
- 改动要**外科手术式**,只碰你需要碰的。

---

## Pull requests / 提 PR

1. Branch off `main` (e.g. `fix/…`, `feat/…`, `docs/…`).
2. Keep commits scoped to one logical change; message in Chinese or English is fine.
3. Run the checks above; make sure typecheck + smoke pass.
4. Fill in the [PR template](.github/pull_request_template.md) — including the **soft-fork compatibility** box if you touched validation/consensus.
5. Open the PR against `main`. Small, focused PRs get reviewed fastest.

1. 从 `main` 开分支;2. 每个 commit 只做一件事,中英文皆可;3. 跑上面的检查,确保 typecheck + smoke 通过;4. 填 [PR 模板](.github/pull_request_template.md)(动了校验/共识就勾**软分叉兼容性**);5. 对 `main` 开 PR,小而聚焦的 PR 审得最快。

---

## Scope & safety / 范围与安全

v0idChain is an **experimental, educational testnet** — see [DISCLAIMER.md](DISCLAIMER.md). Please don't use it to host or facilitate illegal content. Security issues in the crypto/anonymity code are especially welcome — but note this is not audited production crypto, so treat findings as learning, not zero-days for real funds.

v0idChain 是**实验性、教学性测试网**,见 [DISCLAIMER.md](DISCLAIMER.md)。请勿用它托管或促成非法内容。尤其欢迎针对密码学/匿名代码的安全问题——但请注意这不是经过审计的生产密码学。
