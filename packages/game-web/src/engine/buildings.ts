// 程序化中世纪建筑拼装器（古代小镇风）。手绘:灰泥/石墙体 + 木骨架 + 坡瓦屋顶 + 出檐 + 遮阳棚 + 招牌 + 烟囱;
// Kenney 件:门 + 窗（坐标经 ?pick 读出）贴到手绘墙上 ⇒ 「Kenney 拼装 + 手绘部件」。
// 一栋 = w×h 瓦片;离屏按 16px/格 原生分辨率拼装一次（按签名缓存），引擎关抗锯齿放大 ⇒ 像素清晰。
import { atlasImage } from './atlas.js';

const T = 16; // 原生瓦片 px
const STRIDE = 17; // 图集含 1px 间距

export type WallKind = 'timber' | 'stone';
export type SignIcon = 'fish' | 'coin' | 'cart' | 'mug' | 'bread' | 'anvil' | 'potion' | 'scissors' | 'book' | 'letter' | 'cross' | 'flower' | 'wheat';

/** 场景里的一栋建筑:风格 + 左上角格 (x,y) + 占地 w×h 瓦片。 */
export interface BuildingItem {
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
  variant?: number; // 门窗排布/屋顶形状的确定性变体（破除千篇一律）
}

export interface BuildingStyle {
  label: string;
  wall: WallKind;
  wallColor: string;
  beamColor: string; // 木骨架 / 石缝色
  roofColor: string;
  door: [number, number]; // Kenney 门坐标
  window: [number, number]; // Kenney 窗坐标
  awning?: string; // 店铺遮阳棚主色;无 = 民居
  sign?: SignIcon;
  chimney?: boolean;
  open?: string; // 开放式摊位(无墙无门):值=遮阳棚主色。鱼摊等。
}

// 中世纪调色:灰泥/石墙 + 木骨架;陶土/青/石板/木屋顶。门窗坐标取自 tileset ?pick 映射。
export const BUILDING_STYLES: Record<string, BuildingStyle> = {
  house: { label: '民居', wall: 'timber', wallColor: '#e7dcc2', beamColor: '#6b4a2c', roofColor: '#b65a34', door: [32, 0], window: [40, 0], chimney: true },
  cottage: { label: '小屋', wall: 'timber', wallColor: '#dccfb0', beamColor: '#5a3f28', roofColor: '#7f8a52', door: [34, 1], window: [42, 0], chimney: true },
  house2: { label: '民居', wall: 'timber', wallColor: '#dfe0d2', beamColor: '#4a5258', roofColor: '#5a7f9a', door: [34, 1], window: [42, 0], chimney: true },
  house3: { label: '石屋', wall: 'stone', wallColor: '#c6c0b2', beamColor: '#857d6a', roofColor: '#a8703a', door: [40, 7], window: [42, 2], chimney: true },
  grocer: { label: '杂货店', wall: 'timber', wallColor: '#e9dcc0', beamColor: '#6b4a2c', roofColor: '#4f8d84', door: [32, 5], window: [40, 4], awning: '#c2462f', sign: 'cart' },
  bakery: { label: '面包房', wall: 'timber', wallColor: '#ead7b0', beamColor: '#7a5430', roofColor: '#c08a3a', door: [34, 1], window: [40, 0], awning: '#d8a23f', sign: 'bread', chimney: true },
  bank: { label: '钱庄', wall: 'stone', wallColor: '#cdc6af', beamColor: '#8a8266', roofColor: '#6a6f7a', door: [40, 7], window: [42, 2], sign: 'coin' },
  tavern: { label: '酒馆', wall: 'timber', wallColor: '#e2cda0', beamColor: '#5a3a20', roofColor: '#9a5a2f', door: [34, 1], window: [40, 0], awning: '#7a4a8a', sign: 'mug' },
  shop: { label: '店铺', wall: 'stone', wallColor: '#bcc3c0', beamColor: '#7e8a86', roofColor: '#3f7f93', door: [36, 3], window: [40, 4], awning: '#2f86b8' },
  // —— 16 风格扩充(设计自子 agent;对标 Stardew/Terraria 多样性) ——
  manor: { label: '宅院', wall: 'timber', wallColor: '#ead9b6', beamColor: '#7a5230', roofColor: '#c25a3a', door: [32, 0], window: [40, 0], chimney: true },
  slate: { label: '板岩居', wall: 'stone', wallColor: '#c2c4bd', beamColor: '#76808a', roofColor: '#4a6a82', door: [40, 7], window: [42, 2], chimney: true },
  mossy: { label: '林居', wall: 'timber', wallColor: '#d8d0b0', beamColor: '#4f5236', roofColor: '#6f8a4a', door: [34, 1], window: [40, 4], chimney: true },
  rosehouse: { label: '粉居', wall: 'timber', wallColor: '#e8c9bf', beamColor: '#8a5a4a', roofColor: '#a85a5a', door: [36, 3], window: [42, 0], chimney: true },
  tudor: { label: '木构宅', wall: 'timber', wallColor: '#efe7d2', beamColor: '#3a2a1e', roofColor: '#8a6a3a', door: [34, 2], window: [42, 2], chimney: true },
  sandstone: { label: '砂岩屋', wall: 'stone', wallColor: '#d8c9a4', beamColor: '#9a8a64', roofColor: '#b07a44', door: [34, 2], window: [42, 2] },
  smithy: { label: '铁匠铺', wall: 'stone', wallColor: '#b6ada0', beamColor: '#6a6258', roofColor: '#8a3a2f', door: [40, 7], window: [40, 4], awning: '#5a4a3a', sign: 'anvil', chimney: true },
  apothecary: { label: '药铺', wall: 'timber', wallColor: '#e3e7d6', beamColor: '#4a6650', roofColor: '#4f8a6a', door: [36, 3], window: [40, 4], awning: '#3f9a6a', sign: 'potion' },
  tailor: { label: '裁缝铺', wall: 'timber', wallColor: '#e6dcc6', beamColor: '#6a4a6a', roofColor: '#7a5a8a', door: [34, 1], window: [40, 6], awning: '#8a5aa8', sign: 'scissors' },
  bookshop: { label: '书店', wall: 'timber', wallColor: '#e0dac6', beamColor: '#3a4a6a', roofColor: '#3f5a8a', door: [40, 7], window: [42, 0], awning: '#3a5a9a', sign: 'book' },
  florist: { label: '花店', wall: 'timber', wallColor: '#e9dcc0', beamColor: '#5a6a3a', roofColor: '#7f9a52', door: [36, 3], window: [40, 6], awning: '#e08aa8', sign: 'flower' },
  inn: { label: '客栈', wall: 'timber', wallColor: '#ead2a4', beamColor: '#6a3f24', roofColor: '#b06a30', door: [32, 5], window: [40, 6], awning: '#caa23f', sign: 'mug', chimney: true },
  postoffice: { label: '邮局', wall: 'stone', wallColor: '#c6cdc8', beamColor: '#6a7a86', roofColor: '#4a7aa8', door: [40, 7], window: [42, 2], awning: '#3a6ab8', sign: 'letter' },
  chapel: { label: '教堂', wall: 'stone', wallColor: '#cdc8b8', beamColor: '#8a8270', roofColor: '#5a6a78', door: [40, 7], window: [42, 2], sign: 'cross' },
  mill: { label: '磨坊', wall: 'timber', wallColor: '#e2cfa2', beamColor: '#6b4a2c', roofColor: '#9a6a3a', door: [34, 2], window: [40, 0], sign: 'wheat', chimney: true },
  barn: { label: '谷仓', wall: 'timber', wallColor: '#b6543a', beamColor: '#e8e0cc', roofColor: '#7a4a30', door: [32, 5], window: [42, 0] },
  // 开放式鱼摊(无墙无门):柱 + 斜条纹棚 + 冰台摆鱼。
  fishstall: { label: '鱼摊', wall: 'timber', wallColor: '#caa46a', beamColor: '#6b4a2c', roofColor: '#3f7f93', door: [0, 0], window: [0, 0], open: '#2f86b8', sign: 'fish' },
};
export type BuildingStyleId = keyof typeof BUILDING_STYLES;

/** 门所在列（居中，偶数宽取偏左）+ 烟囱列（最右），供场景做交互点/碰撞豁免/炊烟锚点。 */
export function buildingMeta(w: number): { doorCol: number; chimneyCol: number } {
  return { doorCol: Math.floor((w - 1) / 2), chimneyCol: w - 1 };
}

function shade(hex: string, d: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + d));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
}
function stamp(ctx: CanvasRenderingContext2D, coord: [number, number], dx: number, dy: number) {
  const img = atlasImage();
  if (img) ctx.drawImage(img, coord[0] * STRIDE, coord[1] * STRIDE, T, T, dx, dy, T, T);
}

// 灰泥 + 木骨架墙（Tudor 风:角柱 + 上中下横梁 + 斜撑）。
function drawTimberWall(ctx: CanvasRenderingContext2D, y0: number, W: number, H: number, wall: string, beam: string) {
  px(ctx, 0, y0, W, H, wall);
  px(ctx, 1, y0 + 1, W - 2, H - 1, shade(wall, 6)); // 内墙提亮一点
  const b = 2;
  px(ctx, 0, y0, b, H, beam); // 左柱
  px(ctx, W - b, y0, b, H, beam); // 右柱
  px(ctx, 0, y0, W, b, beam); // 上梁
  px(ctx, 0, y0 + H - b, W, b, beam); // 底梁
  const mid = y0 + Math.floor(H * 0.46);
  px(ctx, 0, mid, W, b, beam); // 中梁
  // 斜撑(下半墙,左右各一)
  const steps = Math.floor(H * 0.4);
  for (let i = 0; i < steps; i++) {
    const yy = mid + b + i;
    if (yy > y0 + H - b) break;
    px(ctx, b + Math.floor((i / steps) * (W * 0.32)), yy, b, 1, beam);
    px(ctx, W - b - Math.floor((i / steps) * (W * 0.32)), yy, b, 1, beam);
  }
}

// 错缝石墙。
function drawStoneWall(ctx: CanvasRenderingContext2D, y0: number, W: number, H: number, wall: string, seam: string) {
  px(ctx, 0, y0, W, H, wall);
  for (let ry = y0 + 4; ry < y0 + H; ry += 4) {
    px(ctx, 0, ry, W, 1, seam); // 横缝
    const off = (((ry - y0) / 4) % 2) * 4;
    for (let rx = off; rx < W; rx += 8) px(ctx, rx, ry - 3, 1, 3, shade(seam, 8)); // 错位竖缝
  }
  px(ctx, 0, y0, W, 1, shade(wall, 16)); // 顶高光
}

// 坡瓦屋顶（横向出檐 + 瓦楞 + 屋脊 + 檐影），盖住墙顶。
function drawRoof(ctx: CanvasRenderingContext2D, W: number, roofH: number, color: string) {
  const over = 3; // 出檐
  px(ctx, -over, 0, W + over * 2, roofH, color);
  for (let y = 3; y < roofH - 2; y += 3) px(ctx, -over, y, W + over * 2, 1, shade(color, -16)); // 瓦楞
  for (let x = -over + 4; x < W + over; x += 6) px(ctx, x, 2, 1, roofH - 4, shade(color, 8)); // 竖瓦缝
  px(ctx, -over, 0, W + over * 2, 2, shade(color, -38)); // 屋脊
  px(ctx, -over, roofH - 2, W + over * 2, 2, shade(color, -28)); // 檐影
}

// 条纹遮阳棚（店铺），扇贝下沿。
function drawAwning(ctx: CanvasRenderingContext2D, y: number, W: number, color: string) {
  const h = 5;
  for (let x = 0; x < W; x += 4) px(ctx, x, y, 2, h, color); // 主色竖条
  for (let x = 2; x < W; x += 4) px(ctx, x, y, 2, h, '#f3ece0'); // 白条
  for (let x = 0; x < W; x += 4) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + 2, y + h + 2);
    ctx.lineTo(x + 4, y + h);
    ctx.closePath();
    ctx.fill();
  }
  px(ctx, 0, y, W, 1, shade(color, 24)); // 顶高光
}

// 挂牌 + 图标（鱼铺/钱庄/杂货/酒馆/面包）。
function drawSign(ctx: CanvasRenderingContext2D, cx: number, y: number, icon: SignIcon) {
  px(ctx, cx - 1, y - 3, 2, 3, '#3a2a1c'); // 吊挂
  px(ctx, cx - 7, y, 14, 9, '#6b4a2c'); // 木牌
  px(ctx, cx - 6, y + 1, 12, 7, '#8a6038');
  const ix = cx;
  const iy = y + 4;
  if (icon === 'fish') {
    ctx.fillStyle = '#6fc3dd';
    ctx.beginPath();
    ctx.ellipse(ix - 1, iy, 4, 2.4, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#3f86a3';
    ctx.beginPath();
    ctx.moveTo(ix + 2, iy);
    ctx.lineTo(ix + 5, iy - 2);
    ctx.lineTo(ix + 5, iy + 2);
    ctx.closePath();
    ctx.fill();
    px(ctx, ix - 3, iy - 1, 1, 1, '#11202a');
  } else if (icon === 'coin') {
    ctx.fillStyle = '#f2c63a';
    ctx.beginPath();
    ctx.arc(ix, iy, 3.4, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#b8902a';
    px(ctx, ix - 1, iy - 2, 2, 1, '#b8902a');
    px(ctx, ix - 1, iy + 1, 2, 1, '#b8902a');
    px(ctx, ix - 0.5, iy - 2, 1, 4, '#b8902a');
  } else if (icon === 'cart') {
    px(ctx, ix - 4, iy - 2, 8, 4, '#9a6a3a');
    px(ctx, ix - 3, iy + 2, 2, 2, '#3a2a1c');
    px(ctx, ix + 1, iy + 2, 2, 2, '#3a2a1c');
  } else if (icon === 'mug') {
    px(ctx, ix - 3, iy - 2, 6, 5, '#c89a5a');
    px(ctx, ix - 3, iy - 3, 6, 1, '#f3ece0'); // 泡沫
    px(ctx, ix + 3, iy - 1, 2, 2, '#c89a5a'); // 把手
  } else if (icon === 'bread') {
    ctx.fillStyle = '#c98a48';
    ctx.beginPath();
    ctx.ellipse(ix, iy, 4, 2.6, 0, 0, 7);
    ctx.fill();
    px(ctx, ix - 2, iy - 1, 1, 2, '#8a5a28');
    px(ctx, ix + 1, iy - 1, 1, 2, '#8a5a28');
  } else if (icon === 'anvil') {
    px(ctx, ix - 4, iy - 2, 8, 2, '#5a5a64');
    px(ctx, ix - 1, iy, 3, 2, '#44444c');
    px(ctx, ix - 3, iy + 2, 6, 2, '#3a3a42');
    px(ctx, ix - 6, iy - 2, 2, 2, '#5a5a64');
    px(ctx, ix - 3, iy - 2, 2, 1, '#8a8a94');
  } else if (icon === 'potion') {
    px(ctx, ix - 2, iy - 1, 4, 4, '#4fae7a');
    px(ctx, ix - 1, iy - 3, 2, 2, '#cfe0d0');
    px(ctx, ix - 1, iy - 4, 2, 1, '#8a5a3a');
    px(ctx, ix - 1, iy, 1, 2, '#9ad8b4');
  } else if (icon === 'scissors') {
    for (let k = 0; k < 3; k++) { px(ctx, ix - 3 + k, iy - 3 + k, 1, 1, '#c0c4cc'); px(ctx, ix + 2 - k, iy - 3 + k, 1, 1, '#c0c4cc'); }
    px(ctx, ix - 1, iy, 2, 1, '#7a7a82');
    px(ctx, ix - 3, iy + 1, 2, 2, '#d8a23f');
    px(ctx, ix + 1, iy + 1, 2, 2, '#d8a23f');
  } else if (icon === 'book') {
    px(ctx, ix - 4, iy - 3, 2, 6, '#9a3a3a');
    px(ctx, ix - 2, iy - 3, 6, 6, '#f3ece0');
    px(ctx, ix - 1, iy - 1, 4, 1, '#c0b8a4');
    px(ctx, ix - 1, iy + 1, 4, 1, '#c0b8a4');
    px(ctx, ix, iy - 3, 1, 6, '#c8b8a0');
  } else if (icon === 'letter') {
    px(ctx, ix - 4, iy - 2, 8, 5, '#f3ece0');
    ctx.fillStyle = '#d8cfbc';
    ctx.beginPath();
    ctx.moveTo(ix - 4, iy - 2);
    ctx.lineTo(ix, iy + 1);
    ctx.lineTo(ix + 4, iy - 2);
    ctx.closePath();
    ctx.fill();
    px(ctx, ix, iy, 1, 1, '#b83a3a');
    px(ctx, ix - 4, iy - 2, 8, 1, '#c0b8a4');
  } else if (icon === 'cross') {
    px(ctx, ix - 1, iy - 4, 2, 8, '#e8e0cc');
    px(ctx, ix - 3, iy - 1, 6, 2, '#e8e0cc');
  } else if (icon === 'flower') {
    px(ctx, ix - 1, iy - 1, 2, 2, '#f2c63a');
    px(ctx, ix - 1, iy - 3, 2, 2, '#e07aa8');
    px(ctx, ix - 1, iy + 1, 2, 2, '#e07aa8');
    px(ctx, ix - 3, iy - 1, 2, 2, '#e07aa8');
    px(ctx, ix + 1, iy - 1, 2, 2, '#e07aa8');
    px(ctx, ix, iy + 3, 1, 2, '#4a8a4a');
  } else if (icon === 'wheat') {
    px(ctx, ix, iy - 4, 1, 8, '#b08a3a');
    for (let k = 0; k < 4; k++) { px(ctx, ix - 2, iy - 3 + k * 2, 2, 1, '#d8a23f'); px(ctx, ix + 1, iy - 3 + k * 2, 2, 1, '#d8a23f'); }
    px(ctx, ix, iy - 5, 1, 1, '#e8c86a');
  }
}

function drawChimney(ctx: CanvasRenderingContext2D, x: number, roofH: number) {
  px(ctx, x, roofH - 9, 5, 9, '#8a4a3a');
  px(ctx, x, roofH - 9, 5, 1, '#5a2f26');
  px(ctx, x - 1, roofH - 10, 7, 2, '#6a3a2a'); // 帽檐
}

// 开放式摊位（鱼摊）：四柱 + 斜条纹棚 + 前台冰床摆鱼。无墙无门。
function drawStall(ctx: CanvasRenderingContext2D, W: number, H: number, color: string) {
  const pw = 3;
  const postY = 12;
  for (const x of [2, W - 2 - pw]) {
    px(ctx, x, postY, pw, H - postY - 2, '#6b4a2c');
    px(ctx, x, postY, 1, H - postY - 2, '#8a6038');
  }
  // 斜条纹棚 + 扇贝下沿
  const ah = 10;
  for (let x = 0; x < W; x += 4) px(ctx, x, 2, 2, ah, color);
  for (let x = 2; x < W; x += 4) px(ctx, x, 2, 2, ah, '#f3ece0');
  for (let x = 0; x < W; x += 4) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, 2 + ah);
    ctx.lineTo(x + 2, 2 + ah + 2);
    ctx.lineTo(x + 4, 2 + ah);
    ctx.closePath();
    ctx.fill();
  }
  px(ctx, 0, 2, W, 1, shade(color, 24));
  // 前台木桌 + 冰床
  const cy = H - 12;
  px(ctx, 1, cy, W - 2, 10, '#9a6a3a');
  px(ctx, 1, cy, W - 2, 2, '#b5824a');
  px(ctx, 1, cy + 8, W - 2, 2, '#6b4524');
  px(ctx, 3, cy + 1, W - 6, 5, '#cfe6ef'); // 冰
  for (let i = 0; i * 9 < W - 8; i++) px(ctx, 4 + i * 9, cy + 2, 2, 2, '#eaf6fb');
  // 鱼几条
  for (let i = 0; i < 3; i++) {
    const fx = 11 + i * 17;
    const fy = cy + 3;
    const col = i === 1 ? '#d98a4a' : '#6fb0cf';
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(fx, fy, 5, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade(col, -34);
    ctx.beginPath();
    ctx.moveTo(fx + 4, fy);
    ctx.lineTo(fx + 7, fy - 2);
    ctx.lineTo(fx + 7, fy + 2);
    ctx.closePath();
    ctx.fill();
    px(ctx, fx - 3, fy - 1, 1, 1, '#11202a');
  }
}

// 正面歇山三角顶（改变剪影；峰在中顶 + 山墙小气窗）。
function drawGableRoof(ctx: CanvasRenderingContext2D, W: number, roofH: number, color: string) {
  const over = 3;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-over, roofH);
  ctx.lineTo(W / 2, 1);
  ctx.lineTo(W + over, roofH);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(color, -24); // 右坡暗面
  ctx.beginPath();
  ctx.moveTo(W / 2, 1);
  ctx.lineTo(W + over, roofH);
  ctx.lineTo(W / 2, roofH);
  ctx.closePath();
  ctx.fill();
  px(ctx, -over, roofH - 2, W + over * 2, 2, shade(color, -32)); // 檐影
  ctx.strokeStyle = shade(color, 16); // 左坡屋脊高光
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-over, roofH);
  ctx.lineTo(W / 2, 1);
  ctx.stroke();
  px(ctx, W / 2 - 2, roofH - 8, 4, 4, shade(color, -36)); // 山墙气窗
  px(ctx, W / 2 - 1, roofH - 7, 2, 2, '#2a2a30');
}

const cache = new Map<string, HTMLCanvasElement>();

/** 拼装某风格 w×h 建筑（按签名缓存）。门/窗需图集就绪;未就绪先出无门窗版,图集到位后自然重拼。 */
export function buildingCanvas(styleId: string, w: number, h: number, variant = 0): HTMLCanvasElement {
  const ready = atlasImage() !== null;
  const key = `${styleId}-${w}x${h}-${variant}-${ready ? 1 : 0}`;
  const hit = cache.get(`${styleId}-${w}x${h}-${variant}-1`);
  if (hit) return hit; // 已有就绪版直接用
  const cached = cache.get(key);
  if (cached) return cached;

  const s = BUILDING_STYLES[styleId] ?? BUILDING_STYLES.house;
  const W = w * T;
  const H = h * T;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  if (s.open) {
    drawStall(ctx, W, H, s.open);
    if (s.sign) drawSign(ctx, Math.round(W * 0.5), 12, s.sign);
    cache.set(key, cv);
    return cv;
  }

  const roofH = Math.round(T * 1.35);
  const wallY = roofH - 3;
  const wallH = H - wallY;
  if (s.wall === 'stone') drawStoneWall(ctx, wallY, W, wallH, s.wallColor, s.beamColor);
  else drawTimberWall(ctx, wallY, W, wallH, s.wallColor, s.beamColor);

  // —— 门窗布局随 variant 变化（破除千篇一律）：4 种窗列型 × 单/双层，门保持居中(与场景交互点一致) ——
  const { doorCol } = buildingMeta(w);
  const winRow = wallY + 4;
  const lowerRow = winRow + T + 2;
  const twoFloor = h >= 5; // 高楼做两层窗
  const pat = variant % 4;
  const winAt = (c: number) =>
    pat === 0 ? c % 2 === 0 :
    pat === 1 ? c === 1 || c === w - 2 :
    pat === 2 ? c % 2 === 1 :
    c % 2 === 0 && c !== doorCol;
  for (let c = 0; c < w; c++) {
    if (!winAt(c)) continue;
    stamp(ctx, s.window, c * T, winRow);
    if (twoFloor) stamp(ctx, s.window, c * T, lowerRow);
  }
  stamp(ctx, s.door, doorCol * T, H - T);

  if (s.awning) drawAwning(ctx, H - T - 6, W, s.awning); // 棚在门楣上方
  // 屋顶形状随 variant：约半数(非店铺、够高)用正面歇山三角，改变剪影
  if (Math.floor(variant / 4) % 2 === 1 && !s.awning && h >= 4) drawGableRoof(ctx, W, roofH, s.roofColor);
  else drawRoof(ctx, W, roofH, s.roofColor);
  if (s.chimney) drawChimney(ctx, Math.round(W * 0.72), roofH);
  if (s.sign) drawSign(ctx, Math.round(W * 0.5), roofH + 1, s.sign);

  cache.set(key, cv);
  return cv;
}
