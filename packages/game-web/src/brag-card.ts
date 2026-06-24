// 虚空图鉴 · 像素战绩卡（PNG）——showcase 的核心产物：你最稀有的几件藏品 + 稀有度统计 + 收集完成度，
// 渲染成一张可下载/截图分享的像素风卡片。刻意走严格像素美学（等宽字体 + 硬像素阴影 + 直角无圆角无渐变），
// 因为这是对外传播的"品牌物"。藏品 sprite 复用现有渲染器（renderPet/Fish/Crop）→ 与游戏内完全一致。
import type { Rarity, Crop } from '@v0idchain/core/browser';
import { renderPet } from './pet-render';
import { renderFish } from './fish-render';
import { renderCrop } from './crop-render';

export type ShowcaseItem =
  | { kind: 'pet'; gene: string; rarity: Rarity; label: string }
  | { kind: 'fish'; catchHash: string; rarity: Rarity; label: string }
  | { kind: 'crop'; crop: Crop; hash: string; rarity: Rarity; label: string }
  | { kind: 'mine'; icon: string; rarity: Rarity; label: string };

export interface BragData {
  owner: string; // @昵称 或短地址
  total: number;
  rarity: Record<Rarity, number>;
  completion: { label: string; have: number; of: number }[];
  showcase: ShowcaseItem[]; // 已按稀有度降序，至多 5 件
}

const C = {
  bg: '#0c0b12',
  panel: '#161420',
  panel2: '#221f2d',
  line: '#2e2a3a',
  text: '#ece9f3',
  muted: '#9b94ad',
  accent: '#8b6dff',
};
const RGLOW: Record<Rarity, string> = { common: '#7d768e', rare: '#54a8ff', epic: '#b66bff', legendary: '#ffce3d' };
const RLABEL: Record<Rarity, string> = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' };
const MONO = '"DejaVu Sans Mono", ui-monospace, "SFMono-Regular", Menlo, "PingFang SC", monospace';

/** 离屏画一件藏品的像素 sprite（崽/鱼/作物走渲染器；矿用大字符图标）。 */
function spriteCanvas(item: ShowcaseItem, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  if (item.kind === 'pet') renderPet(c, item.gene, size);
  else if (item.kind === 'fish') renderFish(c, item.catchHash, size);
  else if (item.kind === 'crop') renderCrop(c, item.crop, item.hash, size, 3);
  else {
    c.width = c.height = size;
    const x = c.getContext('2d')!;
    x.font = `${Math.floor(size * 0.66)}px serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(item.icon, size / 2, size / 2 + 2);
  }
  return c;
}

/** 硬像素描边的矩形（直角、无圆角；可选外发光当稀有度色）。 */
function pixelBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, stroke: string, glow?: string) {
  if (glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 14;
  }
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  if (glow) ctx.restore();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

/** 画卡片到 canvas（720×940）。 */
function paint(ctx: CanvasRenderingContext2D, d: BragData) {
  const W = 720;
  const H = 940;
  ctx.imageSmoothingEnabled = false;

  // 背景 + 双层像素边框
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, W - 16, H - 16);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, W - 36, H - 36);

  // 标题
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.text;
  ctx.font = `bold 46px ${MONO}`;
  ctx.fillText('虚空图鉴', 44, 84);
  ctx.fillStyle = C.accent;
  ctx.font = `20px ${MONO}`;
  ctx.fillText('VOID  CODEX', 46, 112);
  // 主人 + 总数
  ctx.fillStyle = C.muted;
  ctx.font = `18px ${MONO}`;
  ctx.fillText(d.owner, 46, 142);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.text;
  ctx.font = `bold 40px ${MONO}`;
  ctx.fillText(String(d.total), W - 46, 96);
  ctx.fillStyle = C.muted;
  ctx.font = `15px ${MONO}`;
  ctx.fillText('链上藏品', W - 46, 120);

  let y = 174;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(44, y);
  ctx.lineTo(W - 44, y);
  ctx.stroke();

  // 稀有度统计墙（4 格）
  y += 22;
  ctx.textAlign = 'left';
  ctx.fillStyle = C.muted;
  ctx.font = `15px ${MONO}`;
  ctx.fillText('稀有度战绩 · 前导 0 比特越多越稀有', 44, y);
  y += 14;
  const order: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
  const cellW = (W - 88 - 3 * 12) / 4;
  const cellH = 84;
  order.forEach((r, i) => {
    const x = 44 + i * (cellW + 12);
    const has = d.rarity[r] > 0;
    pixelBox(ctx, x, y, cellW, cellH, C.panel2, has ? RGLOW[r] : C.line, has && r !== 'common' ? RGLOW[r] : undefined);
    ctx.textAlign = 'center';
    ctx.fillStyle = has ? RGLOW[r] : C.muted;
    ctx.font = `bold 34px ${MONO}`;
    ctx.fillText(String(d.rarity[r]), x + cellW / 2, y + 46);
    ctx.fillStyle = has ? C.text : C.muted;
    ctx.font = `15px ${MONO}`;
    ctx.fillText(RLABEL[r], x + cellW / 2, y + 70);
  });

  // 藏品墙（最稀有的几件）
  y += cellH + 30;
  ctx.textAlign = 'left';
  ctx.fillStyle = C.muted;
  ctx.font = `15px ${MONO}`;
  ctx.fillText('镇馆之宝', 44, y);
  y += 16;
  const n = Math.max(1, d.showcase.length);
  const sCellW = (W - 88 - (n - 1) * 12) / n;
  const sCellH = 188;
  const spriteSize = Math.min(120, Math.floor(sCellW - 24));
  if (d.showcase.length === 0) {
    pixelBox(ctx, 44, y, W - 88, sCellH, C.panel, C.line);
    ctx.textAlign = 'center';
    ctx.fillStyle = C.muted;
    ctx.font = `17px ${MONO}`;
    ctx.fillText('图鉴尚空 —— 去孵崽 / 钓鱼 / 收获 / 采矿，铸下第一件', W / 2, y + sCellH / 2 + 6);
  } else {
    d.showcase.forEach((item, i) => {
      const x = 44 + i * (sCellW + 12);
      pixelBox(ctx, x, y, sCellW, sCellH, C.panel, item.rarity !== 'common' ? RGLOW[item.rarity] : C.line, item.rarity !== 'common' ? RGLOW[item.rarity] : undefined);
      const sp = spriteCanvas(item, spriteSize);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sp, x + (sCellW - spriteSize) / 2, y + 16);
      ctx.textAlign = 'center';
      ctx.fillStyle = RGLOW[item.rarity];
      ctx.font = `bold 13px ${MONO}`;
      ctx.fillText(RLABEL[item.rarity], x + sCellW / 2, y + sCellH - 30);
      ctx.fillStyle = C.text;
      ctx.font = `14px ${MONO}`;
      ctx.fillText(item.label.slice(0, 6), x + sCellW / 2, y + sCellH - 12);
    });
  }

  // 收集完成度
  y += sCellH + 30;
  ctx.textAlign = 'left';
  ctx.fillStyle = C.muted;
  ctx.font = `15px ${MONO}`;
  ctx.fillText('收集完成度', 44, y);
  y += 18;
  const barW = W - 88;
  for (const c of d.completion) {
    pixelBox(ctx, 44, y, barW, 26, C.panel2, C.line);
    const frac = c.of > 0 ? c.have / c.of : 0;
    ctx.fillStyle = C.accent;
    ctx.fillRect(46, y + 2, Math.round((barW - 4) * frac), 22);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.font = `14px ${MONO}`;
    ctx.fillText(c.label, 54, y + 18);
    ctx.textAlign = 'right';
    ctx.fillText(`${c.have} / ${c.of}`, W - 54, y + 18);
    y += 34;
  }

  // 页脚
  ctx.textAlign = 'center';
  ctx.fillStyle = C.muted;
  ctx.font = `14px ${MONO}`;
  ctx.fillText('v0idchain  ·  链上可验证  ·  不可伪造  ·  零增发', W / 2, H - 34);
}

/** 生成战绩卡并触发浏览器下载。 */
export async function downloadBragCard(d: BragData): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 940;
  paint(canvas.getContext('2d')!, d);
  await new Promise<void>((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `void-codex-${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      resolve();
    }, 'image/png');
  });
}
