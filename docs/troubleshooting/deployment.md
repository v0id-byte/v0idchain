# 部署 / systemd

← [返回索引](README.md)

---

## DP-1 `EADDRINUSE` —— 用户级 systemd 服务与系统服务冲突

**症状**  
`v0id-seed.service` 启动失败，日志 `EADDRINUSE :::6001`；端口被另一进程占用。

**根因**  
`~/.config/systemd/user/v0idchain-seed.service` 用户级 systemd 服务用旧配置（miner 模式）
占用同一端口，与系统级 `v0id-seed.service` 冲突。

**排查**

```bash
ss -tlnp | grep 6001          # 看哪个进程占了端口
systemctl --user list-units | grep v0id  # 找用户级服务
```

**修法**

```bash
systemctl --user stop    v0idchain-seed
systemctl --user disable v0idchain-seed
rm ~/.config/systemd/user/v0idchain-seed.service
systemctl --user daemon-reload
sudo systemctl restart v0id-seed
```

---

## DP-2 新增 core 依赖后节点崩溃（`ERR_MODULE_NOT_FOUND`）

**症状**  
`git pull` 后重启服务，立刻 crash，日志 `Cannot find package '@v0idchain/core'`
或 `ERR_MODULE_NOT_FOUND`。

**根因**  
`packages/node` 用 tsx 静态 `import`；pnpm workspace 需先 `--frozen-lockfile` 安装
才能找到新依赖。直接 pull + 重启不装依赖时崩溃。

**修法**  
每次 `git pull` 后、重启服务前先执行：

```bash
corepack pnpm install --frozen-lockfile
sudo systemctl restart v0id-seed   # 或 v0id-relay
```

---

## DP-3 HS 重启必须晚于各中继节点

**原因**  
`v0id-seed`（含 HS）启动时向各中继建引入点电路。若中继节点在 HS **之后**重启，
原有引入点电路因 `link-closed` 级联 `DESTROY` 失效，HS 不会自动重建（无 auto-repair）。

**正确顺序**

```
1. 重启各 relay 节点   → sudo systemctl restart v0id-relay（等 ~5 s 服务就绪）
2. 重启 HS/seed 节点  → sudo systemctl restart v0id-seed
3. 确认日志出现       → 隐藏 <addr>.v0id → 127.0.0.1:xxxx
```

**验证**

```bash
sudo journalctl -u v0id-seed -f | grep 隐藏
```

看到 `隐藏 <addr>.v0id → ...` 即说明引入点电路建立并发布描述符成功。

---

## DP-4 节点广播 IP 陈旧 / Peer 失联

**症状**  
日志显示 `P2P ws://旧IP:6001` 或 `对等 wss://v0id-main.void1211.com:443`（已死对等），
节点无法同步链，`对等` 数量长时间为 0。

**根因**  
EC2 实例停启后公网 IP 变化；service 文件里的 `--advertise` 和 `--peers` 参数未更新。

**修法**  
查看当前公网 IP：

```bash
curl -s ifconfig.me
```

编辑 service 文件（`/etc/systemd/system/v0id-seed.service` 或用户级路径），
更新 `--advertise <新公网IP>` 和 `--peers <有效seed地址>`：

```bash
sudo systemctl daemon-reload
sudo systemctl restart v0id-seed
```

**活跃 seed 地址参考**：`wss://v0id-seed.void1211.com:443`（box1 CF 隧道，相对稳定）
