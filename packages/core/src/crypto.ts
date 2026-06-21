// 密码学原语：SHA-256 哈希 + ed25519 签名 + 端到端加密（x25519 ECDH + XChaCha20-Poly1305）。
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils';
import { x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

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

// ---- 端到端加密私信：用收件人地址(=ed25519 公钥)加密，只有收发双方能解 ----
// 方案：ed25519 密钥转 x25519 → ECDH 出共享密钥 → XChaCha20-Poly1305 认证加密。
// ECDH 对称：(我私钥, 对方公钥) 与 (对方私钥, 我公钥) 得到同一共享密钥 → 发件人也能解自己发的（无需另存副本）。
// 密文上链格式：`ENC|` + hex(24 字节随机 nonce ‖ 密文+tag)。非收发双方只看到这串密文。
export const ENC_PREFIX = 'ENC|';

export function isEncryptedMemo(memo: string): boolean {
  return typeof memo === 'string' && memo.startsWith(ENC_PREFIX);
}

/** 共享密钥：我的 ed25519 私钥(种子) × 对方地址(ed25519 公钥) → 32 字节对称密钥 */
function sharedKey(myPrivateKey: Uint8Array, otherAddress: string): Uint8Array {
  const otherPub = hexToBytes(addressToPublicKeyHex(otherAddress));
  const secret = x25519.getSharedSecret(edwardsToMontgomeryPriv(myPrivateKey), edwardsToMontgomeryPub(otherPub));
  return secret.subarray(0, 32);
}

/** 加密一段明文给收件人（发送方用自己的私钥）。返回 `ENC|<hex>` 串，直接当 memo 上链。 */
export function encryptMemo(plaintext: string, recipientAddress: string, senderPrivateKey: Uint8Array): string {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(sharedKey(senderPrivateKey, recipientAddress), nonce).encrypt(utf8ToBytes(plaintext));
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce);
  blob.set(ct, nonce.length);
  return ENC_PREFIX + bytesToHex(blob);
}

/**
 * 解密一条 `ENC|` 私信。otherPartyAddress = 对方地址（我是收件人→填发件人；我是发件人→填收件人）。
 * 用我的私钥还原同一共享密钥。失败（非本人/被篡改/格式坏）返回 null。
 */
export function decryptMemo(memo: string, otherPartyAddress: string, myPrivateKey: Uint8Array): string | null {
  if (!isEncryptedMemo(memo)) return null;
  try {
    const blob = hexToBytes(memo.slice(ENC_PREFIX.length));
    if (blob.length < 24 + 16) return null; // nonce(24) + 至少一个 poly1305 tag(16)
    const nonce = blob.subarray(0, 24);
    const ct = blob.subarray(24);
    const pt = xchacha20poly1305(sharedKey(myPrivateKey, otherPartyAddress), nonce).decrypt(ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
