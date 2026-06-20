// 持久化：把链和钱包落盘成 JSON，重启不丢。
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Blockchain } from './blockchain.js';
import { Wallet } from './wallet.js';

function walletPath(dataDir: string): string {
  return join(dataDir, 'wallet.json');
}
function chainPath(dataDir: string): string {
  return join(dataDir, 'chain.json');
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
  writeFileSync(walletPath(dataDir), JSON.stringify(w.toJSON(), null, 2));
  return w;
}

/** 读取链；不存在或损坏则返回全新链（仅含创世块）。 */
export function loadChain(dataDir: string): Blockchain {
  const f = chainPath(dataDir);
  if (existsSync(f)) {
    try {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      const bc = Blockchain.fromJSON(data);
      if (Blockchain.validateChain(bc.chain).ok) return bc;
    } catch {
      // 损坏 → 重建
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
