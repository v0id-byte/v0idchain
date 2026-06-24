// @v0idchain/core/browser —— 浏览器安全出口。
// 与 index.ts 等价，但**剔除 storage.js**（它用 node:fs / node:crypto / node:path，浏览器里不可用）。
// 游戏 web 客户端从这里 import：本地自托管钱包、签名、构造交易、解析集市/昵称/消息/红包/崽，全在浏览器内完成。
// 落盘由各端自理（浏览器用 localStorage，见客户端），不依赖 storage 模块。
export * from './config.js';
export * from './crypto.js';
export * from './wallet.js';
export * from './transaction.js';
export * from './block.js';
export * from './blockchain.js';
export * from './market.js';
export * from './messages.js';
export * from './names.js';
export * from './redpacket.js';
export * from './pets.js';
export * from './fishing.js';
export * from './farm.js';
export * from './mine.js';
