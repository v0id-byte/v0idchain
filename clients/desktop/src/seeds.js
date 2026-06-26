// v0id 浏览器 —— 默认种子（出厂网络）。
//
// 应用「开箱即用」要连得上一张真实的 .v0id 网络，否则就是一座本地孤岛
// （目录为空 → 链上中继不足 → 任何 .v0id 都解析不了）。这里给出默认的种子
// ws 列表，main.js 在未显式设置 V0ID_PEERS 时用它来拉起守护进程。
//
// 用户仍可用环境变量覆盖：
//   - V0ID_PEERS=ws://a:6001,ws://b:6001  → 完全替换下面的默认列表
//   - V0ID_SOCKS_EXTERNAL=<port>          → 不起守护、直接用已有 SOCKS（demo/验证，见 VERIFY.md）
//
// 注：这是 CommonJS（被 main.js / preload.js 这些「纯 Electron」文件 require），
//     不是 React 渲染层的 ESM——所以用 module.exports。

// 公网种子节点。线上网络的种子与中继都经 Cloudflare 命名隧道暴露成稳定的 wss://（443 TLS，CF 边缘可达、
// 绕过家宽/GFW 的 IP 封禁）。浏览器连此种子同步链；中继从链上目录取得，经各自隧道建洋葱电路 + .v0id rendezvous。
const DEFAULT_PEERS = ['wss://v0id-seed.void1211.com:443'];

module.exports = { DEFAULT_PEERS };
