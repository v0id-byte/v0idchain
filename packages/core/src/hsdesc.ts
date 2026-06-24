// 隐藏服务描述符密码学（Phase 2B-a）——双向 rendezvous 的密码学地基。
// 三件事：① 自认证的秘密 `.v0id` 地址（地址本身即公钥，不依赖任何目录服务）；
// ② ed25519 按时间周期密钥盲化（服务每个周期派发一个**盲公钥** Ap，外人无法把不同周期的描述符串到同一身份，
//    也无法枚举：没有 A 就推不出 Ap）；③ 描述符 = 加密的引入点 + 用盲私钥签名（只有持有 A 的人能解密 + 验签）。
//
// 设计灵感来自 Tor v3 rend-spec 的密钥盲化与描述符布局，但**用本链自己的域分隔串与参数，不与 Tor 线格式互通**。
// 复用 crypto.ts / onion.ts 同源原语：@noble/curves 的 ed25519 群运算 + @noble/hashes 的 sha256/sha512/hkdf
// + @noble/ciphers 的 XChaCha20-Poly1305，零新依赖。
//
// 正确性铁锚（不可妥协）：signBlinded 产出的必须是**标准 ed25519 签名**，能被 @noble 的 ed25519.verify(sig,msg,Ap)
// 通过。这是盲化数学正确的唯一证明——盲私钥 aprime 与盲公钥 Ap = aprime·G 满足标准 ed25519 验签方程。
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hkdf } from '@noble/hashes/hkdf';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToHex, hexToBytes, utf8ToBytes, sha256Hex } from './crypto.js';
import { randomBytes, concatBytes } from '@noble/hashes/utils';

// ed25519 群：基点 G 与群阶 L（标量在此循环群里模 L 运算）。
// Point 是 @noble 的扩展爱德华兹点（v1.9.x：ed25519.Point，别名 ExtendedPoint）。
const Point = ed25519.Point;
const G = Point.BASE;
const L: bigint = ed25519.CURVE.n;

// 透传给 selftest 用的原语（脚本在 pnpm 严格依赖下看不到 @noble 直接导入，只能经 core 出口拿）。
// selftest 的“铁锚”仍调用**真**的 @noble ed25519.verify / sha256，不是自写实现——这里只是转出口。
export { ed25519, sha256 };

/** 地址 / 描述符版本。改动即不兼容（全网须一致）。 */
export const VERSION = 0x01;
/** 一个时间周期的秒数。盲化按周期推进 → 跨周期不可关联。 */
export const PERIOD_LEN = 86400;

// ---- 小工具 ----

/** 无符号整数 → 8 字节小端。 */
export function u64le(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** bigint 标量 → 32 字节小端（ed25519 标量的标准编码）。 */
export function scalarToLE32(s: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = ((s % L) + L) % L; // 规范化到 [0,L)
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 小端字节 → bigint 后 mod L（0 → 1，避免退化标量）。用于会喂进 Point.multiply 的标量（@noble 拒绝标量 0）。 */
export function leBytesToScalarModL(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  v %= L;
  return v === 0n ? 1n : v;
}

/** 小端字节 → bigint 后纯 mod L（**不**做 0→1 重映射）。用于挑战 k——须与标准验签器逐位一致（它不重映射）。 */
export function leBytesModL(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v % L;
}

// ---- A. 秘密 .v0id 地址（自认证）----
// 编码：base32lower( A(32) || CHECKSUM(2) || VERSION(1) ) + ".v0id"
// CHECKSUM = sha256( utf8(".v0id checksum") || A || [VERSION] )[:2]

const ADDR_SUFFIX = '.v0id';
const CHECKSUM_DOMAIN = utf8ToBytes('.v0id checksum');

function addrChecksum(A: Uint8Array): Uint8Array {
  return sha256(concatBytes(CHECKSUM_DOMAIN, A, new Uint8Array([VERSION]))).slice(0, 2);
}

/** 把 32 字节身份公钥 A 编码成 `<base32>.v0id` 秘密地址。 */
export function encodeV0idAddress(A: Uint8Array): string {
  if (A.length !== 32) throw new Error('A 必须 32 字节');
  const payload = concatBytes(A, addrChecksum(A), new Uint8Array([VERSION]));
  return base32EncodeLower(payload) + ADDR_SUFFIX;
}

/** 解码并校验 `.v0id` 地址 → 还原 A(32)；长度/版本/校验和任一不符 → null。 */
export function decodeV0idAddress(addr: string): Uint8Array | null {
  if (typeof addr !== 'string' || !addr.endsWith(ADDR_SUFFIX)) return null;
  const b32 = addr.slice(0, -ADDR_SUFFIX.length);
  const payload = base32DecodeLower(b32);
  if (payload === null || payload.length !== 35) return null; // 32 + 2 + 1
  const A = payload.slice(0, 32);
  const checksum = payload.slice(32, 34);
  const version = payload[34];
  if (version !== VERSION) return null;
  const expect = addrChecksum(A);
  if (checksum[0] !== expect[0] || checksum[1] !== expect[1]) return null;
  return A;
}

// ---- B. ed25519 密钥盲化（按时间周期）----

/** unix 秒 → 时间周期编号。 */
export function timePeriod(unixSec: number): number {
  return Math.floor(unixSec / PERIOD_LEN);
}

/**
 * 由 32 字节身份种子推出 ed25519 签名标量 a（RFC8032：clamp(sha512(seed)[:32])）。
 * clamp：h[0]&=248; h[31]&=127; h[31]|=64，小端折成 bigint 后**再 mod L**。
 * （clamp 后置高位 bit254 → 数值可能 ≥ L；ed25519 标准在子群里隐式约简，a·G == (a mod L)·G，
 *  且 @noble 1.9.x 的 multiply 严格要求标量 ∈[1,L)。约简后所有下游用法等价：A、aprime、签名方程全在 mod L 下。）
 */
function secretScalar(seed: Uint8Array): bigint {
  const h = sha512(seed).slice(0, 32);
  h[0] &= 248;
  h[31] &= 127;
  h[31] |= 64;
  let a = 0n;
  for (let i = h.length - 1; i >= 0; i--) a = (a << 8n) | BigInt(h[i]);
  return a % L;
}

/** 身份公钥 A = a·G。应与 ed25519.getPublicKey(seed) 完全一致（selftest 断言）。 */
export function identityPub(seed: Uint8Array): Uint8Array {
  return G.multiply(secretScalar(seed)).toRawBytes();
}

// 盲化因子 h = leBytesToScalarModL( sha512( "v0id-blind-v1" || A(32) || u64le(TP) ) )。
// 只依赖**公钥 A** 与周期 TP → 客户端（只知 A）和服务端（知 seed→A）算出同一个 h。
const BLIND_DOMAIN = utf8ToBytes('v0id-blind-v1');
function blindFactor(A: Uint8Array, TP: number): bigint {
  return leBytesToScalarModL(sha512(concatBytes(BLIND_DOMAIN, A, u64le(TP))));
}

/** 客户端侧盲化：只需 A → Ap = h·A = h·(a·G)。返回盲公钥 Ap(32)。 */
export function blindPublic(A: Uint8Array, TP: number): Uint8Array {
  const h = blindFactor(A, TP);
  return Point.fromHex(bytesToHex(A)).multiply(h).toRawBytes();
}

/**
 * 服务端侧盲化：盲私钥 aprime = (h·a) mod L，盲公钥 Ap = aprime·G。
 * 此处的 Ap 必须等于 blindPublic(A,TP)（同一点的两种算法：h·(a·G) == (h·a)·G）——selftest 断言。
 */
export function blindSecret(seed: Uint8Array, TP: number): { aprime: bigint; Ap: Uint8Array } {
  const a = secretScalar(seed);
  const A = G.multiply(a).toRawBytes();
  const h = blindFactor(A, TP);
  const aprime = (h * a) % L;
  const Ap = G.multiply(aprime).toRawBytes();
  return { aprime, Ap };
}

// ---- C. 盲化签名 / 验签（产出标准 ed25519 签名，可被库验签器验证）----

const NONCE_DOMAIN = utf8ToBytes('v0id-blind-nonce-v1');

/**
 * 用盲私钥对 msg 签名 → 标准 ed25519 签名 R(32)||S(32)，能被 ed25519.verify(sig,msg,Ap) 通过。
 *
 * nonce r 用**域分隔 + 盲私钥派生**（确定性，不依赖 RNG）：
 *   r = leBytesToScalarModL( sha512( "v0id-blind-nonce-v1" || u64le(TP) || scalarToLE32(aprime) || msg ) )
 * 这不是 RFC8032 标准 nonce（标准用 prefix=sha512(seed)[32:]），但对正确性无要求——
 * 验签只看 (R,S) 是否满足 S·G == R + k·Ap，本式正是按此构造。绑入 aprime+TP 保证 nonce 随(密钥,周期,消息)唯一。
 */
export function signBlinded(seed: Uint8Array, TP: number, msg: Uint8Array): Uint8Array {
  const { aprime, Ap } = blindSecret(seed, TP);
  const r = leBytesToScalarModL(sha512(concatBytes(NONCE_DOMAIN, u64le(TP), scalarToLE32(aprime), msg)));
  const R = G.multiply(r).toRawBytes();
  // ed25519 挑战 k = H(R || Ap || msg)，用纯 mod L（不重映射）逐位对齐标准验签器 → 签名恒可被 ed25519.verify 通过。
  const k = leBytesModL(sha512(concatBytes(R, Ap, msg)));
  const S = (r + k * aprime) % L;
  return concatBytes(R, scalarToLE32(S));
}

// ---- D. 服务描述符（加密引入点 + 盲签名）----

/** 一个引入点：中继链上身份 / 其 onion 公钥 / 该服务在此引入点的鉴权公钥。 */
export interface IntroPoint {
  relayId: string;
  relayOnionPubHex: string;
  authKeyHex: string;
}

/** 描述符内层明文载荷（加密前的内容）。 */
interface DescInner {
  introPoints: IntroPoint[];
  serviceOnionPubHex: string;
}

/** 链上/DHT 里流通的描述符外壳（全 hex/数字，可 JSON 序列化）。 */
export interface Descriptor {
  v: number;
  tp: number;
  ap: string; // hex(Ap)
  enc: string; // hex(nonce || ciphertext)
  sig: string; // hex(signBlinded(...))
}

// credential = sha256( "v0id-cred-v1" || A )，只能由 A 导出 → 加密密钥的根。
const CRED_DOMAIN = utf8ToBytes('v0id-cred-v1');
function credential(A: Uint8Array): Uint8Array {
  return sha256(concatBytes(CRED_DOMAIN, A));
}

const DESCENC_INFO = utf8ToBytes('v0id-descenc-v1');
// descKey = HKDF-SHA256(ikm=credential, salt=u64le(TP), info="v0id-descenc-v1", 32)
function descKeyFrom(A: Uint8Array, TP: number): Uint8Array {
  return hkdf(sha256, credential(A), u64le(TP), DESCENC_INFO, 32);
}

const HSDESC_DOMAIN = utf8ToBytes('v0id-hsdesc-v1');
// 被签名的字节：域串 || u64le(TP) || Ap || blob —— 把周期、盲身份、密文一并钉进签名。
function descSignBytes(TP: number, Ap: Uint8Array, blob: Uint8Array): Uint8Array {
  return concatBytes(HSDESC_DOMAIN, u64le(TP), Ap, blob);
}

/** 构造描述符：加密 inner + 用盲私钥签名。需要 seed（服务持有身份种子）。 */
export function buildDescriptor(
  seed: Uint8Array,
  TP: number,
  introPoints: IntroPoint[],
  serviceOnionPubHex: string,
): Descriptor {
  const A = identityPub(seed);
  const { Ap } = blindSecret(seed, TP);
  const inner = utf8ToBytes(JSON.stringify({ introPoints, serviceOnionPubHex }));
  const descKey = descKeyFrom(A, TP);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(descKey, nonce).encrypt(inner);
  const blob = concatBytes(nonce, ct);
  const sig = signBlinded(seed, TP, descSignBytes(TP, Ap, blob));
  return { v: 1, tp: TP, ap: bytesToHex(Ap), enc: bytesToHex(blob), sig: bytesToHex(sig) };
}

/**
 * 解析+验证描述符（客户端：只持有 .v0id 地址）。任一步失败 → null。
 *   1. 地址 → A；2. blindPublic(A,tp) 必须等于 desc.ap（绑定身份↔盲公钥）；
 *   3. 标准 ed25519.verify(sig, signBytes, Ap)；4. 由 A 派生 descKey 解密 blob；5. JSON 解析。
 */
export function parseDescriptor(addr: string, desc: Descriptor): DescInner | null {
  const A = decodeV0idAddress(addr);
  if (A === null) return null;
  let Ap: Uint8Array;
  try {
    Ap = blindPublic(A, desc.tp);
  } catch {
    return null;
  }
  if (bytesToHex(Ap) !== desc.ap) return null;
  let blob: Uint8Array;
  let sig: Uint8Array;
  try {
    blob = hexToBytes(desc.enc);
    sig = hexToBytes(desc.sig);
  } catch {
    return null;
  }
  // 标准 ed25519 验签（铁锚：用库验签器，不是自写）。zip215:false 走严格 RFC8032。
  let ok = false;
  try {
    ok = ed25519.verify(sig, descSignBytes(desc.tp, Ap, blob), Ap, { zip215: false });
  } catch {
    return null;
  }
  if (!ok) return null;
  // 解密
  try {
    if (blob.length < 24 + 16) return null; // nonce(24) + 至少一个 poly1305 tag(16)
    const nonce = blob.subarray(0, 24);
    const ct = blob.subarray(24);
    const descKey = descKeyFrom(A, desc.tp);
    const inner = xchacha20poly1305(descKey, nonce).decrypt(ct);
    const parsed = JSON.parse(new TextDecoder().decode(inner)) as DescInner;
    return parsed;
  } catch {
    return null;
  }
}

/** 描述符在 DHT 里的索引：sha256Hex( "v0id-hsdir-v1" || Ap || u64le(TP) )。 */
const HSDIR_DOMAIN = utf8ToBytes('v0id-hsdir-v1');
export function descriptorId(Ap: Uint8Array, TP: number): string {
  return bytesToHex(sha256(concatBytes(HSDIR_DOMAIN, Ap, u64le(TP))));
}

// ---- E. HSDir 环选择 ----

// 64-hex → BE bigint（把哈希当大端 256-bit 整数）。
function hexToBE(hex: string): bigint {
  let v = 0n;
  const b = hexToBytes(hex);
  for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}

/**
 * 负责某描述符的 HSDir 中继：按 |sha256(addr) XOR descId|（大端 bigint）升序，取前 n 个去重。确定性。
 * @param relayAddresses 候选中继的链上地址列表。
 */
export function responsibleHsDirs(descId: string, relayAddresses: string[], n = 3): string[] {
  const target = hexToBE(descId);
  const scored = relayAddresses.map((addr) => ({
    addr,
    dist: hexToBE(sha256Hex(addr)) ^ target,
  }));
  scored.sort((a, b) => (a.dist < b.dist ? -1 : a.dist > b.dist ? 1 : 0));
  const out: string[] = [];
  for (const { addr } of scored) {
    if (!out.includes(addr)) out.push(addr);
    if (out.length >= n) break;
  }
  return out;
}

// ---- Base32（RFC4648 小写，无 padding）----
// 仓内无现成实现，按规范本地实现。地址 payload = 35 字节 = 280 bit = 56 字符整除、无余 bit；
// 无 padding，解码端对一般输入仍校验末尾冗余 bit 为 0（拒非规范编码）。

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const B32_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B32_ALPHABET.length; i++) B32_LOOKUP[B32_ALPHABET[i]] = i;

export function base32EncodeLower(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 0x1f]; // 末尾不足 5 bit → 右补 0
  }
  return out;
}

/** RFC4648 小写 base32 解码；非法字符 / 末尾冗余 bit 非 0 → null（严格，拒绝非规范编码）。 */
export function base32DecodeLower(str: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (!(c in B32_LOOKUP)) return null;
    value = (value << 5) | B32_LOOKUP[c];
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // 末尾剩余 <8 bit 必须全 0，否则是非规范编码（防地址延展性）。
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return new Uint8Array(out);
}
