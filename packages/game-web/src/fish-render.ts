// 渔获渲染（Render Spec v1，见 docs/GAME-PROTOCOL.md §6）：catchHash → 像素鱼。
// 特征 fishTraits 来自 core（全客户端共用）⇒ 同一 catchHash 处处同长相。
// 画法镜像 pet-render：先在 32×32 离屏画，再关抗锯齿放大 ⇒ 像素风。改这张映射 = bump 到 Spec v2。
// 鱼一律朝右（尾在左、头在右），与镇上鱼摊的小鱼图标同向。
import { fishTraits } from '@v0idchain/core/browser';
import type { FishTraits, Rarity } from '@v0idchain/core/browser';

const SHEET = 32;

// 与 pet-render 同一套稀有度外发光（跨子系统一致：稀有蓝、史诗紫、传说金）。
const RARITY_GLOW: Record<Rarity, string | null> = {
  common: null,
  rare: '#54a8ff',
  epic: '#b66bff',
  legendary: '#ffce3d',
};
export const RARITY_LABEL: Record<Rarity, string> = {
  common: '普通',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
};

/** 各稀有度档位的鱼种名（与 core 的 N_SPECIES 一一对应，索引即 species）。 */
export const SPECIES_NAME: Record<Rarity, string[]> = {
  common: ['鲫鱼', '鲈鱼', '泥鳅', '河虾'],
  rare: ['锦鲤', '鳟鱼', '河豚'],
  epic: ['金龙鱼', '电鳗', '月鱼'],
  legendary: ['虚空鲸', '星之鲟'],
};

/** 渔获中文名（稀有度 + 鱼种）。 */
export function fishName(t: FishTraits): string {
  return SPECIES_NAME[t.rarity][t.species] ?? '怪鱼';
}

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${s}% ${l}%)`;

function fillEllipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

/** 朝左的三角尾（鱼头在右）。tailLen/tailSpread 由 finStyle 微调。 */
function drawTail(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, spread: number) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - len, y - spread);
  ctx.lineTo(x - len, y + spread);
  ctx.closePath();
  ctx.fill();
}

function paint(ctx: CanvasRenderingContext2D, t: FishTraits) {
  ctx.clearRect(0, 0, SHEET, SHEET);
  const cx = SHEET / 2;
  const cy = SHEET / 2 + 1;

  // 体型：稀有度越高、sizeCm 越大 → 身越大。虾(common species 3)用更细长身。
  const isShrimp = t.rarity === 'common' && t.species === 3;
  const isWhale = t.rarity === 'legendary' && t.species === 0; // 虚空鲸
  const grow = 0.6 + Math.min(1, t.sizeCm / 200) * 0.7; // 0.6~1.3
  const bw = (isShrimp ? 8 : 11) * grow; // 体宽半径
  const bh = (isShrimp ? 3.4 : 5.2) * grow; // 体高半径

  // 配色：虚空鲸走深空色（体内星点，呼应“烧币进虚空”）；其余按 hue。
  const main = isWhale ? 'hsl(248 40% 22%)' : hsl(t.hue, 62, 55);
  const dark = isWhale ? 'hsl(248 45% 13%)' : hsl(t.hue, 56, 36);
  const belly = isWhale ? 'hsl(250 35% 40%)' : hsl(t.bellyHue, 55, 74);

  // 尾（在身体左侧；finStyle 决定长短/张开）
  const tailLen = 4 + (t.finStyle % 2) * 2;
  const tailSpread = 2.5 + (t.finStyle >> 1) * 1.6;
  ctx.fillStyle = dark;
  drawTail(ctx, cx - bw + 0.5, cy, tailLen, tailSpread);

  // 上背鳍（finStyle 偶数=尖，奇数=圆弧）
  ctx.fillStyle = dark;
  if (t.finStyle % 2 === 0) {
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy - bh + 0.5);
    ctx.lineTo(cx + 1, cy - bh - 2.5);
    ctx.lineTo(cx + 3, cy - bh + 0.5);
    ctx.closePath();
    ctx.fill();
  } else {
    fillEllipse(ctx, cx, cy - bh, 3, 1.6);
  }

  // 身体：深色描边 + 主色填充
  ctx.fillStyle = dark;
  fillEllipse(ctx, cx, cy, bw + 0.8, bh + 0.8);
  ctx.fillStyle = main;
  fillEllipse(ctx, cx, cy, bw, bh);
  // 腹（下半）
  ctx.fillStyle = belly;
  fillEllipse(ctx, cx + 1, cy + bh * 0.45, bw * 0.66, bh * 0.42);

  // 花纹 / 特征：按鱼种点缀
  if (isWhale) {
    // 体内星点（白/金小点）
    const stars: [number, number][] = [[-4, -1], [-1, 1], [2, -1.5], [4, 0.5], [0, -0.5]];
    for (const [sx, sy] of stars) {
      ctx.fillStyle = (sx + sy) % 2 === 0 ? '#ffe27a' : '#e8f0ff';
      fillEllipse(ctx, cx + sx, cy + sy, 0.7, 0.7);
    }
  } else if (t.rarity === 'rare' && t.species === 0) {
    // 锦鲤红白斑
    ctx.fillStyle = hsl((t.hue + 12) % 360, 80, 60);
    fillEllipse(ctx, cx - 2, cy - 1, 2, 1.4);
    fillEllipse(ctx, cx + 3, cy + 1, 1.6, 1.2);
  } else {
    // 通用侧线斑（用副色相）
    ctx.fillStyle = hsl(t.bellyHue, 60, 50);
    for (const dxp of [-3, 0, 3]) fillEllipse(ctx, cx + dxp, cy - 0.5, 0.8, 0.8);
  }

  // 眼（鱼头在右）
  const eyeX = cx + bw * 0.55;
  const eyeY = cy - bh * 0.25;
  ctx.fillStyle = '#fff';
  fillEllipse(ctx, eyeX, eyeY, 1.4, 1.4);
  ctx.fillStyle = '#11202a';
  fillEllipse(ctx, eyeX + 0.4, eyeY, 0.8, 0.9);

  // 虾：加须 + 弯尾段（在通用身上叠几笔）
  if (isShrimp) {
    ctx.strokeStyle = dark;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(eyeX + 1, eyeY - 0.5);
    ctx.lineTo(eyeX + 4, eyeY - 3);
    ctx.moveTo(eyeX + 1, eyeY);
    ctx.lineTo(eyeX + 4, eyeY - 1);
    ctx.stroke();
  }

  // 闪光个体：右上角加一颗高光星
  if (t.shiny) {
    ctx.fillStyle = '#fffbe0';
    const stx = cx + bw * 0.2;
    const sty = cy - bh - 2.5;
    ctx.fillRect(stx - 0.5, sty - 2, 1, 4);
    ctx.fillRect(stx - 2, sty - 0.5, 4, 1);
  }
}

/** 把某 catchHash 的渔获画到 canvas 上（size = 展示边长，像素风）。 */
export function renderFish(canvas: HTMLCanvasElement, catchHash: string, size = 128): void {
  const t = fishTraits(catchHash);
  const off = document.createElement('canvas');
  off.width = off.height = SHEET;
  paint(off.getContext('2d')!, t);

  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  const glow = RARITY_GLOW[t.rarity];
  if (glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = size * 0.11;
  }
  ctx.drawImage(off, 0, 0, SHEET, SHEET, 0, 0, size, size);
  if (glow) ctx.restore();
}

export { fishTraits };
