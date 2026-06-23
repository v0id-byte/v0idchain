// 作物渲染（Render Spec v1，见 docs/GAME-PROTOCOL.md §7）：crop × 成长阶段 × cropHash → 像素作物。
// 特征 cropTraits + 成长阶段 cropStage 来自 core（全客户端共用）⇒ 同一 (crop, hash, stage) 处处同长相。
// 画法镜像 pet/fish-render：先在 32×32 离屏画，再关抗锯齿放大 ⇒ 像素风。改这张映射 = bump 到 Spec v2。
// 成长阶段 0 种子点 / 1 幼苗 / 2 成株(未结果) / 3 成熟结果；品质仅加外发光（不改主体几何 → 不影响“同 hash 同外观”）。
import { cropTraits } from '@v0idchain/core/browser';
import type { CropTraits, Crop, Rarity } from '@v0idchain/core/browser';

const SHEET = 32;

// 与 pet/fish-render 同一套稀有度外发光（跨子系统一致：稀有蓝、史诗紫、传说金）。
const QUALITY_GLOW: Record<Rarity, string | null> = {
  common: null,
  rare: '#54a8ff',
  epic: '#b66bff',
  legendary: '#ffce3d',
};
export const QUALITY_LABEL: Record<Rarity, string> = {
  common: '普通',
  rare: '优质',
  epic: '稀有',
  legendary: '黄金',
};

/** 作物中文名（按 crop 种类）。 */
export const CROP_NAME: Record<Crop, string> = {
  turnip: '芜菁',
  wheat: '小麦',
  pumpkin: '南瓜',
  starfruit: '星之果',
};

/** 各作物果实主色相（成株/结果阶段的果色基底；个体再叠 traits.hue 微调）。 */
const CROP_HUE: Record<Crop, number> = {
  turnip: 285, // 紫白芜菁
  wheat: 45, // 金黄麦穗
  pumpkin: 28, // 橙南瓜
  starfruit: 52, // 金星之果
};

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${s}% ${l}%)`;

function fillEllipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

const SOIL = '#6b4a2f';
const STEM = 'hsl(130 45% 38%)';
const LEAF = 'hsl(125 48% 44%)';
const LEAF_HI = 'hsl(118 52% 56%)';

/** 泥畦底座（各阶段都画，把作物“种”在土里）。 */
function drawSoil(ctx: CanvasRenderingContext2D, cx: number, baseY: number) {
  ctx.fillStyle = SOIL;
  fillEllipse(ctx, cx, baseY, 9, 2.6);
  ctx.fillStyle = '#54381f';
  fillEllipse(ctx, cx, baseY + 0.6, 9, 1.4);
}

function paint(ctx: CanvasRenderingContext2D, t: CropTraits, stage: 0 | 1 | 2 | 3) {
  ctx.clearRect(0, 0, SHEET, SHEET);
  const cx = SHEET / 2;
  const baseY = SHEET - 6; // 土面
  drawSoil(ctx, cx, baseY);

  // 果色：作物基底色相叠个体 hue 微调（±20），品质越高越饱和明亮。
  const baseHue = (CROP_HUE[t.crop] + ((t.hue % 40) - 20) + 360) % 360;
  const qSat = t.quality === 'common' ? 62 : t.quality === 'rare' ? 70 : t.quality === 'epic' ? 78 : 88;
  const fruit = hsl(baseHue, qSat, 56);
  const fruitDark = hsl(baseHue, qSat - 6, 38);
  const fruitHi = hsl(baseHue, qSat - 10, 72);
  const giantScale = t.giant && stage === 3 ? 1.25 : 1; // 巨型仅在结果阶段放大果实

  if (stage === 0) {
    // 种子点：土里几粒深色小点 + 一抹嫩绿冒头
    ctx.fillStyle = '#3b2a18';
    for (const dx of [-2, 0.5, 2.5]) fillEllipse(ctx, cx + dx, baseY - 1, 0.8, 0.7);
    ctx.fillStyle = LEAF_HI;
    fillEllipse(ctx, cx, baseY - 2.5, 1, 1.3);
    return;
  }

  // 幼苗 / 成株 / 结果：共用茎 + 叶，高度随阶段递增
  const stemTop = stage === 1 ? baseY - 7 : stage === 2 ? baseY - 13 : baseY - 14;
  ctx.strokeStyle = STEM;
  ctx.lineWidth = stage === 1 ? 1.2 : 1.8;
  ctx.beginPath();
  ctx.moveTo(cx, baseY - 1);
  ctx.lineTo(cx, stemTop);
  ctx.stroke();

  // 叶（左右对称，数量随阶段）
  const leafRows = stage === 1 ? [baseY - 4] : stage === 2 ? [baseY - 5, baseY - 10] : [baseY - 5, baseY - 10];
  for (const ly of leafRows) {
    for (const s of [-1, 1]) {
      ctx.fillStyle = LEAF;
      fillEllipse(ctx, cx + s * 3, ly, 3, 1.6);
      ctx.fillStyle = LEAF_HI;
      fillEllipse(ctx, cx + s * 3.4, ly - 0.4, 1.4, 0.8);
    }
  }

  if (stage === 1) {
    // 幼苗顶芽
    ctx.fillStyle = LEAF_HI;
    fillEllipse(ctx, cx, stemTop, 1.6, 2);
    return;
  }

  if (stage === 2) {
    // 成株（未结果）：顶部一簇饱满叶团，预示将结果
    ctx.fillStyle = LEAF;
    fillEllipse(ctx, cx, stemTop + 1, 4.2, 3.2);
    ctx.fillStyle = LEAF_HI;
    fillEllipse(ctx, cx - 1, stemTop, 2, 1.6);
    return;
  }

  // stage 3 成熟结果：按作物画果实在茎顶/茎侧
  const fy = stemTop + 1;
  if (t.crop === 'pumpkin') {
    // 南瓜：贴地大果（坐在土上），纵棱
    const r = 6 * giantScale;
    const py = baseY - r * 0.7;
    ctx.fillStyle = fruitDark;
    fillEllipse(ctx, cx, py, r + 0.8, r * 0.82 + 0.8);
    ctx.fillStyle = fruit;
    fillEllipse(ctx, cx, py, r, r * 0.82);
    ctx.strokeStyle = fruitDark;
    ctx.lineWidth = 0.9;
    for (const s of [-1, 0, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + s * r * 0.45, py, Math.max(0.6, r * 0.18), r * 0.78, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = STEM; // 蒂
    ctx.fillRect(cx - 0.8, py - r * 0.82 - 2, 1.6, 2.4);
  } else if (t.crop === 'wheat') {
    // 小麦：茎顶金穗（一串小颗粒 + 芒刺）
    ctx.fillStyle = fruit;
    for (let i = 0; i < 5; i++) {
      const yy = stemTop + i * 2.1;
      fillEllipse(ctx, cx - 1.4, yy, 1.3, 1);
      fillEllipse(ctx, cx + 1.4, yy, 1.3, 1);
    }
    ctx.strokeStyle = fruitHi;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(cx, stemTop - 1);
    ctx.lineTo(cx, stemTop - 4);
    ctx.stroke();
  } else if (t.crop === 'starfruit') {
    // 星之果：茎顶五角星果（金 + 高光），呼应稀有种
    const r = 5 * giantScale;
    ctx.fillStyle = fruitDark;
    drawStar(ctx, cx, fy, r + 0.7, 5);
    ctx.fillStyle = fruit;
    drawStar(ctx, cx, fy, r, 5);
    ctx.fillStyle = fruitHi;
    fillEllipse(ctx, cx - 1, fy - 1, 1.1, 1.1);
  } else {
    // 芜菁（默认圆根果）：茎顶圆果 + 高光
    const r = 4.4 * giantScale;
    ctx.fillStyle = fruitDark;
    fillEllipse(ctx, cx, fy, r + 0.8, r + 0.8);
    ctx.fillStyle = fruit;
    fillEllipse(ctx, cx, fy, r, r);
    ctx.fillStyle = fruitHi;
    fillEllipse(ctx, cx - r * 0.35, fy - r * 0.35, r * 0.4, r * 0.4);
  }

  // 巨型个体：果旁加一颗炫耀光点
  if (t.giant) {
    ctx.fillStyle = '#fffbe0';
    ctx.fillRect(cx + 5, fy - 6, 1, 3);
    ctx.fillRect(cx + 3.5, fy - 4.5, 3, 1);
  }
}

/** 画 n 角星（外接半径 r），果实用。 */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, n: number) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (Math.PI / n) * i - Math.PI / 2;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * 把某 (crop, hash) 的作物画到 canvas 上（size = 展示边长，像素风）。
 * stage 默认 3（成熟，图鉴/收藏展示用）；场景里按 cropStage(growth) 传 0~2 画生长中。
 */
export function renderCrop(canvas: HTMLCanvasElement, crop: Crop, hash: string, size = 128, stage: 0 | 1 | 2 | 3 = 3): void {
  const t = cropTraits(crop, hash);
  const off = document.createElement('canvas');
  off.width = off.height = SHEET;
  paint(off.getContext('2d')!, t, stage);

  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  const glow = stage === 3 ? QUALITY_GLOW[t.quality] : null; // 仅成熟果发光（生长中不剧透品质）
  if (glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = size * 0.11;
  }
  ctx.drawImage(off, 0, 0, SHEET, SHEET, 0, 0, size, size);
  if (glow) ctx.restore();
}

/** 作物中文名（种类 + 品质前缀，结果时用）。 */
export function cropFullName(t: CropTraits): string {
  return `${QUALITY_LABEL[t.quality]}${CROP_NAME[t.crop]}`;
}

export { cropTraits };
