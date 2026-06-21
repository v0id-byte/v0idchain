// 持久化：把链和钱包落盘成 JSON，重启不丢。
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Blockchain } from './blockchain.js';
import { Wallet } from './wallet.js';

function walletPath(dataDir: string): string {
  return join(dataDir, 'wallet.json');
}
function chainPath(dataDir: string): string {
  return join(dataDir, 'chain.json');
}
function tokenPath(dataDir: string): string {
  return join(dataDir, 'api.token');
}

/** 只读 API 令牌；不存在返回 null（用于 CLI 子命令自动取本机节点的令牌）。 */
export function loadApiToken(dataDir: string): string | null {
  const f = tokenPath(dataDir);
  if (!existsSync(f)) return null;
  return readFileSync(f, 'utf8').trim() || null;
}

/**
 * 读取本机节点的 API 令牌；没有则随机生成一个并以 0600 落盘。
 * 同机其他用户/进程读不到此文件（0600），就拿不到令牌 → 调不动转账/挖矿等写接口。
 */
export function loadOrCreateApiToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const existing = loadApiToken(dataDir);
  if (existing) return existing;
  const tok = randomBytes(32).toString('hex');
  writeFileSync(tokenPath(dataDir), tok, { mode: 0o600 });
  chmodSync(tokenPath(dataDir), 0o600);
  return tok;
}

/**
 * 把钱包落盘，并把权限收紧到 0600（仅属主可读写）——里面是**明文私钥**，绝不能让同机其他用户读到。
 * 两道保险：`mode` 关掉新建文件那一刻的窗口；`chmod` 再兜底（mode 受 umask 影响，且覆盖已存在文件时不生效）。
 */
export function writeWalletFile(path: string, w: Wallet): void {
  writeFileSync(path, JSON.stringify(w.toJSON(), null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** 只读取钱包，不存在返回 null（绝不偷偷新建）。用于“查看”类命令。 */
export function loadWallet(dataDir: string): Wallet | null {
  const f = walletPath(dataDir);
  if (!existsSync(f)) return null;
  const data = JSON.parse(readFileSync(f, 'utf8')) as { privateKey: string };
  return Wallet.fromPrivateKeyHex(data.privateKey);
}

/** 读取数据目录下的钱包；不存在则新建一个并保存。 */
export function loadOrCreateWallet(dataDir: string): Wallet {
  mkdirSync(dataDir, { recursive: true });
  const existing = loadWallet(dataDir);
  if (existing) return existing;
  const w = Wallet.generate();
  writeWalletFile(walletPath(dataDir), w);
  return w;
}

/**
 * 读取链；不存在则返回全新链。损坏/非法时**先把坏文件改名备份再重建**，绝不静默丢弃 ——
 * 否则任何人（入侵/共享主机同用户/位翻转）改 chain.json 一个字节就能让节点重启即退回创世、
 * 清空本地状态（央行 1000 起步），且无从恢复。备份后节点会从创世重建并联网同步回来。
 */
export function loadChain(dataDir: string): Blockchain {
  const f = chainPath(dataDir);
  if (existsSync(f)) {
    try {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      const bc = Blockchain.fromJSON(data);
      if (Blockchain.validateChain(bc.chain).ok) return bc;
      throw new Error('chain.json 未通过整链校验');
    } catch (e) {
      const bak = `${f}.corrupt-${Date.now()}`;
      try {
        renameSync(f, bak);
        console.error(`⚠️  chain.json 无法加载（${e instanceof Error ? e.message : e}），已备份到 ${bak}；将从创世重建并联网同步。`);
      } catch {
        console.error(`⚠️  chain.json 无法加载且备份失败：${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return new Blockchain();
}

export function saveChain(dataDir: string, bc: Blockchain): void {
  mkdirSync(dataDir, { recursive: true });
  // 原子写：先写临时文件再 rename（同盘 rename 原子），避免崩溃中途截断 chain.json
  // 导致下次 loadChain 解析失败、把整条链清回创世。
  const tmp = chainPath(dataDir) + '.tmp';
  writeFileSync(tmp, JSON.stringify(bc.toJSON(), null, 2));
  renameSync(tmp, chainPath(dataDir));
}
