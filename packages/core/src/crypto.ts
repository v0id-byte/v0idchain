// 密码学原语：SHA-256 哈希 + ed25519 签名。
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

// @noble/ed25519 v2 默认只提供异步 API；注入同步 sha512 后即可同步签名/验签。
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export { bytesToHex, hexToBytes, utf8ToBytes };

/** 对字符串做 SHA-256，返回 hex */
export function sha256Hex(data: string): string {
  return bytesToHex(sha256(utf8ToBytes(data)));
}

/** 由 32 字节私钥推出公钥 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return ed.getPublicKey(privateKey);
}

/** 对一段 hex 消息签名，返回签名 hex */
export function sign(messageHex: string, privateKey: Uint8Array): string {
  return bytesToHex(ed.sign(hexToBytes(messageHex), privateKey));
}

/** 验签：签名 / 消息 / 公钥 均为 hex。zip215:false → 走严格 RFC8032，拒绝非规范/可锻造签名。 */
export function verify(signatureHex: string, messageHex: string, publicKeyHex: string): boolean {
  try {
    return ed.verify(hexToBytes(signatureHex), hexToBytes(messageHex), hexToBytes(publicKeyHex), {
      zip215: false,
    });
  } catch {
    return false;
  }
}

/** 地址是否是合法格式：'0x' + 64 个小写 hex（= ed25519 公钥） */
export function isValidAddress(address: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(address);
}

/** 一个 64-hex（256-bit）哈希的前导 0 比特数 */
export function leadingZeroBits(hashHex: string): number {
  let bits = 0;
  for (const ch of hashHex) {
    const n = parseInt(ch, 16);
    if (n === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(n) - 28; // n 是 4-bit 值，clz32 减 28 得 nibble 内前导零
    break;
  }
  return bits;
}

/**
 * 交易 Merkle 根：对一组 txid 两两哈希逐层归并（奇数则复制末尾），得到单一根哈希。
 * 让区块头用一个根承诺整组交易，是真链的标准做法。
 */
export function merkleRoot(txids: string[]): string {
  if (txids.length === 0) return sha256Hex('');
  let layer = txids.slice();
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = i + 1 < layer.length ? layer[i + 1] : a;
      next.push(sha256Hex(a + b));
    }
    layer = next;
  }
  return layer[0];
}

/** 地址 = '0x' + 公钥 hex。ed25519 公钥 32 字节 → 64 个 hex 字符。 */
export function publicKeyToAddress(publicKey: Uint8Array): string {
  return '0x' + bytesToHex(publicKey);
}

/** 从地址取回公钥 hex（地址本身就内含公钥，验签时直接用） */
export function addressToPublicKeyHex(address: string): string {
  return address.startsWith('0x') ? address.slice(2) : address;
}
