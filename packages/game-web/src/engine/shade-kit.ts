// 体积/光影统一工具箱（R4）。所有建模函数引用这套 ⇒ 同一束光、同一套数值、同一种"盒子"词汇。
// 治本于"shade 数值散落各处"：档位常量 V 是唯一真相；bhash/bdith 跨建筑与道具共用 ⇒ 颗粒同一支笔。
// 纯静态、可烤进离屏缓存；绝不用 Math.random/Date（确定性 ⇒ 缓存稳定 + 链上 hash 资产可复算）。
import { rampHex } from './light.js';

/** #rrggbb + 档位 d → hue-shift 后的 rgb(...)（亮偏暖、暗偏冷）。 */
export const shade = rampHex;

/** 标准 hue-shift 档位（唯一真相，所有建模只准引用这套，禁止再手写散值）。 */
export const V = {
  topHi: 34,    // 顶面上沿（最亮受光棱）
  topFace: 20,  // cabinet 顶面厚度
  rim: 12,      // 左/上 rim 高光
  leftHi: 9,    // 左受光面
  side: -12,    // 右/背光侧面
  ao: -18,      // 底部接触 AO
  seam: -16,    // 普通缝（比旧 -22 调亮，解决石墙偏暗偏噪）
  deepSeam: -30,// 折痕/深缝（顶↔正面、屋脊）
  eaveAO: -26,  // 檐下投到墙的阴影
  lap: -22,     // 叠瓦/叠板的叠压投影
} as const;

// —— 确定性 hash + 4×4 Bayer 抖动（建筑与道具共用）——
export function bhash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const BBAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bdith = (x: number, y: number) => (BBAYER[((y & 3) * 4) + (x & 3)] + 0.5) / 16;

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}

/** 立着的盒子前脸的体积边：左/上 rim 受光 + 右/底 AO 背光（1px 硬边）。 */
export function bevelBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  rect(ctx, x, y, w, 1, shade(color, V.rim));            // 上 rim
  rect(ctx, x, y, 1, h, shade(color, V.leftHi));         // 左受光
  rect(ctx, x + w - 1, y, 1, h, shade(color, V.side));   // 右暗面
  rect(ctx, x, y + h - 1, w, 1, shade(color, V.ao));     // 底 AO
}

/** 道具/小物件体积：填底 + bevelBox。最省事的"从平片变盒子"。 */
export function propVolume(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  rect(ctx, x, y, w, h, color);
  bevelBox(ctx, x, y, w, h, color);
}

/** cabinet 顶面厚度（受光顶面 + 上沿最亮棱 + 底折痕）。x,y = 顶面左上；capH = 厚度。 */
export function topFace(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, capH: number, color: string) {
  rect(ctx, x, y, w, capH, shade(color, V.topFace));
  rect(ctx, x, y, w, 1, shade(color, V.topHi));
  rect(ctx, x, y + capH - 1, w, 1, shade(color, V.deepSeam));
}

/** 椭圆截面顶面（断柱/木桩/桶口的"切口"）：受光浅椭圆 + 更亮的内核。给圆柱体一个 3D 顶。 */
export function topEllipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string) {
  ctx.fillStyle = shade(color, V.topFace);
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shade(color, V.topHi);
  ctx.beginPath(); ctx.ellipse(cx - rx * 0.18, cy - ry * 0.3, rx * 0.62, ry * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shade(color, V.deepSeam); // 截面下沿暗（与柱身折开）
  ctx.beginPath(); ctx.ellipse(cx, cy + ry * 0.55, rx, ry * 0.45, 0, 0, Math.PI); ctx.fill();
}

/** 真叠瓦 courses：错缝 + 逐瓦色差 + 每排底缘叠压投影 + 偶发苔。替换"横纹+竖缝"。 */
export function drawShingles(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, color: string) {
  const rowH = 3, shW = 5;
  for (let cy = y0, course = 0; cy < y0 + h; cy += rowH, course++) {
    const off = (course % 2) * Math.floor(shW / 2); // 错缝
    const rH = Math.min(rowH, y0 + h - cy);
    for (let sx = x0 - off; sx < x0 + w; sx += shW) {
      const ix = Math.round(sx);
      const ww = Math.min(shW - 1, x0 + w - ix);
      if (ww <= 0 || ix >= x0 + w) continue;
      const v = bhash(course * 3 + 1, ix);
      const tile = shade(color, v > 0.7 ? 6 : v > 0.4 ? 0 : -7); // 逐瓦色差
      const dx = Math.max(ix, x0);
      rect(ctx, dx, cy, Math.min(ww, x0 + w - dx), rH, tile);
      rect(ctx, dx, cy, Math.min(ww, x0 + w - dx), 1, shade(tile, 10)); // 瓦顶受光棱
      if (bhash(course * 7 + 2, ix) < 0.05 && rH > 1) rect(ctx, dx + 1, cy, Math.min(2, ww), 1, '#5f7d3c'); // 偶发苔
    }
    rect(ctx, x0, cy + rH - 1, w, 1, shade(color, V.lap)); // 整排底缘叠压投影 ← 体积核心
  }
}

/** 凹槽内阴影：让玻璃/门"退进墙后"。上/左内暗 + 下/右回光（半透明，叠在贴图上）。 */
export function recessInner(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  rect(ctx, x, y, w, 1, 'rgba(20,16,12,0.40)');           // 上内影
  rect(ctx, x, y, 1, h, 'rgba(20,16,12,0.32)');           // 左内影
  rect(ctx, x, y + h - 1, w, 1, 'rgba(255,240,210,0.20)'); // 下回光
  rect(ctx, x + w - 1, y, 1, h, 'rgba(255,240,210,0.14)'); // 右回光
}

/** 稀疏颗粒（与 ground 同 4×4 Bayer 密度）：在大色块内撒细微亮/暗，破除平涂。 */
export function dither(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, color: string, density = 0.12) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = bhash((x0 + x) * 2 + 1, (y0 + y) * 3 + 1);
    if (n < density) rect(ctx, x0 + x, y0 + y, 1, 1, shade(color, n < density / 2 ? -7 : 6));
  }
}
