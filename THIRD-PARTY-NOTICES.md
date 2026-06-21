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
| [`ws`](https://github.com/websockets/ws) | 8.21.0 | MIT | © 2011 Einar Otto Stangvik | WebSocket P2P |
| [`commander`](https://github.com/tj/commander.js) | 12.1.0 | MIT | © 2011 TJ Holowaychuk | CLI argument parsing |
| [`react`](https://react.dev) | 18.3.1 | MIT | © Meta Platforms, Inc. and affiliates | dashboard UI |
| [`react-dom`](https://react.dev) | 18.3.1 | MIT | © Meta Platforms, Inc. and affiliates | dashboard UI |

## Build / development dependencies / 构建与开发依赖

| Package | Version | License | Copyright | Project |
| --- | --- | --- | --- | --- |
| [`typescript`](https://www.typescriptlang.org) | 5.9.3 | Apache-2.0 | © Microsoft Corporation | type system |
| [`tsx`](https://github.com/privatenumber/tsx) | 4.22.4 | MIT | © Hiroki Osame | run `.ts` without a build |
| [`vite`](https://vite.dev) | 5.4.21 | MIT | © 2019-present VoidZero Inc. and Vite contributors | web dev server / bundler |
| [`@vitejs/plugin-react`](https://github.com/vitejs/vite-plugin-react) | 4.7.0 | MIT | © 2019-present Yuxi (Evan) You and Vite contributors | React plugin for Vite |
| [`@types/node`, `@types/ws`, `@types/react`, `@types/react-dom`](https://github.com/DefinitelyTyped/DefinitelyTyped) | — | MIT | © Microsoft Corp. & DefinitelyTyped contributors | type definitions |

## License texts / 许可证全文

All dependencies above are **MIT** except **TypeScript** (**Apache-2.0**). Each package ships its own
license under `node_modules/<pkg>/LICENSE`.
以上依赖除 **TypeScript**（**Apache-2.0**）外均为 **MIT**；每个包的许可证全文随包发布于 `node_modules/<pkg>/LICENSE`。

- **MIT License** — <https://opensource.org/license/mit>. The permission notice (verbatim):
  > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
  > associated documentation files (the "Software"), to deal in the Software without restriction,
  > including without limitation the rights to use, copy, modify, merge, publish, distribute,
  > sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
  > furnished to do so, subject to the above copyright notice and this permission notice being
  > included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
  > WITHOUT WARRANTY OF ANY KIND.
- **Apache License 2.0** (TypeScript) — <https://www.apache.org/licenses/LICENSE-2.0>.

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

*v0idChain's own code is © v0id-byte. This file covers third-party software only; see the repository
root for the project's own license, if any.*
