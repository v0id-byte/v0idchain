// 游戏服务器入口（阶段 0）：链只读代理 + 提交已签名交易 + faucet + 房间。
// 阶段 1（实时镇中心 presence / WebSocket）后续在此挂载，与阶段 0 不互相阻塞（PRD §9）。
import { startServer } from './server.js';
import { PORT, BIND, NODE_URL, TREASURY, FAUCET_AMOUNT, FAUCET_GLOBAL_CAP, CORS_ORIGINS } from './config.js';

console.log('🎮 v0idChain 游戏服务器（阶段 0）');
console.log(`   监听        ${BIND}:${PORT}`);
console.log(`   上游节点     ${NODE_URL}`);
console.log(`   央行地址     ${TREASURY.address}`);
console.log(`   faucet      每地址 ${FAUCET_AMOUNT}，全局上限 ${FAUCET_GLOBAL_CAP}`);
console.log(`   CORS 白名单  ${CORS_ORIGINS.join(', ') || '(空——仅同源/无浏览器跨域)'}`);
startServer();
console.log(`   就绪 → http://${BIND}:${PORT}/health`);
