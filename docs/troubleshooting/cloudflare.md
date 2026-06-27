# CloudFlare 隧道

← [返回索引](README.md)

---

## CF-1 中继间 EXTEND 失败，CF Tunnel SNI 路由错误

**症状**  
中继间 `EXTEND` 失败（`extend-failed`）；`curl http://<relay>:<port>` 返回 HTTP 426（说明
端口可达），但 WebSocket 握手失败。

**根因**  
链上目录广播端口 443 的中继，需经 CF 隧道 `wss://hostname:443`——CF 边缘按 SNI/Host
路由，必须用主机名，不能用解析出的 IP。  
旧代码统一用 `ws://IP:port`，连上了 CF 边缘 IP 但 SNI 是 IP 而非主机名 →
CF 找不到对应隧道 → WS 握手失败。

**修法**  
`dialRelay()`（中继间 EXTEND）和 `client.ts connect()`（客户端到守卫）：
端口 443 改用 `wss://hostname:port`；明文端口仍用 `ws://IP:port`。

```typescript
// packages/node/src/relay/relaynode.ts  dialRelay()
const scheme = port === 443 ? 'wss' : 'ws';
const target = scheme === 'wss' ? host : resolvedIp;   // CF 隧道必须按主机名走 SNI
new WebSocket(`${scheme}://${target}:${port}`, ...);

// packages/node/src/relay/client.ts  connect()
const ws = new WebSocket(
  `${guard.port === 443 ? 'wss' : 'ws'}://${guard.host}:${guard.port}`, ...
);
```

---

## CF-2 CF 隧道空闲超时掐断 WebSocket

**症状**  
浏览器访问成功一两次后，随机出现连接失败；日志里 WS 连接报 close/reset。  
重启 HS 后短暂恢复，约 1 小时后再次失效（与 → [HS-1](hidden-service.md#hs-1) 叠加）。

**根因**  
CF 隧道默认约 60–90 s 空闲掐断 WebSocket。引入点电路长期驻留但无业务流量时，
沿途 CF 隧道掐断 WS → 引入点电路死亡 → `introTable` 登记消失。

**修法**  
HS 侧每 25 s 向每条引入电路终点发 `CMD_DROP` 保活 cell（中继静默丢弃，零协议改动），
保持电路 + 沿途 CF 隧道常活。已在 `hsservice.ts startIntroKeepalive()` 实现。

```typescript
setInterval(() => {
  for (const it of this.intros)
    it.circ.sendToTerminus(CMD_DROP, new Uint8Array(0));
}, 25_000);
```

---

## CF-3 Bot Fight Mode 阻断 WS 升级

**症状**  
中继 WS 握手返回 HTTP 403 或被重定向到 Cloudflare 验证页；
`curl http://<relay>:443` 返回 HTML 而非 426。

**根因**  
Cloudflare Security → Bots → **Bot Fight Mode** 将来自程序的 WS 升级请求判定为 Bot 流量并拦截。

**修法**  
Cloudflare 仪表盘 → 对应域名 → Security → Bots → **关闭 Bot Fight Mode**。

---

## CF-4 `--relay-advertise-port` 与 `--relay-port` 不一致

**症状**  
链上注册的中继端口是本地监听端口（如 6021），而 CF 隧道对外暴露 443，
导致客户端拨号 `ws://host:6021` 而非 `wss://host:443`，拨号失败。

**根因**  
未区分「本地监听端口」和「链上广播端口」，两者默认相同。  
CF 隧道场景：本地监听任意端口，链上应广播 443（CF 入口）。

**修法**  
用 `--relay-advertise-port 443` 单独设广播端口：

```bash
v0id start --relay \
  --relay-port 6021 \
  --relay-advertise v0id-r1.void1211.com \
  --relay-advertise-port 443
```

`relayAdvertisePort` 在 `rolemanager.ts` 中独立于 `relayPort`，只影响链上发布的端口字段。
