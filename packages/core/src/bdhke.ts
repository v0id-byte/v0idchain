// BDHKE（Blind Diffie–Hellman Key Exchange）盲签原语 —— Phase B 匿名铸币的密码学核心。
//
// 记名券（token.ts）的 serial 在**发券**与**兑现**两头都对铸币厂可见 → 铸币厂能把「谁充值」与
// 「谁兑现」关联，匿名性形同虚设。盲签把这条关联切断：客户端先把秘密 x 盲化成点 B_ 递给铸币厂，
// 铸币厂对 B_ 签名却看不到 x；客户端去盲得到 C。兑现时铸币厂见到的是 (x, C)，与当初签的 B_
// **无从关联**（盲化因子 r 只在客户端）→ 充值者↔兑现券不可链接。
//
//   客户端盲化   Y = hashToCurve(x)，选盲化因子 r，  B_ = Y + r·G     → 递给铸币厂
//   铸币厂签名   C_ = k·B_                                            → 回给客户端（k=铸币私钥）
//   客户端去盲   C  = C_ − r·K = k·Y     （K = k·G，krG 抵消）        → 券 = (x, C)
//   铸币厂核验   k·hashToCurve(x) == C                               → 认；serial/盲化不参与
//
// 曲线 = **secp256k1**（素数阶群、cofactor 1，无小子群陷阱；盲签需要标量乘法在素数阶群里做）。
// 注意：盲签密钥 k 是铸币厂**独立于链上 MINT_ADDRESS（ed25519）的专用密钥**，只用于发/验券，
// 公钥 K=k·G 公示给客户端；链上 DEPOSIT/REDEEM/托管仍走 ed25519。二者互不混用。
//
// 构造（hashToCurve 域分隔 + try-and-increment、盲化/签名/去盲）遵循 Cashu 协议 NUT-00，
// 以便用其公开测试向量对拍验证实现正确（见 scripts/mint-bdhke-test.ts 与文件尾 Attribution）。
//
// 【本切片边界】只含 BDHKE 原语本身。以下留待后续接线切片，不在本文件：
//   · 防双花：兑现时按 secret 记全局已花集拦截（复用现有 spend-service 的原子标记）；
//   · 面额密钥集(keyset)：每面额一把 k，用签名密钥区分面额（本文件是单把 k 的通用原语）；
//   · DLEQ 证明(NUT-12)：让客户端能验证铸币厂确用公示的 K 签名 → 抵御"每人一把 key"的标签攻击。
//     缺 DLEQ 时匿名性仍依赖"铸币厂对所有人用同一 K"这一诚实假设——接线阶段必须补上。
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex, bytesToNumberBE, numberToBytesBE, utf8ToBytes } from '@noble/curves/abstract/utils';

const Pt = secp256k1.ProjectivePoint;
const G = Pt.BASE;
const N = secp256k1.CURVE.n; // 群阶

/** secp256k1 曲线点（盲化点 B_、签名点 C_/C、公钥 K 都是它）。 */
export type ECPoint = InstanceType<typeof Pt>;

const DOMAIN_SEP = utf8ToBytes('Secp256k1_HashToCurve_Cashu_');
const EVEN_Y_PREFIX = Uint8Array.of(0x02); // 压缩点前缀：取偶 y 分支
const HASH_TO_CURVE_MAX_COUNTER = 0x10000; // 每次 counter ~50% 命中，全失败概率 ≈ 2^-65536（实际不可达）

/**
 * 把任意消息确定性地映射到曲线点（NUT-00 try-and-increment）：
 *   msg_hash = sha256(域分隔 ‖ message)；counter 从 0 递增，
 *   候选 x = sha256(msg_hash ‖ counter_le32)，试作压缩点 `02‖x`，落在曲线上即返回，否则 counter+1。
 * 无陷门、无需私钥，任何人可复算 → 兑现核验时用来复算 Y。
 */
export function hashToCurve(message: Uint8Array): ECPoint {
  const msgHash = sha256(concatBytes(DOMAIN_SEP, message));
  const counterBytes = new Uint8Array(4);
  const view = new DataView(counterBytes.buffer);
  for (let counter = 0; counter < HASH_TO_CURVE_MAX_COUNTER; counter++) {
    view.setUint32(0, counter, true); // uint32 小端（NUT-00 规定）
    try {
      return Pt.fromHex(concatBytes(EVEN_Y_PREFIX, sha256(concatBytes(msgHash, counterBytes))));
    } catch {
      // 该候选 x 不在曲线上（无对应 y）→ 递增 counter 重试
    }
  }
  throw new Error('hashToCurve: 未能在计数上限内找到曲线点');
}

// ---- 标量（私钥/盲化因子）----

/** 随机标量 r ∈ [1, n−1]（noble randomPrivateKey 保证落域，拒绝 0 与 ≥n）。 */
export function randomScalar(): bigint {
  return bytesToNumberBE(secp256k1.utils.randomPrivateKey());
}

function assertScalar(s: bigint, label: string): void {
  if (typeof s !== 'bigint' || s <= 0n || s >= N) throw new Error(`${label}超出标量范围 [1, n−1]`);
}

// ---- 铸币厂密钥 ----

/** 铸币厂盲签密钥对：k 保密，K=k·G 公示给客户端（去盲/核验用）。 */
export interface MintKeypair {
  k: bigint; // 私钥标量（掌钥即可签发任意面额券 → 绝不外泄）
  K: ECPoint; // 公钥点 K = k·G
}

/** 由私钥标量构造密钥对。k 必须 ∈ [1, n−1]。 */
export function mintKeypairFromScalar(k: bigint): MintKeypair {
  assertScalar(k, '铸币私钥');
  return { k, K: G.multiply(k) };
}

/** 生成一把随机铸币盲签密钥对。 */
export function generateMintKeypair(): MintKeypair {
  return mintKeypairFromScalar(randomScalar());
}

// ---- BDHKE 三步 + 核验 ----

/** 客户端盲化的产物：B_ 递给铸币厂；r 客户端保密（去盲用）；Y 可弃（兑现时由 secret 复算）。 */
export interface BlindedMessage {
  B_: ECPoint;
  r: bigint;
  Y: ECPoint;
}

/**
 * 【客户端】把秘密 `secret` 盲化：Y=hashToCurve(secret)，B_ = Y + r·G。
 * `r` 省略则随机；显式传入仅供测试向量对拍。secret 由客户端随机生成并保密，兑现时才出示。
 */
export function blind(secret: Uint8Array, r: bigint = randomScalar()): BlindedMessage {
  assertScalar(r, '盲化因子');
  const Y = hashToCurve(secret);
  const B_ = Y.add(G.multiply(r));
  return { B_, r, Y };
}

/** 【铸币厂】对盲化点盲签：C_ = k·B_。铸币厂全程看不到 secret，只见 B_。 */
export function blindSign(B_: ECPoint, k: bigint): ECPoint {
  assertScalar(k, '铸币私钥');
  return B_.multiply(k);
}

/** 【客户端】去盲：C = C_ − r·K = k·Y。得到与 B_ 不可关联的券签名 C。 */
export function unblind(C_: ECPoint, r: bigint, K: ECPoint): ECPoint {
  assertScalar(r, '盲化因子');
  return C_.subtract(K.multiply(r));
}

/**
 * 【铸币厂·兑现时】核验 (secret, C) 确为本厂用 k 签发：k·hashToCurve(secret) == C。
 * 通过即认券（防双花由上层按 secret 记已花集拦，见后续接线切片）。
 */
export function verifyUnblinded(secret: Uint8Array, C: ECPoint, k: bigint): boolean {
  assertScalar(k, '铸币私钥');
  return hashToCurve(secret).multiply(k).equals(C);
}

// ---- 序列化（上链外的线路/落盘用；点=33B 压缩 hex，标量=32B 大端 hex）----

/** 曲线点 → 33 字节压缩 hex（66 hex 字符）。 */
export function pointToHex(P: ECPoint): string {
  return P.toHex(true);
}

/** 压缩 hex → 曲线点。非曲线点/格式非法 → 抛（调用方按无效券处理）。 */
export function pointFromHex(hex: string): ECPoint {
  return Pt.fromHex(hex);
}

/** 标量 → 32 字节大端 hex。 */
export function scalarToHex(s: bigint): string {
  return bytesToHex(numberToBytesBE(s, 32));
}

/** 32 字节大端 hex → 标量，并校验落域 [1, n−1]（越界 → 抛）。 */
export function scalarFromHex(hex: string): bigint {
  const s = bytesToNumberBE(hexToBytes(hex));
  assertScalar(s, '标量');
  return s;
}

// ── Attribution ─────────────────────────────────────────────────────────────
// BDHKE 构造、hashToCurve 的域分隔字符串与 uint32-小端 try-and-increment，遵循
// Cashu 协议 NUT-00（https://github.com/cashubtc/nuts/blob/main/00.md，MIT 许可）。
// 本文件为独立重写，仅采用其密码学构造并借其公开测试向量验证正确性；
// 铸币密钥与代币格式为 v0idchain 自有，与任何 Cashu 铸币厂无共享密钥、不互通资金。
