// 真·像素风程序化地面（星露谷式技法，取代之前过于平滑的版本）：
// 低艺术分辨率(每格 ART 像素) + 限定离散色板 + 4×4 有序抖动(Bayer dithering) + 全硬像素(无渐变/无抗锯齿) +
// 最近邻放大。预渲染 8×8 格「无缝大纹理」(art-res)，各格 blit 子区、引擎关抗锯齿放大 ⇒ 清脆块状像素。
// 大色块分布用可平铺低频噪声 ⇒ 8 格处无缝；细节(草簇/碎石/缝)用确定性硬像素。

const ART = 16; // 每格艺术像素 = 星露谷规格(放大后块感正)
const TEX = 8; // 大纹理边长(格)
const N = TEX * ART; // 128

export const GROUND_KINDS = new Set(['grass', 'dirt', 'stone', 'cobble', 'sand', 'water']);

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 4×4 Bayer 有序抖动阈值 → [0,1)
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number) => (BAYER[(((y & 3) * 4) + (x & 3))] + 0.5) / 16;

// 可平铺值噪声(格点 mod gridN ⇒ 无缝),双线性插值。
function tileNoise(gridN: number): (fx: number, fy: number) => number {
  const v: number[] = [];
  for (let i = 0; i < gridN * gridN; i++) v[i] = hash(i % gridN, Math.floor(i / gridN));
  const at = (x: number, y: number) => v[(((y % gridN) + gridN) % gridN) * gridN + (((x % gridN) + gridN) % gridN)];
  return (fx, fy) => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const sx = fx - x0;
    const sy = fy - y0;
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
}

type RGB = [number, number, number];
const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
const shift = (c: RGB, d: number): RGB => [c[0] + d, c[1] + d, c[2] + d];

function mk(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [cv, ctx];
}
/** 逐像素写底色(限色,无渐变)。 */
function paint(fn: (x: number, y: number) => RGB): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const [cv, ctx] = mk();
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const c = fn(x, y);
      const o = (y * N + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return [cv, ctx];
}

// —— 各地面(cozy 限定色板) ——
const GRASS = { mid: [104, 150, 72] as RGB, light: [124, 168, 92] as RGB, dark: [82, 124, 58] as RGB, hi: [146, 186, 110] as RGB };
function genGrass(): HTMLCanvasElement {
  const noise = tileNoise(TEX);
  const [cv, ctx] = paint((x, y) => {
    const n = noise(x / ART, y / ART);
    if (n < 0.24) return GRASS.dark; // 暗块
    return n + bayer(x, y) - 0.5 > 0.62 ? GRASS.light : GRASS.mid; // 亮/中 抖动
  });
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const r = hash(x * 3 + 1, y * 5 + 2);
      if (r < 0.018) { ctx.fillStyle = css(GRASS.dark); ctx.fillRect(x, y, 1, 2); } // 草叶(暗)
      else if (r > 0.992) { ctx.fillStyle = css(GRASS.hi); ctx.fillRect(x, y, 1, 2); } // 草叶(亮)
      else if (r > 0.988) { ctx.fillStyle = '#e8d24a'; ctx.fillRect(x, y, 1, 1); } // 偶有小花
    }
  return cv;
}

const DIRT = { mid: [138, 100, 60] as RGB, light: [156, 118, 74] as RGB, dark: [112, 80, 50] as RGB };
function genDirt(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => (noise((x / ART) * 2, (y / ART) * 2) + bayer(x, y) - 0.5 > 0.55 ? DIRT.light : DIRT.mid));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const r = hash(x * 7, y * 3 + 5);
      if (r < 0.02) { ctx.fillStyle = css(hash(x, y) > 0.5 ? DIRT.dark : [176, 144, 102]); ctx.fillRect(x, y, 1, 1); }
    }
  return cv;
}

const SAND = { mid: [224, 206, 158] as RGB, light: [236, 220, 172] as RGB, dark: [206, 186, 138] as RGB };
function genSand(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => (noise((x / ART) * 2, (y / ART) * 2) + bayer(x, y) - 0.5 > 0.55 ? SAND.light : SAND.mid));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (hash(x * 5 + 2, y * 9) < 0.02) { ctx.fillStyle = css(SAND.dark); ctx.fillRect(x, y, 1, 1); }
  return cv;
}

const WATER = { mid: [54, 120, 178] as RGB, light: [70, 142, 196] as RGB, dark: [42, 96, 154] as RGB };
function genWater(): HTMLCanvasElement {
  const noise = tileNoise(TEX);
  const [cv] = paint((x, y) => {
    const n = noise(x / ART, (y / ART) * 0.6); // 横向拉长 ⇒ 波带感
    return n + bayer(x, y) - 0.5 > 0.58 ? WATER.light : WATER.mid;
  });
  return cv;
}

// 鹅卵石(中世纪街):硬边石块,~3/格,限灰阶 + 1px 缝/高光/暗边。
const COBBLE: RGB[] = [[150, 148, 140], [128, 126, 118], [166, 164, 156]];
function genCobble(): HTMLCanvasElement {
  const [cv, ctx] = mk();
  ctx.fillStyle = '#4f4b44';
  ctx.fillRect(0, 0, N, N); // 缝底
  const sz = 6;
  let row = 0;
  for (let y = 0; y < N; y += sz, row++) {
    const off = row % 2 ? sz / 2 : 0;
    for (let x = -sz; x < N; x += sz) {
      const sx = (((x + off) % N) + N) % N;
      const col = COBBLE[Math.floor(hash(Math.round((x + off) / sz), row) * COBBLE.length)];
      const jx = Math.floor((hash(row, x) - 0.5) * 2);
      const jy = Math.floor((hash(x, row) - 0.5) * 2);
      ctx.fillStyle = css(col);
      ctx.fillRect(sx + 1 + jx, y + 1 + jy, sz - 2, sz - 2);
      ctx.fillStyle = css(shift(col, 18));
      ctx.fillRect(sx + 1 + jx, y + 1 + jy, sz - 2, 1); // 顶高光
      ctx.fillStyle = css(shift(col, -24));
      ctx.fillRect(sx + 1 + jx, y + sz - 2 + jy, sz - 2, 1); // 底暗
    }
  }
  return cv;
}

// 石板广场:限灰阶抖动底 + 错缝大方石缝(1px 暗线)。
const FLAG: RGB[] = [[166, 166, 172], [152, 152, 158]];
function genStone(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => (noise((x / ART) * 2, (y / ART) * 2) + bayer(x, y) - 0.5 > 0.5 ? FLAG[0] : FLAG[1]));
  ctx.fillStyle = 'rgba(92,92,100,0.7)';
  for (let y = 0; y <= N; y += ART) ctx.fillRect(0, y, N, 1); // 横缝
  let r = 0;
  for (let y = 0; y < N; y += ART, r++) {
    const off = r % 2 ? ART / 2 : 0;
    for (let x = off; x <= N; x += ART) ctx.fillRect(((x % N) + N) % N, y, 1, ART); // 竖缝(错位)
  }
  return cv;
}

const GEN: Record<string, () => HTMLCanvasElement> = { grass: genGrass, dirt: genDirt, stone: genStone, cobble: genCobble, sand: genSand, water: genWater };
const cache = new Map<string, HTMLCanvasElement>();
function texture(name: string): HTMLCanvasElement {
  let t = cache.get(name);
  if (!t) { t = (GEN[name] ?? genGrass)(); cache.set(name, t); }
  return t;
}

/** 画一格地面：从 art-res 无缝大纹理 blit (tx,ty) 子区 → 引擎放大(最近邻)成清脆像素。 */
export function drawGroundTile(ctx: CanvasRenderingContext2D, name: string, dx: number, dy: number, S: number, tx: number, ty: number): void {
  const tex = texture(name);
  const sx = (((tx % TEX) + TEX) % TEX) * ART;
  const sy = (((ty % TEX) + TEX) % TEX) * ART;
  ctx.drawImage(tex, sx, sy, ART, ART, dx, dy, S, S);
}
