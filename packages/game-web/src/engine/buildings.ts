// 程序化中世纪建筑拼装器（古代小镇风）。手绘:灰泥/石墙体 + 木骨架 + 坡瓦屋顶 + 出檐 + 遮阳棚 + 招牌 + 烟囱;
// Kenney 件:门 + 窗（坐标经 ?pick 读出）贴到手绘墙上 ⇒ 「Kenney 拼装 + 手绘部件」。
// 一栋 = w×h 瓦片;离屏按 16px/格 原生分辨率拼装一次（按签名缓存），引擎关抗锯齿放大 ⇒ 像素清晰。
import { atlasImage } from './atlas.js';
import { rampHex } from './light.js';

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

// 屋顶形状(剪影差异的主来源):坡顶 / 正面歇山三角 / 四坡梯形 / 平顶女儿墙 / A 字尖顶。
// 'auto' = 由 variant 在坡顶/歇山间确定性挑(老逻辑,商铺用);住宅各自指定一个固定形状一眼能分。
export type RoofShape = 'auto' | 'pitched' | 'gable' | 'hip' | 'flat' | 'aframe';

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
  // —— 住宅户型字段(让剪影一眼能分,不只换色) ——
  roofShape?: RoofShape; // 屋顶形状(缺省 'auto')
  porch?: string; // 前廊雨棚柱色(美式 farmhouse):门前一排柱 + 平棚
  dormer?: boolean; // 坡顶上开一扇老虎窗(阁楼 cottage)
  wing?: 'left' | 'right'; // 一侧矮耳房(L 形/ranch 车库感)
  trimColor?: string; // 门窗框/檐口描边色(美式撞色 trim);缺省取 beamColor
  shutters?: string; // 窗扇百叶色(美式);有则窗两侧画一对百叶
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
  // —— 美式/乡村住宅(户型剪影一眼能分;墙低饱和暖灰,屋顶唯一高饱和点缀色,门窗撞色 trim + 百叶) ——
  // 暖屋顶组(陶土红/赭/琥珀):
  farmhouse: { label: '前廊农舍', wall: 'timber', wallColor: '#eae3d2', beamColor: '#8a7256', roofColor: '#b6553a', door: [34, 1], window: [42, 0], roofShape: 'gable', porch: '#cdb53f', chimney: true, trimColor: '#f3ece0', shutters: '#5a7050' },
  colonial: { label: '殖民两层', wall: 'timber', wallColor: '#e6ddc8', beamColor: '#7a6450', roofColor: '#9a5a3a', door: [34, 1], window: [42, 0], roofShape: 'hip', chimney: true, trimColor: '#f0e8d6', shutters: '#3a5a78' },
  ranch: { label: '车库平房', wall: 'timber', wallColor: '#e3d6b8', beamColor: '#8a7050', roofColor: '#c08a3a', door: [34, 1], window: [42, 0], roofShape: 'pitched', wing: 'right', trimColor: '#efe7d0', shutters: '#7a4a3a' },
  brownstone: { label: '排屋', wall: 'stone', wallColor: '#c8a274', beamColor: '#9a7850', roofColor: '#7a5a44', door: [40, 7], window: [42, 2], roofShape: 'flat', trimColor: '#e8dcc4' },
  cape: { label: '海角小筑', wall: 'timber', wallColor: '#e8e0cf', beamColor: '#80684e', roofColor: '#a86a44', door: [34, 1], window: [42, 0], roofShape: 'gable', dormer: true, chimney: true, trimColor: '#f3ece0', shutters: '#8a5a4a' },
  // 冷屋顶组(青/蓝灰/苔绿):
  cottagey: { label: '阁楼小屋', wall: 'timber', wallColor: '#e4dcc4', beamColor: '#6a6a4a', roofColor: '#5a7f6a', door: [34, 1], window: [42, 0], roofShape: 'pitched', dormer: true, chimney: true, trimColor: '#eee6d2', shutters: '#4a6a5a' },
  craftsman: { label: '工匠前廊', wall: 'timber', wallColor: '#dcd0b4', beamColor: '#5a5238', roofColor: '#4f6a82', door: [34, 2], window: [42, 2], roofShape: 'pitched', porch: '#6a5238', chimney: true, trimColor: '#e8e0c8', shutters: '#3a4a58' },
  saltbox: { label: '盐盒木屋', wall: 'timber', wallColor: '#e0d8c2', beamColor: '#6a5840', roofColor: '#5a6a78', door: [34, 1], window: [42, 0], roofShape: 'gable', chimney: true, trimColor: '#ece4d0', shutters: '#4a5a4a' },
  aframe: { label: 'A字尖屋', wall: 'timber', wallColor: '#e2d6ba', beamColor: '#6a4a30', roofColor: '#4a7a6a', door: [34, 1], window: [42, 0], roofShape: 'aframe', chimney: true, trimColor: '#efe7cf' },
  bungalow: { label: '平顶小宅', wall: 'stone', wallColor: '#cfc6b0', beamColor: '#7e7660', roofColor: '#6a8a7a', door: [40, 7], window: [42, 2], roofShape: 'flat', trimColor: '#e8e0cc', shutters: '#4a6a5a' },
  // 开放式鱼摊(无墙无门):柱 + 斜条纹棚 + 冰台摆鱼。
  fishstall: { label: '鱼摊', wall: 'timber', wallColor: '#caa46a', beamColor: '#6b4a2c', roofColor: '#3f7f93', door: [0, 0], window: [0, 0], open: '#2f86b8', sign: 'fish' },
};
export type BuildingStyleId = keyof typeof BUILDING_STYLES;

/** 门所在列（居中，偶数宽取偏左）+ 烟囱列（最右），供场景做交互点/碰撞豁免/炊烟锚点。 */
export function buildingMeta(w: number): { doorCol: number; chimneyCol: number } {
  return { doorCol: Math.floor((w - 1) / 2), chimneyCol: w - 1 };
}

// hue-shift 版（§7-C / R9）：提亮偏暖、压暗偏冷，替代纯明度加减 ⇒ 建筑墙/屋顶/招牌全局通透。
const shade = rampHex;
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
  const cap = Math.max(2, Math.round(roofH * 0.22)); // 顶面厚度(cabinet 半深,薄)
  px(ctx, -over, cap, W + over * 2, roofH - cap, color); // 正面坡
  for (let y = cap + 3; y < roofH - 2; y += 3) px(ctx, -over, y, W + over * 2, 1, shade(color, -16)); // 瓦楞
  for (let x = -over + 4; x < W + over; x += 6) px(ctx, x, cap + 2, 1, roofH - cap - 4, shade(color, 8)); // 竖瓦缝
  // 顶面（受光、比正面坡更亮）+ 屋脊折线 ⇒ oblique「正面+一条顶面」体积线索（§7-E）
  px(ctx, -over, 0, W + over * 2, cap, shade(color, 20)); // 顶面厚度
  px(ctx, -over, 0, W + over * 2, 1, shade(color, 34)); // 顶面上沿高光
  px(ctx, -over, cap, W + over * 2, 1, shade(color, -34)); // 屋脊折痕(顶面↔正面)
  px(ctx, -over, roofH - 1, W + over * 2, 1, shade(color, 10)); // 檐口厚(前缘受光)
  px(ctx, -over, roofH, W + over * 2, 1, shade(color, -34)); // 檐下 AO 暗线
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
  ctx.strokeStyle = shade(color, 16); // 左坡屋脊高光
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-over, roofH);
  ctx.lineTo(W / 2, 1);
  ctx.stroke();
  // 檐口厚 + 檐下 AO（§7-E：补 oblique 体积线索，让歇山不像贴纸）
  px(ctx, -over, roofH - 2, W + over * 2, 1, shade(color, 8)); // 檐口前缘(受光薄边)
  px(ctx, -over, roofH - 1, W + over * 2, 1, shade(color, -34)); // 檐下 AO
  px(ctx, W / 2 - 2, 1, 4, 2, shade(color, 26)); // 屋脊帽厚(受光)
  px(ctx, W / 2 - 2, roofH - 8, 4, 4, shade(color, -36)); // 山墙气窗
  px(ctx, W / 2 - 1, roofH - 7, 2, 2, '#2a2a30');
}

// 四坡梯形顶(hip):上窄下宽的梯形,两侧斜坡 + 正面斜坡阴影 ⇒ 殖民风厚重剪影。
function drawHipRoof(ctx: CanvasRenderingContext2D, W: number, roofH: number, color: string) {
  const over = 3;
  const topInset = Math.round(W * 0.26); // 顶边内收量(越大越尖)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-over, roofH);
  ctx.lineTo(topInset, 1);
  ctx.lineTo(W - topInset, 1);
  ctx.lineTo(W + over, roofH);
  ctx.closePath();
  ctx.fill();
  // 两端三角坡用暗面区分(左暗右更暗 ⇒ 体积感)
  ctx.fillStyle = shade(color, -16);
  ctx.beginPath();
  ctx.moveTo(-over, roofH);
  ctx.lineTo(topInset, 1);
  ctx.lineTo(topInset, roofH);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(color, -26);
  ctx.beginPath();
  ctx.moveTo(W + over, roofH);
  ctx.lineTo(W - topInset, 1);
  ctx.lineTo(W - topInset, roofH);
  ctx.closePath();
  ctx.fill();
  for (let y = 4; y < roofH - 2; y += 3) px(ctx, topInset, y, W - topInset * 2, 1, shade(color, -14)); // 正坡瓦楞
  // 屋脊顶面（受光薄顶面 cabinet 半深）+ 折痕 + 檐口厚 + 檐下 AO（§7-E）
  px(ctx, topInset, 0, W - topInset * 2, 3, shade(color, 22)); // 顶面厚度(受光)
  px(ctx, topInset, 0, W - topInset * 2, 1, shade(color, 34)); // 顶面上沿高光
  px(ctx, topInset, 3, W - topInset * 2, 1, shade(color, -30)); // 屋脊折痕
  px(ctx, -over, roofH - 2, W + over * 2, 1, shade(color, 8)); // 檐口前缘
  px(ctx, -over, roofH - 1, W + over * 2, 1, shade(color, -34)); // 檐下 AO
}

// 平顶 + 女儿墙(parapet):矮顶带檐口与压顶线 ⇒ 排屋/平房剪影,与坡顶强烈对比。
function drawFlatRoof(ctx: CanvasRenderingContext2D, W: number, roofH: number, color: string) {
  const over = 2;
  const capH = Math.max(5, Math.round(roofH * 0.5)); // 女儿墙带高度(只占上半,露出墙体顶)
  px(ctx, -over, 0, W + over * 2, capH, color); // 压顶墙带
  // 压顶 coping 顶面（受光薄顶面 = 顶面厚度，§7-E）+ 上沿高光
  px(ctx, -over, 0, W + over * 2, 2, shade(color, 24));
  px(ctx, -over, 0, W + over * 2, 1, shade(color, 36));
  px(ctx, -over, 2, W + over * 2, 1, shade(color, -28)); // coping 折痕(顶面↔正面)
  px(ctx, -over, capH - 2, W + over * 2, 1, shade(color, -22)); // 压顶底影
  px(ctx, -over, capH - 1, W + over * 2, 1, shade(color, -34)); // 压顶底 AO
  // 檐口齿(规则小垛口,强调平顶的水平线)
  for (let x = -over; x < W + over; x += 6) px(ctx, x, 0, 3, 1, shade(color, -22));
}

// A 字尖顶(aframe):从地面直插的超陡双坡,几乎没有竖墙 ⇒ 最独特的剪影。整面屋顶高度=H 大部。
function drawAframeRoof(ctx: CanvasRenderingContext2D, W: number, H: number, color: string) {
  const over = 2;
  const baseY = H; // 坡脚直达底
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(W / 2, 1);
  ctx.lineTo(-over, baseY);
  ctx.lineTo(W + over, baseY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(color, -24); // 右坡暗面
  ctx.beginPath();
  ctx.moveTo(W / 2, 1);
  ctx.lineTo(W + over, baseY);
  ctx.lineTo(W / 2, baseY);
  ctx.closePath();
  ctx.fill();
  // 沿两坡画几道平行瓦楞线(跟随斜率)
  ctx.strokeStyle = shade(color, -14);
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const ty = 1 + (baseY - 1) * (i / 6);
    const half = (W / 2 + over) * (i / 6);
    ctx.beginPath();
    ctx.moveTo(W / 2 - half, ty);
    ctx.lineTo(W / 2 + half, ty);
    ctx.stroke();
  }
  px(ctx, W / 2 - 1, 1, 2, baseY - 1, shade(color, 12)); // 屋脊高光
}

// 坡顶上的老虎窗(dormer):正面一个带小坡顶的凸窗,改变屋顶轮廓(阁楼感)。
function drawDormer(ctx: CanvasRenderingContext2D, W: number, roofH: number, roofColor: string, trim: string) {
  const dw = 8;
  const dx = Math.round(W * 0.5 - dw / 2);
  const dyTop = Math.round(roofH * 0.32);
  const dBodyY = dyTop + 4;
  // 小坡顶
  ctx.fillStyle = shade(roofColor, -10);
  ctx.beginPath();
  ctx.moveTo(dx - 1, dBodyY);
  ctx.lineTo(dx + dw / 2, dyTop);
  ctx.lineTo(dx + dw + 1, dBodyY);
  ctx.closePath();
  ctx.fill();
  // 窗体 + 框 + 玻璃
  px(ctx, dx, dBodyY, dw, roofH - dBodyY + 1, trim);
  px(ctx, dx + 1, dBodyY + 1, dw - 2, roofH - dBodyY - 1, '#6a8aa0');
  px(ctx, dx + dw / 2 - 0, dBodyY + 1, 1, roofH - dBodyY - 1, trim); // 竖棂
}

// 前廊(porch):门前一排细柱 + 一道平棚顶,投在墙下沿之上 ⇒ 美式 farmhouse/craftsman 标志。
function drawPorch(ctx: CanvasRenderingContext2D, W: number, H: number, postColor: string) {
  const roofY = H - T - 3; // 廊顶高度(门窗带上方)
  const depth = 3;
  px(ctx, 0, roofY, W, depth, shade(postColor, 20)); // 廊顶板
  px(ctx, 0, roofY, W, 1, shade(postColor, 40)); // 顶高光
  px(ctx, 0, roofY + depth, W, 1, shade(postColor, -30)); // 顶下影
  // 立柱(均布 3~4 根,避开门居中列)
  const n = W >= 80 ? 4 : 3;
  for (let i = 0; i <= n; i++) {
    const x = Math.round((i / n) * (W - 2));
    px(ctx, x, roofY + depth, 2, H - (roofY + depth), postColor);
    px(ctx, x, roofY + depth, 1, H - (roofY + depth), shade(postColor, 22)); // 柱左高光
  }
  // 廊地台阶(底边一道)
  px(ctx, 0, H - 2, W, 2, shade(postColor, -18));
}

// 一侧矮耳房(wing):在主屋一侧贴一块矮一截的体块(自带小坡顶 + 一扇窗) ⇒ L 形/车库平房剪影。
function drawWing(ctx: CanvasRenderingContext2D, W: number, H: number, side: 'left' | 'right', wall: string, beam: string, roofColor: string, trim: string) {
  const ww = Math.round(W * 0.34); // 耳房宽
  const topY = Math.round(H * 0.42); // 耳房顶比主屋低
  const x0 = side === 'left' ? 0 : W - ww;
  // 墙体(始终带 x0 偏移的方框墙;石/木统一用浅描边面,小耳房不必复刻整墙纹理)
  const wy = topY + 5;
  px(ctx, x0, wy, ww, H - wy, wall);
  px(ctx, x0 + 1, wy + 1, ww - 2, H - wy - 1, shade(wall, 5)); // 内墙提亮
  px(ctx, x0, wy, ww, 2, beam); // 上梁
  px(ctx, x0, H - 2, ww, 2, beam); // 底梁
  px(ctx, x0, wy, 2, H - wy, beam); // 内/外柱
  px(ctx, x0 + ww - 2, wy, 2, H - wy, beam);
  // 小横坡顶(出檐)
  const rh = 7;
  px(ctx, x0 - 2, topY, ww + 4, rh, roofColor);
  for (let y = 2; y < rh - 1; y += 2) px(ctx, x0 - 2, topY + y, ww + 4, 1, shade(roofColor, -16));
  px(ctx, x0 - 2, topY, ww + 4, 1, shade(roofColor, 16));
  px(ctx, x0 - 2, topY + rh - 1, ww + 4, 1, shade(roofColor, -30));
  // 一扇车库/侧窗
  px(ctx, x0 + Math.round(ww / 2) - 4, topY + rh + 4, 8, 8, trim);
  px(ctx, x0 + Math.round(ww / 2) - 3, topY + rh + 5, 6, 6, '#6a8aa0');
  return { x0, ww }; // 供调用方避让此区域的门窗
}

// 一对窗扇百叶(美式 shutters):贴在窗左右各一片竖条。
function drawShutters(ctx: CanvasRenderingContext2D, wx: number, wy: number, color: string) {
  for (const sx of [wx - 3, wx + T - 1]) {
    px(ctx, sx, wy + 1, 3, T - 2, color);
    px(ctx, sx, wy + 1, 1, T - 2, shade(color, 16)); // 高光边
    for (let yy = wy + 2; yy < wy + T - 2; yy += 3) px(ctx, sx, yy, 3, 1, shade(color, -22)); // 百叶横纹
  }
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

  const trim = s.trimColor ?? s.beamColor;
  const { doorCol } = buildingMeta(w);

  // —— A 字尖屋:特例。坡顶几乎吃满整高,只在底部露一点墙 + 居中门 + 山墙小窗 ——
  if (s.roofShape === 'aframe') {
    const baseWallY = H - Math.round(T * 0.9);
    if (s.wall === 'stone') drawStoneWall(ctx, baseWallY, W, H - baseWallY, s.wallColor, s.beamColor);
    else drawTimberWall(ctx, baseWallY, W, H - baseWallY, s.wallColor, s.beamColor);
    drawAframeRoof(ctx, W, H, s.roofColor);
    // 山墙正面一扇大三角窗 + 居中门
    px(ctx, Math.round(W / 2) - 5, Math.round(H * 0.34), 10, Math.round(H * 0.28), trim);
    px(ctx, Math.round(W / 2) - 4, Math.round(H * 0.34) + 1, 8, Math.round(H * 0.28) - 2, '#6a8aa0');
    stamp(ctx, s.door, doorCol * T, H - T);
    if (s.chimney) drawChimney(ctx, Math.round(W * 0.78), Math.round(T * 1.0));
    cache.set(key, cv);
    return cv;
  }

  const roofH = Math.round(T * 1.35);
  const wallY = roofH - 3;
  const wallH = H - wallY;
  if (s.wall === 'stone') drawStoneWall(ctx, wallY, W, wallH, s.wallColor, s.beamColor);
  else drawTimberWall(ctx, wallY, W, wallH, s.wallColor, s.beamColor);

  // —— 一侧耳房(wing):占住一侧列范围,门窗在此让开 ——
  let wingFrom = 0;
  let wingTo = w; // 主屋开窗的列区间 [wingFrom, wingTo)
  if (s.wing) {
    const wg = drawWing(ctx, W, H, s.wing, s.wallColor, s.beamColor, s.roofColor, trim);
    const wingCols = Math.ceil(wg.ww / T);
    if (s.wing === 'left') wingFrom = wingCols;
    else wingTo = w - wingCols;
  }

  // —— 门窗布局随 variant 变化（破除千篇一律）：4 种窗列型 × 单/双层，门保持居中(与场景交互点一致) ——
  const winRow = wallY + 4;
  const lowerRow = winRow + T + 2;
  const twoFloor = h >= 5; // 高楼做两层窗
  const pat = variant % 4;
  const winAt = (c: number) =>
    pat === 0 ? c % 2 === 0 :
    pat === 1 ? c === 1 || c === w - 2 :
    pat === 2 ? c % 2 === 1 :
    c % 2 === 0 && c !== doorCol;
  for (let c = wingFrom; c < wingTo; c++) {
    if (!winAt(c)) continue;
    stamp(ctx, s.window, c * T, winRow);
    if (s.shutters) drawShutters(ctx, c * T, winRow, s.shutters);
    if (twoFloor) {
      stamp(ctx, s.window, c * T, lowerRow);
      if (s.shutters) drawShutters(ctx, c * T, lowerRow, s.shutters);
    }
  }
  stamp(ctx, s.door, doorCol * T, H - T);

  if (s.awning) drawAwning(ctx, H - T - 6, W, s.awning); // 棚在门楣上方
  if (s.porch) drawPorch(ctx, W, H, s.porch); // 前廊(柱+平棚),压在门窗带下沿

  // —— 屋顶形状分派:住宅各自固定剪影;'auto'/未指定走旧 variant 逻辑(商铺) ——
  const shape = s.roofShape ?? 'auto';
  if (shape === 'hip') drawHipRoof(ctx, W, roofH, s.roofColor);
  else if (shape === 'flat') drawFlatRoof(ctx, W, roofH, s.roofColor);
  else if (shape === 'gable') drawGableRoof(ctx, W, roofH, s.roofColor);
  else if (shape === 'pitched') drawRoof(ctx, W, roofH, s.roofColor);
  else if (Math.floor(variant / 4) % 2 === 1 && !s.awning && h >= 4) drawGableRoof(ctx, W, roofH, s.roofColor);
  else drawRoof(ctx, W, roofH, s.roofColor);
  if (s.dormer && (shape === 'pitched' || shape === 'gable' || shape === 'auto')) drawDormer(ctx, W, roofH, s.roofColor, trim);
  if (s.chimney) drawChimney(ctx, Math.round(W * 0.72), roofH);
  if (s.sign) drawSign(ctx, Math.round(W * 0.5), roofH + 1, s.sign);

  cache.set(key, cv);
  return cv;
}
