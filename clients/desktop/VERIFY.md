# v0id 浏览器 · 操作与验证书

在你自己的 Mac 上**手动验证** GUI：本地起一个 demo `.v0id` 隐藏服务网络，再让 Electron 浏览器经它的
SOCKS5 访问那个 `.v0id`，亲眼看到页面渲染出来。

> 这是「**本地 demo 网络 + 浏览器**」的离线验证：**全程不碰公网链**、不挖矿、纯进程内内存中继。
> 它验证的正是 GUI 将走的那条路：webview → SOCKS5（远程 DNS）→ rendezvous → 隐藏服务。
> （公网真链验证见文末「进阶」，留作后续。）

---

## 前置

- **Node**：已有（仓库工具链用 `corepack pnpm exec tsx` 跑 TS）。
- **worktree 路径**：本仓库这个 worktree 的根目录，下文记作 `<根>`，即包含 `clients/desktop/` 的那一层。
  所有「终端 1」命令都从 `<根>` 跑。
- **联网**：仅「终端 2」首次 `pnpm install` 需要联网下载 Electron 二进制（~100MB，走 GitHub CDN）；
  demo 网络与访问过程**全本机回环，不需要公网**。

---

## 步骤（两个终端）

### 终端 1 —— 起 demo 网络（保持运行）

在 `<根>` 下：

```bash
corepack pnpm exec tsx clients/desktop/scripts/demo-network.mjs
```

它会起 6 个进程内中继 + 一个隐藏服务（背后桥到本机 HTTP）+ 一个 SOCKS5（默认 `:9050`），然后打印横幅：

```
────────────────────────────────────────────────────────────────
  v0id demo 网络就绪，保持本终端运行
────────────────────────────────────────────────────────────────
  要在浏览器里访问的地址：  http://xxxxxxxx.v0id/
  .v0id 地址：              xxxxxxxx.v0id
  SOCKS5 端口：             9050
────────────────────────────────────────────────────────────────
```

**记下那一行 `xxxxxxxx.v0id` 地址**（每次启动随机生成，不一样）。**这个终端保持运行别关。**

### 终端 2 —— 起浏览器，指到 demo 的 SOCKS

```bash
cd clients/desktop
pnpm install --ignore-workspace        # 首次：装 electron（务必带 --ignore-workspace，见排错）
V0ID_SOCKS_EXTERNAL=9050 pnpm start     # 让浏览器用终端 1 已起的 SOCKS:9050，而不自起守护
```

浏览器窗口打开后，状态行应显示 **「外部 SOCKS :9050（demo 网络）」**（绿点 = 就绪、可导航）。

在地址栏**粘贴终端 1 那个 `.v0id` 地址** → 回车（或点「前往」）。

---

## 预期结果

webview 里渲染出这一页：

> # ✅ 你正在浏览一个 .v0id 隐藏服务
> 这页面通过 rendezvous 经 3 跳洋葱电路送达——浏览器只知道这个 .v0id 地址，不知道服务在哪台机器。

---

## 验证清单（看到上面那页 = 三条同时成立）

1. **页面正确渲染。** `.v0id` 不是真实 TLD，本机 DNS 解析不了它。能渲染出来，就证明 webview 经
   `socks5://` 代理把主机名**原样交给了 SOCKS 做远程 DNS**（等价 `curl --socks5-hostname`），
   而不是本机解析失败——这是浏览器接线正确的核心判据。

2. **终端 1 出现该次访问的活动日志。** 收到访问的瞬间，**终端 1** 会打印一行：

   ```
   HH:MM:SS  [hs] 收到请求 GET /  ← 一次 rendezvous 会合已送达此本机落地
   ```

   这个本机 HTTP 落地**只有经 rendezvous 桥接才连得到**（没有任何对外端口），所以这行 = 请求**真的走了会合**、
   而非直连。
   （说明：底层中继/会合模块本身是静默的、不打日志；这条「收到请求」是 demo 在它**自己掌控**的落地服务上加的
   可观察探针——它落到这里，就只可能是经会合到达的。）

3. **匿名性推理。** 浏览器全程只有那个 `.v0id` 地址、经 rendezvous 连上，**自始至终不知道隐藏服务的 IP**；
   反过来隐藏服务也只看到会合点、不知道你的 IP。这正是 `.v0id` 的双向匿名属性。

---

## 排错

- **端口 9050 被占。** 换一个端口，两个终端**必须一致**：
  - 终端 1：`V0ID_SOCKS_PORT=9051 corepack pnpm exec tsx clients/desktop/scripts/demo-network.mjs`
  - 终端 2：`V0ID_SOCKS_EXTERNAL=9051 pnpm start`
- **页面空白 / 报 `did-fail-load`。** 依次确认：① 终端 1 还在跑（横幅在、没崩）；② 地址**粘对了**
  （就是终端 1 当次打印的那个，别用旧的）；③ 看浏览器日志：
  `~/Library/Application Support/v0id-browser/browser.log`（里面有 SOCKS 就绪、导航等记录）。
- **electron 没装 / `pnpm start` 报找不到 electron。** 在 `clients/desktop` 下重跑
  `pnpm install --ignore-workspace`。**别漏 `--ignore-workspace`**：仓库根有 `pnpm-workspace.yaml`，
  裸跑 `pnpm install` 会被「吸」进根 workspace 而**不在本目录装 electron**（装了个空）。
  （用 `npm install` 没有这个问题。）
- **状态行不是「外部 SOCKS …」、绿点不亮。** 多半是终端 2 没设 `V0ID_SOCKS_EXTERNAL`（那样它会去自起守护并连真链，
  和本验证无关），或终端 1 的 SOCKS 端口与终端 2 给的不一致。

---

## 进阶：真实公网验证（可选，留作后续）

上面是离线 demo。要在**公网真链**上验证（需链上 ≥3 个中继在线）：

1. **托管你自己的隐藏服务**（任意机器，先有个本机服务，比如 `127.0.0.1:8080`）：

   ```bash
   corepack pnpm exec tsx packages/cli/src/index.ts start \
     --hs-target 127.0.0.1:8080 \
     --peers ws://<种子>:6001
   ```

   它会打印一个公网 `.v0id` 地址。

2. **用浏览器访问它**（这次**不带** `V0ID_SOCKS_EXTERNAL`，让浏览器自己起守护、加入同一张网）：

   ```bash
   cd clients/desktop
   V0ID_PEERS=ws://<种子>:6001 pnpm start
   ```

   地址栏粘贴第 1 步的 `.v0id` 地址。预期同样渲染出你那个服务的页面；不同的是这条链路跨了公网真实中继。

---

## 无头自证（不需要 GUI，给你信心）

GUI 这一步必须你在有显示的 Mac 上亲手点。但 GUI 将走的**那条核心路径**已可无头证明（CI 友好）：

```bash
# 在 <根> 下：完整路径 SOCKS5 → rendezvous → 隐藏服务（含正例取回 body + 负例干净失败）
corepack pnpm exec tsx clients/desktop/scripts/browser-core-test.mjs   # 期望末行 ALL PASS
```

它用真实 `curl --socks5-hostname … http://<addr>.v0id/` 取回隐藏服务 body——正是 webview 用
`proxyRules: 'socks5://…'`（Chromium 远程 DNS）的命令行等价物。
