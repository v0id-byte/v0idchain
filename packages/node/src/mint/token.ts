// 铸币厂代金券（Phase A：运营者记名券）。券是**无记名持有物**：谁持有谁能花，链下流转、无 gas。
// Phase A 用铸币厂 ed25519 私钥对 canonical(denom, serial) 签名；服务方用铸币厂公钥（= MINT_ADDRESS）离线验签，
// 无需联系铸币厂即可确认「这确是央行签发的 denom 面额券」。防双花由铸币厂在**兑现**时按 serial 拦（见 mintd.ts）。
// Phase B 将把这套记名签名换成 BDHKE 盲签 → 铸币厂发券时看不到 serial → 无法关联充值者↔兑现券（匿名优先）。
import { randomBytes } from 'node:crypto';
import { sign, verify, addressToPublicKeyHex, utf8ToBytes } from '@v0idchain/core';

/** 一张代金券。denom=面额（正整数）；serial=唯一序列号（16 字节 hex）；sig=铸币厂对 canonical(denom,serial) 的签名。 */
export interface MintToken {
  denom: number;
  serial: string;
  sig: string;
}

/** 规范化签名 payload（决定签什么）：带版本域分隔，字段顺序固定 → 跨实现可复现。 */
export function tokenPayload(t: Pick<MintToken, 'denom' | 'serial'>): string {
  return JSON.stringify(['v0id-token-v1', t.denom, t.serial]);
}
const payloadToHex = (s: string) => Buffer.from(utf8ToBytes(s)).toString('hex');

/** 铸币厂用私钥签发一张面额 denom 的券（serial 随机）。denom 须正整数。 */
export function issueToken(denom: number, mintPriv: Uint8Array): MintToken {
  if (!Number.isSafeInteger(denom) || denom < 1) throw new Error('券面额须为正整数');
  const serial = randomBytes(16).toString('hex');
  const sig = sign(payloadToHex(tokenPayload({ denom, serial })), mintPriv);
  return { denom, serial, sig };
}

/** 验签一张券：用铸币厂地址（= 公钥，生产为 MINT_ADDRESS）验。面额/序列号格式非法或签名不符 → false。 */
export function verifyToken(t: MintToken, mintAddress: string): boolean {
  if (!t || typeof t !== 'object') return false;
  if (!Number.isSafeInteger(t.denom) || t.denom < 1) return false;
  if (typeof t.serial !== 'string' || !/^[0-9a-f]{32}$/.test(t.serial)) return false;
  if (typeof t.sig !== 'string') return false;
  return verify(t.sig, payloadToHex(tokenPayload(t)), addressToPublicKeyHex(mintAddress));
}
