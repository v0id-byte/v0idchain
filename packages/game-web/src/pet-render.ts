// 崽 渲染（Render Spec v1，见 docs/GAME-PROTOCOL.md §4.3）：基因 → 像素。
// 特征 petTraits 来自 core（全客户端共用）⇒ 同一基因处处同长相（PRD 6.5）。
// 画法：先在 32×32 离屏画，再关抗锯齿放大 ⇒ 像素风。改这张映射 = bump 到 Spec v2。
import { petTraits } from '@v0idchain/core/browser';
import type { PetTraits, Rarity } from '@v0idchain/core/browser';

const SHEET = 32;

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

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h)} ${s}% ${l}%)`;
function fillEllipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

function paint(ctx: CanvasRenderingContext2D, t: PetTraits) {
  ctx.clearRect(0, 0, SHEET, SHEET);
  const main = hsl(t.hue, 64, 56);
  const dark = hsl(t.hue, 58, 34);
  const belly = hsl(t.bellyHue, 58, 75);
  const cx = SHEET / 2;
  const bw = 16 + (t.body % 3) * 3; // 体宽 16/19/22
  const bh = 15 + Math.floor(t.body / 3) * 2; // 体高 15/17
  const by = SHEET / 2 + 3;

  // 耳/角（顶部，按 body 变化）
  ctx.fillStyle = dark;
  const earX = bw / 3;
  if (t.body % 3 === 0) {
    fillEllipse(ctx, cx - earX, by - bh / 2, 3, 3);
    fillEllipse(ctx, cx + earX, by - bh / 2, 3, 3);
  } else if (t.body % 3 === 1) {
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * earX, by - bh / 2 + 1);
      ctx.lineTo(cx + s * (earX + 2), by - bh / 2 - 5);
      ctx.lineTo(cx + s * (earX - 1), by - bh / 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 身体：深色描边 + 主色填充
  ctx.fillStyle = dark;
  fillEllipse(ctx, cx, by, bw / 2 + 1, bh / 2 + 1);
  ctx.fillStyle = main;
  fillEllipse(ctx, cx, by, bw / 2, bh / 2);
  // 腹部
  ctx.fillStyle = belly;
  fillEllipse(ctx, cx, by + 3, bw / 4, bh / 3);

  // 花纹
  if (t.pattern === 1) {
    ctx.fillStyle = dark;
    fillEllipse(ctx, cx - 4, by - 3, 1.4, 1.4);
    fillEllipse(ctx, cx + 4, by - 4, 1.4, 1.4);
    fillEllipse(ctx, cx + 5, by + 1, 1.4, 1.4);
  } else if (t.pattern === 2) {
    ctx.fillStyle = dark;
    ctx.fillRect(cx - bw / 2, by - 1, bw, 1.6);
  } else if (t.pattern === 3) {
    ctx.fillStyle = hsl(t.bellyHue, 72, 66);
    fillEllipse(ctx, cx - bw / 3, by + 1.5, 1.6, 1.2);
    fillEllipse(ctx, cx + bw / 3, by + 1.5, 1.6, 1.2);
  }

  // 眼睛（按 eyes 变化）
  const ex = 3.2;
  const ey = by - 2;
  ctx.fillStyle = '#1b1422';
  if (t.eyes % 3 === 0) {
    fillEllipse(ctx, cx - ex, ey, 1.5, 1.8);
    fillEllipse(ctx, cx + ex, ey, 1.5, 1.8);
    ctx.fillStyle = '#fff';
    fillEllipse(ctx, cx - ex + 0.5, ey - 0.6, 0.5, 0.5);
    fillEllipse(ctx, cx + ex + 0.5, ey - 0.6, 0.5, 0.5);
  } else if (t.eyes % 3 === 1) {
    ctx.fillRect(cx - ex - 1, ey - 1, 2, 2);
    ctx.fillRect(cx + ex - 1, ey - 1, 2, 2);
  } else {
    ctx.strokeStyle = '#1b1422';
    ctx.lineWidth = 1;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * ex - 1.4, ey);
      ctx.lineTo(cx + s * ex, ey - 1.6);
      ctx.lineTo(cx + s * ex + 1.4, ey);
      ctx.stroke();
    }
  }

  // 配饰（accessory>0）
  if (t.accessory > 0) {
    const a = t.accessory;
    if (a % 3 === 1) {
      // 小帽子
      ctx.fillStyle = hsl((t.hue + 180) % 360, 60, 50);
      ctx.fillRect(cx - 4, by - bh / 2 - 2, 8, 2);
      ctx.fillRect(cx - 2.5, by - bh / 2 - 5, 5, 3);
    } else if (a % 3 === 2) {
      // 蝴蝶结
      ctx.fillStyle = hsl((t.bellyHue + 40) % 360, 70, 60);
      fillEllipse(ctx, cx - 2, by - bh / 2, 1.6, 1.2);
      fillEllipse(ctx, cx + 2, by - bh / 2, 1.6, 1.2);
    } else {
      // 腮红/光点
      ctx.fillStyle = hsl((t.hue + 20) % 360, 80, 70);
      fillEllipse(ctx, cx - bw / 2 + 1, by + 2, 1.2, 1);
      fillEllipse(ctx, cx + bw / 2 - 1, by + 2, 1.2, 1);
    }
  }
}

/** 把某基因的崽画到 canvas 上（size = 展示边长，像素风）。 */
export function renderPet(canvas: HTMLCanvasElement, gene: string, size = 128): void {
  const t = petTraits(gene);
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

export { petTraits };
