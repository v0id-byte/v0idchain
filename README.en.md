# v0idChain ⛓ — a hand-rolled blockchain with native token `$V0ID`

**English | [中文](README.md)**

A zero-cost, zero-gas, zero-fee educational blockchain. TypeScript + Node.js, pnpm monorepo.
Hand-written blocks / hashing / chain structure / PoW mining / ed25519 signatures / WebSocket P2P / longest-chain consensus.

> Our own chain, our own validation rules — transfers are free, coins are minted by mining (block rewards).

---

## What's in it

| Capability | How |
| --- | --- |
| Block & chain | `{ index, timestamp, prevHash, transactions, merkleRoot, difficulty, nonce, miner, hash }`, SHA-256 linked |
| Consensus | PoW (**adaptive difficulty** — leading-zero **bits** + Bitcoin-style retarget) + **longest valid chain** |
| Token | `$V0ID`; minted by **mining** (50 per block); genesis pre-mines **1000** to a "treasury" address |
| Transaction | `{ from, to, amount, nonce, timestamp, memo, signature, txid }`, **zero fee**, optional **memo** |
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
corepack pnpm smoke          # core logic: mining / transfers / balances / replay / tamper-detection / longest-chain
corepack pnpm exec tsx scripts/integration.ts   # multi-node: broadcast / sync / late-joiner catch-up / persistence
```

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
v="corepack pnpm exec tsx packages/cli/src/index.ts"   # or: corepack pnpm v0id

# each node prints its own "address 0x…" on startup; `info` shows it too
$v info --api http://127.0.0.1:7001        # node1 status: height / balance / peers / [address]
$v info --api http://127.0.0.1:7002        # node2 status: copy its [address]

# coins come from mining: node1 has --mine, so it accrues a balance (see `info`)
# node1 sends 300 of its mined coins to node2 (zero fee, optional --memo "note")
$v send 0x<node2-address> 300 --api http://127.0.0.1:7001

$v balance 0x<address> --api http://127.0.0.1:7001   # both nodes should agree on the balance
```

> The pre-mine (1000 at genesis) sits in the "treasury" address. Only the holder of its private key (the project author — key stays local, never committed) can distribute it via `send`. Everyone else earns coins by **mining**.

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
  --mine-interval <ms>            block interval (default 4000)

v0id info     [--api URL]         node status
v0id balance  [address] [--api]   balance (omit address = this node)
v0id send     <to> <amount> [--memo <text>] [--api]   transfer (zero fee, optional memo)
v0id mine     [blocks]      [--api]   mine N blocks right now
v0id peers    [--api]             connected peers
v0id connect  <ws-url> [--api]    connect to a peer

v0id wallet show [--name|--data-dir] [--secret]   show address/pubkey (--secret reveals private key)
v0id wallet new  [--name|--data-dir]              create a new wallet
v0id wallet treasury-address                      show the genesis ("treasury") pre-mine address
```

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

- **Coins come from mining.** 50 new coins per block; run `--mine` to earn. Genesis also pre-mines 1000 to a "treasury" address. `config.ts` only contains its **address (pubkey, safe to publish)**; the **private key lives only on the owner's machine** (`.data/treasury/wallet.json`, gitignored, never committed). Only the key holder can distribute that 1000 via `send`. **The repo contains no private keys.**
- **Adaptive difficulty** (leading-zero *bits*, not hex digits → each ±1 bit halves/doubles difficulty for smooth adjustment). Every `RETARGET_INTERVAL` blocks it retargets toward `TARGET_BLOCK_TIME_MS` based on the actual elapsed time of the past window, clamped to `MIN/MAX_DIFFICULTY`. The difficulty is written into each block header and independently recomputed+verified by every node from chain history, so a miner can't lower it. Timestamps must be non-decreasing (no future bound, deliberately, to keep validation deterministic across nodes).
- **Longest-chain consensus**: replace with any longer valid chain; on equal-height forks keep the current one (first-seen). Transient forks converge to the longest chain.
- **Full-chain validation is the sole authority**: every received chain is replayed from genesis, checking PoW, coinbase rules, every signature, nonce ordering, and balances (no double-spend/overspend). The block hash commits to each tx's `txid`, and validation asserts `txid === hash(content)` for **every** tx (including coinbase/genesis) — so tx contents are anchored by PoW; changing an amount or recipient is detected.
- **Genesis is fully pinned**: the genesis block is checked both by its `.hash` field and by recomputing the hash from content, plus the per-tx txid binding above → an attacker can neither steal the pre-mine nor inject a mint-from-thin-air tx. (An earlier version had this bug; fixed with a regression test.)
- **Amounts must be positive integers**: floats would let nodes accumulate rounding differences and disagree on "is the balance enough", splitting consensus — so non-integer/out-of-range amounts are rejected at signature-verification time.
- **All untrusted input is guarded**: P2P messages are field-validated and malformed packets dropped (a bad packet can't crash a node); recipient addresses must be valid `0x`+64hex; `knownUrls`/`seenTx` are capped against unbounded memory growth and reconnect storms.
- **Local API is CSRF-hardened**: the HTTP API binds `127.0.0.1` only, and CORS allows only localhost (`localhost`/`127.0.0.1`) pages — so a malicious website you visit can't quietly `fetch` your running node and `POST /send` to drain it (especially a coin-holding treasury node).
- **No Sybil/DoS protection, no TLS, no fee market.** This is a teaching chain, not a production system.

---

## Roadmap

- [x] Phase 1 — core: block / chain / PoW / genesis tx
- [x] Phase 2 — CLI: wallet / transfer / balance / mining
- [x] Phase 3 — P2P: two-node sync / peer discovery / persistence
- [x] Phase 4 — mining broadcast + longest-chain consensus
- [x] Phase 5 — web dashboard (React/Vite live view + transfers)
- [x] Phase 6 — advanced: **adaptive difficulty** · transaction **memo** · **Merkle root** · **block explorer** (search address/txid/block)
