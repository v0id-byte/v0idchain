// 中继 onion 静态密钥的本机持久化（与钱包同纪律：0600，绝不上链/外泄）。公钥作 RELAY| 描述符的 okey 公布。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { generateOnionKeypair, onionKeypairFromSecret, bytesToHex, hexToBytes, type OnionKeypair } from '@v0idchain/core';

/** 从 <dataDir>/onion.json 读回 onion 密钥；不存在则生成并落盘（0600）。 */
export function loadOrCreateOnionKey(dataDir: string): OnionKeypair {
  const file = join(dataDir, 'onion.json');
  if (existsSync(file)) {
    const { secret } = JSON.parse(readFileSync(file, 'utf8')) as { secret: string };
    return onionKeypairFromSecret(hexToBytes(secret));
  }
  mkdirSync(dataDir, { recursive: true });
  const kp = generateOnionKeypair();
  writeFileSync(file, JSON.stringify({ secret: bytesToHex(kp.secret) }), { mode: 0o600 });
  chmodSync(file, 0o600); // 兜底：若文件已存在（umask 影响），强制收紧权限
  return kp;
}
