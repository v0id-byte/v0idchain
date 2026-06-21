#!/usr/bin/env bash
# 金标准向量自检 —— 无需 Xcode，只用 Command Line Tools 的 swiftc（CryptoKit 随 macOS SDK 提供）。
# 用途：在不打开 Xcode 的情况下，验证 V0idKit 的密钥/规范化序列化/txid/签名与 packages/core 逐字节一致。
#
# 用法：  bash clients/ios/scripts/selfcheck.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$HERE/../V0idKit"
OUT="$(mktemp -d)/v0id-selfcheck"

swiftc -O \
  "$KIT/Sources/V0idKit/Hex.swift" \
  "$KIT/Sources/V0idKit/CanonicalJSON.swift" \
  "$KIT/Sources/V0idKit/Crypto.swift" \
  "$KIT/Sources/V0idKit/Models.swift" \
  "$KIT/Sources/V0idKit/Wallet.swift" \
  "$KIT/SelfCheck/main.swift" \
  -o "$OUT"

"$OUT"
