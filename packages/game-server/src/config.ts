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
