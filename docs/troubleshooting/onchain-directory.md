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

---

## OD-2 回环/私有 IP 中继虚增 usableCount → 良好中继被误判负（Hidden Service 无法访问）

**症状**  
浏览 `.v0id` 隐藏服务返回 SOCKS5 错误（exit 97）或 ~30 s 超时；
日志中大量 `DESTROY blocked-relay-target`，且该 error 不仅出现在死中继，也出现在 AWS 活中继上；
之后连 HSDir 电路也开始失败。

**根因**  
v0id 浏览器守护进程会将自身在链上注册为中继（默认地址 `127.0.0.1:6011`）。  
`buildCircuit` 从 `dir()` 取的 pool 包含此条目。本机 WS 探测 `ws://127.0.0.1:6011` 成功（守护进程就在本机），  
`reachability.knownUsable()` 将其算入可达集 → `usableCount = 4`（r1 + r2 + r3 + localhost）。

`usableCount > 3` 条件成立时，`buildCircuit` 允许对 middle 调用 `markBad`。当以 r1/r2/r3 为 middle  
尝试 EXTEND 到 `127.0.0.1:6011`（exit）时，AWS 中继拨通的是自身 localhost（空端口）→ 返回  
`DESTROY blocked-relay-target`。由于 `isProven(middle)` 为 false，`markBad(r2)` 被错误地调用，  
可达集收缩至 3，之后所有电路只剩 1 个可用 middle，无法再凑出有效 3 跳。

**修法**（已在 `packages/node/src/relay/hsbridge.ts` 修复）  
`buildCircuit` 内部对 `pool` 过滤掉私有 / 回环 host，避免其进入 `usableCount` 统计：

```typescript
const pool = dir().filter((d) => isRoutableHost(d.host));
// isRoutableHost 剔除 127.x.x.x / ::1 / 10.x / 172.16-31.x / 192.168.x
```

`directory()` 仍返回全量（HSDir 一致性哈希要求发布方与客户端用同一集合）。  
过滤到 `127.0.0.1` 的 `buildCircuit` 调用会立即抛 "终点不可达"，由上层循环快速跳过。

**验证**

```bash
# 用 curl SOCKS5 测试隐藏服务（需本地运行带 --socks 的节点）
curl --socks5-hostname 127.0.0.1:1080 http://<addr>.v0id/ -v
# 期望：HTTP 200；出问题时看 stderr 的 [hs-dbg] 行（已移除，需重加临时日志）
```
