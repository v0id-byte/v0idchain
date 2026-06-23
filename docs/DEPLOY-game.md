# 部署 game-server —— 1211 生产机安全清单

> 面向 **`rpi@mc.void1211.com -p 1211`**（树莓派 / Debian aarch64，与 pianotuner 共机）。
> 这台机器的家宽 **封死 80/443**，故全程走**高位端口**：game-server 绑 `127.0.0.1` 高位口，nginx 反代挂另一个高位口，防火墙只放反代那个口。
>
> ⚠️ **本文只是清单。实际部署由主会话亲自执行**——别让自动化盲跑改服务器/防火墙。
>
> 安全基线（已在代码里落实，见 `packages/game-server/src/{config,security,server}.ts`）：
> - 服务只 `listen('127.0.0.1', PORT)`，**绝不公网直连**，所有外部流量必须过 nginx。
> - 所有响应带安全头（`X-Content-Type-Options`/`X-Frame-Options: DENY`/`Referrer-Policy: no-referrer`/`X-Permitted-Cross-Domain-Policies: none`/严格 `CSP`/`Cross-Origin-Resource-Policy: same-origin`），无 `X-Powered-By`。
> - CORS 走**白名单**（`GAME_CORS_ORIGINS`），绝不 `*`。
> - 写端点（`/api/tx`、`/api/faucet`、`PUT /api/room`）每 IP 限流 + 请求体 64KB 上限；入参严格校验（地址 hex、金额非负安全整数、memo/txid 格式）。
> - 错误响应只回简短信息，不甩堆栈；央行私钥/节点 token 只从 env 或 0600 文件读，绝不进响应。

---

## 0. 端口规划（按需改，避开已占用）

| 角色 | 监听 | 端口 | 暴露 |
|------|------|------|------|
| v0idChain 节点 API | `127.0.0.1` | `7001`（默认） | 仅本机 |
| v0idChain 节点 P2P | `0.0.0.0` | `6001`（默认） | 公网（已有，挖矿/同步用） |
| **game-server** | `127.0.0.1` | **`8790`** | **仅本机**（只接 nginx） |
| **nginx 反代** | `0.0.0.0` | **`8443`**（HTTPS）或 **`8790x`**（HTTP 退路） | 公网（仅此口放行） |

> 选高位口避让 pianotuner 与系统服务。下文以 game-server=`8790`、nginx=`8443` 为例。
> **game-server 端口绝不进防火墙白名单**——它只在 `127.0.0.1`，外部碰不到，只有同机 nginx 能连。

---

## 1. 与 pianotuner 隔离（独立用户 + 独立目录 + 独立 unit）

**别和 pianotuner 共用账号/目录/unit。** 各跑各的，互不干扰、互不提权。

```bash
# 1.1 建一个非特权专用用户（不可登录、无 sudo），仅用来跑 game-server
sudo useradd --system --create-home --shell /usr/sbin/nologin v0idgame

# 1.2 代码与运行时数据独立目录（与 pianotuner / 其他业务完全分开）
sudo -u v0idgame git clone https://github.com/v0id-byte/v0idchain.git /home/v0idgame/v0idchain
sudo install -d -m 700 -o v0idgame -g v0idgame /home/v0idgame/v0idchain/.data/game-server
```

> 隔离要点：
> - **独立非特权用户** `v0idgame`：被攻破也碰不到 pianotuner / root。
> - **独立目录** `/home/v0idgame/v0idchain`：与 pianotuner 代码/数据零交叉。
> - **独立 systemd unit**（下节）：崩溃/重启互不牵连。
> - game-server 进程**不需要任何 sudo 能力**。

---

## 2. 机密：env / 0600 文件（绝不进仓库、绝不进响应）

game-server 需要两样机密，都**只从本机文件 / 环境变量读**：

| 机密 | 来源 | 权限 |
|------|------|------|
| 节点 API token（写 `/tx/submit` 用 Bearer） | `NODE_TOKEN` 或 `NODE_TOKEN_FILE` 指向的文件 | `0600`，属主 `v0idgame` |
| 央行钱包 `wallet.json`（faucet 发币私钥） | `TREASURY_WALLET` 指向的 `wallet.json` | `0600`，属主 `v0idgame` |

```bash
# 例：把节点 token 与央行钱包放进专用用户的私密目录（0600）
sudo install -d -m 700 -o v0idgame -g v0idgame /home/v0idgame/secrets
# （把真实文件拷进去后）
sudo chmod 600 /home/v0idgame/secrets/api.token /home/v0idgame/secrets/wallet.json
sudo chown v0idgame:v0idgame /home/v0idgame/secrets/api.token /home/v0idgame/secrets/wallet.json
```

> - **央行钱包是真金白银的私钥**——务必 0600、属主专用用户、永不进 git（仓库 `.gitignore` 已挡 `.data/`）。
> - 代码已保证：私钥/token **绝不出现在任何 HTTP 响应或客户端可见日志**里；内部错误只进 `journalctl`。
> - 想换央行池规模 / faucet 额度，用 env（`FAUCET_AMOUNT`、`FAUCET_GLOBAL_CAP`、`FAUCET_IP_COOLDOWN_MS`），不必改代码。

---

## 3. systemd unit（独立、非特权、自带沙箱加固）

`/etc/systemd/system/v0idchain-game.service`：

```ini
[Unit]
Description=v0idChain game-server (stage 0)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=v0idgame
Group=v0idgame
WorkingDirectory=/home/v0idgame/v0idchain

# —— 绑定与 CORS：务必保持 127.0.0.1；CORS 填真实前端域名（逗号分隔，绝不 *）——
Environment=GAME_BIND=127.0.0.1
Environment=GAME_PORT=8790
Environment=GAME_CORS_ORIGINS=https://game.void1211.com:8443
Environment=GAME_DATA_DIR=/home/v0idgame/v0idchain/.data/game-server

# —— 上游节点（本机 API）+ 机密文件（0600）——
Environment=NODE_URL=http://127.0.0.1:7001
Environment=NODE_TOKEN_FILE=/home/v0idgame/secrets/api.token
Environment=TREASURY_WALLET=/home/v0idgame/secrets/wallet.json

# —— faucet / 限流参数（按需调）——
Environment=FAUCET_AMOUNT=200
Environment=FAUCET_GLOBAL_CAP=100000
Environment=GAME_RATE_LIMIT_MAX=30
Environment=GAME_RATE_LIMIT_WINDOW_MS=60000

ExecStart=/usr/bin/env corepack pnpm --filter @v0idchain/game-server start
Restart=on-failure
RestartSec=3

# —— systemd 沙箱加固（纵深防御：即便被攻破也难提权/横移）——
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/v0idgame/v0idchain/.data
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
```

```bash
# 上线前先装依赖（静态 import 链 core；缺依赖会崩——见 MEMORY 教训）
sudo -u v0idgame bash -lc 'cd /home/v0idgame/v0idchain && corepack pnpm install --frozen-lockfile'
sudo systemctl daemon-reload
sudo systemctl enable --now v0idchain-game
systemctl status v0idchain-game --no-pager
```

> - `ProtectHome=read-only` + `ReadWritePaths=…/.data`：进程只能写运行时数据目录，连自己的家目录其余部分都只读。
> - `corepack pnpm` 需可执行；确认专用用户能跑 `corepack`（Node ≥ 22.13 自带）。若 `nologin` 阻碍 `pnpm install`，临时用 `sudo -u v0idgame bash -lc '...'` 执行。

---

## 4. nginx 反代（挂高位端口，只它对外）

`/etc/nginx/sites-available/v0idchain-game`：

```nginx
server {
    # 家宽封 80/443 → 用高位端口对外
    listen 8443 ssl;
    listen [::]:8443 ssl;
    server_name game.void1211.com;

    # TLS（见 §6 取证方式）；若暂用纯 HTTP 退路，删掉这三行 ssl_* 并把 listen 改成不带 ssl
    ssl_certificate     /etc/letsencrypt/live/game.void1211.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/game.void1211.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 反代体积上限：与 game-server 的 64KB body 上限呼应，nginx 先挡超大请求
    client_max_body_size 64k;

    # 安全头由 game-server 自己回；这里只做转发 + 真实 IP 透传
    location / {
        proxy_pass         http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        # 限流的“每 IP”靠这个头取真实客户端 IP（game-server 信任 X-Forwarded-For 首段）
        proxy_set_header   X-Forwarded-For $remote_addr;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_read_timeout 30s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/v0idchain-game /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> - **只有 nginx 对外**；game-server 在 `127.0.0.1:8790`，外网无法直连。
> - `X-Forwarded-For` 由**本机可信 nginx**写入，game-server 据此做每 IP 限流——这是受控来源，安全。
> - 反代层 `client_max_body_size 64k` 与应用层 body 上限双保险。

---

## 5. 防火墙（只放反代那个高位端口）

```bash
# 仅放行 nginx 对外的高位口（例 8443）+ 节点 P2P（6001，已有）。其余默认拒。
sudo ufw allow 8443/tcp comment 'v0idchain-game nginx'
# 节点 P2P 若尚未放行：sudo ufw allow 6001/tcp comment 'v0idchain p2p'
sudo ufw status numbered
```

> ✅ **绝不放行 `8790`**（game-server）——它只在 `127.0.0.1`，外部本就到不了，开它等于自毁隔离。
> ✅ 节点 API `7001` 同理：只本机，永不进防火墙白名单。

---

## 6. TLS（家宽封 80/443 的取证方式）

80 被封 → **HTTP-01 验证走不通**，用 **DNS-01**（不依赖任何端口）：

```bash
# 以 Cloudflare DNS 为例（按你的 DNS 商换 plugin）
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /home/v0idgame/secrets/cf.ini \
  -d game.void1211.com
# 证书签发后，nginx 用 §4 的 ssl_certificate 路径即可；续期 certbot 定时器自动跑（仍走 DNS-01）
```

**退路（暂不上 TLS）**：nginx 用纯 HTTP 监听高位口（删 `ssl`），对外 `http://game.void1211.com:8443`。
> ⚠️ 风险提示：纯 HTTP 下 faucet 领取、房间布局上传等**明文传输、可被中间人篡改/窃听**。仅作临时联调，**正式对外务必上 TLS（DNS-01）**。

---

## 7. 健康检查

```bash
# 本机直连 game-server（应回 {"ok":true,"height":<数字或 null>}；无密钥/peer 内网地址泄露）
curl -s http://127.0.0.1:8790/health
# 经 nginx（验证反代链路通）
curl -sk https://game.void1211.com:8443/health
# 安全头抽查（应见 nosniff / X-Frame-Options: DENY / CSP；无 X-Powered-By）
curl -sk -D - -o /dev/null https://game.void1211.com:8443/health | grep -iE 'x-content-type|x-frame|content-security|x-powered-by'
# CORS 白名单抽查：未授权 origin 不应回 access-control-allow-origin
curl -sk -D - -o /dev/null -H 'Origin: https://evil.example.com' https://game.void1211.com:8443/health | grep -i access-control-allow-origin && echo '!! CORS 泄露' || echo 'OK 未授权 origin 无 CORS'
systemctl is-active v0idchain-game nginx
```

> `/health` 只回存活 + 链高，**不暴露**版本细节、央行地址、peer 内网地址、token。

---

## 8. 回滚

```bash
# 8.1 代码回滚到上一个已知良好提交（保持 local=GitHub=server 同步：先确认要回到的 commit）
sudo -u v0idgame bash -lc 'cd /home/v0idgame/v0idchain && git fetch && git checkout <last-good-sha> && corepack pnpm install --frozen-lockfile'
sudo systemctl restart v0idchain-game
systemctl status v0idchain-game --no-pager && curl -s http://127.0.0.1:8790/health

# 8.2 只想临时下线（不动代码）：停服务 + 撤防火墙口
sudo systemctl stop v0idchain-game
sudo ufw delete allow 8443/tcp

# 8.3 nginx 配置坏了：撤软链 + reload（game-server 不受影响）
sudo rm /etc/nginx/sites-enabled/v0idchain-game
sudo nginx -t && sudo systemctl reload nginx
```

> - 央行钱包 / faucet 发放记录（`.data/game-server/faucet.json`）**不随代码回滚动**——它记录已发额度，回滚代码不该重置它，否则可能重复发币。
> - 回滚后务必重跑 §7 健康检查 + 安全头抽查。

---

## 附：本地联调（部署前先在本机跑通）

```bash
# 1. 起本机节点（出币 + 提供 API token / 央行钱包）
corepack pnpm dev:node1
# 2. 起 game-server（默认绑 127.0.0.1:8790，读 .data/node1 的 token + 钱包）
corepack pnpm dev:game-server
# 3. 起前端（Vite 5173 已在默认 CORS 白名单内）
corepack pnpm dev:game-web
# 4. 抽查
curl -s http://127.0.0.1:8790/health
corepack pnpm --filter @v0idchain/game-server typecheck
corepack pnpm tsx scripts/smoke.ts
```
