// 洋葱电路的**线缆消息**（cell-plane wire types）。与共识 P2PMessage 完全隔离：cell 平面是匿名的
// （连接不交换身份、按 circId 路由），跑在独立端口/独立 WebSocketServer 上，绝不混入 gossip / HELLO。
//
// 只有 4 种线缆消息：CREATE/CREATED（与某跳做 ntor 握手，仅走一跳）、RELAY（承载定长 512B 洋葱 body，
// 逐跳转发）、DESTROY（拆电路）。EXTEND/EXTENDED 不是线缆消息——它们是**加密 RELAY body 内的命令**
// （见 core/onioncell CMD_*），否则中继就能在明文里看到拓扑。
import { CELL_BODY_LEN, MAX_CELL_CTR } from '@v0idchain/core';

export interface CreateCell {
  t: 'CREATE';
  c: string; // circId（本段 link 上唯一；由发起方铸）
  x: string; // 客户端 ntor 临时公钥 X (hex)
}
export interface CreatedCell {
  t: 'CREATED';
  c: string;
  y: string; // 中继 ntor 临时公钥 Y (hex)
  a: string; // ntor AUTH (hex)
}
export interface RelayCell {
  t: 'RELAY';
  c: string; // circId
  d: 'f' | 'b'; // 方向：f=前向(客户端→出口)，b=后向
  n: number; // 计数器（nonce 源 + 防重放）
  b: string; // 定长洋葱 body，恒 512 字节 = 1024 hex
  dl?: number; // [v2 mixnet 预留] 本跳延迟 ms，v1 恒缺省=0
  cv?: boolean; // [v2 mixnet 预留] cover/drop 掩护 cell，v1 恒缺省=false
}
export interface DestroyCell {
  t: 'DESTROY';
  c: string;
  r?: string; // 原因（调试用）
}
export type CellMsg = CreateCell | CreatedCell | RelayCell | DestroyCell;

const HEX = /^[0-9a-f]*$/;
const KEY_HEX_LEN = 64;
const BODY_HEX_LEN = CELL_BODY_LEN * 2; // 1024

export function encodeCell(m: CellMsg): string {
  return JSON.stringify(m);
}

/** 严格解码：校验类型与必填字段；RELAY body 必须正好 512 字节。畸形 → null（调用方丢弃）。 */
export function decodeCell(s: string): CellMsg | null {
  let o: any;
  try {
    o = JSON.parse(s);
  } catch {
    return null;
  }
  if (!o || typeof o.c !== 'string' || !o.c) return null;
  switch (o.t) {
    case 'CREATE':
      return typeof o.x === 'string' && o.x.length === KEY_HEX_LEN && HEX.test(o.x) ? { t: 'CREATE', c: o.c, x: o.x } : null;
    case 'CREATED':
      return typeof o.y === 'string' &&
        o.y.length === KEY_HEX_LEN &&
        HEX.test(o.y) &&
        typeof o.a === 'string' &&
        o.a.length === KEY_HEX_LEN &&
        HEX.test(o.a)
        ? { t: 'CREATED', c: o.c, y: o.y, a: o.a }
        : null;
    case 'RELAY':
      if ((o.d !== 'f' && o.d !== 'b') || !Number.isSafeInteger(o.n) || o.n < 0 || o.n >= MAX_CELL_CTR) return null;
      if (typeof o.b !== 'string' || o.b.length !== BODY_HEX_LEN || !HEX.test(o.b)) return null;
      return { t: 'RELAY', c: o.c, d: o.d, n: o.n, b: o.b };
    case 'DESTROY':
      return { t: 'DESTROY', c: o.c, r: typeof o.r === 'string' ? o.r : undefined };
    default:
      return null;
  }
}
