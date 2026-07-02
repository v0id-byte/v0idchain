# Running a node — full setup guide

> New here? Get this working first, then go read [TUTORIAL.en.md](TUTORIAL.en.md) for transfers / marketplace / backups / etc.

---

## 1. Requirements

| Dependency | Minimum | Notes |
|------|---------|------|
| **Node.js** | **v22.13** | this project uses `pnpm@9.15.0`, which requires Node ≥ 22.13 |
| **pnpm** | 9.15.0 | managed automatically via corepack, no manual global install needed |
| **Git** | any | to clone the repo |

> ⚠️ If `corepack pnpm install` errors with `This version of pnpm requires at least Node.js v22.13`, your Node.js is too old — upgrade per §2 below.

---

## 2. Install / upgrade Node.js

**Recommended: nvm (Node Version Manager)** — switch versions freely without touching your system-wide install.

### macOS / Linux

```bash
# install nvm (skip if you already have it)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new terminal, or: source ~/.bashrc / ~/.zshrc

# install Node v22 (LTS) and switch to it
nvm install 22
nvm use 22
node -v      # should print v22.x.x (≥ 22.13)
```

> Don't want nvm? Grab the **v22.x LTS** installer straight from [nodejs.org](https://nodejs.org) instead.

### Windows

```powershell
# download and install nvm-windows
# https://github.com/coreybutler/nvm-windows/releases → nvm-setup.exe

nvm install 22
nvm use 22
node -v
```

> You can also download the v22.x Windows installer directly from [nodejs.org](https://nodejs.org).

---

## 3. Enable corepack

Node v22 ships with corepack; enable it once:

```bash
corepack enable      # requires node ≥ 16.10
corepack pnpm -v     # should print 9.15.0
```

Every pnpm command in this project is written as `corepack pnpm …` — no dependency on a global pnpm install; the version is pinned by `package.json`'s `packageManager` field.

---

## 4. Clone & install

```bash
git clone https://github.com/v0id-byte/v0idchain.git
cd v0idchain
corepack pnpm install      # ~30s the first time, cached after
```

Sanity-check the environment:

```bash
corepack pnpm smoke        # runs the core smoke tests; all green = OK
```

**Install the global `v0id` command (recommended).** A prebuilt single file, run `v0id <subcommand>` from anywhere with no per-run TS cold start:

```bash
corepack pnpm build:cli                       # esbuild bundle → packages/cli/dist/index.cjs
cd packages/cli && corepack pnpm link --global && cd ../..
v0id --help                                   # now available globally
```

> First-time `link` says `Unable to find the global bin directory`? Run `corepack pnpm setup` once (adds pnpm's global bin to PATH; open a new terminal), then link again. After editing the CLI source, just rerun `corepack pnpm build:cli` — no need to `link` again. The rest of this doc uses `v0id <subcommand>`; if you'd rather skip the global install, define a same-named function from the repo root instead: `v0id() { corepack pnpm exec tsx packages/cli/src/index.ts "$@"; }`.

---

## 5. Join the public network, run a node, mine (fastest path)

One command to start a node (no mining):

```bash
v0id start --name me --p2p-port 6001 --api-port 7001 --peers ws://mc.void1211.com:6001 --advertise <your-public-ip> # or pick another public, verified node
```

| Flag | Effect |
| --- | --- |
| `--name <name>` | node name — determines the data dir `./.data/<name>/` (default `node`) |
| `--p2p-port <port>` | inter-node P2P port (default 6001) |
| `--api-port <port>` | local HTTP control port, bound to `127.0.0.1` only (default 7001) |
| `--peers` / `--bootstrap <urls>` | comma-separated seed/peer ws addresses |
| `--advertise <url>` | this node's own ws address to broadcast (only needed if you're acting as a seed on a public/LAN address) |
| `--mine` | start mining automatically |

⚠️ The node's port choice has no effect on auto-discovery — any port that doesn't conflict works fine.

---

One command to connect to the public seed and start mining:

```bash
corepack pnpm mine
```

Equivalent to:

```
start --name miner --p2p-port 6001 --api-port 7001 --peers ws://mc.void1211.com:6001 --mine
```

On startup it prints your **wallet address**, syncs first, then starts mining:

```
🔄 connecting / syncing blocks…        ← catches up to network height first, no mining yet (avoids forks)
⛏  12:00:05  height 502 +3  balance 2 $V0ID  difficulty 21bit  peers 1  pool 0
```

`peers ≥ 1` and a rising height from a few hundred means you're connected.

**Even easier**: double-click `mine.command` (macOS) / `mine.bat` (Windows) — auto-installs deps, opens the dashboard, and starts mining. No config needed.

Check your own status from another terminal while mining:

```bash
v0id info --name miner          # address / balance / height / peer count
v0id balance --name miner       # balance only
```

> ⚠️ **Back up your wallet the moment you mine your first coin** (see [TUTORIAL.en.md §8](TUTORIAL.en.md#8-wallet-backup--recovery-must-read)): the private key only lives in `.data/miner/wallet.json` — delete the data dir and the coins are gone.

---

## 6. Local sandbox (two nodes, offline)

Good for learning the mechanics / debugging features — run node1 / node2 in two terminals:

**Terminal 1 — node1 (auto-mining)**

```bash
corepack pnpm dev:node1
# = start --name node1 --p2p-port 6001 --api-port 7001 --mine
```

**Terminal 2 — node2 (connects to node1)**

```bash
corepack pnpm dev:node2
# = start --name node2 --p2p-port 6002 --api-port 7002 --peers ws://127.0.0.1:6001
```

**Terminal 3 — operate**

```bash
v0id info --api http://127.0.0.1:7001 --name node1    # node1 status (incl. address)
v0id info --api http://127.0.0.1:7002 --name node2    # node2 status, copy its address for below

# once node1 has mined a balance, send 5 coins to node2 (fee 1, any memo)
v0id send 0x<node2-address> 5 --fee 1 --memo "lunch money" --api http://127.0.0.1:7001 --name node1

# after node1 mines the next block and packs it, both nodes should agree on the balance
v0id balance 0x<node2-address> --api http://127.0.0.1:7002
```

---

## 7. Run your own public seed node

On a server with a public IP, act as a seed so others can connect:

```bash
corepack pnpm exec tsx packages/cli/src/index.ts start \
  --name seed \
  --p2p-port 6001 \
  --api-port 7001 \
  --advertise ws://<your-public-ip-or-domain>:6001
```

- Open the firewall for the **P2P port** (6001 here); the API port (7001) binds `127.0.0.1` only, never exposed.
- Others connect with `--peers ws://<your-public-ip-or-domain>:6001` — gossip automatically helps everyone discover each other.

---

## 8. Start on boot + auto-restart on crash (systemd)

The `tsx …/index.ts start` command from the previous section is a **foreground process**: close the terminal, or reboot the server, and the node stops. For 24/7 uptime, hand it to systemd (the standard way on Linux servers).

**Create `/etc/systemd/system/v0idchain-seed.service`** (replace `<your-username>`, `<absolute-repo-path>`, and `<your-public-ip-or-domain>` with real values; the `ExecStart` flags are just your own command from §7 — the node doesn't have to be named `seed`):

```ini
[Unit]
Description=v0idChain node ($V0ID)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<your-username>
WorkingDirectory=<absolute-repo-path>
Environment=PATH=/usr/bin:/bin:/usr/local/bin
ExecStart=<absolute-repo-path>/node_modules/.bin/tsx packages/cli/src/index.ts start --name seed --p2p-port 6001 --api-port 7001 --advertise ws://<your-public-ip-or-domain>:6001
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

- `Restart=always` + `RestartSec=3`: if the process dies (uncaught exception, OOM kill, etc.) it's restarted 3 seconds later — this is the "auto-restart on crash" part.
- `WantedBy=multi-user.target` plus the `enable` below: the service comes back up automatically after a server reboot — this is the "start on boot" part.
- Want mining too? Append `--mine` to `ExecStart`. If you've installed the global `v0id` command, you can point `ExecStart` at its resolved path (`which v0id`, e.g. `/usr/local/bin/v0id`) instead — same flags either way.
- The `Environment=PATH=…` line exists because systemd doesn't load your shell config (`.zshrc`/`.bashrc`). If `node`/`corepack` live somewhere else (e.g. under nvm), add that path too, `:`-separated.

**Apply it + common commands:**

```bash
sudo systemctl daemon-reload              # run after creating/editing the unit file
sudo systemctl enable --now v0idchain-seed   # start on boot + start it right now

systemctl status v0idchain-seed --no-pager   # check it's active (running)
journalctl -u v0idchain-seed -f              # tail logs (same lines that used to scroll in your terminal)
sudo systemctl restart v0idchain-seed        # restart after changing --advertise / --peers / etc.
sudo systemctl stop v0idchain-seed           # stop it (doesn't undo the boot-start setting — it'll come back after a reboot)
```

> ⚠️ The data dir (`.data/seed/wallet.json`, etc.) gets its permissions from whichever account you set as `User=`. If you ever ran the node manually with `sudo`, it'll have chowned those files to root — systemd then fails to read them as the regular user. Fix with `sudo chown -R <your-username> .data/`.

---

## 9. Web dashboard (watch the chain live + transfer)

With a node running, open another terminal:

```bash
corepack pnpm dev:web
```

Open **http://localhost:5173** in a browser — live height / balance / block stream / block explorer, and you can transfer directly from the page.

> Transfers need the API token pasted in (found at `.data/<node-name>/api.token`) — a cross-origin page can't read local files, so paste it once and the browser remembers it.

---

## 10. Common startup issues

| Symptom | Cause / fix |
|------|------------|
| `This version of pnpm requires at least Node.js v22.13` | Node.js is older than 22.13 — upgrade per §2 |
| `corepack: command not found` | run `npm install -g corepack`, or use `npx pnpm …` instead |
| `Error: listen EADDRINUSE :::6001` | port already in use. Switch to `--p2p-port 6002`, or find and kill whatever's using it |
| Height stuck at 0 / climbing from 0 (offline) | not connected to a seed (`peers 0`). Check the `--peers` address and your firewall |
| `unauthorized: missing or invalid API token` | mutating ops (send / mine / market) need `--name <the name you started with>` |
| `corepack pnpm install` keeps hitting network errors | check whether you need a proxy, or switch registries: `COREPACK_NPM_REGISTRY=https://registry.npmmirror.com corepack pnpm install` |

More in [TUTORIAL.en.md §10 Troubleshooting](TUTORIAL.en.md#10-troubleshooting-).
