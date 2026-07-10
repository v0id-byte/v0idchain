# v0idChain ⛓ — the blockchain module (native token `$V0ID`)

**English | [中文](README.md)**

> This is one of v0idChain's three modules. The repo is a hub:
> **[🧅 v0idnet anonymity network](../v0idnet/README.md)** (the headline) · **⛓ blockchain** (this module — the base everything runs on) · **🎮 on-chain game** ([../game/README.md](../game/README.md)).
> Back to the **[repo hub → ../../README.md](../../README.md)**.

A hand-rolled, educational blockchain: coins are minted by **mining**, and every transfer pays a **fee (gas)** to the miner. TypeScript + Node.js, pnpm monorepo.
Hand-written blocks / hashing / Merkle root / chain structure / PoW mining / ed25519 signatures / WebSocket P2P / most-work-chain consensus.

> **Our own chain, our own validation rules** — coins come from mining (block reward + fees); every transfer pays a fee to the miner that includes it.
> It is **not** audited, production-grade crypto — it's a **teaching-grade** chain. It also serves as the **base layer** that the upper **v0idnet anonymity network** and the **on-chain game** both run on (nicknames, staking, escrow payments, etc. are all built on its transaction layer).

---

## What it is (for users)

A small chain that genuinely networks and lets you transfer with friends. Coins come from **mining**, and each transfer pays a small fee to the miner. Beyond transfers, it ships a ring of "social toys", all built on **transfers + memo conventions** with **no consensus changes**:

| What you can do | In a line |
| --- | --- |
| ⛏ **Mine** | Run PoW to produce blocks; earn 1 block reward + all of the block's fees |
| 💸 **Send** | Transfer `$V0ID` to an address, paying a fee (gas) to the including miner |
| 💬 **On-chain messages** | Message an address = **burn a little coin into the void**; the body is permanent on-chain |
| 🔒 **Encrypted DMs** | Add `-e` for end-to-end encryption (x25519 ECDH + XChaCha20-Poly1305) — others see only gibberish |
| 🪪 **Nicknames** | Claim a **globally-unique** name; show `@name` instead of a long `0x…` |
| 🧧 **Red packets** | Send lucky-draw / even-split packets for others to grab; refund if unclaimed (consensus-level escrow) |
| 🛒 **Marketplace** | Buy/sell goods & services with `$V0ID`; listings sync network-wide via the chain |

### Quick start

> **Full install steps (incl. Node.js upgrade) → [RUNNING-A-NODE.en.md](RUNNING-A-NODE.en.md); a command-by-command walkthrough of transfers / marketplace / encrypted DMs / red packets / wallet backup → [TUTORIAL.en.md](TUTORIAL.en.md).** Below is the cheat-sheet version.

**Prereq: Node.js ≥ v22.13** (required by `pnpm@9.15.0`).

```bash
git clone https://github.com/v0id-byte/v0idchain.git
cd v0idchain
corepack enable
corepack pnpm install
```

**Install the global `v0id` command (recommended).** A prebuilt single file you can run from any directory:

```bash
corepack pnpm build:cli                       # esbuild bundle → packages/cli/dist/index.cjs
cd packages/cli && corepack pnpm link --global && cd ../..
v0id --help                                   # now available globally
```

> First-time `link` says `Unable to find the global bin directory`? Run `corepack pnpm setup` once (adds pnpm's global bin to PATH; open a new terminal), then link again. No global install? Define a same-named function from the repo root: `v0id() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }` (~1s cold start).

**Join the public network and mine (one command):**

```bash
corepack pnpm mine        # connects to ws://mc.void1211.com:6001, auto-mines
```

> **Double-click** `mine.command` (macOS) / `mine.bat` (Windows) to auto-install deps, open the dashboard, and start mining.

**Local sandbox (two nodes, offline):**

```bash
corepack pnpm dev:node1   # Terminal 1: node1, mining
corepack pnpm dev:node2   # Terminal 2: node2, connects to node1
```

**Web dashboard (optional, with a node running):** `corepack pnpm dev:web` → open http://localhost:5173 (live height / balance / block explorer / transfer panel).

### Common commands

```bash
v0id start --mine                                   # start a node and auto-mine
v0id info                                            # node status: height / balance / peers / address
v0id send <to> <amount> [--fee <n>] [--memo <text>]  # transfer (pays amount + fee)
v0id msg  <to> <text…> [-e]                          # on-chain message (-e = end-to-end encrypt; default burns 5 + 1 gas)
v0id inbox                                            # your inbox
v0id name claim <name>                               # claim a globally-unique nickname
v0id market sell <price> <title…>  /  v0id market buy <id>   # marketplace list / buy
v0id wallet show --secret                            # reveal private key (= backup — back up after your first coin!)
```

> Full subcommands and the complete `market` / `name` / `wallet` sets are in [TUTORIAL.en.md](TUTORIAL.en.md). Mutating ops (send/mine/market…) need `--name <node>` or `--api <url>` pointing at a running node (the CLI reads that node's API token automatically).

> 🧪 **Want to play attacker and watch the defenses reject you?** See the **[hands-on attack/defense labs → LABS.md](LABS.md)**: tamper a tx amount, a low-difficulty long fork, future timestamps, double-spends, a corrupted chain file, a past-checkpoint reorg — 6 reproducible experiments (one command each, with the actual rejection output). *(Doc is in Chinese.)*

---

## Architecture & protocol (for developers)

### Blocks and the chain

```
Block { index, timestamp, prevHash, transactions[], merkleRoot, difficulty, nonce, miner, hash }
calcBlockHash = sha256Hex(JSON.stringify([index, timestamp, prevHash, merkleRoot, difficulty, nonce, miner]))
```

- **Hashing**: the whole protocol uses `sha256Hex(s)` = SHA-256 over the string's UTF-8 bytes → lowercase hex.
- **Merkle root**: tx `txid`s pairwise `sha256Hex(a+b)` folded level by level (odd ⇒ duplicate last, empty ⇒ `sha256Hex("")`), written into the header.
- The header anchors the whole tx set via `merkleRoot → hash → PoW`.

### Consensus: PoW + most-work chain

- **Adaptive difficulty, two generations** (`packages/core/src/blockchain.ts: expectedDifficulty`):
  - **v1** (height `< POW_V2_HEIGHT=15000`): `difficulty` = number of leading-zero **bits** (not hex digits → each ±1 bit halves/doubles difficulty, smoothly tunable); retargets every `RETARGET_INTERVAL` blocks toward `TARGET_BLOCK_TIME_MS` (8 s) by the window's actual elapsed time.
  - **v2** (height `≥ 15000`, with an upgrade window reserved for nodes/wallets): the `difficulty` field instead carries a **Bitcoin-style compact target (nBits)**; retargets every `POW_V2_RETARGET_INTERVAL` blocks proportionally, clamped to ×/÷4 per step — for exact cumulative work. **The block JSON shape is unchanged.**
  - Like Bitcoin, **no artificial cap** (bounded only by the 256-bit hash width), with a `MIN_DIFFICULTY` floor so it can always drop back to mineable. Difficulty is written into the header and **deterministically recomputed + verified** by every node from chain history — a miner can't set it.
- **Most-work valid chain** (`replaceChain` / `chainWork`): pick the chain by **cumulative PoW** (v1 `Σ 2^difficulty`, v2 Bitcoin-style target proof), **not by length**; strictly-greater work wins (first-seen otherwise).
- **Future-timestamp bound**: timestamps must be **non-decreasing** and no more than `MAX_FUTURE_DRIFT_MS` (2 min) ahead of local time. This kills the "set your clock to the future → stretch the retarget window → crush difficulty to the floor" manipulation — together with the most-work rule it reduces the "difficulty-suppression double-spend" to a **genuine ≥51% real-hashrate attack** (the inherent limit no fork-choice rule can prevent).
- **Checkpoints**: `CHECKPOINTS` in `config.ts` hardcodes a few `{index, hash}` pairs; a chain must match them at those heights, and `replaceChain` refuses any reorg that rolls back past the latest checkpoint → **freezes confirmed history** and raises the cost of deep reorgs (the standard low-hashrate-PoW buffer, as in early Bitcoin Core). Currently seeded with the first 300 blocks of the canonical chain.

### Transactions, signatures, and state

```
Transaction { from, to, amount, fee, nonce, timestamp, memo, burn?, signature, txid }
```

- **Signatures**: **ed25519** (`@noble/ed25519`, RFC 8032, strict `zip215:false` verification). Address = `0x` + the pubkey's lowercase hex (64 chars) → the address **embeds the pubkey**, so verification reads it straight from `from`.
- **txid**: `txid = sha256Hex(JSON.stringify([from, to, amount, fee, nonce, timestamp, memo]))`, with **`burn` appended only when >0**. This keeps historical/genesis tx hashes **byte-for-byte unchanged** (the basis for "adding messages doesn't reset the chain"). `fee` is included → **tampering with the fee breaks the txid**. The signed message is the **32 bytes** decoded from `txid` (not the hex string).
- **Replay protection**: a per-address auto-increment **nonce**; a signed tx can't be double-spent.
- **Fees (gas) → the miner**: every regular transfer pays `fee ≥ minFeeFor(amount)` (floor `MIN_FEE=1`, plus a proportional `floor(amount × FEE_RATE_BPS/10000)`, 10 bps = 0.1%); `coinbase amount = block reward BLOCK_REWARD + the block's total fees`, pinned by consensus — off by a single coin and the block is invalid → a miner can't mint extra. Miners pack **highest-fee-first** (≤ `MAX_BLOCK_TXS` per block), forming a fee market.
- **One `applyTx` / `computeState` / `validateChain` state machine** (`blockchain.ts`): `computeState` (replays to derive balances/nonces/red-packet pools/stake pools) and `validateChain` (the sole consensus authority — replays from genesis checking PoW / coinbase / every signature / nonce ordering / balances / merkleRoot / checkpoints) **share the same `applyTx`** → miner and verifier compute identical state, so no fork. Amounts are forced to positive integers (floats would let nodes accumulate rounding differences and split consensus).

### memo-convention protocol verbs

Many "features" change no consensus; they agree on a memo prefix so chain-scanning clients can **reconstruct** higher-level semantics. The chain itself just sees valid transactions; the new code only **interprets/displays** them:

| Verb | Shape | Meaning |
| --- | --- | --- |
| `NAME\|<name>` | self-transfer of 1 | claim a globally-unique nickname (first-come-first-served, `names.ts`) |
| message (no prefix) | `amount=0 + burn>0 + memo` | on-chain message body (`messages.ts`) |
| `ENC\|<ciphertext>` | as above, memo = ciphertext | end-to-end encrypted DM |
| `RED\|count\|r or e` | transfer to `RED_ESCROW_ADDRESS` | send a red packet (lucky-draw r / even-split e, `redpacket.ts`) |
| `CLAIM\|<id>` / `REFUND\|<id>` | `amount=0` | grab / refund-after-expiry (consensus-level escrow; state machine in `blockchain.ts`) |
| `MKT\|price\|title` / `BUY\|<id>` / `DEL\|<id>` | transfer + memo | marketplace list / buy / delist |
| `STAKE\|<role>` / `UNSTAKE\|` / `SLASH\|` | transfer to `STAKE_ESCROW_ADDRESS` / `amount=0` | **v0idnet relay stake/slash** (see the [v0idnet module](../v0idnet/README.md)) |

> ⚠️ **Messages / encrypted DMs are a soft fork**: plain-transfer blocks validate on old & new nodes; but once a block contains a message tx, or a memo exceeds the old 128 limit (encrypted DMs raise `MAX_MEMO` to 512), **un-upgraded nodes reject that block**. The genesis hash and existing checkpoints are **unchanged** (`burn` enters the txid only when >0) → the old chain and treasury pre-mine stay valid, **no chain reset**. Red-packet `CLAIM/REFUND` and staking `UNSTAKE/SLASH` use the new `amount=0` boundary and are treated as historical plain txs before their activation height. **Nicknames are not a soft fork** (a claim is just a valid self-transfer to old nodes).

### Where the code lives

```
v0idchain/packages/
├── core/   blockchain core: crypto / wallet / transaction / block / blockchain / config
│           + memo subsystems: messages · redpacket · names · staking (…game subsystems belong to the game module)
├── node/   node: p2p (WebSocket network) / node (orchestration + mining loop) / api (local HTTP control, 127.0.0.1 only)
├── cli/    CLI (`v0id`): start / send / mine / balance / info / msg / name / market / wallet
└── web/    Vite + React dashboard + block explorer
```

The CLI is a **thin client**: `start` runs a node; the other subcommands drive a running node through its **local HTTP API** (`127.0.0.1` only; mutating endpoints require a Bearer token `api.token`, `0600`). Full nodes still sync full chains over WebSocket (`HELLO` / `QUERY_ALL` / `BLOCKS` / `TX` / `PEERS`, single frame ≤ 64MB); wallets/indexers can use `QUERY_HEADERS`, `QUERY_RECENT`, `QUERY_TX_PROOF`, and `QUERY_ADDRESS_PROOFS` for non-consensus light sync and on-demand historical backfill.

### Further reading

- **[CLIENT-PROTOCOL.md](CLIENT-PROTOCOL.md)** — cross-implementation interop spec + **golden test vectors** (required for any non-Node client: the txid preimage, signing, encrypted-DM vectors).
- **[WEBRTC-MESH-DESIGN.md](WEBRTC-MESH-DESIGN.md)** — browser-native P2P (WebRTC mesh) design.
- **[LABS.md](LABS.md)** — 6 hands-on attack/defense experiments.
- **[RUNNING-A-NODE.en.md](RUNNING-A-NODE.en.md)** ([中文](RUNNING-A-NODE.md)) · **[TUTORIAL.en.md](TUTORIAL.en.md)** ([中文](TUTORIAL.md)).

---

## Design stance & known limits (toy chain — not for real money)

- **The only source of coins is coinbase** (the block-reward part is pinned to `BLOCK_REWARD` by consensus; fees are merely moved from senders, not minted). Genesis pre-mines `GENESIS_PREMINE=1000` to a **"treasury" address** — `config.ts` only holds its **address (pubkey, safe to publish)**; the **private key lives only on the owner's machine** (`.data/treasury/wallet.json`, gitignored). The treasury is a **plain single-sig address with no minting privilege**; losing its key just loses those 1000 coins, like any wallet. **The repo contains no private keys.**
- **Full-chain validation is the sole authority**: every received chain is replayed from genesis; the block hash anchors each tx's content (incl. coinbase/genesis) to PoW via `txid` — changing an amount or recipient is detected. Genesis is fully pinned (checked by both its `.hash` and a content recompute).
- **All untrusted input is guarded**: P2P messages are field-validated and malformed packets dropped; recipient addresses must be valid `0x`+64hex; gossip-learned peers are filtered for private/loopback/link-local (anti-SSRF); `knownUrls` is pinned-FIFO, `mempool ≤ MAX_MEMPOOL`, and the WS frame + chunked-sync aggregate buffer are capped (anti-OOM); `wallet.json` / `api.token` / `chain.json` / `peers.json` are `0600`; a corrupted `chain.json` is backed up before rebuilding from genesis (never silently wiped).
- **Still missing**: Sybil resistance, TLS, inter-node auth/encryption, a mature fee market (there's a "highest-fee-first + per-block cap" seed). Known low-severity residuals: the HELLO `address` field is unsigned (identity can be spoofed for peer-list display, but no coin theft — spending needs an ed25519 signature); inbound connection count is unbounded with no per-connection bandwidth throttle. **This is a teaching chain — don't put real money on it**; to expose it publicly, at least add TLS, guard `api.token` and the treasury key, and understand the inherent 51% risk of a low-hashrate PoW chain.

---

## Acknowledgements & license

Depends on [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) / [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) / [`@noble/curves`](https://github.com/paulmillr/noble-curves) / [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) (Paul Miller, MIT) for signatures/hashing/encryption, [`ws`](https://github.com/websockets/ws) (MIT) for P2P, [`commander`](https://github.com/tj/commander.js) (MIT) for the CLI, and [`react`](https://react.dev) / [`vite`](https://vite.dev) / [`tsx`](https://github.com/privatenumber/tsx) / [`typescript`](https://www.typescriptlang.org) for the dashboard & toolchain. Design draws on the [Bitcoin whitepaper](https://bitcoin.org/bitcoin.pdf), [RFC 8032 (Ed25519)](https://www.rfc-editor.org/rfc/rfc8032), [RFC 7748 (X25519)](https://www.rfc-editor.org/rfc/rfc7748), [FIPS 180-4 (SHA-256)](https://csrc.nist.gov/pubs/fips/180-4/upd1/final) (**design only — no source copied**). Full list in the repo root's **[THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md)**.

v0idChain's own code is released under the **MIT License** (© 2026 v0id-byte, see [LICENSE](../../LICENSE)).
