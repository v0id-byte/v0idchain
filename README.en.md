# v0idChain ⛓ — a hand-rolled blockchain with native token `$V0ID`

**English | [中文](README.md)**

An educational blockchain: coins are minted by mining, transfers pay a fee (gas) to the miner. TypeScript + Node.js, pnpm monorepo.
Hand-written blocks / hashing / chain structure / PoW mining / ed25519 signatures / WebSocket P2P / most-work-chain consensus.

> Our own chain, our own validation rules — coins come from mining (block reward + fees); every transfer pays a fee (gas) to the miner that includes it.

> 📘 **First time? Start with the [full tutorial → TUTORIAL.en.md](TUTORIAL.en.md)** — from setup to mining / transferring / the marketplace / wallet backup, plus **every common command explained**. This README is the cheat sheet + design notes.

---

## What's in it

| Capability | How |
| --- | --- |
| Block & chain | `{ index, timestamp, prevHash, transactions, merkleRoot, difficulty, nonce, miner, hash }`, SHA-256 linked |
| Consensus | PoW (**adaptive difficulty** — leading-zero **bits** + Bitcoin-style retarget) + **most-work valid chain** (by cumulative PoW, not length) |
| Token | `$V0ID`; minted by **mining** (miner gets **1** block reward **+ the block's fees**); genesis pre-mines **1000** to a "treasury" address |
| Transaction | `{ from, to, amount, fee, nonce, timestamp, memo, signature, txid }`, **carries a fee (gas) paid to the miner**, optional **memo** |
| Fees | each tx pays ≥ `MIN_FEE` (default **1**) to the including miner; miners pack **highest-fee-first** (≤ `MAX_BLOCK_TXS` per block) → a simple fee market |
| Block header | transaction **Merkle root** + per-block adaptive `difficulty` (leading-zero bits) |
| Signatures | **ed25519** (`@noble/ed25519`); address = `0x` + pubkey hex |
| Replay protection | per-address auto-increment **nonce**; a signed tx can't be double-spent |
| Network | `ws` full-duplex; block/tx broadcast; **peer gossip auto-discovery**; auto-reconnect |
| Dashboard | live chain state + transfers (with memo) + **block explorer** (search by address / txid / block) |
| Persistence | chain + wallet saved as JSON (`<dataDir>/chain.json`, `wallet.json`), survives restart |

---

## Project layout

```
v0idchain/
├── packages/
│   ├── core/   blockchain core: crypto / wallet / transaction / block / blockchain / storage
│   ├── node/   node: p2p (WebSocket network) / node (orchestration + mining loop) / api (local HTTP control)
│   ├── cli/    CLI: start / mine / send / balance / peers / info / wallet
│   └── web/    Vite + React dashboard + block explorer
└── scripts/    smoke.ts (core smoke test) / integration.ts (multi-node integration test)
```

The CLI (`v0id`) drives a running node through its **local HTTP API** (bound to `127.0.0.1` only):
`start` runs a node; the other subcommands are thin clients — point them at a node with `--api`.

---

## Quick start

### 0. Get pnpm (skip if you have it)

Node ≥ 18. Use Node's built-in corepack — no global pnpm install needed:

```bash
corepack pnpm -v      # any pnpm command can be written as: corepack pnpm …
```

### 1. Install dependencies

```bash
corepack pnpm install
```

**Install the global `v0id` command (recommended).** A prebuilt single file you can run from any directory, with no per-call TS cold start:

```bash
corepack pnpm build:cli                       # esbuild bundle → packages/cli/dist/index.cjs
cd packages/cli && corepack pnpm link --global && cd ../..
v0id --help                                   # now available globally
```

> First-time `link` says `Unable to find the global bin directory`? Run `corepack pnpm setup` once (adds pnpm's global bin dir to your PATH; open a new terminal), then link again. After editing CLI source, re-run `corepack pnpm build:cli` to refresh. No global install? Define a same-named function from the repo root: `v0id() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }` (~1s cold start).

### 🚀 Join the public network and mine (fastest path)

After installing, **one command** connects to the public seed node and starts mining:

```bash
corepack pnpm mine        # connects to ws://mc.void1211.com:6001, auto-mines, prints a status line every 5s
```

> Don't like the command line? **Double-click** `mine.command` (macOS) or `mine.bat` (Windows) — it installs deps, opens the dashboard, and starts mining.

To watch the chain while mining: in another terminal run `corepack pnpm dev:web` → open http://localhost:5173 .
Mined coins are held by your own wallet (data in `.data/miner/`); send them to friends with `send`.

### 2. Self-checks (optional but recommended)

```bash
corepack pnpm smoke          # core logic: mining / transfers / balances / replay / tamper-detection / most-work consensus
corepack pnpm exec tsx scripts/integration.ts   # multi-node: broadcast / sync / late-joiner catch-up / persistence
```

> 🧪 **Want to play attacker and watch the defenses reject you?** See the **[hands-on attack/defense labs → docs/LABS.md](docs/LABS.md)** — tamper a tx amount, a low-difficulty long fork, future timestamps, double-spends, a corrupted chain file, and a past-checkpoint reorg, organized as 6 reproducible experiments (one command each, with the actual rejection output). Drop-in lab for a distributed-systems / cryptography course. *(Doc is in Chinese.)*

### 3. Run two local nodes

Open **two terminals**:

```bash
# Terminal 1 — node1, auto-mining
corepack pnpm dev:node1

# Terminal 2 — node2, connects to node1
corepack pnpm dev:node2
```

`dev:node1` = `start --name node1 --p2p-port 6001 --api-port 7001 --mine`
`dev:node2` = `start --name node2 --p2p-port 6002 --api-port 7002 --peers ws://127.0.0.1:6001`

Open a **third terminal** to drive them:

```bash
# `v0id <cmd>` (installed above) drives a running node. No global install? Define a fallback from the repo root: v0id() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }

# each node prints its own "address 0x…" on startup; `info` shows it too
v0id info --api http://127.0.0.1:7001        # node1 status: height / balance / peers / [address]
v0id info --api http://127.0.0.1:7002        # node2 status: copy its [address]

# coins come from mining: node1 has --mine, so it accrues a balance (see `info`)
# node1 sends 300 of its mined coins to node2 (pays a fee, default min 1; --fee to override, optional --memo "note")
v0id send 0x<node2-address> 300 --api http://127.0.0.1:7001

v0id balance 0x<address> --api http://127.0.0.1:7001   # both nodes should agree on the balance
```

> The pre-mine (1000 at genesis) sits in the "treasury" address. Only the holder of its private key (the project author — key stays local, never committed) can distribute it via `send`. Everyone else earns coins by **mining**. The treasury is a plain single-sig address with **no minting privilege** (new coins only ever come from coinbase; the **block-reward part** is fixed at `BLOCK_REWARD` by consensus — the coinbase total is `reward + the block's fees`, and fees are merely moved from senders, not minted) — so losing its key just loses those 1000 coins, like any wallet; keep it safe (`wallet.json` is now `0600`).

> Chain data is persisted under `./.data/<node-name>/` (survives restart). To start fresh from genesis, delete it: `rm -rf .data`.

### 4. Web dashboard (optional, live view)

With at least one node running (e.g. node1 above), in another terminal:

```bash
corepack pnpm dev:web
```

Open **http://localhost:5173** — live height, your node's balance, difficulty (bits), peer count, mempool,
and a live block feed (refreshes every 1.5s; each block shows its difficulty and Merkle root). The input top-right
switches which node's API you're viewing (default `http://127.0.0.1:7001`; use `:7002` for node2). You can **transfer**
(with a memo) right from the page, plus a **block explorer**: look up an address (balance + history), a txid, or a block by number/hash.

> The dashboard is pure front-end and only talks to a node's HTTP API. CORS is restricted to localhost pages — see the security notes.

---

## CLI cheat sheet

```
v0id start [options]              start a node (P2P + local API, optional auto-mining)
  --name <name>                   node name → data dir (default ./.data/<name>)
  --p2p-port <port>               P2P port (default 6001)
  --api-port <port>               local HTTP API port (default 7001)
  --peers / --bootstrap <urls>    comma-separated peer/seed ws URLs
  --advertise <url>               this node's externally-reachable ws URL (only for public/LAN)
  --mine                          auto-mine after start
  --mine-interval <ms>            pause between blocks (default 0 = mine continuously, paced by PoW difficulty; set >0 to save battery)

v0id info     [--api URL]         node status
v0id balance  [address] [--api]   balance (omit address = this node)
v0id send     <to> <amount> [--fee <n>] [--memo <text>] [--api]   transfer (pays amount+fee; --fee sets gas, default min 1)
v0id mine     [blocks]      [--api]   mine N blocks right now
v0id peers    [--api]             connected peers
v0id connect  <ws-url> [--api]    connect to a peer

v0id market list   [--all] [--api]            browse listings (--all includes sold/delisted)
v0id market sell   <price> <title…> [--api]   list an item (self-transfer of 1, memo records the item)
v0id market buy    <id> [--api]               buy (pay the seller the price; id prefix ok)
v0id market delist <id> [--api]               take down your own listing

v0id msg     <to> <text…> [--burn <n>] [--fee <n>] [-e] [--api]   send an on-chain message (no transfer; burns $V0ID into the void; --burn default 5; -e = end-to-end encrypt)
v0id inbox   [address] [--sent] [--api]       view your inbox (messages sent to you; --sent shows your outbox)
v0id newcomers [--api]                        newcomers found this session (new node online / new address first seen on-chain)

v0id name claim <name> [--api]                claim a globally-unique nickname (first-come-first-served; self-transfer + memo)
v0id name list  [--api]                        list registered nicknames
v0id name who   <name> [--api]                which address owns a nickname
v0id name of    [address] [--api]             an address's display nickname

v0id wallet show   [--name|--data-dir] [--secret]   show address/pubkey (--secret reveals private key = backup)
v0id wallet new    [--name|--data-dir]              create a new wallet
v0id wallet import <privkey> [--name|--data-dir] [--force]   restore a wallet from a backed-up key
v0id wallet treasury-address                        show the genesis ("treasury") pre-mine address
```

---

## Marketplace (buy/sell goods & services with `$V0ID`)

Making the coin useful = giving it value. The marketplace is built entirely on **transfers + memo** —
**no consensus changes, no central server** — so listings sync across the network via the chain and are permanent:

- **List** = transfer 1 coin to yourself with memo `MKT|price|title` (net-zero; just records the item on-chain)
- **Buy** = transfer the price to the seller with memo `BUY|<listing-txid>`
- **Delist** = memo `DEL|<listing-txid>` (only valid from the seller)

Any node scans the chain to reconstruct the listing list (sold/delisted auto-marked). There's a "Marketplace" panel
in the dashboard, or use the CLI:

```bash
v0id market sell 30 ch3-revision-notes --api http://127.0.0.1:7001   # list (wait one block to confirm)
v0id market list --api http://127.0.0.1:7002                         # other nodes see it too (synced)
v0id market buy 9f59c01a --api http://127.0.0.1:7002                 # buy by id prefix
```

> On-chain settlement (payment + sale record), off-chain delivery (the notes / the favor / the drink). Listing needs ≥2 balance (the self-transfer of 1 + the min fee of 1, which goes to the miner).

---

## On-chain messages & newcomer discovery

**Messaging = burn-to-speak.** Send a message to any address: instead of transferring coins, you **burn** a little `$V0ID`
into the void address (`NULL_ADDRESS`, forever unspendable = destroyed). The body is plaintext on-chain, syncs network-wide,
and is permanent. Technically it's a new kind of transaction: `amount=0 + burn>0 + memo=body`, plus the min fee to the including miner.

```bash
v0id msg 0x720c…b1ce "leaving you a note on-chain 👋" --api http://127.0.0.1:7001   # default burns 5 + 1 gas
v0id inbox --api http://127.0.0.1:7002        # the recipient node reads its inbox (wait one block)
v0id inbox --sent --api http://127.0.0.1:7001 # see what you've sent
```

Total burned across the network = the void address's balance, shown as "Burned 🔥" in `v0id info` and atop the dashboard
(the ledger stays conserved: the burn just moves into a forever-unspendable address).

**🔒 End-to-end encrypted DMs.** Add `-e` so only the recipient can read it (encrypted to their pubkey via x25519 ECDH + XChaCha20-Poly1305; the ciphertext goes on-chain as `ENC|…` gibberish to everyone else; the sender can also decrypt their own via ECDH). Only the **body** is encrypted — sender/recipient/time/burn stay public.

```bash
v0id msg 0x… "a secret only you can read 🤫" -e --api http://127.0.0.1:7001   # end-to-end encrypted
```

> Encrypted DMs raise `MAX_MEMO` from 128 to 512 (to fit the ciphertext) — a **soft fork** (old nodes reject blocks with >128-char memos), so the whole network must upgrade together; but it's not hashed and does not reset the chain.

**Newcomer discovery.** A running node prints a live `🆕` line when either kind of "newcomer" appears; also queryable via
`v0id newcomers` / the dashboard "Newcomers" panel:

- **New node online** (P2P layer): when a new machine connects and announces its address in the handshake.
- **New address first seen** (economic identity): the first time an address shows up as a sender/recipient in a block.

**🪪 On-chain nicknames (globally-unique, first-come-first-served).** Give an address a name; transfers/messages/the explorer then show `@name` instead of a long `0x…`. Claim = self-transfer of 1 + memo `NAME|<name>`, **first-come-first-served** (a name belongs to its first claimant). Names are 1–20 chars of lowercase letters/digits/`_`/`-`; reserved names like `treasury`/`official`/`admin` are blocked (anti-impersonation).

```bash
v0id name claim v0id-boss --api http://127.0.0.1:7001   # claim (wait one block)
v0id name who  v0id-boss --api http://127.0.0.1:7002    # other nodes resolve it too → address
v0id inbox --api http://127.0.0.1:7002                  # inbox shows the sender as @v0id-boss
```

> Nicknames are a pure memo convention — **no consensus change, no soft fork**: a claim is just a valid self-transfer that old nodes accept; only clients that want to *display* names need the new code.

> ⚠️ **Messaging is a soft fork.** Plain-transfer blocks validate on old & new nodes alike; but once a miner packs a message
> transaction into a block, **nodes that haven't upgraded to this version will reject that block**. So before messaging over the
> network, make sure **every node (including the public seed) is upgraded**. The good news: the genesis hash and existing
> checkpoints are **unchanged** (the burn field only enters the txid when >0), so the old chain and treasury pre-mine remain
> valid — **no chain reset needed**.

---

## Networking with friends

Everyone runs `corepack pnpm install` and starts their own node — the key is **being able to reach each other**.

### A. Same LAN (same WiFi)

Person A starts and finds their LAN IP (e.g. `192.168.1.23`):

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start --name me \
  --p2p-port 6001 --api-port 7001 --advertise ws://192.168.1.23:6001 --mine
```

Person B connects to it (connecting to one is enough — gossip discovers the rest):

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start --name me \
  --p2p-port 6001 --api-port 7001 --peers ws://192.168.1.23:6001 --mine
```

### B. Across networks — use a public machine as the seed node (recommended)

Run a persistent seed node on a machine with a public address (port-forwarded server):

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start --name seed \
  --p2p-port 6001 --api-port 7001 --advertise ws://<public-host-or-ip>:6001
```

> The P2P port (6001 here) must be open / port-forwarded. The API port only listens on 127.0.0.1 and is never exposed.

Everyone else just points `--peers ws://<public-host-or-ip>:6001` at it, then gossip introduces them to each other:

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start --name me \
  --p2p-port 6001 --api-port 7001 --peers ws://<public-host-or-ip>:6001 --mine
```

---

## Design notes & known limits (toy chain — not for real money)

- **Coins come from mining.** 1 new coin per block (the block reward) **plus that block's transaction fees**; run `--mine` to earn. Genesis also pre-mines 1000 to a "treasury" address. `config.ts` only contains its **address (pubkey, safe to publish)**; the **private key lives only on the owner's machine** (`.data/treasury/wallet.json`, gitignored, never committed). Only the key holder can distribute that 1000 via `send`. **The repo contains no private keys.**
- **Fees (gas) → the miner.** Every regular transfer must carry a fee ≥ `MIN_FEE` (default **1**): the sender pays `amount + fee`, the recipient receives `amount`, and **the fee goes to whoever mines the tx** (folded into their coinbase). `coinbase amount = block reward + total block fees`, pinned by consensus — off by a single coin and the block is rejected, so a miner can't mint extra; the fee is signed into the `txid`, so **tampering with the fee breaks the txid**. Miners pack **highest-fee-first** (≤ `MAX_BLOCK_TXS` per block) → under congestion higher bids land first, a simple **fee market**. Supply is conserved: a fee just moves from sender to miner, it is **not minted** (new coins still only come from the block reward); coinbase/genesis carry zero fee themselves.
- **Adaptive difficulty** (leading-zero *bits*, not hex digits → each ±1 bit halves/doubles difficulty for smooth adjustment). Every `RETARGET_INTERVAL` blocks it retargets toward `TARGET_BLOCK_TIME_MS` based on the actual elapsed time of the past window — **just like Bitcoin: difficulty rises as hashrate grows and falls as it drops, with no artificial cap** (bounded only by the 256-bit hash width), and a `MIN_DIFFICULTY` floor so it can always drop back to mineable. ⚠️ Same caveat as Bitcoin: if hashrate spikes then suddenly drops, slow machines get temporarily stuck at high difficulty (until the next retarget lowers it). The difficulty is written into each block header and independently recomputed+verified by every node from chain history, so a miner can't set it. **Block cadence is genuinely set by PoW difficulty** (mining is continuous by default, no artificial throttle). Mining is **chunked & async**: it yields the event loop after each batch of nonces, so even at high difficulty (seconds per block) the node never freezes and keeps relaying blocks (it abandons stale work the moment a peer's new block arrives). Timestamps must be **non-decreasing** and **no more than `MAX_FUTURE_DRIFT_MS` (2 min) ahead of local time** — this kills the "set your clock an hour ahead to stretch the retarget window and crush difficulty to the floor" manipulation (the one and only clock-dependent contextual check).
- **Most-work-chain consensus**: pick the chain by **cumulative PoW** (`chainWork = Σ 2^difficulty`), not by length — the correct Bitcoin rule (it also picks the genuinely-most-work chain under legitimate difficulty swings, and forecloses pure length-padding). Equal-or-less work is not adopted (first-seen wins). ⚠️ **By itself this does NOT stop the difficulty-suppression double-spend**: a longer low-difficulty fork can still have *more* cumulative work (it inherits the honest high-difficulty prefix and simply adds many more blocks). What actually blocks that attack is the **future-timestamp bound** above — suppressing difficulty requires pushing block timestamps far into the future, which is rejected, so difficulty can't be dragged down and cheap blocks never materialize. Together they **reduce the attack to a genuine ≥51% real-hashrate attack** — the inherent limit no fork-choice rule can prevent (a low-hashrate chain is especially exposed).
- **Checkpoints**: `CHECKPOINTS` in `config.ts` hardcodes a few `{index, hash}` pairs; a chain must match them at those heights (else the whole chain is invalid), and `replaceChain` refuses any reorg that rolls back past the latest checkpoint. This **freezes** confirmed history — even an attacker who genuinely out-works the chain can't rewrite the old ledger. It's the standard low-hashrate-PoW buffer against deep reorgs / ≥51% (as in early Bitcoin Core). **Currently seeded with the first 300 blocks of the canonical chain (heights 100/200/300, all deeply confirmed)**; the operator can keep appending more recent well-confirmed heights via `v0id checkpoint <height>` (all nodes must match and restart together; a wrong entry makes the local chain fail validation).
- **Full-chain validation is the sole authority**: every received chain is replayed from genesis, checking PoW, coinbase rules, every signature, nonce ordering, and balances (no double-spend/overspend). The block hash commits to each tx's `txid`, and validation asserts `txid === hash(content)` for **every** tx (including coinbase/genesis) — so tx contents are anchored by PoW; changing an amount or recipient is detected.
- **Genesis is fully pinned**: the genesis block is checked both by its `.hash` field and by recomputing the hash from content, plus the per-tx txid binding above → an attacker can neither steal the pre-mine nor inject a mint-from-thin-air tx. (An earlier version had this bug; fixed with a regression test.)
- **Amounts must be positive integers**: floats would let nodes accumulate rounding differences and disagree on "is the balance enough", splitting consensus — so non-integer/out-of-range amounts are rejected at signature-verification time.
- **All untrusted input is guarded**: P2P messages are field-validated and malformed packets dropped (a bad packet can't crash a node); recipient addresses must be valid `0x`+64hex; `knownUrls`/`seenTx` are capped against unbounded memory growth and reconnect storms.
- **Local API has two layers**: the HTTP API binds `127.0.0.1` only and CORS allows only localhost pages (browser-CSRF defense); on top of that, **mutating endpoints (send/mine/connect/market) require a Bearer token** — `.data/<node>/api.token` (random 32 bytes, `0600`, auto-generated on start; the CLI reads it automatically, the dashboard takes it pasted once). This stops **other local users** from `POST /send`-ing to drain your wallet: they can't read the `0600` `api.token`, and the token is **never served over any endpoint** (a previous unauthenticated `/my-token` that echoed it has been removed). ⚠️ A **process running as you** (e.g. a malicious npm postinstall) can still read `api.token` directly — `0600` only keeps out *other* users, not your own processes; that's the inherent limit of a file-based token. Read-only GETs and `/health` stay open.
- **P2P hardening**: gossip-learned peer URLs are filtered for private/loopback/link-local addresses (anti-SSRF; operator-supplied `--peers`/`--advertise` go through a trusted path and are exempt). **IPv6 literals use a "global-unicast `2000::/3` allowlist only"**, closing `::ffff:` IPv4-mapped, `64:ff9b::` NAT64, `[::1]` and similar bypasses (Node normalizes `::ffff:127.0.0.1` to a bracketed hex form, so prefix blacklists are unreliable). `knownUrls` FIFO-evicts the oldest non-pinned entry when full while operator seeds are pinned forever (so junk floods can't crowd out real peers); single WS message ≤ 64MB (anti-OOM); **the chunked full-chain-sync aggregate buffer is also capped** (≤ `MAX_SYNC_BLOCKS` blocks per connection — closing the pre-auth OOM where a connected peer reports an astronomical `total` in a `BLOCKS` chunk to grow the buffer without bound); `mempool` ≤ `MAX_MEMPOOL`.
- **Local data files are `0600`**: `wallet.json` (plaintext key), `api.token`, and also `chain.json` / `peers.json` are owner-only — the latter two are public data (the ledger / public peer URLs) but share the same permission as the key/token so no other local user gets a readable copy; legacy files are re-tightened to `0600` on load.
- **`chain.json` corruption fail-safe**: if it can't be loaded (parse error or failed full-chain validation), the bad file is **renamed to a backup** (`chain.json.corrupt-<ts>`) before rebuilding from genesis — never silently wiped, so a one-byte tamper can't make a node lose all local state on restart.
- **Still missing**: Sybil resistance, TLS, inter-node auth/encryption, a **mature** fee market (there's a "highest-fee-first + per-block cap" seed, but no dynamic min-fee / EIP-1559-style pricing). Two known low-severity residuals: the **HELLO `address` field is unsigned** (peer identity can be spoofed — affects only peer-list display & de-dup, no coin theft since spending needs an ed25519 signature), and **WS caps per-message size and the chunked-sync aggregate buffer, but inbound connection count itself is unbounded and there's no per-connection bandwidth throttle** (outbound is bounded by `maxPeers=8`). This is a teaching chain — **don't put real money on it**; to expose it publicly, at least add TLS (e.g. behind a reverse proxy), guard `api.token` and the treasury key, and understand the inherent 51% risk of a low-hashrate PoW chain.

---

## Roadmap

- [x] Phase 1 — core: block / chain / PoW / genesis tx
- [x] Phase 2 — CLI: wallet / transfer / balance / mining
- [x] Phase 3 — P2P: two-node sync / peer discovery / persistence
- [x] Phase 4 — mining broadcast + most-work-chain consensus
- [x] Phase 5 — web dashboard (React/Vite live view + transfers)
- [x] Phase 6 — advanced: **adaptive difficulty** · transaction **memo** · **Merkle root** · **block explorer** (search address/txid/block)
- [x] Phase 7 — **marketplace**: buy/sell goods & services with `$V0ID` (built on memos, no consensus change)
- [x] Phase 8 — **security hardening**: most-work consensus + future-timestamp bound (anti difficulty-suppression double-spend) · **checkpoints** (freeze history vs deep reorg) · API token auth · P2P private-address filter / pinned-FIFO `knownUrls` · WS size cap · mempool cap · `0600` key/token files
- [x] Phase 9 — **fees (gas)**: transfers pay a fee, paid to the including miner (folded into coinbase, consensus-pinned `reward + fees`) · min-fee + **highest-fee-first** packing (fee-market seed) · treasury address rotation
- [x] Phase 10 — **on-chain messages**: message an address by burning `$V0ID` into the void (`amount=0 + burn>0 + memo`; burn enters the txid backward-compatibly → genesis/checkpoints unchanged) · inbox/outbox · **newcomer discovery** (new node online + new address first-seen; live CLI `🆕` + `newcomers` + dashboard panel)

---

## Acknowledgements & open-source notices

v0idChain stands on the shoulders of giants — it depends on [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) / [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) (Paul Miller, MIT) for signatures & hashing, [`ws`](https://github.com/websockets/ws) (MIT) for P2P, [`commander`](https://github.com/tj/commander.js) (MIT) for the CLI, and [`react`](https://react.dev) / [`vite`](https://vite.dev) / [`tsx`](https://github.com/privatenumber/tsx) (MIT) / [`typescript`](https://www.typescriptlang.org) (Apache-2.0) for the dashboard & toolchain. Its design draws on the [Bitcoin whitepaper](https://bitcoin.org/bitcoin.pdf), [RFC 8032 (Ed25519)](https://www.rfc-editor.org/rfc/rfc8032), and [FIPS 180-4 (SHA-256)](https://csrc.nist.gov/pubs/fips/180-4/upd1/final) (**design only — no source copied**).

> Full versions, copyrights and licenses: **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**. This repo **vendors no third-party source** (deps are installed via pnpm; `node_modules/` is gitignored).

---

## License

v0idChain's own code is released under the **MIT License** (© 2026 v0id-byte, see [LICENSE](LICENSE)) — use, modify and distribute freely, keeping the copyright and permission notice. Third-party dependency licenses are in the acknowledgements above and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
