# Void World · An On-Chain Pixel Social World 🎮

**English | [中文](./README.md)**

> One of v0idChain's three modules.
> [🏠 Hub (root README)](../../README.md) · [⛓ Blockchain (the base)](../blockchain/README.md) · [🧅 v0idnet anonymity network (the headline)](../v0idnet/README.md) · **🎮 On-chain game (this module)**

A pixel social world that runs **entirely on-chain**: raise *pets* (on-chain genetic NFTs), farm, fish, and mine — then mint every collectible into the **Void Codex (虚空图鉴)**, a wall of treasures that is **unforgeable and permanently queryable from the chain**.

This is not a throwaway demo. It's a **real game**, and the best "it works, and it's fun" showcase for the `$V0ID` chain: everything of value (pets, catches, crops, ore, land) is an **on-chain asset**, minted by the player's own **signature** and validated by **every node on the network**. The game server cannot alter a single byte of it.

> 🎨 **Pixels are the foundation, not a shortcut.** Pixel art, monospace type, hard pixel shadows throughout — no rounded corners, no frosted glass, no gradients. The aesthetic *is* part of the design.

---

## Contents

- [For players](#for-players)
  - [What it is](#what-it-is)
  - [Gameplay at a glance](#gameplay-at-a-glance)
  - [The Void Codex: the spine](#the-void-codex-the-spine)
  - [How to play](#how-to-play)
- [For developers](#for-developers)
  - [Architecture in one line](#architecture-in-one-line)
  - [The three-layer rule](#the-three-layer-rule)
  - [Code map](#code-map)
  - [memo conventions = on-chain assets](#memo-conventions--on-chain-assets)
  - [Deterministic rendering: same gene, same look everywhere](#deterministic-rendering-same-gene-same-look-everywhere)
  - [Economy parameters](#economy-parameters)
  - [Boundary guard & security posture](#boundary-guard--security-posture)
  - [Run it locally](#run-it-locally)
  - [Design docs](#design-docs)

---

# For players

## What it is

A Stardew-flavored **pixel social world**, but its substrate is the `$V0ID` blockchain:

- Walk into your room, the town center, your farm, the cave on the east side; visit other players' homes.
- Collect **four categories of on-chain treasures** — pets, fish, crops, ore — each one **written to the chain and impossible to forge**.
- Aggregate your trophies into the **Void Codex** and export a pixel **brag card PNG** in one click.

By design it **doesn't chase DAU and has no daily check-ins**: its identity is "teaching showcase + social toy". Friction is **ritualized** (the loot-box-style reveal, the sting of burning coins — both are part of the experience), and retention comes from the urge to *collect*, not from streaks.

## Gameplay at a glance

| Feature | What you do | On-chain output | Status |
| --- | --- | --- | --- |
| **Pets (PET NFT)** | Hatch an on-chain genetic pet; breed offspring with "mom's eyes, dad's pattern"; evolve for a visual aura; gift pets to friends | A unique pixel pet whose look is fixed by its gene | ✅ Implemented |
| **Farm (planting)** | Buy land (dynamic price) → build a field → plant turnip/wheat/pumpkin/starfruit → grow by block height → harvest | On-chain collectible crops (quality from the harvest block hash) | ✅ Implemented |
| **Stationing a pet** | Assign a pet to a field to **deterministically speed up** crop growth (by rarity + evolution tier) | The pet is locked while stationed (can't breed/transfer) | ✅ Implemented |
| **Fishing** | Play a cast-and-reel QTE at the water's edge; mint the catch you like onto the chain | An on-chain catch (species/rarity from the block hash) | ✅ Implemented |
| **Mine / cave** | Descend and mine; mint a "discovery proof" or "material" onto the chain | On-chain ore assets (purity/rarity from the block hash) | ✅ Core implemented · pixel art TBD |
| **Void Codex + brag card** | View the rarity wall + collection completion across all four categories; export a pixel brag card PNG | A shareable PNG | ✅ Implemented |
| **Room / visiting / social card** | Decorate your room, visit others, view on-chain social cards | Room layout (convenience layer) + on-chain aggregated card | ✅ Implemented |
| **Crop P2P secondary market** | Trade crops / land between players | `CROPX` / `LANDX` | 🚧 Phase 2 (memo prefix reserved, not yet processed) |
| **Live town-center presence** | See other players walking around the world | WebSocket (off-chain) | 🚧 Stage 1 (protocol defined; see GAME-PROTOCOL §2.5) |

> **Where rarity comes from (across all four categories):** rarity = the number of **leading-zero bits** in the asset's on-chain hash (≥5 rare / ≥8 epic / ≥12 legendary, probability `2⁻ᵏ`). Same philosophy as mining — rarity is "you happened to hash a lot of leading zeros", so **nobody can forge a legendary**. And the hash mixes in the **block hash, which is only fixed after the block is mined**, so re-casting, hacking the front-end JS, or cherry-picking a txid all get you nowhere: **the economy is anti-cheat by construction.**

## The Void Codex: the spine

The four gameplay loops look separate on the surface, but they all **feed one collection meta** — the Void Codex. It aggregates pets / fish / crops / ore into one wall:

- **Rarity trophy wall**: how many of each tier (common / rare / epic / legendary).
- **Collection completion** (Pokédex-style): how many fish species, crops, and ore kinds you've gathered.
- **Crown jewels**: the top 5 of all your treasures by rarity.
- **Brag card PNG**: render all of the above into a single pixel card and download it to share.

The Codex **records on-chain assets only** (verifiable, unforgeable = the entire point of a codex); fruit in your single-player inventory or backyard plots don't count.

## How to play

1. **Open the game** — live: **[game.void1211.com](https://game.void1211.com)** (deployment details in [DEPLOY-game.md](./DEPLOY-game.md)).
2. **Get coins automatically** — on first visit, the faucet sends a `$V0ID` grant to your new address (once per address, **moved** from the central-bank premine pool, not minted out of thin air).
3. **Mint your first treasure** — hatch a pet at the pedestal, press `E` at the water to fish, or plant in the farm. **Your wallet private key never leaves your local browser** — every "write" action is signed locally and the server only broadcasts it for you.
4. **Collect & show off** — fill the Void Codex and export a brag card.

> Want a native experience? The repo also has native light / desktop clients in progress (see the root README). This module's game-web is the **browser** entry point.

---

# For developers

## Architecture in one line

**A fully on-chain game, built on the `$V0ID` chain's "memo conventions" — no consensus changes, no soft fork, zero system-side minting.**

Every gameplay loop (pets / farm / fishing / mine) is the same humble transaction: a **self-transfer (`from === to`) + a coin burn (`burn > 0`) + a `memo` prefix**. To an old node this is just a valid "self-message" — accepted as-is — so **no consensus change and no soft fork are needed**. Any node can replay the chain (pure functions `parseXxx(chain)`) to reconstruct all game state, **reorg-safe and byte-for-byte identical across clients**.

```
Browser (core/browser: build + ed25519-sign locally)
   │  POST /api/tx  { tx: <signed transaction> }
   ▼
game-server  ──(forward only, never co-signs, holds node token)──►  v0idChain node  POST /tx/submit  ──► network broadcast
```

The game server is a **non-authoritative convenience layer**: it forwards read-only chain queries, broadcasts already-signed transactions, runs the faucet, and stores room layouts / presence. If it **goes down, nobody loses anything of value**, and it **cannot conjure on-chain value** out of nothing.

## The three-layer rule

| Layer | Role | What lives there |
| --- | --- | --- |
| Client (game-web) | Instant, zero-latency | World rendering, walking, animation, fishing/mining QTE, outfit preview |
| Game server (game-server) | **Non-authoritative convenience layer** | Read-only chain proxy, forwarding signed txns, faucet, room layout bytes, presence |
| v0idChain (core/node) | **The only source of value truth** | Pets/crops/catches/ore (NFTs), `$V0ID` balances, land ownership, names, marketplace |

This rule is enforced by tooling via `scripts/check-boundaries.ts` (see below).

## Code map

```
packages/
├── core/src/          Blockchain core + the game's "value truth layer" (pure functions, no UI)
│   ├── pets.ts        Pet NFTs: hatch/breed(breedGene)/evolve/station + parsePets + petTraits
│   ├── farm.ts        Farm: buy land/build field/plant/harvest + parseFarm + dynamic landPrice + growth/quality
│   ├── fishing.ts     Fishing: mint catch + parseFish + fishTraits (rarity reuses petRarity)
│   ├── mining.ts      Mine: discovery proof/material minting + parseMines + mineTraits (on-chain authority, 8 ore kinds)
│   ├── mine.ts        Client-side mine metadata (art/icons, browser export)
│   └── feed.ts        Network activity-feed aggregation (deriveFeed)
├── game-server/src/   Non-authoritative convenience layer (Node HTTP, binds 127.0.0.1)
│   ├── server.ts      All HTTP endpoints (read-only proxy / /api/tx / /api/faucet / rooms / profile / feed)
│   ├── faucet.ts      The only coin spout: moves from the central-bank pool (cap + rate limit + global cap)
│   ├── security.ts    Security headers / CORS allowlist / per-IP rate limit / strict input validation
│   ├── rooms.ts       Room layout bytes (key = owner address, with on-chain version hash)
│   └── chain.ts       Upstream node RPC wrapper
└── game-web/src/      React game UI (Vite)
    ├── App.tsx        Main state machine: 7 panels (codex/wallet/pets/fish/farm/mine/profile)
    ├── Codex.tsx      Void Codex: four-category aggregation + completion + brag card
    ├── pet-render.ts / fish-render.ts / crop-render.ts   Procedural pixel rendering (same gene/hash → same look)
    ├── brag-card.ts   Brag card PNG export
    ├── engine/        2D pixel engine: scene/ground/buildings/foliage/light/mine… (procedural "fake 3D")
    └── FarmPanel / FishingModal / Social / Hotbar / RevealOverlay …
```

> ⚠️ **The mine has two metadata sources**: `mining.ts` is the **on-chain authority** (8 ore kinds: copper/iron/silver/gold/amethyst/void_crystal/starcore/ancient_relic, with `parseMines` + validation + `burn` computation), and both the game-server and the browser Codex use it; `mine.ts` is an earlier client-side metadata subset (5 kinds). New code should treat `mining.ts` as canonical.

## memo conventions = on-chain assets

Each subsystem encodes its assets into a `memo` prefix. All are **`from===to` + `burn>0`**, and only "settle" after their own pure function `parseXxx(chain)` validates ownership / burn / state:

| Subsystem | memo | Action | Burn |
| --- | --- | --- | --- |
| Pet | `PET\|` | Hatch (pet id = txid, gene = sha256(owner+txid)) | `PET_HATCH_COST` |
| Pet | `PETX\|<petId>` | Gift/transfer (only the current owner is valid) | ≥1 (sent to recipient) |
| Pet | `PETBREED\|<a>\|<b>` | Breed (child gene = `breedGene(parents, blockHash, txid)`, visible inheritance) | `PET_BREED_COST` |
| Pet | `PETEVO\|<petId>` | Evolve (+1 tier up to `MAX_EVO`, visual aura only) | `PET_EVO_COST` |
| Pet | `PETFARM\|<petId>\|<zoneId>` / `PETUNSTATION\|<petId>` | Station to a field to accelerate / recall | `PETFARM_COST` / 0 |
| Farm | `LAND\|<n>` | Buy land (n must be the next index, `burn ≥ landPrice`) | dynamic price |
| Farm | `ZONE\|<plotN>\|<type>` | Build a zone (MVP implements `farmland` only) | `ZONE_COST` |
| Farm | `PLANT\|<zoneId>\|<crop>\|<slot>` | Plant (records `plantHeight`) | `SEED_COST[crop]` |
| Farm | `HARVEST\|<plantId>` | Harvest a mature crop → on-chain collectible crop | `HARVEST_BURN` |
| Fishing | `FISH\|` | Mint a catch (id = txid, hash mixes in the block hash) | `FISH_BURN` |
| Mine | `MINE\|DISC\|…` / `MINE\|MAT\|…` | Mint a discovery proof / material | scales with depth/tier |

> These "protocol memos" collide in shape with "on-chain DMs" (`amount=0 + burn>0`), so `messages.ts`'s `isProtocolMemo()` centrally excludes every prefix and `parseMessages` skips them — subsystem transactions are **never misdelivered into the DM inbox**.

**Growth = block height.** Crop maturity = `clamp((currentHeight − plantHeight) / GROW_BLOCKS[crop], 0, 1)`, computed purely from chain height → no "time" ambiguity, reorg-safe, identical across clients, and **no "watering" transaction required**.

**Quality/rarity = the post-mining block hash.** `cropHash`/`catchHash`/`mineAssetHash` = `sha256(owner + '|' + blockHash + '|' + txid)`, the same source as the red-packet `redSeed`. Players can't alter the on-chain txid or block hash → **legendaries can't be forged**; rolling for better loot means burning again and landing in a fresh, uncontrollable block.

## Deterministic rendering: same gene, same look everywhere

An asset's **appearance is derived entirely from its on-chain hash by pure functions** — the chain stores no images:

- core provides `petTraits(gene)` / `fishTraits(catchHash)` / `cropTraits(crop, hash)` / `mineTraits(...)` — mapping byte segments of the hash into body/hue/eyes/pattern/species/quality…
- The client's `renderPet` / `renderFish` / `renderCrop` draw those traits into 16×16 / 32×32 pixels per a **versioned Render Spec** (GAME-PROTOCOL §4/§6/§7), scaled up with integer nearest-neighbor and anti-aliasing off.

Because the traits are locked down in core, **the same gene/hash renders pixel-for-pixel identically across any client** (web, and future native clients). Changing the mapping table = bump to Spec v2, and old assets must still render without their look jumping.

## Economy parameters

Integer coins, **everything is burned into the void with zero system-side minting**; the only minting exception is the faucet (moving coins from the central-bank premine pool).

| Parameter | Location | Default |
| --- | --- | --- |
| `PET_HATCH_COST` / `PET_BREED_COST` / `PET_EVO_COST` / `MAX_EVO` | `core/pets.ts` | 300 / 200 / 80 / 3 |
| `PETFARM_COST` (station) / `farmAssistPct` (speedup cap) | `core/pets.ts` | 50 / capped at 50% |
| `LAND_BASE` / `LAND_K` / `LAND_QUAD_DEN` / `LAND_VELOCITY_WINDOW` | `core/farm.ts` | 200 / 50 / 2500 / 720 |
| `ZONE_COST` / `SEED_COST` / `GROW_BLOCKS` / `HARVEST_BURN` | `core/farm.ts` | 100 / 10·15·25·50 / 30·60·120·200 / 2 |
| `FISH_BURN` | `core/fishing.ts` | 2 |
| `FAUCET_AMOUNT` / `FAUCET_GLOBAL_CAP` | game-server (env) | configurable |

**The dynamic land price (`landPrice`) is on a consensus-recomputable path**, so it's an **all-integer fixed-point bonding curve** (a linear `scarcity` term + a quadratic term, plus a velocity bump), with **no floats, no `Math.pow`, no `ceil`** — a last-bit ulp difference in floating point would make two ends disagree on whether a given land purchase is valid → the farm state would split across clients. Native clients must reproduce the exact integer operator order (golden vectors in GAME-PROTOCOL §7.3).

> ⚠️ **"An on-chain action can be rejected by chain state, and the burn is not refunded."** The farm is an "optimistic submit, judge after the fact" architecture. A land-price race (price rises so `burn < price`) or same-slot concurrency (two txns race for one slot; first in chain order wins) makes the loser's transaction ignored by `parseFarm`, yet its `burn` has genuinely gone into the void and is not refunded. The client mitigates this with a "`ceil(landPrice × 1.05)` buffer + pre-checks" (GAME-PROTOCOL §7.8).

## Boundary guard & security posture

- **Architecture boundaries** are enforced by `scripts/check-boundaries.ts` (`corepack pnpm check:boundaries`): ① the game layer may only depend on `@v0idchain/core[/browser]`, never on node/cli; ② the chain layer never depends back on the game layer. The chain can live without the game.
- **game-server security baseline** (see `game-server/src/{config,security,server}.ts` + [DEPLOY-game.md](./DEPLOY-game.md)): `listen('127.0.0.1')` only (all external traffic must go through nginx); full security headers + strict CSP; CORS allowlist (never `*`); write endpoints have per-IP rate limiting + a 64 KB body cap + strict input validation; the central-bank private key / node token are read only from env or 0600 files and **never appear in any response**.
- **The faucet is not minting**: it only moves from the central-bank address, with a per-address cap + rate limit + global cap; there is zero path that bypasses coinbase to create new coins.

## Run it locally

```bash
# 1. Start a local node (mints coins + provides the API token / central-bank wallet)
corepack pnpm dev:node1
# 2. Start the game server (binds 127.0.0.1:8790 by default, reads .data/node1's token + wallet)
corepack pnpm dev:game-server
# 3. Start the front-end (Vite; the default CORS allowlist includes 5173)
corepack pnpm dev:game-web

# Sanity checks
curl -s http://127.0.0.1:8790/health        # → {"ok":true,"height":<n|null>}
corepack pnpm --filter @v0idchain/game-server typecheck
corepack pnpm tsx scripts/smoke.ts           # core smoke test (includes farm/pet regressions)
corepack pnpm check:boundaries               # architecture boundary guard
```

## Design docs

| Doc | Contents |
| --- | --- |
| [GAME-PROTOCOL.md](./GAME-PROTOCOL.md) | Game-server↔client convenience-layer protocol + all memo conventions + gene→pixel Render Specs (**authoritative reference**) |
| [ECONOMY-LAND-DESIGN.md](./ECONOMY-LAND-DESIGN.md) | Land/farm economy: dynamic land price, growth, quality randomness source |
| [FISHING-DESIGN.md](./FISHING-DESIGN.md) | Fishing QTE + catch memo convention + species/rarity |
| [MINE_ART_REQUIREMENTS.md](./MINE_ART_REQUIREMENTS.md) | Mine pixel-art requirements (the list of bitmap assets still to be produced) |
| [RENDER-3D-FEEL.md](./RENDER-3D-FEEL.md) | Research on making pixel 2D "fake 3D" (light direction / contact shadows / faux perspective, with citations) |
| [CODE-REVIEW-game.md](./CODE-REVIEW-game.md) | Game-layer code review record |
| [DEPLOY-game.md](./DEPLOY-game.md) | game-server production-deploy security checklist (1211 box: dedicated user + systemd sandbox + nginx + firewall + TLS) |

---

> The three modules share one monorepo and a common `packages/core`. Head back to the [🏠 hub](../../README.md) to see how v0idnet (anonymity network) and the blockchain (the base) combine with this game into one whole.
