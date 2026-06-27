# 隐藏服务（Hidden Service）

← [返回索引](README.md)

---

## HS-1 浏览器 ERR_TIMED_OUT（-7），精确耗时 72 s

**症状**  
v0id 浏览器访问 `.v0id` 地址，约 72 s 后返回 ERR_TIMED_OUT（错误码 -7）。  
`curl --socks5-hostname` 同样超时，精确在 72 s 断开。  
现象在 HS 启动约 1 小时后开始出现，重启 HS 服务后恢复，再过约 1 小时再次失效。

**根因**  
`CIRCUIT_MAX_AGE_MS = 1 h` 在中继节点的 `sweep()` 里强制销毁达龄电路，
哪怕该电路每 25 s 都有 HS 保活 `CMD_DROP` 流过（`lastSeen` 始终新鲜）。

引入点电路是三跳：`HS → guard → middle → intro_relay`。  
`introByCirc` 豁免只保护**最终跳**（`intro_relay` 侧）；中间跳（`guard`、`middle`）
不在 `introByCirc` 里，照常被 max-age 检查。

1 h 后 guard 扫除其转发电路 → `DESTROY` 级联传到 `intro_relay` →
`introTable` 摘除 `authKey` 登记 → `INTRODUCE1` 静默丢弃 →
`RENDEZVOUS2` 永不到达 → `RDV_TIMEOUT`(12 s) + 建路(~6 s) ≈ `HS_ATTEMPT_TIMEOUT`(18 s)，
重试 4 次，共 72 s。

**修法**  
`packages/node/src/relay/relaynode.ts` `sweep()` 删除 max-age 分支：

```diff
- else if (now - c.createdAt > this.dos.maxAgeMs) this.destroyCircuit(c, undefined, 'max-age');
```

只保留 idle 检查（10 min 无流量）。有保活流量的转发电路不再被误杀；
真正废弃的电路仍被 idle 回收。

修复后重启顺序见 → [DP-3](deployment.md#dp-3-hs-重启必须晚于各中继节点)。  
`commit b34a68c`

**相关**  
→ [CF-2](cloudflare.md#cf-2-cf-隧道空闲超时掐断-websocket)（CF 隧道也会掐断电路，保活是必要条件）

---

## HS-2 描述符发布成功，客户端却拿到旧描述符（rev 防回滚）

**症状**  
`publishDescriptors()` 打印成功，但客户端拿到旧描述符（旧 `authKey`），
`INTRODUCE1` 始终被引入点静默丢弃，`RENDEZVOUS2` 永不到达。  
通常在 HS 进程重启后出现。

**根因**  
HSDir 只接受同一 `descId` 下 `rev` 严格更高的描述符（防回滚）。  
重启后若 `rev` 从 `0` 开始，低于 HSDir 已存的旧 `rev` → HSDir 拒收，
继续供旧描述符（旧 `authKey`）。

**修法**  
`rev` 用墙钟毫秒作底：

```typescript
private nextRev(): number {
  const r = Math.max(Date.now(), this.lastRev + 1);
  this.lastRev = r;
  return r;
}
```

跨重启天然更高；同进程内多次发布严格 +1。已在 `hsservice.ts` 实现。

---

## HS-3 重启 HS 后短暂可用，约 1 h 后再次失效（周期性）

**症状**  
重启 `v0id-seed` 后立刻可连，约 1 小时后再次 72 s 超时，周期性重现。

**根因**  
即 [HS-1](#hs-1-浏览器-err_timed_out-7精确耗时-72-s) 的 max-age 扫除问题；
HS 重启只是重建了新鲜引入点电路，但 1 h 后中继仍会扫除中间跳。

**修法**  
部署 `commit b34a68c`（删除 max-age 分支）到所有中继节点后，不再复现。
