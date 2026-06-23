// 程序化动态物件（篝火/火把/灯笼/喷泉/水井/鱼…）。不依赖图集帧:用时间驱动火苗/水花/摆动,
// 每个实例带确定性相位偏移(由格子坐标算)避免整齐划一。与崽/家具同源——都是“代码画像素”。
// 约定:画在格子左上角 (cx,cy)、边长 S 的范围内;火苗/微光可向上溢出格子(故在深度排序里按 y 站位)。

export type EffectKind = 'campfire' | 'torch' | 'lantern' | 'fountain' | 'well' | 'fishHang' | 'chimneySmoke';

export interface EffectItem {
  kind: EffectKind;
  x: number;
  y: number;
}

export type EffectDrawer = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  S: number, // 格子边长(px) = scale*16
  t: number, // 秒(单调递增)
  ph: number, // 实例相位偏移(0..TAU)
) => void;

const TAU = Math.PI * 2;

/** 由格子坐标导出稳定相位,让同类实例不整齐划一。 */
export function phaseOf(x: number, y: number): number {
  return ((x * 73 + y * 31) % 1000) / 1000 * TAU;
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, TAU);
  ctx.fill();
}

/** 暖色径向光晕(篝火/灯火的根);夜间叠加层另算,这里是常驻微光。 */
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'transparent');
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// 火舌定义:由外到内(宽矮红→高橙→窄黄核)。各自频率/相位/偏移 ⇒ 不同步,看起来飘逸而非机械摆。
const FLAME_TONGUES = [
  { dx: -1.5, h: 6.2, w: 2.0, fr: 6.5, col: '#d83c17' },
  { dx: 1.3, h: 5.6, w: 1.7, fr: 8.0, col: '#e84e1b' },
  { dx: -0.2, h: 8.6, w: 1.6, fr: 9.5, col: '#ff8a1e' },
  { dx: 0.6, h: 6.6, w: 1.2, fr: 12.0, col: '#ffb733' },
  { dx: 0.0, h: 4.8, w: 0.9, fr: 15.0, col: '#ffe88a' },
];

/** 一簇飘逸火苗:多条细火舌向上舔、尖端随微风飘 curl、整簇轻倾。baseY=火根。 */
function flame(ctx: CanvasRenderingContext2D, x: number, baseY: number, u: number, t: number, ph: number, scale = 1) {
  const s = u * scale;
  const breeze = Math.sin(t * 1.1 + ph) * 1.0 * s; // 整簇随风轻倾(慢)
  for (const g of FLAME_TONGUES) {
    const lick = 0.74 + 0.26 * Math.sin(t * g.fr + ph * 1.7); // 各舌独立伸缩
    const h = g.h * s * lick;
    const w = g.w * s;
    const bx = x + g.dx * s;
    const curl = breeze + Math.sin(t * g.fr * 0.6 + ph) * 1.3 * s; // 尖端飘移/卷
    ctx.fillStyle = g.col;
    ctx.beginPath();
    ctx.moveTo(bx - w, baseY);
    // 左缘升到飘移的尖端,再右缘回落 ⇒ 收成一个尖、向上舔的细舌
    ctx.bezierCurveTo(bx - w, baseY - h * 0.5, bx + curl - w * 0.4, baseY - h * 0.85, bx + curl, baseY - h);
    ctx.bezierCurveTo(bx + curl + w * 0.4, baseY - h * 0.85, bx + w, baseY - h * 0.5, bx + w, baseY);
    ctx.closePath();
    ctx.fill();
  }
}

/** 上升的火星/灰烬,n 粒,渐隐。 */
function sparks(ctx: CanvasRenderingContext2D, x: number, baseY: number, u: number, t: number, ph: number, n = 3) {
  for (let i = 0; i < n; i++) {
    const p = (t * 0.6 + i / n + ph * 0.16) % 1;
    const sx = x + Math.sin((p + ph) * TAU) * 3 * u;
    const sy = baseY - 4 * u - p * 9 * u;
    ctx.save();
    ctx.globalAlpha = (1 - p) * 0.9;
    ctx.fillStyle = i % 2 ? '#ffd66b' : '#ff8a3d';
    const s = Math.max(1, u * 0.6);
    ctx.fillRect(sx, sy, s, s);
    ctx.restore();
  }
}

const campfire: EffectDrawer = (ctx, cx, cy, S, t, ph) => {
  const u = S / 16;
  const x = cx + S / 2;
  const baseY = cy + S * 0.72;
  glow(ctx, x, baseY - 3 * u, 10 * u, '#ff8a3d', 0.16 + 0.06 * Math.sin(t * 6 + ph));
  // 柴堆(两根交叉原木)
  ctx.fillStyle = '#5a3a22';
  ctx.save();
  ctx.translate(x, baseY);
  for (const a of [-0.5, 0.5]) {
    ctx.save();
    ctx.rotate(a);
    ctx.fillRect(-5 * u, -1.2 * u, 10 * u, 2.4 * u);
    ctx.restore();
  }
  ctx.restore();
  // 炭火
  ctx.fillStyle = '#c63a16';
  ctx.fillRect(x - 3 * u, baseY - 1.2 * u, 6 * u, 2 * u);
  flame(ctx, x, baseY - 0.5 * u, u, t, ph, 1.15);
  sparks(ctx, x, baseY, u, t, ph, 3);
};

const torch: EffectDrawer = (ctx, cx, cy, S, t, ph) => {
  const u = S / 16;
  const x = cx + S / 2;
  const topY = cy + S * 0.36;
  // 木杆
  ctx.fillStyle = '#6b4a2c';
  ctx.fillRect(x - u, topY, 2 * u, S * 0.6);
  // 缠布头
  ctx.fillStyle = '#3a2a1c';
  ctx.fillRect(x - 1.6 * u, topY - u, 3.2 * u, 2 * u);
  glow(ctx, x, topY - 2 * u, 6 * u, '#ff9d3d', 0.18 + 0.07 * Math.sin(t * 7 + ph));
  flame(ctx, x, topY - 0.5 * u, u, t, ph, 0.8);
  sparks(ctx, x, topY - u, u, t, ph, 2);
};

const lantern: EffectDrawer = (ctx, cx, cy, S, t, ph) => {
  const u = S / 16;
  const x = cx + S / 2;
  const topY = cy + S * 0.3;
  // 立柱
  ctx.fillStyle = '#3b3550';
  ctx.fillRect(x - 1.2 * u, topY, 2.4 * u, S * 0.66);
  ctx.fillRect(x - 3 * u, cy + S * 0.94, 6 * u, 1.5 * u); // 底座
  // 灯笼壳
  ctx.fillStyle = '#2b2740';
  ctx.fillRect(x - 3 * u, topY - 5 * u, 6 * u, 6 * u);
  // 灯火(脉动)
  const fl = 0.7 + 0.3 * Math.sin(t * 5 + ph);
  glow(ctx, x, topY - 2 * u, 7 * u, '#ffd27a', 0.22 * fl);
  ctx.fillStyle = `rgba(255, 219, 130, ${0.6 + 0.4 * fl})`;
  ctx.fillRect(x - 2 * u, topY - 4 * u, 4 * u, 4 * u);
  ctx.fillStyle = '#fff4cf';
  ctx.fillRect(x - 1 * u, topY - 3 * u, 2 * u, 2.4 * u);
};

const fountain: EffectDrawer = (ctx, cx, cy, S, t, ph) => {
  const u = S / 16;
  const x = cx + S / 2;
  const y = cy + S * 0.6;
  // 池壁 + 水面
  ctx.fillStyle = '#9aa3ad';
  ellipse(ctx, x, y, 7 * u, 4 * u);
  ctx.fillStyle = '#5fb0d6';
  ellipse(ctx, x, y, 6 * u, 3.2 * u);
  // 涟漪
  ctx.save();
  ctx.strokeStyle = '#cdeaf6';
  ctx.lineWidth = 1;
  for (let i = 0; i < 2; i++) {
    const p = (t * 0.5 + i / 2 + ph) % 1;
    ctx.globalAlpha = (1 - p) * 0.55;
    ctx.beginPath();
    ctx.ellipse(x, y, (1 + p * 5) * u, (0.6 + p * 2.6) * u, 0, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
  // 中柱
  ctx.fillStyle = '#b7c0c9';
  ctx.fillRect(x - 1.2 * u, y - 6 * u, 2.4 * u, 6 * u);
  // 喷涌水珠
  ctx.save();
  ctx.fillStyle = '#e3f3fb';
  for (let i = 0; i < 6; i++) {
    const p = (t * 1.1 + i / 6 + ph) % 1;
    const a = (i / 6) * TAU;
    const dx = Math.cos(a) * p * 5 * u;
    const dy = -Math.sin(p * Math.PI) * 7 * u;
    ctx.globalAlpha = 1 - p;
    ctx.fillRect(x + dx, y - 6 * u + dy, u, u);
  }
  ctx.restore();
};

const well: EffectDrawer = (ctx, cx, cy, S, t, ph) => {
  const u = S / 16;
  const x = cx + S / 2;
  const y = cy + S * 0.62;
  // 石圈
  ctx.fillStyle = '#8d8678';
  ellipse(ctx, x, y, 6 * u, 4 * u);
  ctx.fillStyle = '#34507a';
  ellipse(ctx, x, y, 4.4 * u, 2.8 * u); // 井水
  // 水面微光
  ctx.save();
  ctx.globalAlpha = 0.4 + 0.2 * Math.sin(t * 2 + ph);
  ctx.fillStyle = '#9fd0ee';
  ctx.fillRect(x - 2 * u + Math.sin(t + ph) * u, y - 0.5 * u, 3 * u, 1 * u);
  ctx.restore();
  // 立柱 + 屋顶
  ctx.fillStyle = '#5a3f28';
  ctx.fillRect(x - 5 * u, y - 9 * u, 1.6 * u, 9 * u);
  ctx.fillRect(x + 3.4 * u, y - 9 * u, 1.6 * u, 9 * u);
  ctx.fillStyle = '#7a3b2a';
  ctx.beginPath();
  ctx.moveTo(x - 7 * u, y - 8 * u);
  ctx.lineTo(x, y - 12 * u);
  ctx.lineTo(x + 7 * u, y - 8 * u);
  ctx.closePath();
  ctx.fill();
};

const fishHang: EffectDrawer = (ctx, cx, cy, S, t, ph) => {
  const u = S / 16;
  const x = cx + S / 2;
  const topY = cy + S * 0.18;
  // 挂绳
  ctx.strokeStyle = '#7a6a52';
  ctx.lineWidth = Math.max(1, u * 0.5);
  ctx.beginPath();
  ctx.moveTo(x, cy);
  ctx.lineTo(x, topY);
  ctx.stroke();
  // 鱼身(随摆尾轻晃),用相位偏移
  const sway = Math.sin(t * 2 + ph) * 0.18;
  ctx.save();
  ctx.translate(x, topY + 4 * u);
  ctx.rotate(sway);
  ctx.fillStyle = '#5aa6c4';
  ellipse(ctx, 0, 0, 5 * u, 2.6 * u);
  ctx.fillStyle = '#cfeaf3';
  ellipse(ctx, -1.5 * u, 0.6 * u, 2.4 * u, 1.3 * u); // 肚
  // 尾巴(快摆)
  const tail = Math.sin(t * 8 + ph) * 0.5;
  ctx.fillStyle = '#3f86a3';
  ctx.beginPath();
  ctx.moveTo(4.5 * u, 0);
  ctx.lineTo(8 * u, -2.4 * u + tail * 2 * u);
  ctx.lineTo(8 * u, 2.4 * u + tail * 2 * u);
  ctx.closePath();
  ctx.fill();
  // 眼
  ctx.fillStyle = '#11202a';
  ctx.fillRect(-3.4 * u, -1 * u, u, u);
  ctx.restore();
};

// 烟囱炊烟:几团灰白烟向上飘、边升边扩散变淡、左右轻摆。锚在烟囱格。
const chimneySmoke: EffectDrawer = (ctx, cx, cy, S, t, ph) => {
  const u = S / 16;
  const x = cx + S / 2;
  const baseY = cy + S * 0.5;
  ctx.save();
  ctx.fillStyle = '#d8d2c8';
  for (let i = 0; i < 4; i++) {
    const p = (t * 0.22 + i / 4 + ph * 0.1) % 1;
    const yy = baseY - p * 15 * u;
    const xx = x + Math.sin(p * 3 + ph + i) * 2.4 * u;
    const r = (1.2 + p * 2.8) * u;
    ctx.globalAlpha = (1 - p) * 0.34;
    ctx.beginPath();
    ctx.arc(xx, yy, r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
};

export const EFFECTS: Record<EffectKind, EffectDrawer> = {
  campfire,
  torch,
  lantern,
  fountain,
  well,
  fishHang,
  chimneySmoke,
};

/**
 * 水面波光:画在已铺好的水瓦片之上(在瓦片层调用)。几道随时间横向游走的高光,低透明度,
 * 各瓦片用坐标做相位偏移,整片水看起来粼粼而非死蓝。
 */
export function drawWaterShimmer(
  ctx: CanvasRenderingContext2D,
  dx: number,
  dy: number,
  S: number,
  t: number,
  tx: number,
  ty: number,
): void {
  const u = S / 16;
  const ph = phaseOf(tx, ty);
  ctx.save();
  ctx.fillStyle = '#bfe6f5';
  for (let i = 0; i < 2; i++) {
    const yy = dy + S * (0.3 + 0.4 * i) + Math.sin(t * 1.5 + ph + i) * 1.5 * u;
    const off = ((t * 6 + ph * 3 + i * 7) % 16) * u;
    ctx.globalAlpha = 0.12 + 0.06 * Math.sin(t * 2 + ph + i * 2);
    ctx.fillRect(dx + (off % (12 * u)), yy, 4 * u, Math.max(1, u));
  }
  ctx.restore();
}

/** 花/草随风轻摆:返回应绕“底部中心”施加的旋转角(弧度),供绘制时 save/rotate/restore 包裹。 */
export function swayAngle(t: number, x: number, y: number): number {
  return Math.sin(t * 1.6 + phaseOf(x, y)) * 0.1;
}
