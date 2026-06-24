// 洋葱电路每跳握手：ntor —— 单向认证的密钥协商（客户端验证中继持有静态 onion 私钥，中继不认证客户端）。
// 给出三样东西：① 前向保密（双方各出一个临时 x25519 密钥，会话结束即弃 → 事后即使拿到长期私钥也解不开历史电路）；
// ② 中继认证（客户端用握手 MAC 确认对端确实握有该中继在 `RELAY|` 描述符里公布的静态 onion 公钥 B）；
// ③ 转录绑定（MAC 覆盖整段握手 + 中继链上身份 ID，杜绝密钥替换 / 中间人重绑）。
//
// 设计与命名照搬 Tor 的 ntor 握手（Tor proposal 216 / tor-spec §5.1.4，BSD-3 许可），但用本链自己的 PROTOID 与
// 原生 x25519，**不与 Tor 线格式互通**——这是 v0idchain 独立匿名网络的握手，不是 Tor 客户端。
// 复用的原语与 crypto.ts 同源：@noble/curves 的 x25519 + @noble/hashes 的 HMAC-SHA256 / HKDF-SHA256，零新依赖。
//
// 关键设计决定（plan §3.2 Decide-now #1）：中继的 onion 静态密钥是**独立的 x25519 密钥**，不是把 ed25519
// 钱包私钥转 Montgomery 复用（那会让钱包私钥泄漏追溯破解所有历史电路 = 无前向保密）。中继生成一对 onion 密钥
// 持久化到 .data，并把**公钥**作为 `okey` 字段写进 `RELAY|` 链上描述符；ID 仍是它的 ed25519 钱包地址（绑进握手转录）。
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { expand as hkdfExpand } from '@noble/hashes/hkdf';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils';

/** 本链握手协议标识。改动它即不兼容（所有节点须一致）。 */
export const ONION_PROTOID = 'ntor-v0idchain-x25519-sha256-1';

// HMAC 的“tweak”（个性化串，作 HMAC 密钥用）；四个用途各一，互不串味。
const T_MAC = utf8ToBytes(ONION_PROTOID + ':mac'); // 握手认证 MAC（AUTH）
const T_KEY = utf8ToBytes(ONION_PROTOID + ':key_extract'); // KEY_SEED 提取
const T_VERIFY = utf8ToBytes(ONION_PROTOID + ':verify'); // verify（喂进 AUTH，绑定转录）
const M_EXPAND = utf8ToBytes(ONION_PROTOID + ':key_expand'); // HKDF-Expand 的 info
const PROTOID_BYTES = utf8ToBytes(ONION_PROTOID);
const SERVER_STR = utf8ToBytes('Server'); // 方向标签：AUTH 由中继(server)产出

/** 每个方向的对称密钥长度（字节）。XChaCha20-Poly1305 用 32 字节密钥。 */
export const KEY_LEN = 32;

/** x25519 密钥对（裸 32 字节）。中继的 onion 静态密钥 / 双方的临时密钥都用它。 */
export interface OnionKeypair {
  secret: Uint8Array; // 32 字节标量（私钥）——中继须 0600 持久化，绝不上链、绝不外泄
  pub: Uint8Array; // 32 字节公钥——中继作 `okey` 写进 RELAY| 描述符
}

/**
 * 一条电路某一跳协商出的密钥材料（4 把，各 32 字节）。
 * 定长 cell 用**流加密**逐层套/剥（XChaCha20，不扩长 → 不泄露跳位 → 可 mixnet），完整性靠**端到端 MAC**（见 circuit.ts）。
 * enc* = 流加密密钥；mac* = 端到端完整性密钥。forward = 客户端→中继方向，backward = 中继→客户端方向。
 */
export interface CircuitKeys {
  encForward: Uint8Array; // 流加密：客户端→中继
  encBackward: Uint8Array; // 流加密：中继→客户端
  macForward: Uint8Array; // 完整性 MAC：客户端→该跳
  macBackward: Uint8Array; // 完整性 MAC：该跳→客户端
}

/** 客户端握手中途态：发出 CREATE 后、收到 CREATED 前，须保留临时私钥 x。 */
export interface ClientHandshakeState {
  ephSecret: Uint8Array; // x（私有，喂给 ntorClientFinish）
  ephPublic: Uint8Array; // X（放进 CREATE.clientEph 发给中继）
}

/** 中继处理 CREATE 的产物：回给客户端的 Y、AUTH，以及本跳协商出的双向密钥。 */
export interface ServerHandshakeResult {
  serverEph: Uint8Array; // Y（放进 CREATED.serverEph）
  auth: Uint8Array; // AUTH（放进 CREATED.auth）——客户端据此认证本中继
  keys: CircuitKeys;
}

/** 生成一对 onion 密钥（中继启动时调一次，持久化）。 */
export function generateOnionKeypair(): OnionKeypair {
  return onionKeypairFromSecret(x25519.utils.randomSecretKey());
}

/** 由持久化的 32 字节私钥还原 onion 密钥对（中继重启时从 .data 读回；金标准向量也用它定死输入）。 */
export function onionKeypairFromSecret(secret: Uint8Array): OnionKeypair {
  return { secret, pub: x25519.getPublicKey(secret) };
}

/** x25519 ECDH，封装低阶点/全零等异常为 null（攻击者可发畸形点试图让握手崩溃 → 这里降级为握手失败）。 */
function dh(secret: Uint8Array, pub: Uint8Array): Uint8Array | null {
  try {
    return x25519.getSharedSecret(secret, pub);
  } catch {
    return null;
  }
}

/** 恒定时间比较（防 MAC 校验的时序侧信道）。 */
function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// secret_input = EXP1 ‖ EXP2 ‖ ID ‖ B ‖ X ‖ Y ‖ PROTOID —— 双方各自算出必须逐字节相同，是整个握手的“共同秘密+转录”。
function secretInput(
  exp1: Uint8Array,
  exp2: Uint8Array,
  id: Uint8Array,
  B: Uint8Array,
  X: Uint8Array,
  Y: Uint8Array,
): Uint8Array {
  return concatBytes(exp1, exp2, id, B, X, Y, PROTOID_BYTES);
}

// auth_input = verify ‖ ID ‖ B ‖ Y ‖ X ‖ PROTOID ‖ "Server"；AUTH = HMAC(t_mac, auth_input)。
function authMac(verify: Uint8Array, id: Uint8Array, B: Uint8Array, Y: Uint8Array, X: Uint8Array): Uint8Array {
  return hmac(sha256, T_MAC, concatBytes(verify, id, B, Y, X, PROTOID_BYTES, SERVER_STR));
}

// KEY_SEED → HKDF-Expand(SHA256) → 128 字节 → 切 4 把 32 字节：encF | encB | macF | macB。
// 把 KEY_SEED 当 PRK 直接 Expand（KEY_SEED 本就是一次 HMAC 提取的结果）。HKDF-Expand 输出前缀稳定
// （前 64 字节与只取 64 时完全一致）→ enc* 两把与早期金标准向量不变；日后要更多材料继续增大 length 即可，向后兼容。
function deriveKeys(keySeed: Uint8Array): CircuitKeys {
  const okm = hkdfExpand(sha256, keySeed, M_EXPAND, 4 * KEY_LEN);
  return {
    encForward: okm.slice(0, KEY_LEN),
    encBackward: okm.slice(KEY_LEN, 2 * KEY_LEN),
    macForward: okm.slice(2 * KEY_LEN, 3 * KEY_LEN),
    macBackward: okm.slice(3 * KEY_LEN, 4 * KEY_LEN),
  };
}

/**
 * 客户端第 1 步：生成临时密钥，产出要放进 CREATE 的 X。
 * @param ephSecret 仅测试/金标准向量传入固定值；生产省略 → 每次随机（前向保密的前提）。
 */
export function ntorClientStart(ephSecret: Uint8Array = x25519.utils.randomSecretKey()): ClientHandshakeState {
  return { ephSecret, ephPublic: x25519.getPublicKey(ephSecret) };
}

/**
 * 中继处理 CREATE：用自己的静态 onion 密钥 + 临时密钥与客户端的 X 协商，产出 (Y, AUTH, 双向密钥)。
 * @param relayId 中继的 ed25519 钱包地址公钥（32 字节）——绑进转录，把电路钉到中继链上身份。
 * @param staticOnion 中继持久化的 onion 密钥对 {b, B}。
 * @param clientEph 客户端的 X（来自 CREATE）。
 * @param serverEphSecret 仅测试传固定值；生产省略 → 随机。
 * @returns 畸形输入 → null（中继应回 DESTROY）。
 */
export function ntorServer(
  relayId: Uint8Array,
  staticOnion: OnionKeypair,
  clientEph: Uint8Array,
  serverEphSecret: Uint8Array = x25519.utils.randomSecretKey(),
): ServerHandshakeResult | null {
  const Y = x25519.getPublicKey(serverEphSecret);
  const expEph = dh(serverEphSecret, clientEph); // EXP(X, y) —— 临时×临时 → 前向保密
  const expStatic = dh(staticOnion.secret, clientEph); // EXP(X, b) —— 临时×静态 → 中继认证
  if (!expEph || !expStatic) return null;
  const si = secretInput(expEph, expStatic, relayId, staticOnion.pub, clientEph, Y);
  const keySeed = hmac(sha256, T_KEY, si);
  const verify = hmac(sha256, T_VERIFY, si);
  const auth = authMac(verify, relayId, staticOnion.pub, Y, clientEph);
  return { serverEph: Y, auth, keys: deriveKeys(keySeed) };
}

/**
 * 客户端第 2 步：收到 CREATED(Y, AUTH) 后，重算共享秘密、**验证 AUTH**、导出双向密钥。
 * @param staticOnionPub 中继静态 onion 公钥 B（来自其 `RELAY|` 描述符的 okey 字段）。
 * @returns AUTH 不匹配（中继身份未通过认证 / 被中间人）或畸形输入 → null，客户端必须中止本跳、换中继。
 */
export function ntorClientFinish(
  state: ClientHandshakeState,
  relayId: Uint8Array,
  staticOnionPub: Uint8Array,
  serverEph: Uint8Array,
  auth: Uint8Array,
): CircuitKeys | null {
  const expEph = dh(state.ephSecret, serverEph); // EXP(Y, x) == EXP(X, y)
  const expStatic = dh(state.ephSecret, staticOnionPub); // EXP(B, x) == EXP(X, b)
  if (!expEph || !expStatic) return null;
  const si = secretInput(expEph, expStatic, relayId, staticOnionPub, state.ephPublic, serverEph);
  const keySeed = hmac(sha256, T_KEY, si);
  const verify = hmac(sha256, T_VERIFY, si);
  const expectedAuth = authMac(verify, relayId, staticOnionPub, serverEph, state.ephPublic);
  if (!ctEqual(expectedAuth, auth)) return null; // 中继认证失败 → 中止
  return deriveKeys(keySeed);
}
