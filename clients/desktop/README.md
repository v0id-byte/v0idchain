# v0id 浏览器（Electron + React）

一个把 **v0idchain 守护进程 + `.v0id` 隐藏服务网络** 包成 GUI 的桌面浏览器。输入一个 `.v0id`
地址，它就经洋葱网络（SOCKS5 + rendezvous，守护进程已实现且测过）打到对应的隐藏服务——访问双方互不知 IP。

外壳是一个 **React 多板块应用**（左侧栏：浏览器 / 浏览客户端 / 中继 / 托管站点 / 链·挖矿 / 钱包），
其中「浏览器」板块是**可用的多标签 `.v0id` 浏览器**（标签、前进/后退/刷新、地址校验、书签、起始页）。
其余 5 个板块本阶段是**占位面板**：说明各自角色 + 只读链状态，运行时开关与质押/钱包动作留待下一阶段 (E)。

## 架构

GUI 不重新实现洋葱或 rendezvous——那些 `packages/cli` 的 `v0id start` 已经做好。本应用只是个壳：

```
┌─────────────────────────── Electron 主进程 (src/main.js，纯 CJS) ───────────────────────────┐
│  1) spawn 守护子进程：corepack pnpm exec tsx packages/cli/src/index.ts start --socks --peers … │
│       → 节点 + 本地 SOCKS5 代理（既出 clearnet，也把 .v0id 经 rendezvous 连隐藏服务）          │
│       种子默认取 src/seeds.js 的 DEFAULT_PEERS（除非 V0ID_PEERS 覆盖）→ 开箱即用、非本地孤岛  │
│  2) TCP 轮询 127.0.0.1:<socksPort> 等 SOCKS 就绪（比解析 stdout 更稳）                          │
│  3) 给 <webview> 的具名 partition session 设代理 socks5://127.0.0.1:<socksPort>                │
│       → 浏览器每次请求都走洋葱网络；+ deny-all 权限 + WebRTC 走代理（防 IP 泄露）              │
│  4) IPC（preload contextBridge）：地址校验 / 链状态只读 / 书签文件 I/O                          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
        │ preload.js (contextBridge, contextIsolation:true, nodeIntegration:false)
        ▼
   渲染层 = React + Vite（src/renderer/）：窗口自身的「受信页面」（无 Node）。
   不可信的 .v0id 页面只在「浏览器」板块的 <webview partition="v0id"> 里加载。
```

### 安全模型（关键）

- **React 渲染层是受信的窗口页面**：`contextIsolation:true` + `nodeIntegration:false`，所有特权操作
  （书签文件 I/O、地址校验、取链状态）都经 `preload` 的 contextBridge IPC 转交主进程，渲染层拿不到 Node。
- **不可信的 `.v0id` 页面只在 `<webview partition="v0id">` 里**：该 partition 的 session 被
  `main.js` 设了 SOCKS5 代理 + **deny-all 权限**（`setPermissionRequestHandler`/`setPermissionCheckHandler`）
  + **WebRTC 强制走代理**（`force-webrtc-ip-handling-policy=disable_non_proxied_udp`，防 ICE/STUN 泄露本机/公网 IP）。
  webview 标签不开 `nodeintegration`/`preload`，拿不到 Node。
- **内存型 partition（隐私）**：partition 名是 `v0id`（**无 `persist:` 前缀**）→ cookie / 缓存 / localStorage /
  IndexedDB / 已访问链接全留在内存，进程退出即蒸发，磁盘不留浏览痕迹。唯一落盘的是用户主动收藏的书签。
- **弹窗/越权加固**：`app.on('web-contents-created')` 对 webview 的 webContents 设
  `setWindowOpenHandler(deny)`（拒绝 `.v0id` 页开未加固的新窗口）+ `will-navigate` 限定 http(s)/about:blank。
  地址校验（`normalizeTarget`）对**非 .v0id** 目标拒绝环回/私网 IP（防恶意页诱导打本机守护 API）。
- 所有标签共享同一个 `v0id` session（同一条 SOCKS 路径）。

### 文件

| 文件 | 作用 |
| --- | --- |
| `src/main.js` | Electron 主进程（纯 CJS）：spawn 守护、等 SOCKS、设 webview 代理、IPC（导航/校验/链状态/书签）、退出杀守护、dev 载 Vite / prod 载 dist |
| `src/preload.js` | contextBridge 暴露 `window.v0id`：`navigate` / `validate` / `info` / `bookmarks.{list,add,remove}` / `onStatus` |
| `src/seeds.js` | `DEFAULT_PEERS`（出厂种子，默认 `ws://mc.void1211.com:6001`）；main.js 在未设 `V0ID_PEERS` 时用它 |
| `src/renderer/` | **React + Vite** 渲染层（外壳 + 浏览器 + 占位板块），构建到 `src/renderer/dist/` |
| `src/renderer/App.jsx` | 外壳：左侧栏 6 板块切换 |
| `src/renderer/sections/Browser.jsx` | 多标签 `.v0id` 浏览器（标签 / 前后退刷新 / 地址校验 / 书签 / 起始页） |
| `src/renderer/sections/Placeholders.jsx` | 5 个占位板块（角色说明 + 只读 `/info` 状态 + “下一阶段 E”提示） |
| `scripts/browser-core-test.mjs` | 无头验证：SOCKS5 → rendezvous → 隐藏服务 的完整路径（= webview 走的路） |
| `scripts/demo-network.mjs` | 本地 demo `.v0id` 网络（常驻），给手动 GUI 验证用（外部 SOCKS :9050） |

## 在 macOS 上构建 / 运行

`clients/desktop` 是**独立**的（不是 pnpm workspace 成员），有自己的 `node_modules`：

```bash
cd clients/desktop
pnpm install --ignore-workspace   # 或 npm install —— 装 React/Vite/Electron（Electron ~100MB，需连 GitHub CDN）
pnpm build                        # Vite 构建 React 渲染层 → src/renderer/dist/
pnpm start                        # electron . —— 主进程加载构建好的 dist
```

> ⚠️ **必须用 `--ignore-workspace`（或直接 `npm install`）。** 仓库根有 `pnpm-workspace.yaml`，
> 裸跑 `pnpm install` 会被它“吸”进根 workspace 而**不在本目录装依赖**。`--ignore-workspace`
> 让 pnpm 把 `clients/desktop` 当独立项目装。`npm install` 没有这个问题（根 `package.json` 无 `workspaces`）。

应用运行时会调用**仓库根**的工具链跑守护进程（`corepack pnpm exec tsx packages/cli/src/index.ts`），
因此仓库其余部分也要能 `corepack pnpm install`（首次见 VERIFY 的前置）。

### 开发模式（React 热更新）

```bash
cd clients/desktop
pnpm dev                                              # 终端 A：Vite dev server（默认 http://localhost:5173）
V0ID_RENDERER_DEV_URL=http://localhost:5173 pnpm start  # 终端 B：Electron 加载 dev server（改 .jsx 即时刷新）
```

不设 `V0ID_RENDERER_DEV_URL` 时，主进程加载 `src/renderer/dist/index.html`（须先 `pnpm build`）。
若 dist 不存在又没给 dev URL，窗口会显示一段“请先 build”的指引页（而非白屏）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `V0ID_PEERS` | `src/seeds.js` 的 `DEFAULT_PEERS` | 逗号分隔的种子/对等 ws 地址。**设了就完全覆盖**默认种子。 |
| `V0ID_SOCKS_PORT` | `9050` | 守护进程 SOCKS5 端口（webview 代理也指这里）。 |
| `V0ID_API_PORT` | `7001` | 守护进程本地 HTTP API 端口（占位板块/状态行的 `/info` 从这里取）。 |
| `V0ID_SOCKS_EXTERNAL` | 空 | 设了就**不起守护**，直接用 `127.0.0.1:<port>` 上已有的 SOCKS（demo/验证，见 VERIFY.md）。 |
| `V0ID_RENDERER_DEV_URL` | 空 | 设了就加载该 Vite dev server URL（开发热更新）；否则加载构建好的 dist。 |

守护进程的数据目录在 Electron 的 `userData/v0id`，书签在 `userData/bookmarks.json`，日志在 `userData/browser.log`。

## 浏览器板块（功能）

- **多标签**：每个标签一个 `<webview partition="v0id">`，共享同一 SOCKS 会话（内存型）；非活动标签 CSS 隐藏、不销毁。新建/关闭标签。
- **导航**：后退 / 前进 / 刷新（停止）驱动当前 webview，按 `canGoBack/canGoForward` 启用；加载/失败状态，`did-fail-load` → 「连不上该 .v0id 服务」。
- **地址栏**：经 `window.v0id.validate`（= 主进程 `normalizeTarget`）校验，接受 `xxxxx.v0id` 与普通 http(s)。
- **书签**：持久化在 `userData/bookmarks.json`（**文件 I/O 在主进程**，经 contextBridge 暴露）；地址栏 ☆ 收藏/取消，起始页卡片打开/删除。
- **起始页**：书签 + 诚实引导（**不硬编码假 `.v0id` 地址**——目前没有公开站点目录）。外部 SOCKS 模式下额外提示用 demo 地址。
- **历史默认关**（隐私）：仅会话内、不落盘的「最近访问」列表，关窗即失。

## 关于 `.v0id` 远程 DNS（重要）

`.v0id` 不是真实 TLD，本机 DNS 解析不了。**必须让 Chromium 把主机名原样交给 SOCKS 代理去解析**
（远程 DNS）。做法是把代理写成 `proxyRules: 'socks5://127.0.0.1:<port>'` —— Chromium 对 `socks5://`
形式的代理做远程 DNS（等价 `curl --socks5-hostname`），守护进程的 SOCKS5 收到 `ATYP=domain` 的 `.v0id`
主机名后走 rendezvous。代码里（`src/main.js`）对此有注释。

> ⚠️ **远程 DNS 的最终确认需在你的 Mac 上手动验证**：本环境无显示、跑不起 GUI。
> `scripts/browser-core-test.mjs` 已用真实 `curl --socks5-hostname` 无头证明了 SOCKS→rendezvous→隐藏服务这条路本身是通的。

## 无头自测（核心能力）

GUI 在无显示环境跑不了，但浏览器的**核心路径**可以无头验证（须在**仓库根**跑，用根工具链的 tsx）：

```bash
# 在仓库根（含 clients/ 的那一层）：
corepack pnpm exec tsx clients/desktop/scripts/browser-core-test.mjs
# 期望末行：ALL PASS
```

它起 6 个进程内中继 + 一个隐藏服务（桥到本机 HTTP），再起带 HS deps 的 SOCKS5，然后用真实
`curl --socks5-hostname … http://<addr>.v0id/` 取回 body——正是 Electron webview 将走的路径。

## 诚实的边界

- **本阶段（2F-2/2F-3）**：React 外壳 + 可用浏览器板块已完成；另外 5 个板块是占位（角色说明 + 只读状态）。
  运行时开关、质押、钱包写操作在下一阶段 (E)。
- **没有打包/签名/自动更新**：`pnpm build` 出 Vite 产物后 `electron .` 跑。`.dmg` 公证留待后续 (2F-7)。
- `.v0id` 解析**只在守护进程运行、链上 ≥3 个中继、且目标服务已发布描述符时**有效。
- GUI 的最终确认（标签/书签/导航/远程 DNS）需在有显示的 Mac 上手动跑一次，见 `VERIFY.md`。
