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

/**
 * 导入已有钱包：校验私钥 hex（容忍 0x 前缀/大小写/空白），通过则覆盖当前钱包并返回地址。
 * 调用方负责 location.reload() 让全应用以新钱包重载。换钱包会重置 faucet 领取标记。
 */
export function importPrivateKey(input: string): { ok: boolean; address?: string; error?: string } {
  const t = input.trim();
  if (!t) return { ok: false, error: '请粘贴私钥' };
  const bare = t.replace(/^0x/i, '');
  let w: Wallet | null = null;
  for (const cand of [t, bare, '0x' + bare]) {
    try {
      w = Wallet.fromPrivateKeyHex(cand);
      break;
    } catch {
      /* 试下一种格式 */
    }
  }
  if (!w) return { ok: false, error: '私钥无效（应为 64 位十六进制）' };
  localStorage.setItem(KEY, w.toJSON().privateKey);
  localStorage.removeItem('v0idchain.game.faucet.claimed'); // 换钱包 → 重置 faucet 标记
  return { ok: true, address: w.address };
}

export function shortAddr(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
