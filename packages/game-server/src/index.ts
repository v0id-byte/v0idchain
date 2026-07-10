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
const server = startServer();
console.log(`   就绪 → http://${BIND}:${PORT}/health`);

// 优雅退出（systemctl restart/stop 发 SIGTERM）：停止接收新连接再退出；
// server.close() 的回调要等存量 keep-alive 连接自然断开，兜底 3s 后强制退出，避免部署时卡住。
// 这段本身不像 CLI 那边一路同步退到 process.exit——中间等着 close 回调，所以进程会先存活一段时间，
// 需要挡重复信号（比如两次 Ctrl-C），否则会叠出第二个 close()/兜底计时器。
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n   收到 ${signal}，关闭服务器…`);
  const forceExit = setTimeout(() => process.exit(0), 3000);
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
