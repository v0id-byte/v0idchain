# v0id 网络 —— 说明与上手

> 一个跑在 **v0idchain 区块链**上的 **Tor 式洋葱匿名网络**。`.v0id` 地址 = 隐藏服务,访客与服务器**互不知 IP**。
> 深入:协议见 [HS-PROTOCOL.md](HS-PROTOCOL.md),激励见 [INCENTIVE-PROTOCOL.md](INCENTIVE-PROTOCOL.md)。

## 这是什么

- **底层 = $V0ID 区块链**(PoW 出币、转账带手续费给矿工)。链同时当**中继目录**——替代 Tor 的目录权威:中继把自己登记上链,任何客户端回放链就得到一致的中继名单。
- **匿名层 = 洋葱路由 + 隐藏服务**:3 跳电路(ntor 握手 + 定长 cell + 逐跳剥洋葱层),`.v0id` 隐藏服务经 rendezvous 拼接两条电路 → 双向匿名。
- **客户端 = v0id 浏览器**(签名 macOS app)+ CLI 守护进程。

## 现在能做什么

**区块链(都能用):** 转账 · 链上消息(烧币进虚空)· 全网唯一昵称 · 端到端加密私信 · 红包 · 集市 · 像素社交小游戏。

**匿名网络:**
- 经 **SOCKS5 + 3 跳洋葱电路**出网(访问 `.v0id`,出口策略默认 deny-all = 不做 clearnet 出口、无法律风险)。
- **托管 `.v0id` 隐藏服务**:把本地端口/文件夹发布成一个 `.v0id` 地址,别人匿名访问,双方互不知 IP。
- **跑中继**贡献带宽:entry guards 钉死入口(抗统计去匿名)+ DoS 加固(限速/电路上限/TTL 清扫)。
- **Mixnet**(opt-in):逐跳指数延迟 + cover 流量,更抗流量分析(默认关、零回归)。
- **激励层**(已建,height **16000** 激活):质押抗女巫 + 可信测量在线率 + 国库奖励(v1 建好但**暂不发**)+ 掉线罚没。

**桌面 app:** 标签页浏览 `.v0id` · 4 个角色板块(浏览客户端 / 中继 / 托管站点 / 链·挖矿,运行时一键开关)· 钱包(收发 / 质押)。

## 线上网络(已部署)

| | |
|---|---|
| 种子 | `ws://mc.void1211.com:6001`(链 + 中继目录;app 的 `seeds.js` 已内置 → 开箱即连) |
| 中继 | 6 个:`mc.void1211.com:6021–6026`(上链发布、公网可达) |
| 矿工 | 种子机上 systemd 持续出块(难度自调维持 ~8s/块) |
| 已验证 | 真 3 跳洋葱电路经这 6 个中继建成 |

## 上手 · CLI

```bash
corepack pnpm install   # 首次

# ① 当客户端浏览 .v0id —— 起本地 SOCKS5
corepack pnpm exec tsx packages/cli/src/index.ts start \
  --socks --socks-port 9050 --peers ws://mc.void1211.com:6001
# 另开终端,经洋葱访问某个 .v0id 隐藏服务:
curl --socks5-hostname 127.0.0.1:9050 http://<地址>.v0id/

# ② 托管你自己的 .v0id 站点(先有个本地服务,例:python3 -m http.server 8080)
corepack pnpm exec tsx packages/cli/src/index.ts start \
  --hs-target 127.0.0.1:8080 --peers ws://mc.void1211.com:6001
#   启动后会打印你的 xxxxx.v0id 地址 → 分享给别人匿名访问

# ③ 跑一个中继贡献带宽(--relay-advertise 填你的公网可达 host:cell 端口须转发)
corepack pnpm exec tsx packages/cli/src/index.ts start \
  --relay --relay-advertise <你的公网host> --peers ws://mc.void1211.com:6001

# ④ 挖矿赚 $V0ID
corepack pnpm exec tsx packages/cli/src/index.ts start --mine --peers ws://mc.void1211.com:6001
```

## 上手 · 桌面 app

1. 构建/安装签名 `.dmg`(`clients/desktop/`,公证后;见 `clients/desktop/RELEASE.md`)。双击打开即自动拉起守护进程 + 连线上网络。
2. 地址栏输 `xxxxx.v0id` 浏览;侧栏 4 个板块一键开 中继 / 托管站点 / 挖矿;钱包收发 $V0ID。

> ⚠️ **系统代理(clash 等)**:要给 `mc.void1211.com` 加一条 **DIRECT(直连)** 规则,否则守护进程连中继的 `ws://` 会被代理截断、建不了电路。这是本地环境问题,普通网络用户无碍。

## 现状 & 诚实边界

- **匿名集小 = 弱匿名**:6 中继 + 少量用户时匿名性弱。这是**网络规模**问题、与密码学无关——人越多越匿名。
- **不防**:全局被动对手的端到端流量/时序关联(低延迟洋葱的固有局限,Mixnet 缓解);应用层去匿名(JS / 浏览器指纹 / 内容回连)。
- **激励 v1**:可信测量方是**中心化**的、国库是**有限引导池**(非永续);真去中心化 / 抗女巫靠后续的客户端概率支付(见 INCENTIVE-PROTOCOL §8)。
- **`.v0id` 隐藏服务往返**:洋葱**传输层已线上验证**(真 3 跳电路建成)+ HS 代码 in-process 自测全过。但**端到端往返目前卡在拓扑**——线上 6 个中继**都在同一台 NAT 后的种子机**,单条电路 hairpin 没问题,而 HS rendezvous 需要**多条中继间电路并发建立**,单台路由器的 NAT hairpin 撑不住嵌套连接。要真正跑通 `.v0id` 浏览,需把中继**分散到不同主机/IP**(真运营者多样性,见 INCENTIVE-PROTOCOL 路线)。这是部署拓扑问题,不是代码缺陷。
