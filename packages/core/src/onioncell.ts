// 定长洋葱 cell 的密码学核心（与 ntor 握手 onion.ts 同属 core 的“洋葱”子系统）。
// 设计目标同时满足两条硬约束：① **定长 512 字节**（mixnet 无法 mix 变长包 → 改尺寸=硬 wire break，故第一天就锁死）；
// ② **真实工具级完整性**。二者张力的标准解法（Tor 的做法）：用**流加密**逐层套/剥（不扩长）+ **端到端 MAC**（防篡改），
// 而非 AEAD 逐层（会随剥层缩短→泄露跳位）。
//
// 终点识别（“这个 cell 是不是给我这一跳的”）：源端把面向目标跳的明文 body 头 8 字节 `recognized` 置 0 并附该跳 MAC；
// 中继剥掉自己一层后，若 recognized==0 且 MAC 通过 → 是我的（按 cmd 处理）；否则（深层密文，recognized 几乎必非 0）→ 转发下一跳。
// 攻击者改不动：流加密的位翻转会传到出口被 MAC 抓住 → 丢弃。中继看不懂内层（被更深的 keystream 异或，无对应密钥）。
//
// 复用 crypto.ts 同源原语：@noble/ciphers 的 xchacha20（裸流）、@noble/hashes 的 HMAC-SHA256。
import { xchacha20 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import type { CircuitKeys } from './onion.js';

/** cell 定长（字节）。所有在网 cell body 恒为此长，任何剥/套层都不改变它。 */
export const CELL_BODY_LEN = 512;
const RECOGNIZED_LEN = 8; // 头 8 字节：0 = 本跳是终点
const CMD_LEN = 1;
const LEN_LEN = 2; // data 真实长度 (uint16)
const MAC_LEN = 16; // 截断 HMAC-SHA256 端到端完整性 tag
const HEADER_LEN = RECOGNIZED_LEN + CMD_LEN + LEN_LEN; // 11
/** body 里可承载的最大数据字节。512 - 11(头) - 16(MAC) = 485。 */
export const CELL_DATA_LEN = CELL_BODY_LEN - HEADER_LEN - MAC_LEN;

// relay 命令（body 内 cmd 字节）。EXTEND/EXTENDED 是**加密 cell 内的命令**而非明文线缆 cell——否则拓扑泄露。
export const CMD_DATA = 1; // 应用/流数据（到/来自出口）。流模式下即 TCP 字节分片
export const CMD_EXTEND = 2; // 延伸电路：data = nextHopId(32) ‖ clientEph(32) = 64B（下一跳 onion 公钥客户端已从目录知道、本地绑进 AUTH，无需上送）
export const CMD_EXTENDED = 3; // 延伸应答：data = serverEph(32) ‖ auth(32) = 64B
export const CMD_BEGIN = 4; // 客户端→出口：开流，data = UTF8 "host:port"（CONNECT 目标）
export const CMD_CONNECTED = 5; // 出口→客户端：data[0]=0 已连通 / 非 0 失败（出口策略拒或连接失败）
export const CMD_END = 6; // 任一方向：流关闭

// 隐藏服务描述符 DHT（Phase 2B-b）：客户端经电路把终点跳（=某 HSDir 中继）当应答方，发布/取回描述符。
// 描述符 > 单 cell（CELL_DATA_LEN≈485B），故 PUBLISH/FETCH/RESP 均按 hsdir.ts 的分帧逐 cell 分片。
export const CMD_HS_PUBLISH = 7; // 客户端→HSDir：发布，data = 分帧块（首块含 4B 总长 + descIdHex(64) ‖ JSON）
export const CMD_HS_FETCH = 8; // 客户端→HSDir：取回，data = 分帧块（descIdHex(64)，单 cell 即够）
export const CMD_HS_RESP = 9; // HSDir→客户端：应答体（发布 = "OK"；取回 = 描述符 JSON），分帧分片
export const CMD_HS_END = 10; // HSDir→客户端：一次应答结束（PUBLISH 失败时不带任何 RESP 直接 END = 失败）

// 引入点 + 会合点（rendezvous，Phase 2B-c）：双向匿名连接的握手平面。三个角色循 Tor v3 rend-spec 的思路：
// 服务在若干**引入点(IP)**中继上挂电路候命；客户端建一条到**会合点(RP)**中继的电路并留一个 cookie；
// 客户端经 IP 把一个加密 INTRODUCE 投给服务（IP 看不懂，只按 authKey 转给服务的引入电路）；
// 服务收到后另建一条到 RP 的电路、报上 cookie；RP 据 cookie **拼接(splice)**两条电路 → 双方经 RP 透传
// 不透明的端到端密文（RP 解不开）。IP 永不知 RP / 客户端 IP；RP 永不知双方身份；双方互不知对方 IP。
export const CMD_ESTABLISH_INTRO = 11; // 服务→IP(终点)：在此中继挂一个引入点，data = authKey(32)
export const CMD_INTRO_ESTABLISHED = 12; // IP→服务(后向)：引入点已登记
export const CMD_INTRODUCE1 = 13; // 客户端→IP(终点)：data = authKey(32) ‖ 给服务的引入盲信封（ephPub32 ‖ ct）
export const CMD_INTRODUCE2 = 14; // IP→服务(后向，沿服务的引入电路)：data = 引入盲信封（IP 原样转，不含 authKey）
export const CMD_ESTABLISH_RENDEZVOUS = 15; // 客户端→RP(终点)：在此中继占一个会合槽，data = cookie(20)
export const CMD_RENDEZVOUS_ESTABLISHED = 16; // RP→客户端(后向)：会合槽已登记
export const CMD_RENDEZVOUS1 = 17; // 服务→RP(终点)：data = cookie(20) ‖ serverEph(32) ‖ auth(32)（报到并交付握手应答）
export const CMD_RENDEZVOUS2 = 18; // RP→客户端(后向，沿客户端的会合电路)：data = serverEph(32) ‖ auth(32)
export const CMD_RDV_DATA = 19; // 拼接两端任一方向：承载端到端密文（RP 透传，解不开），data = ctr(8 大端) ‖ 密文

/**
 * cell 计数器上限。nonceFromCounter 用 JS 浮点数运算，超过 2^53 会丢精度 → 相邻计数器映射到同一 nonce
 * → (key,nonce) 重用 → 流密钥重用。设 2^48 硬上限（远低于 2^53，留足余量）；中继/客户端逼近时应拆电路换路。
 */
export const MAX_CELL_CTR = 2 ** 48;

const ZERO_RECOGNIZED = new Uint8Array(RECOGNIZED_LEN);

/** 24 字节 nonce（XChaCha20）：64-bit 计数器写末尾、其余 0。**同一 cell 所有跳用同一 nonce**，流加密层才能组合。 */
export function nonceFromCounter(ctr: number): Uint8Array {
  const n = new Uint8Array(24);
  let v = Math.floor(ctr);
  for (let i = 23; i >= 16 && v > 0; i--) {
    n[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return n;
}

/** 套/剥一层（XChaCha20 裸流，自反：同 key+nonce 应用两次=原文）。不改变长度。 */
export function applyLayer(streamKey: Uint8Array, nonce: Uint8Array, body: Uint8Array): Uint8Array {
  return xchacha20(streamKey, nonce, body);
}

function bodyMac(macKey: Uint8Array, preMac: Uint8Array): Uint8Array {
  return hmac(sha256, macKey, preMac).subarray(0, MAC_LEN);
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/**
 * 构造一个“面向目标跳”的明文 cell body（recognized=0 ‖ cmd ‖ len ‖ data(补零到 485) ‖ MAC）。
 * macKey = 目标跳与本端共享的方向 MAC 密钥（前向用 macForward，后向用 macBackward）。
 * 之后由调用方用各跳 enc 密钥逐层 applyLayer 套上洋葱。
 */
export function packCellBody(cmd: number, data: Uint8Array, macKey: Uint8Array): Uint8Array {
  if (data.length > CELL_DATA_LEN) throw new Error(`cell data 过长: ${data.length} > ${CELL_DATA_LEN}`);
  const body = new Uint8Array(CELL_BODY_LEN); // recognized 段默认 0
  body[RECOGNIZED_LEN] = cmd & 0xff;
  body[RECOGNIZED_LEN + 1] = (data.length >> 8) & 0xff;
  body[RECOGNIZED_LEN + 2] = data.length & 0xff;
  body.set(data, HEADER_LEN);
  const preMac = body.subarray(0, HEADER_LEN + CELL_DATA_LEN); // recognized..data 全段（含补零，一并认证）
  body.set(bodyMac(macKey, preMac), HEADER_LEN + CELL_DATA_LEN);
  return body;
}

/**
 * 某跳剥掉自己一层后尝试解读：recognized==0 且 MAC 通过 → 返回 {cmd,data}（是给我的）；
 * 否则返回 null（深层密文 / 被篡改 / 非本跳）→ 调用方应转发下一跳（若无下一跳则丢弃）。
 */
export function unpackCellBody(body: Uint8Array, macKey: Uint8Array): { cmd: number; data: Uint8Array } | null {
  if (body.length !== CELL_BODY_LEN) return null;
  if (!ctEqual(body.subarray(0, RECOGNIZED_LEN), ZERO_RECOGNIZED)) return null; // recognized 非 0 → 转发
  const preMac = body.subarray(0, HEADER_LEN + CELL_DATA_LEN);
  const mac = body.subarray(HEADER_LEN + CELL_DATA_LEN);
  if (!ctEqual(bodyMac(macKey, preMac), mac)) return null; // MAC 不过 → 非本跳/被篡改
  const cmd = body[RECOGNIZED_LEN];
  const len = (body[RECOGNIZED_LEN + 1] << 8) | body[RECOGNIZED_LEN + 2];
  if (len > CELL_DATA_LEN) return null;
  return { cmd, data: body.subarray(HEADER_LEN, HEADER_LEN + len) };
}

/**
 * 客户端：把一个面向第 t 跳（0 起）的 cell 用 hop[0..t] 的 enc 密钥**前向**逐层套好，返回发给 hop0 的 512B body。
 * @param hops 有序跳密钥；@param t 目标跳下标；ctr = 该方向计数器（nonce 源 + 防重放）。
 */
export function wrapForward(hops: CircuitKeys[], t: number, cmd: number, data: Uint8Array, ctr: number): Uint8Array {
  const nonce = nonceFromCounter(ctr);
  let body = packCellBody(cmd, data, hops[t].macForward);
  for (let i = t; i >= 0; i--) body = applyLayer(hops[i].encForward, nonce, body); // 由内(t)向外(0)套
  return body;
}

/**
 * 客户端：收到**后向** cell（出口/某跳发来，经各跳逐层套）后，剥掉 hop[0..t] 全部后向层并校验 MAC。
 * 流加密层异或可交换 → 剥层顺序无关；剥完用第 t 跳 macBackward 验。失败返回 null。
 */
export function unwrapBackward(hops: CircuitKeys[], t: number, body: Uint8Array, ctr: number): { cmd: number; data: Uint8Array } | null {
  const nonce = nonceFromCounter(ctr);
  let b = body;
  for (let i = 0; i <= t; i++) b = applyLayer(hops[i].encBackward, nonce, b);
  return unpackCellBody(b, hops[t].macBackward);
}
