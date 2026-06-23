// 实心「圆角方」像素树（星露谷/泰拉瑞亚式：限色 + 抖动 + 硬边描边，无抗锯齿），带野果。
// 冠 = 一整块圆角矩形(实心,不再用圆球拼 ⇒ 不会有缺口/不完整)；上部受光、暗边描边、几颗野果。
// 按 16px/格 艺术分辨率逐像素生成、按 variant 缓存；引擎放大(最近邻)成清脆像素。锚点=树干底中心对齐所在格。
const ARTT = 16; // 星露谷规格
export const TREE_W = 3.0;
export const TREE_H = 3.4;
const TREE_VARIANTS = 4;

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number) => (BAYER[(((y & 3) * 4) + (x & 3))] + 0.5) / 16;

export function treeVariant(x: number, y: number): number {
  return Math.floor(hash(x * 7 + 1, y * 13 + 5) * TREE_VARIANTS) % TREE_VARIANTS;
}

type RGB = [number, number, number];
interface TreePal { light: RGB; mid: RGB; dark: RGB; rim: RGB; berry?: RGB }
const PALETTES: TreePal[] = [
  { light: [122, 170, 84], mid: [86, 138, 58], dark: [60, 104, 46], rim: [40, 76, 36], berry: [214, 72, 58] }, // 绿·红果
  { light: [134, 182, 96], mid: [98, 150, 66], dark: [66, 112, 50], rim: [44, 84, 40] }, // 绿·无果
  { light: [148, 192, 98], mid: [114, 166, 72], dark: [78, 122, 52], rim: [52, 92, 42], berry: [236, 158, 44] }, // 青柠·橙果
  { light: [220, 166, 78], mid: [194, 124, 54], dark: [150, 88, 40], rim: [108, 62, 32] }, // 秋橙
];

// 圆角矩形内判定(像素级)。
function rrIn(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const inX = x >= x0 + r && x <= x1 - r;
  const inY = y >= y0 + r && y <= y1 - r;
  if (inX || inY) return true;
  const cxr = x < x0 + r ? x0 + r : x1 - r;
  const cyr = y < y0 + r ? y0 + r : y1 - r;
  return (x - cxr) * (x - cxr) + (y - cyr) * (y - cyr) <= r * r;
}

const cache = new Map<number, HTMLCanvasElement>();

/** 取某形态圆角方树画布（art-res，缓存）。底中心对齐 (W/2, H)。 */
export function treeCanvas(variant: number): HTMLCanvasElement {
  const v = ((variant % TREE_VARIANTS) + TREE_VARIANTS) % TREE_VARIANTS;
  const hit = cache.get(v);
  if (hit) return hit;
  const W = Math.round(TREE_W * ARTT);
  const H = Math.round(TREE_H * ARTT);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(W, H);
  const set = (x: number, y: number, c: RGB, a = 255) => {
    const o = (y * W + x) * 4;
    img.data[o] = c[0];
    img.data[o + 1] = c[1];
    img.data[o + 2] = c[2];
    img.data[o + 3] = a;
  };
  const p = PALETTES[v];
  const cx = W / 2;

  // 树干
  const trunkW = Math.max(4, Math.round(ARTT * 0.42));
  const trunkH = Math.round(ARTT * 0.95);
  const trunkY = H - trunkH;

  // 冠：圆角矩形
  const x0 = 3;
  const x1 = W - 4;
  const y0 = 2;
  const y1 = trunkY + 1;
  const r = Math.round((y1 - y0) * 0.34); // 适度圆角(方中带圆)
  const canH = y1 - y0;

  // 野果(冠内确定性几颗)
  const berries: [number, number][] = [];
  if (p.berry) for (let i = 0; i < 9; i++) berries.push([x0 + 3 + hash(v * 9 + i, i * 7) * (x1 - x0 - 6), y0 + 3 + hash(i * 3 + 2, v + i) * (canH - 6)]);

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (x >= cx - trunkW / 2 && x < cx + trunkW / 2 && y >= trunkY) {
        set(x, y, x < cx - trunkW / 6 ? [82, 56, 34] : [110, 78, 46]);
        continue;
      }
      if (rrIn(x, y, x0, y0, x1, y1, r)) {
        if (!rrIn(x, y, x0 + 1, y0 + 1, x1 - 1, y1 - 1, r - 1)) { set(x, y, p.rim); continue; } // 暗边描边
        let berry = false;
        for (const [bx, by] of berries) if (Math.abs(x - bx) + Math.abs(y - by) < 1.6) { berry = true; break; }
        if (berry && p.berry) { set(x, y, p.berry); continue; }
        // 上部+左侧受光,叠低频暗叶簇,再抖动量化到 light/mid/dark
        const L = (y1 - y) / canH * 0.8 + (cx - x) / W * 0.3;
        const clump = hash(Math.floor(x / 3), Math.floor(y / 3)) < 0.22 ? -0.25 : 0; // 暗叶团
        const w = L + clump + bayer(x, y) - 0.5;
        set(x, y, w > 0.58 ? p.light : w > 0.26 ? p.mid : p.dark);
        continue;
      }
      if (y > H - 3 && Math.abs(x - cx) < ARTT * 1.0) set(x, y, [24, 34, 20], 70); // 落地阴影
    }
  ctx.putImageData(img, 0, 0);
  cache.set(v, cv);
  return cv;
}
