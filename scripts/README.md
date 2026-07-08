# Standalone script checks

This directory contains focused TypeScript checks and demos that exercise the chain, anonymity network, mint, paywall, relay, and developer tooling surfaces without a separate test runner. Run commands from the repository root after installing dependencies with `corepack pnpm install`.

Runtime values are rough local buckets. Scripts that bind localhost ports or start in-process relays can vary by machine, and deploy-readiness scripts may skip unless you provide the documented environment.

## Consensus and chain

| Script | What it covers | Rough runtime | Run command |
|---|---|---:|---|
| `scripts/client-protocol-test.ts` | Wallet keys, memo encryption, signatures, transaction preimages, and protocol vectors. | `<1s` | `corepack pnpm exec tsx scripts/client-protocol-test.ts` |
| `scripts/forge-chain.ts` | Helper for cheaply forging valid high chains used by staking and mint tests. | Helper | Imported by other scripts; no direct pass/fail check. |
| `scripts/integration.ts` | Multi-node WebSocket integration: block broadcast, transfer sync, late peer catch-up, and two-way mining. | `5-15s` | `corepack pnpm exec tsx scripts/integration.ts` |
| `scripts/labs/01-tamper-amount.ts` | Lab: tampering with transaction amounts and watching validation fail through txid, Merkle root, PoW, and signature layers. | `<1s` | `corepack pnpm exec tsx scripts/labs/01-tamper-amount.ts` |
| `scripts/labs/02-cheap-long-fork.ts` | Lab: a long low-difficulty fork is rejected by cumulative work selection. | `<1s` | `corepack pnpm exec tsx scripts/labs/02-cheap-long-fork.ts` |
| `scripts/labs/03-future-timestamp.ts` | Lab: future timestamps cannot be used to force the difficulty floor. | `<1s` | `corepack pnpm exec tsx scripts/labs/03-future-timestamp.ts` |
| `scripts/labs/04-double-spend-nonce.ts` | Lab: double spend, overspend, and out-of-order nonce rejection. | `<1s` | `corepack pnpm exec tsx scripts/labs/04-double-spend-nonce.ts` |
| `scripts/labs/05-corrupt-chainjson.ts` | Lab: corrupt `chain.json` is backed up and rebuilt instead of silently wiping local state. | `<1s` | `corepack pnpm exec tsx scripts/labs/05-corrupt-chainjson.ts` |
| `scripts/labs/06-checkpoint-reorg.ts` | Lab: deep reorgs past a checkpoint are rejected even with more work. | `<1s` | `corepack pnpm exec tsx scripts/labs/06-checkpoint-reorg.ts` |
| `scripts/light-sync-test.ts` | Light-client sync primitives: headers, recent blocks, and Merkle inclusion proofs. | `3-10s` | `corepack pnpm exec tsx scripts/light-sync-test.ts` |
| `scripts/smoke.ts` | Single-process end-to-end smoke: mining, transfers, balances, replay defense, chain validation, fork choice, and advanced features. | `~40s` | `corepack pnpm smoke` |

## Onion routing and mixnet

| Script | What it covers | Rough runtime | Run command |
|---|---|---:|---|
| `scripts/antireplay-test.ts` | Sliding-window anti-replay accepts reordered mixnet cells while rejecting true replays, stale counters, and out-of-range counters. | `<1s` | `corepack pnpm exec tsx scripts/antireplay-test.ts` |
| `scripts/backward-replay-test.ts` | Client-side strict replay defense for backward cells across rendezvous, stream, and hidden-service fetch paths. | `3-10s` | `corepack pnpm exec tsx scripts/backward-replay-test.ts` |
| `scripts/guards-test.ts` | GuardManager pinning, persistence, slow rotation, exclusion pruning, self-exclusion, and real-circuit guard reuse. | `3-10s` | `corepack pnpm exec tsx scripts/guards-test.ts` |
| `scripts/mixnet-test.ts` | Opt-in mixnet behavior: hop delays, cover traffic, drop handling, scheduler rate, and no behavior change when disabled. | `5-15s` | `corepack pnpm exec tsx scripts/mixnet-test.ts` |
| `scripts/onioncell-selftest.ts` | In-memory fixed-size three-hop onion cells, layered decrypt/forward behavior, exit plaintext recovery, and MAC tamper detection. | `<1s` | `corepack pnpm exec tsx scripts/onioncell-selftest.ts` |
| `scripts/onion-selftest.ts` | `ntor` onion handshake self-checks and deterministic golden vectors for docs and cross-implementation tests. | `<1s` | `corepack pnpm exec tsx scripts/onion-selftest.ts` |

## Hidden services and SOCKS

| Script | What it covers | Rough runtime | Run command |
|---|---|---:|---|
| `scripts/hsdesc-selftest.ts` | Hidden-service descriptor cryptography, blind signatures, parse/build round trips, and golden vectors. | `<1s` | `corepack pnpm exec tsx scripts/hsdesc-selftest.ts` |
| `scripts/hs-dht-test.ts` | Descriptor DHT publish/fetch over real circuits with five relays and a static directory. | `3-10s` | `corepack pnpm exec tsx scripts/hs-dht-test.ts` |
| `scripts/hs-intro-recovery-test.ts` | Hidden-service intro-point recovery after the only intro relay dies. | `5-15s` | `corepack pnpm exec tsx scripts/hs-intro-recovery-test.ts` |
| `scripts/hs-rendezvous-test.ts` | End-to-end anonymous hidden-service rendezvous, bidirectional data flow, and IP-hiding properties. | `3-10s` | `corepack pnpm exec tsx scripts/hs-rendezvous-test.ts` |
| `scripts/hsrend-selftest.ts` | Network-free INTRODUCE blind envelopes and end-to-end rendezvous data seals, including tamper and wrong-key negatives. | `<1s` | `corepack pnpm exec tsx scripts/hsrend-selftest.ts` |
| `scripts/hs-socks-test.ts` | Real `curl --socks5-hostname` access to a `.v0id` hidden service through local SOCKS5 and rendezvous. | `5-20s` | `corepack pnpm exec tsx scripts/hs-socks-test.ts` |
| `scripts/socks-demo-test.ts` | Real curl through local SOCKS5, a three-hop onion circuit, and a local HTTP service. | `1-5s` | `corepack pnpm exec tsx scripts/socks-demo-test.ts` |

## Relay, staking, and roles

| Script | What it covers | Rough runtime | Run command |
|---|---|---:|---|
| `scripts/measurer-test.ts` | Measurer probing with real WebSocket relays, short circuits, offline detection, and attestation signatures. | `3-10s` | `corepack pnpm exec tsx scripts/measurer-test.ts` |
| `scripts/relay-advertise-guard-test.ts` | Relay advertisement guards: only public broadcast hosts publish `RELAY` descriptors; private and loopback hosts stay local-only. | `<1s` | `corepack pnpm exec tsx scripts/relay-advertise-guard-test.ts` |
| `scripts/relay-daemon-smoke.ts` | Relay daemon wiring: persistent onion keys, mining balance, `RELAY` descriptor publication, discovery, and cell-port binding. | `5-30s` | `corepack pnpm exec tsx scripts/relay-daemon-smoke.ts` |
| `scripts/relay-dos-test.ts` | Relay DoS hardening: idle cleanup, extend timeout, per-connection circuit limit, cell rate limit, and per-IP circuit limit. | `5-20s` | `corepack pnpm exec tsx scripts/relay-dos-test.ts` |
| `scripts/relay-integration.ts` | Three-hop real-WebSocket relay circuit integration and anonymity properties. | `3-10s` | `corepack pnpm exec tsx scripts/relay-integration.ts` |
| `scripts/relays-selftest.ts` | Relay directory parsing, relay memo construction, and lookup behavior. | `<1s` | `corepack pnpm exec tsx scripts/relays-selftest.ts` |
| `scripts/relay-stream-test.ts` | TCP stream over a three-hop onion circuit with exit `CONNECT` and bidirectional byte flow. | `1-5s` | `corepack pnpm exec tsx scripts/relay-stream-test.ts` |
| `scripts/reward-epoch-test.ts` | Reward math for attestations and stake pools, bootstrap multiplier, pool cap, offline/no-stake exclusions, and preview purity. | `<1s` | `corepack pnpm exec tsx scripts/reward-epoch-test.ts` |
| `scripts/rolemanager-smoke.ts` | Runtime role switching through RoleManager and HTTP API: mining, relay start/stop, idempotency, and hidden-service preconditions. | `10-30s` | `corepack pnpm exec tsx scripts/rolemanager-smoke.ts` |
| `scripts/rtc-proto.ts` | WebRTC mesh proof of concept: seed signaling, DataChannel direct connection, seed shutdown, and block delivery over RTC. | `5-20s` | `corepack pnpm exec tsx scripts/rtc-proto.ts` |
| `scripts/slash-decide-test.ts` | Slashing decisions, offline-history rolling windows, SLASH transaction formation, and rejection of locally signed non-measurer slashes. | `5-20s` | `corepack pnpm exec tsx scripts/slash-decide-test.ts` |
| `scripts/staking-selftest.ts` | Staking state machine: STAKE, UNSTAKE, SLASH formation/rejection, fork safety, relay selection thresholds, activation, and config vectors. | `15-45s` | `corepack pnpm exec tsx scripts/staking-selftest.ts` |

## Mint and paywall

| Script | What it covers | Rough runtime | Run command |
|---|---|---:|---|
| `scripts/mint-bdhke-test.ts` | BDHKE blind-signature primitive against Cashu NUT-00 vectors, random round trips, unlinkability, negatives, and serialization bounds. | `<1s` | `corepack pnpm exec tsx scripts/mint-bdhke-test.ts` |
| `scripts/mint-daemon-test.ts` | Off-chain mint daemon logic: voucher issue/verify, quota ledger, no over-issue, redemption double-spend defense, and persistence. | `1-3s` | `corepack pnpm exec tsx scripts/mint-daemon-test.ts` |
| `scripts/mint-devnet-e2e.ts` | Deploy-readiness flow proving an operator-controlled devnet can accept an on-chain `REDEEM`; skips without operator key env. | `Skip or 30s+` | `corepack pnpm exec tsx scripts/mint-devnet-e2e.ts` |
| `scripts/mint-selftest.ts` | Mint consensus and state view checks: config vectors, parsing, redemption splits, activation gates, deposits, reserve conservation, unauthorized redemption rejection, and fork safety. | `5-20s` | `corepack pnpm exec tsx scripts/mint-selftest.ts` |
| `scripts/mint-spend-service-test.ts` | Online voucher spend service over hidden services: valid spend, cross-service double-spend rejection, forged voucher rejection, and unpublished address failure. | `3-10s` | `corepack pnpm exec tsx scripts/mint-spend-service-test.ts` |
| `scripts/mint-spend-test.ts` | Offline accounting for third-party service providers after atomic mint `spend`: owed ledger, persistence, shared spent set, and settlement formation. | `<1s` | `corepack pnpm exec tsx scripts/mint-spend-test.ts` |
| `scripts/paywall-curl-e2e.ts` | Client paywall flow over SOCKS-style HTTP: voucher wallet, paid-site access, insufficient balance, spent-voucher rejection, and commit-on-success behavior. | `5-20s` | `corepack pnpm exec tsx scripts/paywall-curl-e2e.ts` |
| `scripts/paywall-e2e.ts` | In-tunnel paywall handshake for `.v0id` sites: signed price discovery, chain-free payment acceptance, and free-site behavior. | `5-20s` | `corepack pnpm exec tsx scripts/paywall-e2e.ts` |
| `scripts/paywall-online-e2e.ts` | Online verification paywall path: site submits visitor vouchers to the mint over onion routing, owed accounting, double-spend rejection, and local prechecks. | `5-20s` | `corepack pnpm exec tsx scripts/paywall-online-e2e.ts` |
| `scripts/paywall-redeem-test.ts` | Paywall store to mint redemption bridge: persistence, accepted voucher transfer, redeemed cleanup, fail-closed corruption handling, and duplicate redemption defense. | `1-3s` | `corepack pnpm exec tsx scripts/paywall-redeem-test.ts` |

## Other tooling

| Script | What it covers | Rough runtime | Run command |
|---|---|---:|---|
| `scripts/check-boundaries.ts` | Architecture boundary guard: game packages depend only on core, and chain packages do not depend back on game packages. | `<1s` | `corepack pnpm check:boundaries` |
| `scripts/gen-mining-vectors.ts` | Golden mining vectors for difficulty retargeting and coinbase txids used by native client tests. | `<1s` | `corepack pnpm exec tsx scripts/gen-mining-vectors.ts` |
