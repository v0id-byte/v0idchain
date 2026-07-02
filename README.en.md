# v0idChain — anonymity network · blockchain · on-chain game

**English | [中文](README.md)**

[![CI](https://github.com/v0id-byte/v0idchain/actions/workflows/ci.yml/badge.svg)](https://github.com/v0id-byte/v0idchain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/v0id-byte/v0idchain?style=social)](https://github.com/v0id-byte/v0idchain/stargazers)

A from-scratch, hand-rolled TypeScript project that grew three working things: a **Tor-style onion anonymity network (v0idnet)**, the **home-grown blockchain ($V0ID)** it runs on, and a **fully on-chain pixel game**. A pnpm monorepo; `tsx` runs the `.ts` directly, no build step — **a whole system you can read end to end**.

> Honest up front: this is a **hand-rolled / educational-grade** implementation (not audited production crypto). The anonymity network is real in design, but a small network = weak anonymity. Each module is described at its true maturity.

---

## 🧅 v0idnet — the `.v0id` onion anonymity network (the headline)

> **[→ module docs: docs/v0idnet/](docs/v0idnet/README.en.md)** · [architecture & how it works (with diagrams)](docs/v0idnet/ARCHITECTURE.md)

A Tor-style onion network: visitor and server communicate over **3-hop encrypted circuits**, and `.v0id` hidden services let **both sides hide their IP from each other**. The blockchain serves as the **decentralized relay directory** (replay the chain → a consistent relay list, replacing Tor's directory authorities).

- **Browse / host `.v0id` hidden services** · **run a relay** · **Mixnet** (opt-in) · **staking incentive layer** (built, activates at height 16000)
- **Download the v0id Browser** (signed + notarized macOS app): [browser-v0.2.6](https://github.com/v0id-byte/v0idchain/releases/tag/browser-v0.2.6) · Windows/Linux coming soon
- **Live network**: seed `mc.void1211.com:6001` + 5 relays (AWS ×3 + RackNerd ×2); a real 3-hop circuit is verified

## ⛓ v0idChain — the $V0ID blockchain (the base)

> **[→ module docs: docs/blockchain/](docs/blockchain/README.en.md)** · [run a node](docs/blockchain/RUNNING-A-NODE.en.md) · [full tutorial](docs/blockchain/TUTORIAL.en.md)

Hand-written blocks / hashing / PoW mining (adaptive difficulty + Bitcoin-style retargeting + heaviest-chain rule) / ed25519 signatures / WebSocket P2P. Coins come from mining; transfers pay a fee (gas) to the miner. Both v0idnet and the game run on top of it.

- Transfers · on-chain **messages** (burn-to-void) · globally-unique **nicknames** · end-to-end **encrypted DMs** · **red packets** · **marketplace**
- Every social/game/anonymity feature is layered on via **memo conventions**, mostly without consensus changes

## 🎮 On-chain game — a pixel social world click game.void1211.com to have fun!

> **[→ module docs: docs/game/](docs/game/README.en.md)**

A **fully on-chain pixel social world**: collect creatures/NFTs, farm, fish, and mine, all feeding a **Void Codex** collection meta. Built entirely on the blockchain's memo conventions (no consensus changes).

---

## Quick start

```bash
corepack pnpm install                 # Node ≥ 22.13, pnpm ships with the repo
# Run a node + mine (see each module's docs)
corepack pnpm exec tsx packages/cli/src/index.ts start --mine --peers ws://mc.void1211.com:6001

# Or one command with Docker — start a node that joins the live net:
docker build -t v0idchain . && docker run --rm v0idchain
```

- **Want anonymous browsing** → [v0idnet quick start](docs/v0idnet/README.en.md)
- **Want the chain / to build** → [blockchain quick start](docs/blockchain/README.en.md) + [tutorial](docs/blockchain/TUTORIAL.en.md)
- **Want to play the game** → [game docs](docs/game/README.en.md)
- **Want to contribute** → [ROADMAP.md](ROADMAP.md) + [CONTRIBUTING.md](CONTRIBUTING.md)

## Repo layout

| Directory | Contents |
|---|---|
| `packages/core` | chain + onion protocol + game logic (`onion*` `hs*` `mixnet` / `pets` `farm` `fishing` `mine`) |
| `packages/node` | P2P + local API + the relay subsystem (`relay/*`) |
| `packages/cli` | the `v0id` command-line daemon |
| `packages/game-server` · `game-web` · `web` | game backend/frontend · web wallet |
| `clients/desktop` | the v0id Browser (Electron) |
| `docs/{v0idnet,blockchain,game}/` | the three module docs |

## Contributing

Want to join? Start with [ROADMAP.md](ROADMAP.md) — it lays out the **direction, the token-value thesis ($V0ID = the economic layer that lets an open anonymity network resist abuse, Sybils, and censorship without surveillance), and good first issues**. Dev setup, tests, and the module map are in [CONTRIBUTING.md](CONTRIBUTING.md). **You don't need to understand consensus to help** — docs, i18n, tests, Docker, and pixel art are all welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## ⚠️ Disclaimer

v0idChain is an **experimental, educational testnet**: the **token has no monetary value and is not an investment**; the anonymity network is a research-grade implementation (not audited production crypto, small network = weak anonymity); **you are responsible for local-law compliance**; the project **does not host, endorse, or facilitate** any illegal content. Full text in [DISCLAIMER.md](DISCLAIMER.md).

## Honest boundaries & attribution

Small anonymity set = weak anonymity; no defense against a global passive adversary or application-layer deanonymization; v1 incentives use a centralized measurer. Each module's docs carry detailed honest boundaries. Third-party licenses/attribution in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); v0idnet's ideas draw on Tor / Nym / Orchid / Lokinet (see file headers and [ARCHITECTURE §9](docs/v0idnet/ARCHITECTURE.md)).
