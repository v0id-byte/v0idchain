# v0idnet —— `.v0id` 洋葱匿名网络

**[English](README.en.md) | 中文** · 三大模块之一([← 回总览](../../README.md) · [区块链](../blockchain/README.md) · [链上游戏](../game/README.md))

> 一个跑在 [v0idChain 区块链](../blockchain/README.md)上的 **Tor 式洋葱匿名网络**。`.v0id` 地址 = 隐藏服务,访客与服务器**互不知 IP**。

---

## 这是什么

- **匿名层** = 洋葱路由(3 跳电路:ntor 握手 + 定长 cell + 逐跳剥洋葱)+ 隐藏服务(rendezvous 双向匿名)。
- **目录层** = 区块链:中继把自己登记上链,客户端回放链得到一致名单——**替代 Tor 的目录权威**。
- **客户端** = v0id 浏览器(签名 macOS app)+ CLI 守护进程。

> 📐 **想懂原理?** 看 **[架构与原理 → ARCHITECTURE.md](ARCHITECTURE.md)**(威胁模型 / 洋葱路由 / 隐藏服务 / 激励 / 部署,含架构图)。协议细节:[HS-PROTOCOL.md](HS-PROTOCOL.md) · [INCENTIVE-PROTOCOL.md](INCENTIVE-PROTOCOL.md) · [MINT-PROTOCOL.md](MINT-PROTOCOL.md)(央行电子现金铸币厂：用户为服务付费、用量回流养中继)。

## 能做什么

- **浏览 `.v0id`**:经本地 SOCKS5 + 3 跳洋葱电路访问隐藏服务(出口默认 deny-all = 不做 clearnet 出口、无法律风险)。
- **托管 `.v0id` 站点**:把本地端口/文件夹发布成一个 `.v0id` 地址,别人匿名访问、双方互不知 IP。
- **跑中继**:贡献带宽(entry guards 钉入口 + DoS 加固);**Mixnet**(opt-in)逐跳延迟更抗流量分析。
- **激励**(已建、height 16000 激活):质押抗女巫 + 可信测量 + 国库奖励(v1 建好暂不发)+ 掉线罚没。

---

## 上手 · 桌面 app(最简)

**下载**:[v0id Browser 0.2.5 (macOS / Apple Silicon)](https://github.com/v0id-byte/v0idchain/releases/tag/browser-v0.2.5) —— 已签名公证,双击装、无 Gatekeeper 拦截。Windows / Linux 版**敬请期待**。

打开即自动拉起守护进程 + 连线上网络;地址栏输 `xxxxx.v0id` 浏览;侧栏 4 板块一键开 中继/托管/挖矿;钱包收发 $V0ID。

> ⚠️ **系统代理(clash 等)**:给 `mc.void1211.com` 加一条 **DIRECT(直连)** 规则,否则守护连中继的 `ws://` 被截断。本地环境问题,普通用户无碍。

## 上手 · CLI

```bash
corepack pnpm install
# 浏览 .v0id —— 起本地 SOCKS5
corepack pnpm exec tsx packages/cli/src/index.ts start --socks --socks-port 9050 --peers ws://mc.void1211.com:6001
curl --socks5-hostname 127.0.0.1:9050 http://<地址>.v0id/

# 托管你自己的 .v0id 站点(先有个本地服务,例 python3 -m http.server 8080)
corepack pnpm exec tsx packages/cli/src/index.ts start --hs-target 127.0.0.1:8080 --peers ws://mc.void1211.com:6001

# 跑中继贡献带宽
corepack pnpm exec tsx packages/cli/src/index.ts start --relay --relay-advertise <你的公网host> --peers ws://mc.void1211.com:6001
```

## 线上网络

种子 `ws://mc.void1211.com:6001`(链 + 目录)+ 6 中继(`mc.void1211.com:6021–6026`)+ 矿工持续出块。app 的 `seeds.js` 已内置 → 开箱即连。**真 3 跳洋葱电路已端到端验证。**

---

## 给开发者

- **代码**:洋葱协议 `packages/core/src/{onion,onioncell,hsdesc,hsrend,mixnet}.ts`;中继/客户端 `packages/node/src/relay/*`;桌面 app `clients/desktop/`。
- **架构**:[ARCHITECTURE.md](ARCHITECTURE.md)。**协议规范**:[HS-PROTOCOL.md](HS-PROTOCOL.md)(隐藏服务 §0–20)、[INCENTIVE-PROTOCOL.md](INCENTIVE-PROTOCOL.md)(激励)、[MINT-PROTOCOL.md](MINT-PROTOCOL.md)(央行电子现金铸币厂 · 支付层)。
- **测试**:`scripts/{onion-selftest,onioncell-selftest,relay-integration,hs-*,guards-test,relay-dos-test,antireplay-test,staking-selftest,measurer-test,mint-selftest,mint-daemon-test}.ts`,黄金向量跨实现对齐。

## 诚实边界

匿名集小 = 弱匿名;不防全局被动对手端到端关联 / 应用层去匿名;激励 v1 中心化测量 + 有限国库引导池;`.v0id` 完整浏览需把中继分散到不同主机(单 NAT 拓扑限制,见 [ARCHITECTURE §7](ARCHITECTURE.md))。详见 [ARCHITECTURE §8](ARCHITECTURE.md)。
