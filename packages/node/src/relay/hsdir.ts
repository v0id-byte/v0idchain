// 隐藏服务描述符 DHT 的「多 cell 分帧」+「HSDir 存储」助手（Phase 2B-b）。
//
// 为什么要分帧：一个描述符 JSON（加密引入点 + 盲签名）远超单 cell 的 CELL_DATA_LEN(≈485B)。
// cell 本身定长不可改（mixnet 约束），故把一条**逻辑消息**切成多个 cell 载荷，接收端按总长重组。
//
// 帧格式（极简、健壮）：
//   首块载荷  = [4 字节大端 total][消息头若干字节]   （total = 整条消息字节数，不含这 4 字节）
//   后续块载荷 = 纯续字节
//   接收端把每块「去掉首块那 4 字节后的」净荷顺次拼接，攒够 total 字节即完整。
// 这条信道**保序可靠**（底层电路前向计数器单调 + 中继按 n 严格增防重放/防乱序），故分帧无需自带序号。
import { CELL_DATA_LEN } from '@v0idchain/core';

const LEN_PREFIX = 4; // 首块的 4 字节大端总长前缀

/**
 * 把一条逻辑消息编码成若干 cell 载荷（每块 ≤ CELL_DATA_LEN）。
 * 首块 = [4B total] ‖ 头段；其余块 = 续字节。空消息 → 单块（仅 4B 长度=0）。
 */
export function encodeFramed(msg: Uint8Array): Uint8Array[] {
  const total = msg.length;
  const cells: Uint8Array[] = [];
  // 首块：先放 4B 大端长度，再尽量塞消息字节（受 CELL_DATA_LEN 限）。
  const firstBody = Math.min(msg.length, CELL_DATA_LEN - LEN_PREFIX);
  const first = new Uint8Array(LEN_PREFIX + firstBody);
  first[0] = (total >>> 24) & 0xff;
  first[1] = (total >>> 16) & 0xff;
  first[2] = (total >>> 8) & 0xff;
  first[3] = total & 0xff;
  first.set(msg.subarray(0, firstBody), LEN_PREFIX);
  cells.push(first);
  // 续块：剩余字节按 CELL_DATA_LEN 切片。
  for (let o = firstBody; o < msg.length; o += CELL_DATA_LEN) {
    cells.push(msg.subarray(o, o + CELL_DATA_LEN));
  }
  return cells;
}

/**
 * 有状态重组器：逐块喂入 push(cell)，内部累积；攒够 total 即 complete。
 * 对恶意/残缺帧稳健：首块不足 4B 直接 invalid；total 超上限 invalid；溢出（收到的净荷 > total）invalid。
 * 任一非法态进入后保持非法（不再接受 push），调用方据此销毁电路/丢弃。
 */
export class FrameReassembler {
  private total = -1; // -1 = 尚未读到长度前缀
  private chunks: Uint8Array[] = [];
  private got = 0; // 已累积净荷字节
  private invalid = false;

  /** maxTotal = 该信道允许的单条消息上限（抗内存放大；HSDir 发布/取回各自传入）。 */
  constructor(private readonly maxTotal: number) {}

  /** 喂入一块 cell 净荷。返回 true 表示本块被接受（仍在重组中或刚好完成）；false = 帧非法。 */
  push(cell: Uint8Array): boolean {
    if (this.invalid) return false;
    if (this.total < 0) {
      // 首块：必须含 4B 长度前缀。
      if (cell.length < LEN_PREFIX) return this.fail();
      this.total = (cell[0] << 24) | (cell[1] << 16) | (cell[2] << 8) | cell[3];
      this.total >>>= 0; // 转无符号
      if (this.total > this.maxTotal) return this.fail();
      const body = cell.subarray(LEN_PREFIX);
      if (body.length > 0) {
        this.chunks.push(body);
        this.got += body.length;
      }
    } else {
      if (cell.length > 0) {
        this.chunks.push(cell);
        this.got += cell.length;
      }
    }
    if (this.got > this.total) return this.fail(); // 净荷超过声明长度 → 非法
    return true;
  }

  private fail(): boolean {
    this.invalid = true;
    return false;
  }

  /** 是否已收齐（got === total 且帧合法）。 */
  get complete(): boolean {
    return !this.invalid && this.total >= 0 && this.got === this.total;
  }

  /** 是否已进入非法态。 */
  get failed(): boolean {
    return this.invalid;
  }

  /** 取出重组后的完整消息（仅 complete 时调用；否则返回 null）。 */
  take(): Uint8Array | null {
    if (!this.complete) return null;
    const out = new Uint8Array(this.total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
