# v0idnet — the `.v0id` onion anonymity network

**English | [中文](README.md)** · one of three modules ([← overview](../../README.en.md) · [blockchain](../blockchain/README.en.md) · [on-chain game](../game/README.en.md))

> A **Tor-style onion anonymity network** running on the [v0idChain blockchain](../blockchain/README.en.md). A `.v0id` address is a hidden service; **visitor and server never learn each other's IP**.

---

## What it is

- **Anonymity layer** = onion routing (3-hop circuits: ntor handshake + fixed-length cells + per-hop onion peeling) + hidden services (bidirectional rendezvous).
- **Directory layer** = the blockchain: relays register themselves on-chain, clients replay the chain to get a consistent list — **replacing Tor's directory authorities**.
- **Clients** = the v0id Browser (signed macOS app) + a CLI daemon.

> 📐 **Want the how?** See **[ARCHITECTURE.md](ARCHITECTURE.md)** (threat model / onion routing / hidden services / incentives / deployment, with diagrams). Protocol specs: [HS-PROTOCOL.md](HS-PROTOCOL.md) · [INCENTIVE-PROTOCOL.md](INCENTIVE-PROTOCOL.md) (Chinese).

## What you can do

- **Browse `.v0id`**: reach hidden services through a local SOCKS5 proxy + a 3-hop onion circuit (exit policy is deny-all by default — no clearnet exit, no legal exposure).
- **Host a `.v0id` site**: publish a local port/folder as a `.v0id` address; others reach it anonymously, neither side learns the other's IP.
- **Run a relay**: contribute bandwidth (entry guards pin the entry + DoS hardening); **Mixnet** (opt-in) adds per-hop delay for stronger traffic-analysis resistance.
- **Incentives** (built, activates at height 16000): staking (anti-Sybil) + trusted measurement + treasury rewards (built but not emitted in v1) + downtime slashing.

---

## Quick start · desktop app (easiest)

**Download**: [v0id Browser 0.2.0 (macOS / Apple Silicon)](https://github.com/v0id-byte/v0idchain/releases/tag/browser-v0.2.0) — signed + notarized, double-click to install, no Gatekeeper prompt. Windows / Linux **coming soon**.

It auto-launches the daemon + connects to the live network; type `xxxxx.v0id` in the address bar; the sidebar's 4 boards toggle relay / hosting / mining at runtime; the wallet sends/receives $V0ID.

> ⚠️ **System proxy (clash, etc.)**: add a **DIRECT** rule for `mc.void1211.com`, otherwise the daemon's `ws://` to the relays gets intercepted. A local-environment issue; normal users are unaffected.

## Quick start · CLI

```bash
corepack pnpm install
# Browse .v0id — start a local SOCKS5
corepack pnpm exec tsx packages/cli/src/index.ts start --socks --socks-port 9050 --peers ws://mc.void1211.com:6001
curl --socks5-hostname 127.0.0.1:9050 http://<address>.v0id/

# Host your own .v0id site (have a local service first, e.g. python3 -m http.server 8080)
corepack pnpm exec tsx packages/cli/src/index.ts start --hs-target 127.0.0.1:8080 --peers ws://mc.void1211.com:6001

# Run a relay to contribute bandwidth
corepack pnpm exec tsx packages/cli/src/index.ts start --relay --relay-advertise <your-public-host> --peers ws://mc.void1211.com:6001
```

## Live network

Seed `ws://mc.void1211.com:6001` (chain + directory) + 6 relays (`mc.void1211.com:6021–6026`) + a miner producing blocks. The app's `seeds.js` ships the seed, so it connects out of the box. **A real 3-hop onion circuit through these relays is end-to-end verified.**

---

## For developers

- **Code**: onion protocol `packages/core/src/{onion,onioncell,hsdesc,hsrend,mixnet}.ts`; relay/client `packages/node/src/relay/*`; desktop app `clients/desktop/`.
- **Architecture**: [ARCHITECTURE.md](ARCHITECTURE.md). **Protocol specs**: [HS-PROTOCOL.md](HS-PROTOCOL.md) (hidden services), [INCENTIVE-PROTOCOL.md](INCENTIVE-PROTOCOL.md) (incentives).
- **Tests**: `scripts/{onion-selftest,onioncell-selftest,relay-integration,hs-*,guards-test,relay-dos-test,antireplay,staking-selftest,measurer-test}.ts`, with golden vectors locked for cross-implementation parity.

## Honest boundaries

Small anonymity set = weak anonymity; does not defend against a global passive adversary's end-to-end correlation, nor application-layer deanonymization; v1 incentives use a centralized measurer + a finite treasury bootstrap pool; full `.v0id` browsing needs relays spread across distinct hosts (single-NAT topology limit, see [ARCHITECTURE §7](ARCHITECTURE.md)). Details in [ARCHITECTURE §8](ARCHITECTURE.md).
