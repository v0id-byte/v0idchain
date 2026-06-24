// 真·像素风程序化地面（星露谷式技法，取代之前过于平滑的版本）：
// 低艺术分辨率(每格 ART 像素) + 限定离散色板 + 4×4 有序抖动(Bayer dithering) + 全硬像素(无渐变/无抗锯齿) +
// 最近邻放大。预渲染 8×8 格「无缝大纹理」(art-res)，各格 blit 子区、引擎关抗锯齿放大 ⇒ 清脆块状像素。
// 大色块分布用可平铺低频噪声 ⇒ 8 格处无缝；细节(草簇/碎石/缝)用确定性硬像素。
import { rampRGB } from './light.js';

const ART = 16; // 每格艺术像素 = 星露谷规格(放大后块感正)
const TEX = 8; // 大纹理边长(格)
const N = TEX * ART; // 128

export const GROUND_KINDS = new Set(['grass', 'dirt', 'stone', 'cobble', 'sand', 'water', 'caveFloor', 'caveWall',
  // 场景专属变体（R2）：木栈道 / 湿沙岸线 / 林地苔藓 / 废墟裂石。
  'plank', 'sandWet', 'grassForest', 'stoneRuins']);

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
// hue-shift 版（§7-C）：亮偏暖、暗偏冷，替代纯明度加减 ⇒ 鹅卵石等地面块顶亮底暗更通透。
const shift = (c: RGB, d: number): RGB => rampRGB(c[0], c[1], c[2], d);

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
const GRASS = { mid: [110, 158, 66] as RGB, light: [134, 178, 82] as RGB, dark: [86, 128, 48] as RGB, hi: [158, 200, 96] as RGB };
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
      const r2 = hash(x * 11 + 7, y * 13 + 2);
      if (r < 0.018) { ctx.fillStyle = css(GRASS.dark); ctx.fillRect(x, y, 1, 2); } // 草叶(暗)
      else if (r > 0.992) { ctx.fillStyle = css(GRASS.hi); ctx.fillRect(x, y, 1, 2); } // 草叶(亮)
      else if (r > 0.986) { ctx.fillStyle = r > 0.989 ? '#e8d24a' : '#e8a0a0'; ctx.fillRect(x, y, 1, 1); } // 花（黄/粉）
      else if (r2 < 0.005) { ctx.fillStyle = '#c8ba98'; ctx.fillRect(x, y, 2, 1); } // 小石子
    }
  return cv;
}

const DIRT = { mid: [152, 110, 62] as RGB, light: [172, 128, 72] as RGB, dark: [120, 88, 50] as RGB };
function genDirt(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => (noise((x / ART) * 2, (y / ART) * 2) + bayer(x, y) - 0.5 > 0.55 ? DIRT.light : DIRT.mid));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const r = hash(x * 7, y * 3 + 5);
      if (r < 0.015) { ctx.fillStyle = css(hash(x, y) > 0.5 ? DIRT.dark : [188, 154, 102]); ctx.fillRect(x, y, 1, 1); }
      else if (r < 0.022) { ctx.fillStyle = css(DIRT.dark); ctx.fillRect(x, y, 2, 1); } // 有机划痕
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
const COBBLE: RGB[] = [[158, 150, 134], [134, 126, 110], [174, 166, 148]];
function genCobble(): HTMLCanvasElement {
  const [cv, ctx] = mk();
  ctx.fillStyle = '#484038';
  ctx.fillRect(0, 0, N, N); // 缝底（暖棕色）
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
      ctx.fillStyle = css(shift(col, 24));
      ctx.fillRect(sx + 1 + jx, y + 1 + jy, sz - 2, 1); // 顶高光（加强）
      ctx.fillStyle = css(shift(col, -32));
      ctx.fillRect(sx + 1 + jx, y + sz - 2 + jy, sz - 2, 1); // 底暗（加强）
    }
  }
  return cv;
}

// 石板广场:限灰阶抖动底 + 错缝大方石缝(1px 暗线)。
const FLAG: RGB[] = [[170, 162, 148], [156, 148, 134]];
function genStone(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => (noise((x / ART) * 2, (y / ART) * 2) + bayer(x, y) - 0.5 > 0.5 ? FLAG[0] : FLAG[1]));
  ctx.fillStyle = 'rgba(86,76,62,0.65)';
  for (let y = 0; y <= N; y += ART) ctx.fillRect(0, y, N, 1); // 横缝
  let r = 0;
  for (let y = 0; y < N; y += ART, r++) {
    const off = r % 2 ? ART / 2 : 0;
    for (let x = off; x <= N; x += ART) ctx.fillRect(((x % N) + N) % N, y, 1, ART); // 竖缝(错位)
  }
  return cv;
}

const CAVE_FLOOR = { mid: [54, 50, 61] as RGB, light: [68, 62, 74] as RGB, dark: [38, 36, 46] as RGB, gem: [91, 83, 116] as RGB };
function genCaveFloor(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => {
    const n = noise((x / ART) * 2, (y / ART) * 2);
    if (n < 0.28) return CAVE_FLOOR.dark;
    return n + bayer(x, y) - 0.5 > 0.58 ? CAVE_FLOOR.light : CAVE_FLOOR.mid;
  });
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = hash(x * 11 + 3, y * 7 + 9);
      if (r < 0.014) { ctx.fillStyle = css(CAVE_FLOOR.dark); ctx.fillRect(x, y, 1, 1); }
      else if (r > 0.996) { ctx.fillStyle = css(CAVE_FLOOR.gem); ctx.fillRect(x, y, 1, 1); }
    }
  }
  return cv;
}

const CAVE_WALL = { mid: [38, 35, 47] as RGB, light: [56, 50, 66] as RGB, dark: [23, 22, 31] as RGB };
function genCaveWall(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => {
    const n = noise((x / ART) * 2, (y / ART) * 2);
    if (n < 0.32) return CAVE_WALL.dark;
    return n + bayer(x, y) - 0.5 > 0.55 ? CAVE_WALL.light : CAVE_WALL.mid;
  });
  ctx.fillStyle = 'rgba(12,10,18,0.55)';
  for (let y = ART - 1; y < N; y += ART) ctx.fillRect(0, y, N, 1);
  for (let x = ART - 1; x < N; x += ART) ctx.fillRect(x, 0, 1, N);
  return cv;
}

// ───────── 场景专属变体（R2，加在通用地面之上，不改既有场景） ─────────

// 木栈道（码头/甲板）：暖木长板 + 横板缝 + 纵向木纹 + 板端错缝 + 钉。
const PLANK = { mid: [150, 108, 64] as RGB, light: [170, 126, 76] as RGB, dark: [120, 84, 48] as RGB, seam: [78, 52, 30] as RGB };
function genPlank(): HTMLCanvasElement {
  const boardH = 8; // 板宽(沿 y)，整除 N ⇒ 纵向无缝
  const [cv, ctx] = paint((x, y) => {
    const band = Math.floor(y / boardH);
    const base = hash(band, 3) > 0.62 ? PLANK.light : hash(band, 7) < 0.3 ? PLANK.dark : PLANK.mid;
    const grain = hash(Math.floor(x / 2), band * 5 + 1);
    if (grain < 0.12) return shift(base, -10); // 深木纹
    if (grain > 0.9) return shift(base, 9); // 亮木纹
    return bayer(x, y) - 0.5 + (hash(x, band) - 0.5) * 0.3 > 0.25 ? shift(base, 5) : base;
  });
  ctx.fillStyle = css(PLANK.seam);
  for (let y = 0; y < N; y += boardH) ctx.fillRect(0, y, N, 1); // 横板缝
  ctx.fillStyle = css(shift(PLANK.light, 8));
  for (let y = 1; y < N; y += boardH) ctx.fillRect(0, y, N, 1); // 缝下板顶高光
  for (let band = 0; band * boardH < N; band++) {
    const y = band * boardH;
    const jx = ((band % 2 ? 0 : 64) + Math.floor(hash(band, 11) * 24)) % N;
    ctx.fillStyle = css(PLANK.seam);
    ctx.fillRect(jx, y, 1, boardH); // 板端竖缝(错位)
    ctx.fillStyle = css(shift(PLANK.dark, -14));
    ctx.fillRect(3, y + 3, 1, 1); ctx.fillRect(N - 5, y + 3, 1, 1); // 钉
  }
  return cv;
}

// 湿沙（海岸线）：比 sand 暗一档 + 湿渍暗斑 + 贝壳碎点。
const SAND_WET = { mid: [176, 160, 120] as RGB, light: [192, 176, 134] as RGB, dark: [150, 136, 100] as RGB };
function genSandWet(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => {
    const n = noise((x / ART) * 2, (y / ART) * 2);
    if (n < 0.3) return SAND_WET.dark;
    return n + bayer(x, y) - 0.5 > 0.56 ? SAND_WET.light : SAND_WET.mid;
  });
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = hash(x * 5 + 2, y * 9);
    if (r < 0.012) { ctx.fillStyle = hash(x, y) > 0.5 ? '#f0e6d2' : '#e7b8a0'; ctx.fillRect(x, y, 1, 1); } // 贝壳碎
    else if (r > 0.99) { ctx.fillStyle = css(shift(SAND_WET.dark, -12)); ctx.fillRect(x, y, 2, 1); } // 湿渍
  }
  return cv;
}

// 林地（森林秘境）：苔藓深绿 + 更多暗叶团 + 落叶(橙黄) + 枯枝。
const GRASSF = { mid: [78, 118, 52] as RGB, light: [98, 140, 64] as RGB, dark: [56, 92, 40] as RGB, hi: [120, 160, 78] as RGB };
function genGrassForest(): HTMLCanvasElement {
  const noise = tileNoise(TEX);
  const [cv, ctx] = paint((x, y) => {
    const n = noise(x / ART, y / ART);
    if (n < 0.34) return GRASSF.dark;
    return n + bayer(x, y) - 0.5 > 0.6 ? GRASSF.light : GRASSF.mid;
  });
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = hash(x * 3 + 1, y * 5 + 2);
    if (r < 0.03) { ctx.fillStyle = css(GRASSF.dark); ctx.fillRect(x, y, 1, 2); } // 暗草叶
    else if (r > 0.985) { ctx.fillStyle = css(GRASSF.hi); ctx.fillRect(x, y, 1, 2); } // 亮草尖
    else {
      const lf = hash(x * 7 + 5, y * 11 + 3);
      if (lf > 0.992) { ctx.fillStyle = lf > 0.996 ? '#b67a32' : '#c89a44'; ctx.fillRect(x, y, 2, 1); } // 落叶
      else if (lf < 0.004) { ctx.fillStyle = '#6a4a2a'; ctx.fillRect(x, y, 2, 1); } // 枯枝
    }
  }
  return cv;
}

// 废墟石板：旗石底 + 缝隙青苔 + 贯穿裂缝 + 个别缺块露土。
function genStoneRuins(): HTMLCanvasElement {
  const noise = tileNoise(TEX * 2);
  const [cv, ctx] = paint((x, y) => (noise((x / ART) * 2, (y / ART) * 2) + bayer(x, y) - 0.5 > 0.5 ? FLAG[0] : FLAG[1]));
  ctx.fillStyle = 'rgba(70,62,50,0.7)';
  for (let y = 0; y <= N; y += ART) ctx.fillRect(0, y, N, 1); // 横缝
  let r = 0;
  for (let y = 0; y < N; y += ART, r++) { const off = r % 2 ? ART / 2 : 0; for (let x = off; x <= N; x += ART) ctx.fillRect(((x % N) + N) % N, y, 1, ART); } // 竖缝(错位)
  for (let y = 0; y <= N; y += ART) for (let x = 0; x < N; x++) if (hash(x * 3, y * 5 + 1) < 0.16) { ctx.fillStyle = hash(x, y) > 0.5 ? '#5f7d3c' : '#4c6630'; ctx.fillRect(x, y, 1, 1); } // 缝隙青苔
  for (let i = 0; i < 6; i++) { // 贯穿裂缝(随机游走)
    let cxk = Math.floor(hash(i * 7 + 1, 2) * N), cyk = Math.floor(hash(i, 9) * N);
    ctx.fillStyle = '#39332a';
    for (let k = 0; k < 22; k++) { ctx.fillRect((cxk + N) % N, (cyk + N) % N, 1, 1); cxk += hash(i, k) < 0.5 ? 1 : 0; cyk += hash(k, i) < 0.4 ? 1 : hash(k, i) < 0.72 ? 0 : -1; }
  }
  for (let i = 0; i < 4; i++) { const bx = Math.floor(hash(i * 5 + 2, 7) * (N - ART)); const by = Math.floor(hash(i, 3) * (N - ART)); ctx.fillStyle = css(DIRT.mid); ctx.fillRect(bx, by, ART - 3, ART - 3); } // 缺块露土
  return cv;
}

const GEN: Record<string, () => HTMLCanvasElement> = {
  grass: genGrass,
  dirt: genDirt,
  stone: genStone,
  cobble: genCobble,
  sand: genSand,
  water: genWater,
  caveFloor: genCaveFloor,
  caveWall: genCaveWall,
  plank: genPlank,
  sandWet: genSandWet,
  grassForest: genGrassForest,
  stoneRuins: genStoneRuins,
};
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

/**
 * 用外部 PNG 替换某地面种类的缓存纹理（将 16×16 像素图平铺成 128×128 无缝大纹理）。
 * 在 loadMineSprites() 完成后调用，让 caveFloor/caveWall 切换到手绘资源。
 */
export function setGroundSprite(name: string, img: HTMLImageElement): void {
  const [cv, ctx] = mk();
  ctx.imageSmoothingEnabled = false;
  const pat = ctx.createPattern(img, 'repeat');
  if (!pat) return;
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, N, N);
  cache.set(name, cv);
}
