// 游戏服务器配置：全部从环境变量读，给出可本地直接跑通的默认值。
// ⚠️ 央行私钥、faucet 状态等运行时数据放 DATA_DIR（gitignore 的 .data 下），绝不进仓库。
import { readFileSync } from 'node:fs';
import { Wallet } from '@v0idchain/core';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 游戏服务器对外端口 */
export const PORT = envInt('GAME_PORT', 8790);

/**
 * 监听地址。默认 127.0.0.1：只接本机（nginx 反代）连接，绝不公网直连。
 * 生产务必保持 127.0.0.1；如确需改（如容器内）用 GAME_BIND 显式覆盖。
 */
export const BIND = env('GAME_BIND', '127.0.0.1');

/**
 * CORS 允许的前端 origin 白名单（逗号分隔）。默认仅放行本机 dev 端口（Vite 5173 / 预览 4173）。
 * 生产把真实前端域名加进 GAME_CORS_ORIGINS（如 https://game.example.com）。绝不用 '*' —— 宁缺毋滥。
 */
export const CORS_ORIGINS: string[] = env(
  'GAME_CORS_ORIGINS',
  'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 单次请求体大小上限（字节）。挡住超大 body 撑爆内存；房间布局/交易都远小于此。 */
export const MAX_BODY_BYTES = envInt('GAME_MAX_BODY_BYTES', 64 * 1024);

/** 房间布局字节上限（写 /api/room 时校验）。便利层数据，给足余量即可。 */
export const MAX_LAYOUT_BYTES = envInt('GAME_MAX_LAYOUT_BYTES', 32 * 1024);

/** 写端点（/api/tx、/api/faucet、PUT /api/room）每 IP 速率限制：窗口内最多多少次。 */
export const RATE_LIMIT_MAX = envInt('GAME_RATE_LIMIT_MAX', 30);

/** 速率限制窗口（毫秒）。默认 60s 内每 IP 最多 RATE_LIMIT_MAX 次写请求。 */
export const RATE_LIMIT_WINDOW_MS = envInt('GAME_RATE_LIMIT_WINDOW_MS', 60_000);

/** 运行时数据目录（房间布局、faucet 发放记录）。默认放 .data/game-server。 */
export const DATA_DIR = env('GAME_DATA_DIR', '.data/game-server');

/** 上游 v0idChain 节点（本机节点的 HTTP 控制接口）。 */
export const NODE_URL = env('NODE_URL', 'http://127.0.0.1:7001');

/**
 * 节点 token：写接口（/tx/submit）需 Bearer。优先 NODE_TOKEN，否则从 NODE_TOKEN_FILE 读
 * （默认本机 dev 节点 .data/node1/api.token）。读不到则为空串（仅读链可用，提交交易会 401）。
 */
function loadNodeToken(): string {
  const direct = process.env.NODE_TOKEN;
  if (direct) return direct;
  const file = env('NODE_TOKEN_FILE', '.data/node1/api.token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    console.warn(`⚠️ 读不到节点 token（${file}）：可读链，但 faucet/提交交易会被节点 401。设 NODE_TOKEN 或 NODE_TOKEN_FILE。`);
    return '';
  }
}
export const NODE_TOKEN = loadNodeToken();

/**
 * 央行钱包（faucet 发币的私钥来源）。从 TREASURY_WALLET 指向的 wallet.json 读 { privateKey }。
 * 本地 dev：默认指向 dev 节点自己的钱包（它挖矿有币），让 faucet 立刻可验证。
 * 生产：指向真正的央行 wallet.json（0600、gitignore，仅服务器本机）。
 */
function loadTreasury(): Wallet {
  const file = env('TREASURY_WALLET', '.data/node1/wallet.json');
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof json.privateKey !== 'string') throw new Error('wallet.json 缺少 privateKey');
    return Wallet.fromPrivateKeyHex(json.privateKey);
  } catch (e) {
    throw new Error(`无法载入央行钱包（TREASURY_WALLET=${file}）：${e instanceof Error ? e.message : e}`);
  }
}
export const TREASURY: Wallet = loadTreasury();

/** faucet 单地址额度（整数币）。最终值由 v0id 拍板（PRD Q2）；央行池会被矿工回补，故可慷慨些。 */
export const FAUCET_AMOUNT = envInt('FAUCET_AMOUNT', 200);

/** faucet 全局总额上限：累计发放超过此值即拒绝（兜底防把央行池抽干）。 */
export const FAUCET_GLOBAL_CAP = envInt('FAUCET_GLOBAL_CAP', 100_000);

/** 同一 IP 两次领取的最小间隔（毫秒），挡住单机刷量。 */
export const FAUCET_IP_COOLDOWN_MS = envInt('FAUCET_IP_COOLDOWN_MS', 60_000);
