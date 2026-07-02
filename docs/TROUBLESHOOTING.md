# v0idChain 疑难杂症手册

运维 / 开发过程中真实踩过的坑，按模块分类。每条：**症状 → 根因 → 修法**。

---

## 目录

1. [隐藏服务（Hidden Service）](#1-隐藏服务hidden-service)
2. [中继 / 电路构建](#2-中继--电路构建)
3. [CloudFlare 隧道](#3-cloudflare-隧道)
4. [链上中继目录污染](#4-链上中继目录污染)
5. [部署 / systemd](#5-部署--systemd)
6. [AWS / EC2 运维](#6-aws--ec2-运维)

---

## 1 隐藏服务（Hidden Service）

### 1.1 浏览器 ERR_TIMED_OUT（-7），精确耗时 72 s

**症状**  
v0id 浏览器访问 `.v0id` 地址，约 72 s 后返回 ERR_TIMED_OUT（错误码 -7）。
`curl --socks5-hostname` 同样超时，精确在 72.06 s 断开。

**根因**  
`CIRCUIT_MAX_AGE_MS = 1 h` 在中继节点扫除逻辑里会在电路建立满 1 小时后强制销毁，
哪怕该电路每 25 s 都在收到 HS 保活 `CMD_DROP`（`lastSeen` 始终新鲜）。

引入点电路是三跳：`box1 → guard → middle → intro_relay`。
`introByCirc` 豁免只保护**最终跳**（`intro_relay` 侧），中间跳（`guard`、`middle`）不在
`introByCirc` 里，仍受 max-age 检查。

1 小时后 guard 扫除其转发电路 → DESTROY 级联传播到 `intro_relay` → `introTable` 摘除
`authKey` 登记 → 客户端发出的 `INTRODUCE1` 被静默丢弃 → `RENDEZVOUS2` 永不到达 →
`RDV_TIMEOUT` (12 s) + 建路时间 (∼6 s) ≈ `HS_ATTEMPT_TIMEOUT` (18 s)，
连接重试 4 次，共 4 × 18 s = 72 s。

**修法**  
`packages/node/src/relay/relaynode.ts` `sweep()` 中删除 `else if (max-age)` 分支，
只保留 idle 检查（10 分钟无流量）。有保活流量的引入点转发电路不再被误杀；
真正废弃的电路仍被 idle 回收。

```diff
- else if (now - c.createdAt > this.dos.maxAgeMs) this.destroyCircuit(c, undefined, 'max-age');
```

修复后需重启引入点服务（`v0id-seed`）让 HS 重建新鲜引入点电路并重新发布描述符，
再同步重启各中继节点（`v0id-relay`）令修复生效。  
`commit b34a68c`

---

### 1.2 描述符发布成功但客户端总取不到（rev 防回滚）

**症状**  
服务重启后 `publishDescriptors()` 成功打印，但客户端拿到旧描述符（旧 authKey），
`INTRODUCE1` 始终被引入点静默丢弃，RENDEZVOUS2 永不到达。

**根因**  
HSDir 只接受同一 `descId` 下 `rev` 严格更高的描述符（防回滚）。服务重启后若 `rev`
从 `0` 开始，低于 HSDir 已存的旧 `rev` → HSDir 拒收新描述符，继续供旧描述符（旧 authKey）。

**修法**  
`rev` 用墙钟毫秒作底：`Math.max(Date.now(), this.lastRev + 1)`。
跨重启天然更高；同进程内多次发布严格 +1。已在 `hsservice.ts` `nextRev()` 实现。

---

### 1.3 重启 HS 后 1 小时内可用，之后再次失效（已被 1.1 修复）

**症状**  
重启 `v0id-seed` 后隐藏服务立刻可连，约 1 小时后再次 72 s 超时，周期性重现。

**根因**  
即为 [1.1](#11-浏览器-err_timed_out-7精确耗时-72-s) 中 max-age 扫除问题，修复后不再复现。

---

## 2 中继 / 电路构建

### 2.1 电路建路冷启动慢（∼5 s）

**症状**  
第一次访问 `.v0id` 地址，SOCKS5 代理要等约 5 s 才开始响应。

**根因**  
`RelayReachability` 缓存冷启动：第一次 `refresh()` 要对所有中继并行做 WS 探测，
`PROBE_TIMEOUT_MS = 5000`。探测完成前不知道哪些中继可达，阻塞电路构建。

**行为说明**  
属正常设计；缓存 TTL = 3 min，暖缓存下建路秒级完成。链上目录含大量死中继时
冷启动尤其慢（见 [4.1](#41-链上目录含大量死中继polluted-directory)）。

---

### 2.2 `BUILD_CIRCUIT` 失败，错误 `extend-failed` / `extend-timeout`

**症状**  
日志出现 `extend-failed` 或 `extend-timeout`，电路无法建到三跳。

**根因候选**  
- 目标中继是链上目录里的死中继（防火墙/下线/私网地址），WS 握手失败。  
- 中继版本过旧，未实现 EXTEND 协议（hairpin NAT、旧版 link-closed）。  
- CF 隧道 SNI 路由失败（见 [3.1](#31-中继间-extend-失败cf-tunnel-sni-路由错误)）。

**修法**  
可达性探测缓存（`RelayReachability`）会在失败后 `markBad`，TTL 内自动剔除死中继。
若多跳都失败可手动检查链上目录：`v0id status` 看中继列表，确认可达 IP/端口。

---

### 2.3 守卫节点（GuardManager）锁死已离线的中继

**症状**  
`guards.json` 里三个守卫全是已下线的 mc 节点（如 `mc.void1211.com:6021-6026`），
所有电路都建不起来，日志看不到成功 `CREATED`。

**根因**  
`GuardManager` 持久化采样集，`DEFAULT_LIFETIME_MS = 30 天`，
`DEFAULT_COOLDOWN_MS = 10 min`。离线的守卫 10 min 冷却后再试，仍失败再冷却，
循环无法自动切换到新守卫（因为 `sampleSize = 3`，采样集满则不补充）。

**修法**  
删除数据目录下的 `guards.json`，让守卫重新采样。  
Mac 浏览器：`~/Library/Application Support/v0id-browser/v0id/guards.json`  
服务端节点：`<dataDir>/guards.json`（默认 `.data/<name>/guards.json`）

---

## 3 CloudFlare 隧道

### 3.1 中继间 EXTEND 失败，CF Tunnel SNI 路由错误

**症状**  
中继间 EXTEND 失败（`extend-failed`），curl HTTP 426 探测能连上，但 WS 握手失败。

**根因**  
链上目录广播端口 443 的中继，需经 CF 隧道 `wss://hostname:443`（CF 边缘按
SNI/Host 路由）。旧代码统一用 `ws://IP:port`，连上了 CF 边缘 IP 但 SNI 是 IP 而非
主机名 → CF 找不到对应隧道 → 握手失败。

**修法**  
`dialRelay()` 和 `client.ts connect()`：端口 443 改用 `wss://hostname:port`；
明文端口仍用 `ws://IP:port`。

```typescript
const scheme = port === 443 ? 'wss' : 'ws';
// wss（CF 隧道）必须按主机名连接以走对 SNI
const target = scheme === 'wss' ? host : resolvedIp;
new WebSocket(`${scheme}://${target}:${port}`, ...);
```

---

### 3.2 CF 隧道空闲超时把 WebSocket 掐断

**症状**  
浏览器访问成功一两次后，随机出现连接失败；日志里 WS 连接报 close。

**根因**  
CF 隧道默认约 60–90 s 空闲掐断 WebSocket。引入点电路长期驻留但无业务流量时，
沿途 CF 隧道会掐断 WS → 引入点电路死亡 → introTable 登记消失（见 [1.1](#11-浏览器-err_timed_out-7精确耗时-72-s)）。

**修法**  
HS 侧每 25 s 向每条引入电路终点发 `CMD_DROP` 保活 cell（中继静默丢弃，零协议改动）。
已在 `hsservice.ts startIntroKeepalive()` 实现。

---

### 3.3 CF Bot Fight Mode 阻断 WS 升级

**症状**  
中继 WS 握手返回 403，curl 到 CF 隧道地址被重定向或返回验证页面。

**修法**  
Cloudflare 仪表盘 → Security → Bots → **关闭 Bot Fight Mode**。

---

### 3.4 `--relay-advertise-port` 与 `--relay-port` 不一致

**症状**  
中继注册到链上的端口是本地监听端口（如 6021），但 CF 隧道暴露的是 443，导致
客户端拨号 `ws://host:6021` 而非 `wss://host:443`，拨号失败。

**修法**  
用 `--relay-advertise-port 443` 让链上广播 443（CF 入口），本地仍监听 `--relay-port`：

```bash
v0id start --relay \
  --relay-port 6021 \
  --relay-advertise v0id-r1.void1211.com \
  --relay-advertise-port 443
```

---

## 4 链上中继目录污染

### 4.1 链上目录含大量死中继（Polluted Directory）

**症状**  
`v0id status` 看到 10 条中继，但浏览/托管时 `EXTEND` / `hsFetch` 大量失败，
实际只有 3 条 AWS 中继可用；冷启动电路建路耗时 > 5 s。

**根因**  
链上 `RELAY|` 交易只能发布、无法注销。早期注册的 mc 中继（防火墙/关机/hairpin NAT）
永久留在链上，污染中继目录；客户端选路时随机撞到死中继就要等 EXTEND 超时（6 s）。

**影响**  
- `responsibleHsDirs(descId, ALL_10_relays, 6)` 选出的 6 个 HSDir 可能只有 ≤3 个活的。
- 冷启动可达性探测要对全部 10 条并行 WS 探测，约 5 s。
- `BUILD_CIRCUIT` 随机撞到死中继 → `extend-failed` → 重试。

**缓解**  
- 已加可达性探测缓存（`RelayReachability`）：首次探测后 TTL = 3 min，暖缓存下
  死中继秒级剔除，不再付 6 s 超时。  
- PR #32 加入选路抗污染（reachability 探测 + 转发判负 / RP 回退 / 引入点多轮）。  
- 彻底解决方案：链上加中继注销交易或质押到期自动失效（待做）。

---

## 5 部署 / systemd

### 5.1 `EADDRINUSE` —— 用户级 systemd 服务与系统服务冲突

**症状**  
`v0id-seed.service` 启动失败，日志 `EADDRINUSE :::6001`；端口被另一个进程占用。

**根因**  
`~/.config/systemd/user/v0idchain-seed.service` 用户级 systemd 服务用旧配置（miner 模式）
占用同一端口 6001，与系统级 `v0id-seed.service` 冲突。

**修法**  
```bash
systemctl --user stop  v0idchain-seed
systemctl --user disable v0idchain-seed
rm ~/.config/systemd/user/v0idchain-seed.service
systemctl --user daemon-reload
```

---

### 5.2 新增 `@v0idchain/core` 依赖后种子节点崩溃（静态 import 失败）

**症状**  
`v0id-seed.service` 重启后立刻 crash，日志 `Cannot find package '@v0idchain/core'`
或 `ERR_MODULE_NOT_FOUND`。

**根因**  
`packages/node` 用 tsx 静态 `import`，pnpm workspace 需先执行 `--frozen-lockfile` 安装才能
找到新依赖。直接 `git pull` + 重启不装依赖时崩溃。

**修法**  
每次 `git pull` 后、重启服务前先：
```bash
corepack pnpm install --frozen-lockfile
```

---

### 5.3 部署顺序：应先重启中继再重启 HS

**说明**  
`v0id-seed`（含 HS）在启动时会向当前各中继建引入点电路。若中继节点在 HS 之后重启，
原有引入点电路会因 `link-closed` 级联 DESTROY 失效，HS 不会自动重建（无 auto-repair）。

**正确顺序**  
1. 重启各 relay 节点（`v0id-relay.service`）  
2. 重启 HS/seed 节点（`v0id-seed.service`）  
3. 等待日志出现 `隐藏 <addr>.v0id → ...` 确认 HS 发布成功  

---

### 5.4 `v0id-seed.service` 广播 IP / Peer 配置陈旧

**症状**  
日志显示 `P2P ws://18.224.54.51:6001`（旧 IP）或 `对等 wss://v0id-main.void1211.com:443`
（已死对等），节点无法同步链。

**根因**  
EC2 实例停启后公网 IP 变化，service 文件里的 `--advertise` 和 `--peers` 参数未更新。

**修法**  
编辑 `v0id-seed.service`（通常在 `/etc/systemd/system/` 或 `~/.config/systemd/user/`），
更新 `--advertise <新公网IP>` 和 `--peers <有效seed地址>`，再 `systemctl daemon-reload && systemctl restart v0id-seed`。

---

## 6 AWS / EC2 运维

### 6.1 EC2 Instance Connect SSH 密钥 60 s 过期

**症状**  
`send-ssh-public-key` 成功，但随后 SSH 返回 `Permission denied (publickey)`。

**根因**  
EC2 Instance Connect 注入的临时公钥只有 **60 秒**有效期。
两次操作之间的等待（parallel 循环、网络延迟）可能超时。

**修法**  
注入和 SSH 必须在同一命令链里原子执行：

```bash
aws ec2-instance-connect send-ssh-public-key \
  --instance-id <ID> --instance-os-user ec2-user \
  --ssh-public-key file://~/.ssh/id_ed25519.pub \
  --profile v0idops
ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_ed25519 ec2-user@<IP> "..."
```

多实例并行时用函数封装，确保每个实例都在自己的 `send-ssh-public-key` 后立即 SSH。

---

### 6.2 AWS t2.micro OOM（社交链满节点）

**症状**  
`v0id-seed.service` 随机重启或被 OOM Killer 杀死；`dmesg | grep -i oom` 可见。

**根因**  
社交链满节点内存占用 ∼711 MB，t2.micro 仅 1 GB RAM，Linux OOM 触发。

**修法**  
加 2 GB swap（`fallocate` 在某些 Amazon Linux 版本报 EINVAL，用 `dd` 代替）：

```bash
sudo dd if=/dev/zero of=/swapfile bs=128M count=16
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
```

---

### 6.3 Amazon Linux 2023 无 `nc` 命令

**症状**  
`nc -zv <host> <port>` 报 `command not found`。

**修法**  
用 curl 测 WebSocket 端口可达性（HTTP 426 = 服务在线并拒绝非 WS 升级）：

```bash
curl -s -o /dev/null -w '%{http_code}' http://<host>:<port>
# 返回 426 = WebSocket 中继端口正常
```

---

### 6.4 EC2 实例 git pull GitHub 超时（mc box 专属）

**症状**  
mc box（`mc.void1211.com`）上 `git pull` 卡住超时，AWS EC2 直连 GitHub 正常。

**根因**  
mc 服务器网络路由问题，需走本机 Clash 代理出站。

**修法**（仅 mc box，AWS EC2 直连正常）：
```bash
git -c http.proxy=http://127.0.0.1:7890 fetch origin
git reset --hard origin/main
```

---

### 6.5 AWS relay 节点本地有未提交修改导致 `git pull` 拒绝

**症状**  
`git pull` 报 `Please commit your changes or stash them before you merge. Aborting`，
relay 节点停在旧代码。

**根因**  
直接在服务器上 patch 了文件但未 commit（常见于紧急修复），与上游 commits 冲突。

**修法**  
若上游已包含这些修改，直接 hard-reset：

```bash
git fetch origin
git reset --hard origin/main
corepack pnpm install --frozen-lockfile
sudo systemctl restart v0id-relay
```

⚠️ 先确认上游确实包含本地修改，否则会丢失 patch。

---

*最后更新：2026-06-27*
