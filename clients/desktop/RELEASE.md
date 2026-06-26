# v0id 浏览器 · macOS 发布手册（Electron App）

把 `clients/desktop` 的 Electron「v0id 浏览器」打成 **签名 + 公证（notarize）+ 钉合（staple）的 `.app`/`.dmg`**，
并上传到 GitHub Release。

这是 Electron 版的发布流程，与钱包的 `clients/macos/RELEASE.md` 平行；签名身份 / 公证凭据 / `DEVELOPER_DIR`
等**事实复用钱包那份**，下面只点明 Electron 特有的部分。

## 关键设计（为什么这样打包）

打包后的 `.app` 里**没有仓库、没有 pnpm、没有 tsx**，没法像开发时那样 `corepack pnpm exec tsx …` 起守护进程。
所以：

1. **守护进程被 esbuild 打成单文件 CJS**：`pnpm bundle:daemon` 把 `packages/cli/src/index.ts` 连同
   `@v0idchain/node` / `@v0idchain/core` / `ws` / `@noble/*` 全 bundle 进
   `resources/daemon/v0id-daemon.cjs`，随 `extraResources` 进 `Contents/Resources/daemon/`。
2. **用 Electron 自带二进制当 Node 跑它**：`app.isPackaged` 时，`main.js` 的 `spawnDaemon()` 走
   `spawn(process.execPath, [daemonCjs, 'start', '--socks', …], { env: { …, ELECTRON_RUN_AS_NODE: '1' } })`。
   `ELECTRON_RUN_AS_NODE=1` 让 Electron 退化成纯 Node（不开窗、不加载 Chromium）。开发模式仍走
   `corepack pnpm exec tsx`，两条路径跑的是同一条 `v0id start --socks …`。
3. **`node-datachannel` 被 externalize 出 bundle**：它是 `--webrtc` mesh 才用的**原生模块**（`.node`），
   且在源码里本就是 `optionalDependency` + 动态 `import()`（仅 `enableRtc` 时加载）。浏览器守护进程只跑
   `--socks`，**从不 require 它**，所以 `--external:node-datachannel` 后 bundle 干净、运行不缺它，
   也无需随包附带任何 `.node`。（`bundle:daemon` 脚本已带这个 flag。）

## 前提（Assumptions）

- 仓库（worktree）根：本 worktree 根目录（含 `clients/desktop/`），下文记作 `<repo>`。
- 应用目录：`clients/desktop`（**独立包**，非 workspace 成员；用 `pnpm install --ignore-workspace`）。
- App id：`com.v0idchain.browser`；产品名：`v0id Browser`。
- 版本源：`clients/desktop/package.json` 的 `version`（当前 `0.2.0`）。
- Developer Team ID：`C58WLH687Z`。
- 签名身份：`Developer ID Application: liuhaoran qin (C58WLH687Z)`。
  `package.json` 不再硬编码个人证书名；本机打包时请用 `CSC_NAME="Developer ID Application: liuhaoran qin (C58WLH687Z)"`
  或让 electron-builder 自动选择钥匙串里的 Developer ID 证书。下文 `codesign` / `xcrun` 仍用带前缀的全名。
- Keychain 里的公证 profile：`v0idchain-notary`。
- `xcrun` 用 `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer`。
- GitHub 仓库：`v0id-byte/v0idchain`。

公证（notarize）只能由**用户在自己的 GUI 登录会话**里跑（`v0idchain-notary` 凭据在那）。
故 electron-builder 配置里 `notarize: false`——**打包阶段只签名、不公证**，公证是下面单独的人工步骤。

## 前置检查（Preconditions）

从 `<repo>`：

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun notarytool history --keychain-profile v0idchain-notary

gh auth status
```

预期：

- 列出 `Developer ID Application: liuhaoran qin (C58WLH687Z)`。
- `notarytool history` 成功（可能显示 `No submission history`）。
- `gh auth status` 显示有效登录且有该仓库权限。

若公证 profile 不存在，用户需用 Apple ID 的 app 专用密码创建（**别让用户把密码贴进对话**）：

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun notarytool store-credentials v0idchain-notary \
  --apple-id "<apple-id-email>" \
  --team-id "C58WLH687Z" \
  --password "<app-specific-password>"
```

## 构建签名 App（Build + Sign）

```bash
cd <repo>/clients/desktop

pnpm install --ignore-workspace      # 独立包；首装会下 Electron 二进制（~100MB，走 GitHub CDN）
pnpm run build                        # Vite 构建 React 渲染层 → src/renderer/dist/
pnpm run bundle:daemon                # esbuild 打守护进程 → resources/daemon/v0id-daemon.cjs
CSC_NAME="Developer ID Application: liuhaoran qin (C58WLH687Z)" pnpm run dist  # electron-builder：签名 .app + 出 .dmg/.zip（notarize:false）
```

> `bundle:daemon` 用 `<repo>` 根的 workspace 解析 `@v0idchain/*`（它们 link 在各自包的
> `node_modules` 下）。若 `bundle:daemon` 报找不到 `@v0idchain/node`，先在 `<repo>` 根跑一次
> `corepack pnpm install --frozen-lockfile` 让 workspace symlink 就位。

产物：

```text
clients/desktop/out/mac-arm64/v0id Browser.app      # 已签名（Developer ID + 硬化运行时）
clients/desktop/out/v0id Browser-0.2.0-arm64.dmg
clients/desktop/out/v0id Browser-0.2.0-arm64-mac.zip
```

> 操作机网络注意（clash 代理）：本机若开着 clash/mihomo，`pnpm install` 下 Electron 二进制可能被代理
> 截断或变慢。直连 GitHub 即可（确认 `curl -sI https://github.com` 通）；必要时
> `export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890` 再重试，
> 或换一个普通网络。运行期访问公网种子 `mc.void1211.com:6001` 同理——把它加进 clash 的 DIRECT，
> 或在普通网络上测试，免得守护进程连不上链。

## 校验签名（Verify Signing）

```bash
APP='clients/desktop/out/mac-arm64/v0id Browser.app'

codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier|Runtime|Identifier'
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -E 'allow-jit|library-validation|network'
```

预期：

- `valid on disk` + `satisfies its Designated Requirement`。
- Authority 含 `Developer ID Application: liuhaoran qin (C58WLH687Z)`。
- `TeamIdentifier=C58WLH687Z`，且有 `Runtime Version=`（硬化运行时已开）。
- entitlements 含 `com.apple.security.cs.allow-jit`、`…disable-library-validation`、
  `…network.client`、`…network.server`（守护进程跑 V8 + 监听 SOCKS / 连中继需要它们）。

确认守护 bundle 已随包：

```bash
ls "$APP/Contents/Resources/daemon/v0id-daemon.cjs"
```

## 公证 App（Notarize）—— 用户在 GUI 会话里跑

对 `.dmg` 直接公证在本机可能挂起。可靠路径：**公证 `.app` 的 ZIP → 钉合 `.app` → 从钉合后的 `.app` 再造 DMG**。

electron-builder 已经出了一个 `…-mac.zip`，可直接用它提交；或自己 `ditto` 一个：

```bash
APP='clients/desktop/out/mac-arm64/v0id Browser.app'
ZIP='clients/desktop/out/v0id Browser-0.2.0-arm64-mac.zip'   # electron-builder 产物，亦可：
# ditto -c -k --keepParent "$APP" "$ZIP"

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun notarytool submit "$ZIP" \
  --keychain-profile v0idchain-notary \
  --wait
```

预期 `status: Accepted`。若 `Invalid`，拉日志：

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun notarytool log <submission-id> --keychain-profile v0idchain-notary
```

## 钉合并校验 App（Staple + Verify）

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun stapler staple "$APP"

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcrun stapler validate "$APP"

spctl --assess --type execute --verbose=4 "$APP"
```

预期：

```text
accepted
source=Notarized Developer ID
```

## 从钉合后的 App 造 DMG（Build DMG From Stapled App）

> 这是「先公证 ZIP、钉合、再造 DMG」的关键一环——避免对 DMG 直接公证时挂起的坑。
> （此时 electron-builder 早先出的那个 `.dmg` 里的 `.app` 还没钉合，所以重新造一个钉合版 DMG。）

```bash
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
DIST='clients/desktop/out'
STAGE="$DIST/dmg-stage"
DMG="$DIST/v0id-Browser-macOS-${VERSION}.dmg"

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"

ditto "$APP" "$STAGE/v0id Browser.app"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "v0id Browser ${VERSION}" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG"

codesign --force \
  --sign 'Developer ID Application: liuhaoran qin (C58WLH687Z)' \
  --timestamp \
  "$DMG"

codesign --verify --verbose=2 "$DMG"
hdiutil verify "$DMG"
shasum -a 256 "$DMG"
```

校验 DMG 里的 App 被 Gatekeeper 接受：

```bash
MOUNT_OUTPUT=$(hdiutil attach "$DMG" -nobrowse -readonly)
MOUNT_POINT=$(printf '%s\n' "$MOUNT_OUTPUT" | awk '/\/Volumes\// {for (i=3;i<=NF;i++) {printf (i==3?"":" ") $i}; print ""}' | tail -1)
spctl --assess --type execute --verbose=4 "$MOUNT_POINT/v0id Browser.app"
hdiutil detach "$MOUNT_POINT"
```

预期 `accepted` / `source=Notarized Developer ID`。

## 上传 GitHub Release

```bash
gh release upload <tag> "$DMG" --repo v0id-byte/v0idchain --clobber
```

若该 tag 的 release 还不存在，按钱包那份 `clients/macos/RELEASE.md` 的 `gh release create …` 写法新建
（标题 / notes / SHA-256 同款）。

## 成功标准（Success Criteria）

- `pnpm run build` + `pnpm run bundle:daemon` + `pnpm run dist` 全成功，出签名 `.app`/`.dmg`/`.zip`。
- `codesign --verify --deep --strict` 通过；Authority = Developer ID、`TeamIdentifier=C58WLH687Z`、有硬化运行时。
- `Contents/Resources/daemon/v0id-daemon.cjs` 在包内。
- `xcrun notarytool submit … --wait` 状态 `Accepted`；`stapler validate` 通过。
- `spctl` 把（挂载的 DMG 里的）App 判为 `Notarized Developer ID`。
- 启动 App 后守护进程经 `ELECTRON_RUN_AS_NODE` 起来、SOCKS 端口监听、能连上公网种子开始同步。
