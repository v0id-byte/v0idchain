# v0id 浏览器（Electron MVP）

一个把 **v0idchain 守护进程 + `.v0id` 隐藏服务网络** 包成 GUI 的极简单窗浏览器。输入一个 `.v0id`
地址，它就经洋葱网络（SOCKS5 + rendezvous，守护进程已实现且测过）打到对应的隐藏服务——访问双方互不知 IP。

这是 **MVP**：直接 `electron .` 从仓库跑，暂无打包/签名/自动更新。

## 它是什么 / 架构

GUI 不重新实现洋葱或 rendezvous——那些 `packages/cli` 的 `v0id start` 已经做好。本应用只是个壳：

```
┌─────────────────────────── Electron 主进程 (src/main.js) ───────────────────────────┐
│  1) spawn 守护子进程：corepack pnpm exec tsx packages/cli/src/index.ts start --socks  │
│       → 节点 + 本地 SOCKS5 代理（既出 clearnet，也把 .v0id 经 rendezvous 连隐藏服务）  │
│  2) TCP 轮询 127.0.0.1:<socksPort> 等 SOCKS 就绪（比解析 stdout 更稳）                  │
│  3) 给 <webview> 的具名 partition session 设代理 socks5://127.0.0.1:<socksPort>        │
│       → 浏览器每次请求都走洋葱网络                                                      │
│  4) IPC：地址栏输入 xxxxx.v0id → 主进程校验 → webview 加载 http://xxxxx.v0id/           │
└──────────────────────────────────────────────────────────────────────────────────────┘
        │ preload.js (contextBridge, contextIsolation:true, nodeIntegration:false)
        ▼
   renderer (index.html + renderer.js)：地址栏 + “前往” + 状态行 + <webview>
```

文件：

| 文件 | 作用 |
| --- | --- |
| `src/main.js` | Electron 主进程：spawn 守护、等 SOCKS、设 webview 代理、IPC、退出时杀守护 |
| `src/preload.js` | contextBridge 暴露最小 `window.v0id`（`navigate` / `onStatus`） |
| `src/index.html` | 暗色 “void” 主题 UI：地址栏、状态行、`<webview partition="persist:v0id">` |
| `src/renderer.js` | 页面逻辑：导航、状态、`did-fail-load` 友好提示 |
| `scripts/browser-core-test.mjs` | 无头验证：SOCKS5 → rendezvous → 隐藏服务 的完整路径（= webview 走的路） |

## 在 macOS 上构建 / 运行

```bash
cd clients/desktop
pnpm install --ignore-workspace   # 或 npm install —— 会下载 ~100MB 的 Electron 二进制（需要能连 GitHub CDN）
pnpm start                        # 或 npm start —— 即 `electron .`
```

> ⚠️ **必须用 `--ignore-workspace`（或直接 `npm install`）。** 仓库根有个 `pnpm-workspace.yaml`，
> 裸跑 `pnpm install` 会被它“吸”进根 workspace 而**不在本目录装 electron**。`--ignore-workspace`
> 让 pnpm 把 `clients/desktop` 当成独立项目装（已实测：electron 33 二进制成功下载到本目录
> `node_modules`，且不碰根 lockfile）。`npm install` 没有这个问题（根 `package.json` 无 `workspaces` 字段）。

`clients/desktop` 是**独立**的（不是 pnpm workspace 成员，和 `clients/{macos,ios,android}` 一样各自独立构建），
所以它有自己的 `node_modules`。但它运行时会调用**仓库根**的工具链来跑守护进程，因此仓库其余部分要能
`corepack pnpm install`（守护进程经 `corepack pnpm exec tsx` 跑 `packages/cli/src/index.ts`）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `V0ID_PEERS` | 空 | 逗号分隔的种子/对等 ws 地址，如 `ws://seed.example:6001`。**不设则纯本地**——没有网络、链上中继不足，`.v0id` 解析不了。要访问真实隐藏服务必须设它加入一个有 ≥3 中继的网络。 |
| `V0ID_SOCKS_PORT` | `9050` | 守护进程 SOCKS5 端口（webview 代理也指这里）。 |

例：加入一个网络再开浏览器

```bash
V0ID_PEERS=ws://your-seed-host:6001 pnpm start
```

守护进程的数据目录在 Electron 的 `userData/v0id`（不污染仓库），日志在 `userData/browser.log`。

## 关于 `.v0id` 远程 DNS（重要）

`.v0id` 不是真实 TLD，本机 DNS 解析不了。**必须让 Chromium 把主机名原样交给 SOCKS 代理去解析**
（远程 DNS），而不是自己先解析后再连。做法是把代理写成 `proxyRules: 'socks5://127.0.0.1:<port>'`
——Chromium 对 `socks5://` 形式的代理做远程 DNS（等价于 `curl --socks5-hostname`），守护进程的
SOCKS5 收到 `ATYP=domain` 的 `.v0id` 主机名后走 rendezvous。代码里（`src/main.js`）对此有注释。

> ⚠️ **远程 DNS 的最终确认需在你的 Mac 上手动验证**：本环境无显示、跑不起 GUI。开浏览器访问一个
> 已托管的 `.v0id` 后，看守护进程窗口/`browser.log` 是否出现该 `.v0id` 的 CONNECT 日志即可确认
> Chromium 把主机名交给了代理（而非本地解析失败）。`scripts/browser-core-test.mjs` 已用真实
> `curl --socks5-hostname` 无头证明了 SOCKS→rendezvous→隐藏服务这条路本身是通的。

## 无头自测（核心能力）

GUI 在无显示环境跑不了，但浏览器的**核心路径**可以无头验证：

```bash
cd clients/desktop
corepack pnpm exec tsx scripts/browser-core-test.mjs
# 期望末行：ALL PASS
```

它起 6 个进程内中继 + 一个隐藏服务（桥到本机 HTTP），再起带 HS deps 的 SOCKS5，然后用真实
`curl --socks5-hostname … http://<addr>.v0id/` 取回 body——正是 Electron webview 将走的路径。

## 诚实的边界（MVP）

- **没有打包/签名/自动更新**：从仓库 `electron .` 跑。
- `.v0id` 解析**只在守护进程运行、链上 ≥3 个中继、且目标服务已发布描述符时**有效。纯本地
  （不设 `V0ID_PEERS`）跑得起来但访问不到任何 `.v0id`（目录为空）。
- 远程 DNS 经 `socks5://` proxyRules 走（见上）；GUI 层面的最终确认需在有显示的 Mac 上手动跑一次。
