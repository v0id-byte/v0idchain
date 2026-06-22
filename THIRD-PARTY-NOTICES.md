# Third-Party Notices / 第三方依赖与许可声明

v0idChain is built on the open-source software listed below — we gratefully acknowledge their
authors. v0idChain does **not** vendor (copy) any of their source into this repository: every
dependency is fetched at install time by pnpm, and `node_modules/` (plus the build output `dist/`)
is git-ignored, so this repo redistributes none of their code. This file exists for attribution,
academic correctness, and to record the licenses we rely on.

v0idChain 基于以下开源软件构建，特此致谢。本仓库**不内嵌（不拷贝）**它们的源码 —— 所有依赖都在安装时由
pnpm 拉取，`node_modules/`（及构建产物 `dist/`）已 git-ignore，因此仓库本身不再分发它们的代码。本文件
用于署名、学术正确，并记录所依赖的许可证。

> Versions below are the resolved versions in the current lockfile; the semver ranges live in each
> `package.json`. License / copyright lines were read directly from the installed packages.
> 下表版本为当前 lockfile 的解析版本；semver 范围见各 `package.json`。许可证/版权信息直接读自已安装的包。

## Runtime dependencies / 运行时依赖

| Package | Version | License | Copyright | Project |
| --- | --- | --- | --- | --- |
| [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) | 2.3.0 | MIT | © 2019 Paul Miller (paulmillr.com) | ed25519 signatures |
| [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) | 1.8.0 | MIT | © 2022 Paul Miller (paulmillr.com) | SHA-256 / SHA-512 |
| [`@noble/curves`](https://github.com/paulmillr/noble-curves) | 1.9.7 | MIT | © 2022 Paul Miller (paulmillr.com) | x25519 ECDH (encrypted DMs) |
| [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) | 1.3.0 | MIT | © 2022 Paul Miller (paulmillr.com) | XChaCha20-Poly1305 (encrypted DMs) |
| [`ws`](https://github.com/websockets/ws) | 8.21.0 | MIT | © 2011 Einar Otto Stangvik | WebSocket P2P |
| [`commander`](https://github.com/tj/commander.js) | 12.1.0 | MIT | © 2011 TJ Holowaychuk | CLI argument parsing |
| [`react`](https://react.dev) | 18.3.1 | MIT | © Meta Platforms, Inc. and affiliates | dashboard UI |
| [`react-dom`](https://react.dev) | 18.3.1 | MIT | © Meta Platforms, Inc. and affiliates | dashboard UI |

## Build / development dependencies / 构建与开发依赖

| Package | Version | License | Copyright | Project |
| --- | --- | --- | --- | --- |
| [`typescript`](https://www.typescriptlang.org) | 5.9.3 | Apache-2.0 | © Microsoft Corporation | type system |
| [`tsx`](https://github.com/privatenumber/tsx) | 4.22.4 | MIT | © Hiroki Osame | run `.ts` without a build |
| [`esbuild`](https://github.com/evanw/esbuild) | 0.24.2 | MIT | © 2020 Evan Wallace | bundle the global `v0id` single-file CLI |
| [`vite`](https://vite.dev) | 5.4.21 | MIT | © 2019-present VoidZero Inc. and Vite contributors | web dev server / bundler |
| [`@vitejs/plugin-react`](https://github.com/vitejs/vite-plugin-react) | 4.7.0 | MIT | © 2019-present Yuxi (Evan) You and Vite contributors | React plugin for Vite |
| [`@types/node`, `@types/ws`, `@types/react`, `@types/react-dom`](https://github.com/DefinitelyTyped/DefinitelyTyped) | — | MIT | © Microsoft Corp. & DefinitelyTyped contributors | type definitions |

## Optional native dependency (WebRTC mesh) / 可选原生依赖（WebRTC mesh）

Declared as an **`optionalDependency`** in `packages/node/package.json` and loaded by **dynamic import**
(`packages/node/src/rtc.ts`): if the native prebuild is unavailable on a platform, the node degrades to
WS-only and never crashes. It is therefore not installed on every machine and may be absent from
`node_modules/`. It ships **prebuilt N-API binaries** that statically bundle the C++ library
`libdatachannel` (and its own transitive native libs, each under their respective licenses).
声明为 `packages/node/package.json` 里的 **`optionalDependency`**，经**动态 import**（`rtc.ts`）加载：某平台拿不到
原生预编译包时，节点自动退化为纯 WS、绝不崩溃，因此并非每台机器都会安装、`node_modules/` 中可能缺席。它分发**预编译
N-API 二进制**，内部静态打包了 C++ 库 `libdatachannel`（及其各自许可下的传递原生依赖）。

| Package | Version | License | Copyright | Project |
| --- | --- | --- | --- | --- |
| [`node-datachannel`](https://github.com/murat-dogan/node-datachannel) | 0.32.3 | **MPL-2.0** | © Murat Doğan (murat-dogan) | WebRTC DataChannel (Node N-API binding) |
| └ bundled [`libdatachannel`](https://github.com/paullouisageneau/libdatachannel) | (vendored by ↑) | **MPL-2.0** | © 2019–2021 Paul-Louis Ageneau | C++ WebRTC/SCTP DataChannel implementation |

> **MPL-2.0 is file-level copyleft**: it permits use in a larger work under any license, but modifications
> **to MPL-licensed files themselves** must stay MPL and be source-available. v0idChain **does not modify or
> vendor** either project — both are fetched at install time, unmodified — so the disclosure obligation is
> satisfied by these upstream links. 我们既不改动也不内嵌这两个项目（安装时原样拉取），故 MPL-2.0 的源码披露义务由上述上游链接满足。

## License texts / 许可证全文

All dependencies above are **MIT**, except **TypeScript** (**Apache-2.0**) and the optional native
WebRTC stack **node-datachannel / libdatachannel** (**MPL-2.0**). Each package ships its own license
under `node_modules/<pkg>/LICENSE`.
以上依赖除 **TypeScript**（**Apache-2.0**）与可选原生 WebRTC 栈 **node-datachannel / libdatachannel**（**MPL-2.0**）
外均为 **MIT**；每个包的许可证全文随包发布于 `node_modules/<pkg>/LICENSE`。

- **MIT License** — <https://opensource.org/license/mit>. The permission notice (verbatim):
  > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
  > associated documentation files (the "Software"), to deal in the Software without restriction,
  > including without limitation the rights to use, copy, modify, merge, publish, distribute,
  > sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
  > furnished to do so, subject to the above copyright notice and this permission notice being
  > included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
  > WITHOUT WARRANTY OF ANY KIND.
- **Apache License 2.0** (TypeScript) — <https://www.apache.org/licenses/LICENSE-2.0>.
- **Mozilla Public License 2.0** (node-datachannel / libdatachannel) — <https://www.mozilla.org/en-US/MPL/2.0/>.
  File-level copyleft; modifications to MPL-covered files must remain MPL and source-available. v0idChain
  uses both unmodified, so no source-disclosure action is required of this repo beyond these links.

## Standards & design references / 标准与设计参考 (concepts, not code)

These shaped v0idChain's design; **no source code was copied** — each was implemented independently
from the public specification. Cited for academic correctness.
以下文献塑造了 v0idChain 的设计；**未拷贝任何源码** —— 均依据公开规范独立实现，特此引用以求学术严谨。

1. S. Nakamoto, *Bitcoin: A Peer-to-Peer Electronic Cash System* (2008) — <https://bitcoin.org/bitcoin.pdf>.
   Inspiration for proof-of-work, difficulty retargeting, the **most-work (heaviest) chain** rule,
   `coinbase = block subsidy + transaction fees`, and Merkle roots.
2. D. J. Bernstein, N. Duif, T. Lange, P. Schwabe, B.-Y. Yang, *High-speed high-security signatures*
   (2011); IETF **RFC 8032 — EdDSA** — <https://www.rfc-editor.org/rfc/rfc8032>. The Ed25519 scheme
   (implemented via `@noble/ed25519`).
3. NIST **FIPS 180-4**, *Secure Hash Standard* — <https://csrc.nist.gov/pubs/fips/180-4/upd1/final>.
   SHA-256 (implemented via `@noble/hashes`).

---

*v0idChain's own code is © 2026 v0id-byte and released under the **MIT License** (see
[`LICENSE`](LICENSE)). This file covers third-party software only.*
