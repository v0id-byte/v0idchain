# 中继 / 电路构建

← [返回索引](README.md)

---

## RC-1 电路建路冷启动慢（~5 s）

**症状**  
第一次访问 `.v0id` 地址，SOCKS5 代理响应有约 5 s 延迟；之后明显变快。

**根因**  
`RelayReachability` 缓存冷启动：第一次 `refresh()` 对所有链上中继并行做 WS 探测，
`PROBE_TIMEOUT_MS = 5000`。探测完成前不知道哪些中继可达，阻塞电路构建。

链上目录含大量死中继时冷启动尤慢（10 条中继 × 5 s 并行 = 5 s 墙钟，但每条死中继
都会撑满超时）。见 → [OD-1](onchain-directory.md#od-1-链上目录含大量死中继polluted-directory)。

**行为说明**  
属正常设计，非 bug。缓存 TTL = 3 min，暖缓存下建路秒级完成。

---

## RC-2 `extend-failed` / `extend-timeout` 电路建不到三跳

**症状**  
日志反复出现 `extend-failed` 或 `extend-timeout`，`BUILD_CIRCUIT` 无法完成三跳。

**根因候选（按频率排序）**

| 根因 | 判断方法 |
|------|---------|
| 目标中继是链上死中继（防火墙/下线） | `curl -s -o /dev/null -w '%{http_code}' http://<host>:<port>` 返回非 426 |
| CF 隧道 SNI 路由错误 | 见 → [CF-1](cloudflare.md#cf-1-中继间-extend-失败cf-tunnel-sni-路由错误) |
| 中继版本过旧（hairpin NAT / link-closed） | 尝试其他中继看是否同现象 |
| `guards.json` 锁死离线守卫 | 见 → [RC-3](#rc-3-守卫节点guardmanager-锁死离线中继) |

**修法**  
可达性探测缓存（`RelayReachability`）会在失败后 `markBad`，TTL(3 min) 内自动剔除。
若多跳都失败，可检查 `guards.json` 是否需要重置（见 RC-3）。

---

## RC-3 守卫节点（GuardManager）锁死已离线中继

**症状**  
`guards.json` 里三个守卫全是已下线节点（如旧 mc 中继 `mc.void1211.com:6021-6026`），
所有电路建路失败，日志看不到成功 `CREATED`。

**根因**  
`GuardManager` 持久化采样集，`DEFAULT_LIFETIME_MS = 30 天`，`DEFAULT_COOLDOWN_MS = 10 min`。  
离线守卫 10 min 冷却后再试 → 仍失败 → 再冷却，循环。  
采样集已满（`sampleSize = 3`）时不会自动补充新守卫。

**修法**  
删除 `guards.json`，让守卫重新采样：

| 角色 | 路径 |
|------|------|
| Mac 浏览器 | `~/Library/Application Support/v0id-browser/v0id/guards.json` |
| 服务端节点 | `<dataDir>/guards.json`（默认 `.data/<name>/guards.json`） |

删除后重启节点/浏览器，守卫会从当前链上可达中继重新采样。
