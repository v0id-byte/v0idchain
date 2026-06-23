// 自托管钱包：私钥只存浏览器 localStorage，永不上送服务器（PRD 6.1）。
// 所有“写”动作都用它在本地签名，再把已签名交易交给游戏服务器广播。
import { Wallet } from '@v0idchain/core/browser';

const KEY = 'v0idchain.game.privkey';

export function loadOrCreateWallet(): Wallet {
  const stored = localStorage.getItem(KEY);
  if (stored) {
    try {
      return Wallet.fromPrivateKeyHex(stored);
    } catch {
      // 损坏 → 重新生成（旧 key 作废）
    }
  }
  const w = Wallet.generate();
  localStorage.setItem(KEY, w.toJSON().privateKey);
  return w;
}

/** 导出私钥 hex（让用户备份/导入到原生“软件钱包 App”）。 */
export function exportPrivateKey(): string {
  return localStorage.getItem(KEY) ?? '';
}

export function shortAddr(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
