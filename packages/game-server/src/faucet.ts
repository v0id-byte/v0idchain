// faucet —— 唯一的 $V0ID 分发口。从央行预挖池**搬运**（限额+限速+全局上限），不是增发：
// 服务器用央行私钥本地签一笔普通转账并广播。绕不过 coinbase，不在游戏侧造一分钱新币（PRD §1 规则 1/3）。
import { join } from 'node:path';
import { createTransaction, isValidAddress } from '@v0idchain/core';
import {
  TREASURY,
  FAUCET_AMOUNT,
  FAUCET_GLOBAL_CAP,
  FAUCET_IP_COOLDOWN_MS,
  DATA_DIR,
} from './config.js';
import { snapshot, submitSigned } from './chain.js';
import { readJson, writeJson } from './store.js';

interface FaucetState {
  funded: Record<string, string>; // 地址 → 领取交易 txid（每地址只发一次）
  total: number; // 累计已发放总额（对照全局上限）
}

const FILE = join(DATA_DIR, 'faucet.json');
const state = readJson<FaucetState>(FILE, { funded: {}, total: 0 });
const ipLast = new Map<string, number>(); // IP → 上次领取时刻
let submittedTotal = -1; // 央行已提交交易计数（懒初始化自链上 nonce），用于在出块前推进 nonce
let queue: Promise<unknown> = Promise.resolve(); // 串行化所有发放，天然杜绝并发 nonce 冲突

export interface FaucetResult {
  ok: boolean;
  txid?: string;
  amount?: number;
  error?: string;
}
const err = (error: string): FaucetResult => ({ ok: false, error });

/** 领取 faucet。串到队列里执行 —— 同一时刻只有一笔在算 nonce + 提交，避免 nonce 撞车。 */
export function dispense(address: string, ip: string): Promise<FaucetResult> {
  const run = queue.then(() => doDispense(address, ip));
  queue = run.catch(() => {}); // 让队列在单笔失败后继续，不卡死
  return run;
}

async function doDispense(address: string, ip: string): Promise<FaucetResult> {
  if (!isValidAddress(address)) return err('地址格式无效');
  if (state.funded[address]) return err('该地址已领过 faucet（每地址限一次）');
  if (state.total + FAUCET_AMOUNT > FAUCET_GLOBAL_CAP) return err('faucet 池已发完（达全局上限）');
  const last = ipLast.get(ip) ?? 0;
  if (Date.now() - last < FAUCET_IP_COOLDOWN_MS) return err('同一网络领取过于频繁，稍后再试');

  const bc = await snapshot(true);
  const chainNonce = bc.nonceOf(TREASURY.address);
  if (submittedTotal < 0) submittedTotal = chainNonce;
  // 央行池要够付 额度 + 手续费；不够则明确拒绝（而不是崩溃，PRD 6.1 验收）。
  if (bc.balanceOf(TREASURY.address) < FAUCET_AMOUNT + 1) {
    return err('央行池余额不足——请给央行地址充值后再试');
  }

  const nonce = Math.max(chainNonce, submittedTotal); // 出块前也能连发：取链上 nonce 与本地已提交计数的较大者
  const tx = createTransaction(TREASURY, address, FAUCET_AMOUNT, nonce); // 默认手续费 = minFeeFor(额度)
  const r = await submitSigned(tx);
  if (!r.ok) return err(r.error ?? '提交交易失败');

  submittedTotal = nonce + 1; // 仅在成功后推进，失败不跳号
  state.funded[address] = tx.txid;
  state.total += FAUCET_AMOUNT;
  ipLast.set(ip, Date.now());
  writeJson(FILE, state);
  return { ok: true, txid: tx.txid, amount: FAUCET_AMOUNT };
}
