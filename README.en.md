# v0idChain — anonymity network · blockchain · on-chain game

**English | [中文](README.md)**

A from-scratch, hand-rolled TypeScript project that grew three working things: a **Tor-style onion anonymity network (v0idnet)**, the **home-grown blockchain ($V0ID)** it runs on, and a **fully on-chain pixel game**. A pnpm monorepo; `tsx` runs the `.ts` directly, no build step.

> Honest up front: this is a **hand-rolled / educational-grade** implementation (not audited production crypto). The anonymity network is real in design, but a small network = weak anonymity. Each module is described at its true maturity.

---

## 🧅 v0idnet — the `.v0id` onion anonymity network (the headline)

> **[→ module docs: docs/v0idnet/](docs/v0idnet/README.en.md)** · [architecture & how it works (with diagrams)](docs/v0idnet/ARCHITECTURE.md)

A Tor-style onion network: visitor and server communicate over **3-hop encrypted circuits**, and `.v0id` hidden services let **both sides hide their IP from each other**. The blockchain serves as the **decentralized relay directory** (replay the chain → a consistent relay list, replacing Tor's directory authorities).

- **Browse / host `.v0id` hidden services** · **run a relay** · **Mixnet** (opt-in) · **staking incentive layer** (built, activates at height 16000)
- **Download the v0id Browser** (signed + notarized macOS app): [browser-v0.2.0](https://github.com/v0id-byte/v0idchain/releases/tag/browser-v0.2.0) · Windows/Linux coming soon
- **Live network**: seed `mc.void1211.com:6001` + 6 relays; a real 3-hop circuit is verified

## ⛓ v0idChain — the $V0ID blockchain (the base)

> **[→ module docs: docs/blockchain/](docs/blockchain/README.en.md)** · [run a node](docs/blockchain/RUNNING-A-NODE.md) · [full tutorial](docs/blockchain/TUTORIAL.en.md)

Hand-written blocks / hashing / PoW mining (adaptive difficulty + Bitcoin-style retargeting + heaviest-chain rule) / ed25519 signatures / WebSocket P2P. Coins come from mining; transfers pay a fee (gas) to the miner. Both v0idnet and the game run on top of it.

- Transfers · on-chain **messages** (burn-to-void) · globally-unique **nicknames** · end-to-end **encrypted DMs** · **red packets** · **marketplace**
- Every social/game/anonymity feature is layered on via **memo conventions**, mostly without consensus changes

## 🎮 On-chain game — a pixel social world click game.void1211.com to have fun!

> **[→ module docs: docs/game/](docs/game/README.en.md)**

A **fully on-chain pixel social world**: collect creatures/NFTs, farm, fish, and mine, all feeding a **Void Codex** collection meta. Built entirely on the blockchain's memo conventions (no consensus changes).

---

## Quick start

```bash
corepack pnpm install                 # Node 18+, pnpm ships with the repo
# Run a node + mine (see each module's docs)
corepack pnpm exec tsx packages/cli/src/index.ts start --mine --peers ws://mc.void1211.com:6001
```

- **Want anonymous browsing** → [v0idnet quick start](docs/v0idnet/README.en.md)
- **Want the chain / to build** → [blockchain quick start](docs/blockchain/README.en.md) + [tutorial](docs/blockchain/TUTORIAL.en.md)
- **Want to play the game** → [game docs](docs/game/README.en.md)

## Repo layout

| Directory | Contents |
|---|---|
| `packages/core` | chain + onion protocol + game logic (`onion*` `hs*` `mixnet` / `pets` `farm` `fishing` `mine`) |
| `packages/node` | P2P + local API + the relay subsystem (`relay/*`) |
| `packages/cli` | the `v0id` command-line daemon |
| `packages/game-server` · `game-web` · `web` | game backend/frontend · web wallet |
| `clients/desktop` | the v0id Browser (Electron) |
| `docs/{v0idnet,blockchain,game}/` | the three module docs |

## Honest boundaries & attribution

Small anonymity set = weak anonymity; no defense against a global passive adversary or application-layer deanonymization; v1 incentives use a centralized measurer. Each module's docs carry detailed honest boundaries. Third-party licenses/attribution in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); v0idnet's ideas draw on Tor / Nym / Orchid / Lokinet (see file headers and [ARCHITECTURE §9](docs/v0idnet/ARCHITECTURE.md)).
