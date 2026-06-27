# 链上中继目录

← [返回索引](README.md)

---

## OD-1 链上目录含大量死中继（Polluted Directory）

**症状**  
`v0id status` 显示 10 条中继，但浏览 / 托管时 `EXTEND` / `hsFetch` 大量失败；
实际只有少数 AWS 中继可用；冷启动建路耗时 > 5 s；日志反复出现 `extend-failed`。

**根因**  
链上 `RELAY|` memo 交易只能发布、无法注销。早期注册的 mc 中继
（防火墙封锁 / 关机 / hairpin NAT）永久留在链上。

影响面：
- `responsibleHsDirs(descId, ALL_relays, 6)` 选出的 6 个 HSDir 可能只有 ≤ 3 个存活。
- 冷启动要对全部中继并行 WS 探测（`PROBE_TIMEOUT_MS = 5 s`）。
- `BUILD_CIRCUIT` 随机撞到死中继 → 等 `HOP_TIMEOUT_MS` (6 s) 超时 → 重试。

**缓解手段**

| 手段 | 说明 |
|------|------|
| 可达性探测缓存 | 首次探测后缓存 3 min；死中继秒级剔除，不再付 6 s 超时 |
| PR #32 选路抗污染 | reachability 探测 + 转发判负 / RP 回退 / 引入点多轮 |
| `HSDIR_REPLICAS = 6` | 即使死中继占位，存活 HSDir 命中概率仍可接受 |
| 手动停掉死中继服务 | 减少链上目录里的活跃 IP（已停 mc 6 台旧中继） |

**彻底解决（待做）**  
链上加中继注销交易，或质押到期自动失效（Phase 3 激励体系后续）。

**定位工具**

```bash
# 检查某中继是否可达（HTTP 426 = WebSocket 端口正常监听）
curl -s -o /dev/null -w '%{http_code}' http://<host>:<port>

# 查看当前链上中继列表
v0id status   # 看 relays 字段
```
