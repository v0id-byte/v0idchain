// 引入/会合（rendezvous）的密码学：两件独立的事（Phase 2B-c）。
//
// ① **INTRODUCE 盲信封**（introduceSeal/introduceOpen）：客户端把会合参数密封给服务，
//    经引入点(IP)中继转交。单向 DH——客户端出一个临时 x25519 密钥 e，与服务静态 onion 公钥 B
//    做 ECDH；服务用静态私钥 b 与 e.pub 还原同一共享点。IP 既无 e.priv 也无 b → 看不懂内容
//    （它只按明文 authKey 找到该服务的引入电路、把信封原样后向转发）。这复刻 crypto.ts 的私信思路，
//    但密钥派生独立（域分隔 "v0id-introduce-v1"），且只需服务的**静态 onion 密钥**（非 ed25519 身份钥）。
//
// ② **端到端 RDV 数据封**（rdvSeal/rdvOpen）：握手完成后双方各持一套 CircuitKeys（来自 ntor）。
//    应用字节在进入 CMD_RDV_DATA cell **之前**就用方向密钥 AEAD 封死 → 会合点(RP)只透传密文、解不开。
//    nonce 由单调计数器派生（复用 onioncell 的 nonceFromCounter，与流加密同源），计数器随 cell 明文传输
//    （它只是 nonce；AEAD 的完整性由 Poly1305 tag 保证，篡改密文/计数器都会令解密失败）。
//
// 复用 crypto.ts / onioncell.ts 同源原语：@noble/curves 的 x25519 + @noble/hashes 的 HKDF-SHA256
// + @noble/ciphers 的 XChaCha20-Poly1305，零新依赖。不与 Tor 线格式互通——这是 v0idchain 自己的握手。
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { utf8ToBytes, concatBytes, randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import type { OnionKeypair } from './onion.js';
import { nonceFromCounter, MAX_CELL_CTR } from './onioncell.js';

// INTRODUCE 信封各段长度（字节）。ephPub = 客户端临时 x25519 公钥；nonce = XChaCha 24B；其余为密文+tag。
export const INTRO_EPHPUB_LEN = 32;
const INTRO_NONCE_LEN = 24;
const INTRO_INFO = utf8ToBytes('v0id-introduce-v1'); // HKDF info 域分隔（与私信/描述符各不串味）

/** x25519 ECDH，封装低阶点/全零异常为 null（攻击者可发畸形点试图让握手崩溃 → 降级为失败）。 */
function dh(secret: Uint8Array, pub: Uint8Array): Uint8Array | null {
  try {
    return x25519.getSharedSecret(secret, pub);
  } catch {
    return null;
  }
}

// 由 ECDH 共享点派生 32 字节对称密钥：HKDF-SHA256(ikm=shared, salt=∅, info="v0id-introduce-v1")。
function introKey(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, new Uint8Array(0), INTRO_INFO, 32);
}

/** 客户端密封的 INTRODUCE 信封：ephPub = 客户端临时公钥；ct = nonce(24) ‖ 密文+tag。 */
export interface IntroduceSealed {
  ephPub: Uint8Array; // 32 字节
  ct: Uint8Array; // 24(nonce) + plaintext.length + 16(tag)
}

/**
 * 客户端：把 plaintext 密封给服务（用其静态 onion 公钥 B）。生成临时 x25519 密钥 e，
 * key = HKDF(x25519(e.priv, B), info="v0id-introduce-v1")，ct = nonce(随机24) ‖ XChaCha20-Poly1305 加密。
 * @param serviceOnionPub 服务静态 onion 公钥 B（来自描述符 serviceOnionPubHex）。
 * @param ephSecret 仅测试/金标准向量传固定值；生产省略 → 每次随机。
 */
export function introduceSeal(
  serviceOnionPub: Uint8Array,
  plaintext: Uint8Array,
  ephSecret: Uint8Array = x25519.utils.randomSecretKey(),
): IntroduceSealed {
  const ephPub = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, serviceOnionPub); // 客户端侧不吞异常：自己生成的 B 应合法
  const key = introKey(shared);
  const nonce = randomBytes(INTRO_NONCE_LEN);
  const sealed = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return { ephPub, ct: concatBytes(nonce, sealed) };
}

/**
 * 服务：用静态 onion 私钥 b 与客户端 ephPub 还原同一共享点、解开信封。
 * AEAD 失败（被篡改 / 非本服务密钥 / 畸形点）→ null。
 * @param serviceOnion 服务静态 onion 密钥对 {b, B}。
 */
export function introduceOpen(serviceOnion: OnionKeypair, ephPub: Uint8Array, ct: Uint8Array): Uint8Array | null {
  if (ephPub.length !== INTRO_EPHPUB_LEN || ct.length < INTRO_NONCE_LEN + 16) return null;
  const shared = dh(serviceOnion.secret, ephPub);
  if (!shared) return null;
  const key = introKey(shared);
  const nonce = ct.subarray(0, INTRO_NONCE_LEN);
  const body = ct.subarray(INTRO_NONCE_LEN);
  try {
    return xchacha20poly1305(key, nonce).decrypt(body);
  } catch {
    return null;
  }
}

// ---- INTRODUCE 明文载荷：{ rpRelayId(0x..ed25519 地址) , cookie(20) , clientNtorEph(32) } ----
// 编码：rpId 公钥(32) ‖ cookie(20) ‖ clientNtorEph(32) = 84 字节定长（服务据此建到 RP 的电路并跑 ntorServer）。

export const RDV_COOKIE_LEN = 20;
const NTOR_EPH_LEN = 32;
const INTRO_PLAINTEXT_LEN = 32 + RDV_COOKIE_LEN + NTOR_EPH_LEN; // 84

/** INTRODUCE 明文（会合参数）：rpRelayId 用 0x.. 地址串，内部编码为其 32 字节公钥。 */
export interface IntroducePayload {
  rpRelayId: string; // 会合点中继的钱包地址 0x..
  cookie: Uint8Array; // 20 字节会合 cookie（客户端在 RP 注册的同一值）
  clientNtorEph: Uint8Array; // 32 字节 ntor 客户端临时公钥 X
}

/** 把会合参数编码成定长信封明文。rpPubHex = rpRelayId 去掉 0x 后的 64-hex 公钥。 */
export function encodeIntroducePayload(rpPubHex: string, cookie: Uint8Array, clientNtorEph: Uint8Array): Uint8Array {
  if (cookie.length !== RDV_COOKIE_LEN) throw new Error('cookie 必须 20 字节');
  if (clientNtorEph.length !== NTOR_EPH_LEN) throw new Error('clientNtorEph 必须 32 字节');
  const rpPub = hexToU8(rpPubHex);
  if (rpPub.length !== 32) throw new Error('rpRelayId 公钥必须 32 字节');
  return concatBytes(rpPub, cookie, clientNtorEph);
}

/** 解码定长信封明文 → { rpPubHex, cookie, clientNtorEph }；长度不符 → null。 */
export function decodeIntroducePayload(
  plaintext: Uint8Array,
): { rpPubHex: string; cookie: Uint8Array; clientNtorEph: Uint8Array } | null {
  if (plaintext.length !== INTRO_PLAINTEXT_LEN) return null;
  return {
    rpPubHex: u8ToHex(plaintext.subarray(0, 32)),
    cookie: plaintext.subarray(32, 32 + RDV_COOKIE_LEN),
    clientNtorEph: plaintext.subarray(32 + RDV_COOKIE_LEN, INTRO_PLAINTEXT_LEN),
  };
}

// 本模块内联的 hex 助手（避免与 crypto.ts 形成循环依赖；逻辑等价）。
function u8ToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
function hexToU8(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// ---- 端到端 RDV 数据封：握手后双方各持 CircuitKeys，应用字节在进 CMD_RDV_DATA 前 AEAD 封死 ----
// cell 数据布局：ctr(8 字节大端) ‖ XChaCha20-Poly1305(key, nonceFromCounter(ctr)).encrypt(bytes)。
// 方向：客户端发用 encForward / 收用 encBackward；服务镜像（发用 encBackward / 收用 encForward）。
// counter 须每方向单调递增、绝不重用（key,nonce 重用会破坏 XChaCha20-Poly1305）。

const RDV_CTR_LEN = 8;

function ctrToBE8(ctr: number): Uint8Array {
  const out = new Uint8Array(RDV_CTR_LEN);
  let v = Math.floor(ctr);
  for (let i = RDV_CTR_LEN - 1; i >= 0 && v > 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}
function be8ToCtr(b: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < RDV_CTR_LEN; i++) v = v * 256 + b[i];
  return v;
}

/**
 * 端到端密封一段应用字节 → CMD_RDV_DATA 的 data。
 * @param key 本方向流加密密钥（客户端发=encForward，服务发=encBackward）。
 * @param ctr 本方向单调计数器（调用方负责递增、防重用，并保持 < MAX_CELL_CTR 浮点安全区）。
 */
export function rdvSeal(key: Uint8Array, ctr: number, bytes: Uint8Array): Uint8Array {
  const nonce = nonceFromCounter(ctr);
  const sealed = xchacha20poly1305(key, nonce).encrypt(bytes);
  return concatBytes(ctrToBE8(ctr), sealed);
}

/**
 * 端到端解封一个 CMD_RDV_DATA 的 data → 应用字节。从前 8 字节读出 ctr 还原 nonce，再 AEAD 解密。
 * AEAD 失败（RP 篡改 / 错密钥）或长度不足 → null。**不**在此做计数器单调校验（调用方按自身状态去重/拒重放）。
 * @param key 本方向流加密密钥（客户端收=encBackward，服务收=encForward）。
 */
export function rdvOpen(key: Uint8Array, data: Uint8Array): { ctr: number; bytes: Uint8Array } | null {
  if (data.length < RDV_CTR_LEN + 16) return null;
  const ctr = be8ToCtr(data.subarray(0, RDV_CTR_LEN));
  if (!Number.isSafeInteger(ctr) || ctr < 0 || ctr >= MAX_CELL_CTR) return null;
  const nonce = nonceFromCounter(ctr);
  try {
    const bytes = xchacha20poly1305(key, nonce).decrypt(data.subarray(RDV_CTR_LEN));
    return { ctr, bytes };
  } catch {
    return null;
  }
}
