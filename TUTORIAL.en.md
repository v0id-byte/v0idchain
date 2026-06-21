# v0idChain — Full Tutorial 🧭

**English | [中文](TUTORIAL.md)** · From zero to mining / transferring / trading on the network, plus every common command explained.

> By the end you can: run a node, mine `$V0ID`, send coins to friends (with memo/fee), buy & sell on the marketplace, back up and recover a wallet, and understand what each command does.
> Companion: [README](README.en.md) (cheat sheet + design notes).

---

## 0. Five concepts first (plain words)

| Concept | One line |
| --- | --- |
| **Wallet / address** | A keypair. The **address** = `0x` + public key, shared so people can pay you; the **private key** stays on your machine — lose it and the coins are gone. The address is your identity. |
| **Mining = minting** | Your node hashes (PoW) until it finds a block under the current difficulty; **each block rewards 1 `$V0ID`** (plus that block's fees). This is the only source of new coins. |
| **Fee (gas)** | Every transfer pays a small fee (min **1** by default) **to the miner** who includes it. Pay more → packed sooner. Sender pays `amount + fee`; recipient receives `amount`. |
| **nonce / replay protection** | Each address has an auto-incrementing counter, so the same signed tx can't be broadcast and charged twice. |
| **Consensus = most-work chain** | The chain with the **greatest cumulative PoW** wins network-wide (not the longest). Plus a future-timestamp bound and checkpoints to block cheating. |

Two more you'll meet: the **marketplace** (trade via transfer + memo, on-chain) and the **treasury address** (genesis pre-mine of 1000; its private key is only with the project author).

---

## 1. Set up (5 min)

Needs **Node ≥ 18** (20+ recommended). Use Node's built-in **corepack** for pnpm — no global install:

```bash
node -v                     # confirm ≥ 18
git clone https://github.com/v0id-byte/v0idchain.git
cd v0idchain
corepack pnpm install       # any pnpm command = corepack pnpm …
```

A shorthand to save typing (`v` = the CLI throughout this tutorial):

```bash
v() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }
v --help                   # list all commands
```

---

## 2. Path A: join the public chain, one command to mine (fastest)

```bash
corepack pnpm mine
```

This starts a node named `miner`, connects to the public seed `ws://mc.void1211.com:6001`, auto-mines, and prints a status line every 5s:

```
  🔄 connecting / syncing blocks…      ← connect to the seed + catch up first, no mining yet (avoids forks)
  ⛏ 12:00:05  height 502 +3  balance 2 $V0ID  difficulty 21bit  peers 1  pool 0
```

> **Why no mining at first?** A networked node **connects + catches up to the network height before it starts mining**, and pauses when offline — otherwise you'd mine a private "parallel chain" from genesis that nobody accepts. Once the height climbs from the hundreds and `peers ≥ 1`, you're synced.

**Even easier**: double-click `mine.command` (macOS) / `mine.bat` (Windows) — installs deps, opens the dashboard, starts mining.

While mining, drive the `miner` node from another terminal (note `--name miner`, see the token note below):

```bash
v info  --name miner                 # your address / balance / height
v balance --name miner               # this node's balance
```

> ⚠️ **Token**: `pnpm mine` uses node name **miner**. Read-only commands (info/balance/peers) need no token; but **writes (transfer/mine/market)** need `--name miner` so the CLI can auto-read `.data/miner/api.token` (else `unauthorized`). Or pass `--token <token>` explicitly.

**👉 First thing after mining a coin: back up your wallet** (see [§8](#8-wallet-backup--recovery-must-read)).

---

## 3. Path B: local sandbox, learn the mechanics (do this first)

No network — run **two nodes** on your machine and watch the whole "mine → mint → transfer → sync" loop.

**Terminal 1** — node1, auto-mining:

```bash
corepack pnpm dev:node1
# = start --name node1 --p2p-port 6001 --api-port 7001 --mine
```

**Terminal 2** — node2, connects to node1:

```bash
corepack pnpm dev:node2
# = start --name node2 --p2p-port 6002 --api-port 7002 --peers ws://127.0.0.1:6001
```

**Terminal 3** — drive them (each has its own data dir + token in `.data/node1`, `.data/node2`):

```bash
v() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }

v info --api http://127.0.0.1:7001 --name node1     # node1: height & balance climbing (it mines)
v info --api http://127.0.0.1:7002 --name node2     # node2: copy its [address]

# node1 sends 5 of its mined coins to node2 (fee 1, with a memo)
v send 0x<node2-address> 5 --fee 1 --memo "lunch" --api http://127.0.0.1:7001 --name node1

# after node1 mines a block that packs it, both nodes agree on the balance
v balance 0x<node2-address> --api http://127.0.0.1:7001     # shows 5
v balance 0x<node2-address> --api http://127.0.0.1:7002     # node2 too (synced)
```

Once this clicks, you understand the whole chain.

---

## 4. Every common command, explained 📖

All "client" subcommands talk to a **running** node via `--api <url>` (default `http://127.0.0.1:7001`); use `--name` / `--data-dir` to locate that node's token file.

### `start` — run a node (the big one)

```bash
v start --name me --p2p-port 6001 --api-port 7001 --peers ws://mc.void1211.com:6001 --mine
```

| Option | Meaning |
| --- | --- |
| `--name <name>` | node name → data dir `./.data/<name>/` (default `node`) |
| `--p2p-port <port>` | P2P port between nodes (default 6001) |
| `--api-port <port>` | local HTTP control port, bound to `127.0.0.1` (default 7001) |
| `--peers` / `--bootstrap <urls>` | comma-separated seed/peer ws URLs |
| `--advertise <url>` | this node's externally-reachable ws URL (only when acting as a public/LAN seed) |
| `--mine` | auto-mine after start |
| `--mine-interval <ms>` | gap between blocks; default `0` = mine continuously (paced by difficulty); set >0 to save power |

On start it prints: address, P2P/API URLs, data dir, **token path** (`api.token`), current height and balance.

### `info` — node status

```bash
v info --name me
```
```
address   0x….
balance   7 $V0ID
height    503 (504 blocks)
mempool   0 pending
difficulty 21
fee       ≥ 1 (gas, to miner)
peers     1
```

### `balance` — check balance

```bash
v balance                       # no address = this node
v balance 0x<address> --name me # any address
```

### `send` — transfer (core)

```bash
v send 0x<to-address> 100 --fee 2 --memo "thanks!" --name me
```
- Sender is debited **amount + fee** (102 here); recipient receives **amount** (100); the fee (2) goes to the miner who packs it.
- `--fee`: min **1**; **higher = packed sooner** (fee auction under congestion).
- `--memo`: on-chain note (≤128 chars, emoji ok).
- Prints `✅ broadcast txid=… fee=2`. The tx confirms (and balances change) only once a miner includes it in a block.

### `mine` — mine a few blocks manually

```bash
v mine 3 --name me      # make the running node mine 3 blocks now
```
(`start --mine` mines continuously in the background; `mine N` nudges a few — handy in the sandbox.)

### `peers` / `connect` — view / add peers

```bash
v peers --name me
v connect ws://127.0.0.1:6002 --name me
```

### `checkpoint` — produce a history-freeze entry (operator use)

```bash
v checkpoint 300 --name me
#  { index: 300, hash: '0000…' },     ← paste into CHECKPOINTS in packages/core/src/config.ts
```
Pins a well-confirmed height to block deep reorgs (≥51% attacks). **All nodes must carry identical entries and restart together**; a wrong hash makes the local chain fail validation. Most people never need this — it's a maintainer chore.

### `market` — marketplace (see [§6](#6-marketplace-buy--sell))

```bash
v market list [--all] --name me
v market sell <price> <title…> --name me
v market buy  <listing-id-prefix> --name me
v market delist <listing-id> --name me
```

### `msg` / `inbox` — on-chain messages (burn-to-speak, see [§7](#7-on-chain-messages--newcomer-discovery-))

```bash
v msg 0x<recipient> hello there --name me      # send: default burns 5 + 1 fee
v inbox --name me2                              # recipient reads the inbox (wait one block)
v inbox --sent --name me                        # see what you've sent
```

### `newcomers` — newcomers found this session

```bash
v newcomers --name me     # lists "new node online" / "new address first seen" (a running node also prints 🆕 live)
```

### `name` — on-chain nicknames (globally-unique, first-come-first-served)

```bash
v name claim v0id-boss --name me   # claim a nickname (self-transfer + memo; first-come; wait one block)
v name list  --name me             # list registered nicknames
v name who   v0id-boss --name me   # which address owns this nickname
v name of    --name me             # my (or a given address's) display nickname
```

Once claimed, transfers/messages/the explorer show you as `@v0id-boss` instead of a long address. Names are 1–20 chars of lowercase letters/digits/`_`/`-`; reserved names like `treasury`/`official` are blocked. Pure memo convention — **no consensus change**.

### `wallet` — wallet management (**no running node needed**, reads the data dir)

```bash
v wallet show --name me [--secret]     # address/pubkey; --secret also reveals the private key (= backup)
v wallet new  --name me2               # generate a fresh wallet in a new data dir
v wallet import <64-hex-key> --name me # recover a wallet from a backed-up key (balances come back too)
v wallet treasury-address             # show the "treasury" pre-mine address (public info)
```

---

## 5. Web dashboard (visualize the chain + transfer)

With a node running, in another terminal:

```bash
corepack pnpm dev:web
```

Open **http://localhost:5173**: live height, balance, difficulty, peer count, mempool, a live block feed, and a **block explorer** (search by address / txid / block). Top-right switches the node API and lets you **paste the API token**.

> **Want to transfer from the dashboard?** It's a cross-origin front-end with no filesystem access, so paste the token **once**: it's in the node's data dir at `api.token` (e.g. `.data/miner/api.token`) — copy its contents into the "API token" box (the browser remembers it). Read-only viewing needs no token.

---

## 6. Marketplace: buy & sell 🛒

The marketplace is built purely on "transfer + memo" — **no consensus change, no server** — and listings sync chain-wide:

```bash
# seller lists (self-transfer 1 coin + min fee, records the item on-chain; needs ≥2 balance)
v market sell 30 "chapter-3 study notes" --name me
#  🏷 listed txid=9f59c01a…(visible after one block confirms)

# anyone can see it (synced network-wide)
v market list --name me
#  [on sale] 30 $V0ID  chapter-3 study notes   seller 0x12ab…  id 9f59c01a34bc…

# buyer purchases (pays the price to the seller; id prefix is fine)
v market buy 9f59c01a --name me
#  🛒 ordered & paid txid=…
```

Delist: `v market delist <listing-id> --name me` (only the seller). **Settle on-chain (payment + sale record), deliver off-chain** (notes / help / a drink).

---

## 7. On-chain messages & newcomer discovery ✉️

**Messaging = burn-to-speak.** Send a line to any address: instead of transferring coins, you **burn** a little `$V0ID`
into the void (forever unspendable = destroyed). The body is plaintext on-chain, syncs network-wide, and is permanent.
Technically it's a new kind of transaction (`amount=0 + burn>0 + memo=body`), plus the min fee to the including miner.

```bash
# node1 messages node2 (default burns 5 + 1 fee)
v msg 0x<node2-addr> "leaving you a note on-chain 👋" --name node1
#  ✉️ message broadcast txid=…  🔥burn=5 fee=1

# after a block packs it, node2 reads its inbox
v inbox --name node2
#  ← 0x…(node1)  leaving you a note on-chain 👋   🔥5 #25   2026/6/21 …

v inbox --sent --name node1     # node1 sees what it sent
```

Burn more to flex / deflate harder: `--burn 50`. Total burned across the network: "Burned 🔥" in `v0id info` or atop the dashboard.

**🔒 Encrypted DMs**: add `-e` so only the recipient can read it (ciphertext on-chain as `ENC|…`; you, the sender, can also decrypt your own):

```bash
v msg 0x<node2-addr> "a secret only you can read 🤫" -e --name node1
v inbox --name node2     # node2 auto-decrypts to plaintext + 🔒
```

> Encryption raises the memo cap from 128 to 512 (to fit ciphertext) — a soft fork, so upgrade all nodes together; no chain reset.

**Newcomer discovery.** A running node prints a live `🆕` line for two kinds of "newcomer"; also via `v0id newcomers` / the dashboard "Newcomers" panel:

- **New node online** (P2P layer): when a new machine connects and announces its address in the handshake.
- **New address first seen** (economic identity): the first time an address appears as a sender/recipient in a block.

> ⚠️ **Messaging is a soft fork**: nodes that haven't upgraded will reject blocks containing message transactions. Before
> messaging over the network, make sure **every node (including the public seed) is upgraded**. But the genesis hash and existing
> checkpoints are **unchanged** (the burn enters the txid only when >0), so the old chain and treasury pre-mine stay valid — **no reset needed**.

---

## 8. Wallet backup & recovery (must-read ‼️)

Your private key lives only in `.data/<node-name>/wallet.json` (mode `0600`, owner-only). **Deleting the data dir / switching machines = coins gone**, unless you backed up the key.

```bash
# Back up: reveal the key, store it somewhere safe (don't screenshot it into a group chat)
v wallet show --name miner --secret

# Recover: after a wipe or new machine, restore from the key (balances come back)
v wallet import <your-64-hex-key> --name miner
# then run corepack pnpm mine to go online; the balance re-syncs
```

---

## 9. Play with friends 🌐

### A. Same LAN (same WiFi)

Person A finds their LAN IP (e.g. `192.168.1.23`) and acts as a mini-seed:

```bash
v start --name me --p2p-port 6001 --api-port 7001 --advertise ws://192.168.1.23:6001 --mine
```

Others connect to them (one is enough — gossip discovers the rest):

```bash
v start --name me --p2p-port 6001 --api-port 7001 --peers ws://192.168.1.23:6001 --mine
```

### B. Across networks — just use the public seed

Easiest: everyone runs `corepack pnpm mine` (it already has `--peers ws://mc.void1211.com:6001`) and joins the same chain. To pay each other, grab the address from their `info`.

---

## 10. Troubleshooting 🛠️

| Symptom | Cause / fix |
| --- | --- |
| **Height stuck at 0 / climbing on its own** | Not connected (`peers 0`). A networked node must connect+catch-up before mining; check `--peers`, firewall/ports. `info` → is `peers ≥ 1`? |
| **`unauthorized: missing or wrong API token`** | Writes (send/mine/market) need a token. Pass `--name <your-start-name>` (e.g. `--name miner`) so the CLI reads `api.token`, or `--token <token>`. |
| **`can't reach node …`** | That node isn't running, or wrong `--api` port. `start` it, then use the matching `--api-port`. |
| **transfer says "insufficient balance: have X, need Y (incl. fee N)"** | Your balance < amount + fee. Mine/receive more, or lower the amount/`--fee`. |
| **two nodes disagree on height/balance** | Give it a few seconds to sync; or the other just mined a block not yet propagated. `peers` to confirm they're connected. |
| **`chain.json failed to load… backed up to chain.json.corrupt-…`** | The chain file was corrupt; the node **auto-backed it up and rebuilt from genesis** (re-syncs online) — this is protection, not a bug. |
| **start over** | Delete the data dir: `rm -rf .data/<node-name>` (**this loses that node's wallet** — back up the key first!). |

---

## 11. Security & limits (don't use real money)

This is a **teaching chain**. It's been hardened (most-work consensus + future-timestamp bound vs double-spend, checkpoints freezing history, API token auth, `0600` wallet/token files, P2P private-address filtering vs SSRF, corrupt-chain fail-safe — see [README "Design notes & known limits"](README.en.md#design-notes--known-limits-toy-chain--not-for-real-money)).

But still: **no TLS, no inter-node encryption, and the inherent 51% risk of a low-hashrate PoW chain** (checkpoints raise the cost, they don't remove it). So: **no real money** — learning and playing with friends is exactly the right use.

---

## 12. Going deeper

```bash
corepack pnpm smoke                              # core self-test (mining/transfer/consensus/security regressions)
corepack pnpm exec tsx scripts/integration.ts    # multi-node integration test
corepack pnpm -r run typecheck                   # typecheck all packages
```

Source tour: `packages/core` (block/chain/PoW/transaction/wallet/storage/consensus) · `packages/node` (p2p / mining orchestration / local API) · `packages/cli` (command line) · `packages/web` (dashboard). To change the rules, start from `packages/core/src/config.ts` (parameters) and `blockchain.ts` (consensus).

Have fun — and when you mine your first `$V0ID`, run `wallet show --secret` and back it up!
