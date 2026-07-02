# v0idChain 疑难杂症索引

> 每条记录格式：**症状 → 根因 → 修法**。  
> 遇到新坑，在对应子文档里加一条；这里只维护速查入口。

---

## 症状速查

| 症状关键词 | 文档 | 章节 |
|-----------|------|------|
| ERR_TIMED_OUT / -7 / 72 s 超时 | [hidden-service.md](hidden-service.md) | §HS-1 |
| 描述符发布成功但客户端拿到旧描述符 | [hidden-service.md](hidden-service.md) | §HS-2 |
| INTRODUCE1 静默丢弃 / RENDEZVOUS2 永不到达 | [hidden-service.md](hidden-service.md) | §HS-1, §HS-2 |
| extend-failed / extend-timeout | [relay-circuit.md](relay-circuit.md) | §RC-2 |
| 电路建路冷启动慢 ~5 s | [relay-circuit.md](relay-circuit.md) | §RC-1 |
| guards.json 锁死已下线守卫 | [relay-circuit.md](relay-circuit.md) | §RC-3 |
| CF 隧道握手失败 / WS 426 能通但 WS 不行 | [cloudflare.md](cloudflare.md) | §CF-1 |
| CF 隧道随机掐断 WebSocket | [cloudflare.md](cloudflare.md) | §CF-2 |
| Bot Fight Mode 阻断 WS 升级 | [cloudflare.md](cloudflare.md) | §CF-3 |
| 链上端口与实际拨号端口不符 | [cloudflare.md](cloudflare.md) | §CF-4 |
| hsFetch / EXTEND 大量失败，只有少数中继可用 | [onchain-directory.md](onchain-directory.md) | §OD-1 |
| EADDRINUSE 端口冲突 | [deployment.md](deployment.md) | §DP-1 |
| 重启后 ERR_MODULE_NOT_FOUND / 依赖找不到 | [deployment.md](deployment.md) | §DP-2 |
| 中继重启后 HS 引入点电路立刻失效 | [deployment.md](deployment.md) | §DP-3 |
| 节点广播 IP 是旧 IP / Peer 失联 | [deployment.md](deployment.md) | §DP-4 |
| SSH Permission denied (publickey) | [aws-ec2.md](aws-ec2.md) | §AWS-1 |
| 节点 OOM / 随机重启 | [aws-ec2.md](aws-ec2.md) | §AWS-2 |
| nc: command not found | [aws-ec2.md](aws-ec2.md) | §AWS-3 |
| git pull GitHub 超时（mc box） | [aws-ec2.md](aws-ec2.md) | §AWS-4 |
| git pull 报 local changes 冲突 | [aws-ec2.md](aws-ec2.md) | §AWS-5 |

---

## 子文档

| 文件 | 主题 | 条目 |
|------|------|------|
| [hidden-service.md](hidden-service.md) | 隐藏服务 / Rendezvous | HS-1 ~ HS-3 |
| [relay-circuit.md](relay-circuit.md) | 中继选路 / 电路构建 | RC-1 ~ RC-3 |
| [cloudflare.md](cloudflare.md) | CloudFlare 隧道 | CF-1 ~ CF-4 |
| [onchain-directory.md](onchain-directory.md) | 链上中继目录 | OD-1 |
| [deployment.md](deployment.md) | 部署 / systemd | DP-1 ~ DP-4 |
| [aws-ec2.md](aws-ec2.md) | AWS / EC2 运维 | AWS-1 ~ AWS-5 |

---

*最后更新：2026-06-27*
