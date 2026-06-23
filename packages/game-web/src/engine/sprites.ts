// 程序化占位精灵（后续 Task #11 换 Kenney CC0）。全部 16px 瓦片，离屏生成 + 缓存。
// 角色用“胶囊 + 朝向眼睛 + 2 帧上下微跳”，和崽的程序化像素同一调性。
export const TILE = 16;
export type Dir = 'down' | 'up' | 'left' | 'right';

type C = HTMLCanvasElement;
function mk(w = TILE, h = TILE): [C, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

// ---- 瓦片 ----
function tile(base: string, edge: string, speckle?: string): C {
  const [c, x] = mk();
  x.fillStyle = base;
  x.fillRect(0, 0, TILE, TILE);
  x.fillStyle = edge;
  x.fillRect(0, TILE - 1, TILE, 1);
  x.fillRect(TILE - 1, 0, 1, TILE);
  if (speckle) {
    x.fillStyle = speckle;
    for (const [px, py] of [[3, 4], [10, 7], [6, 12], [13, 2]]) x.fillRect(px, py, 1, 1);
  }
  return c;
}

export interface TileSet {
  floor: C;
  floorAlt: C;
  wall: C;
  wallTop: C;
  grass: C;
  path: C;
  rug: C;
  door: C;
}
export function buildTiles(): TileSet {
  return {
    floor: tile('#6f4d31', '#5b3f28', '#7a5638'),
    floorAlt: tile('#79543a', '#5b3f28'),
    wall: tile('#37334c', '#272338'),
    wallTop: tile('#454063', '#312c49'),
    grass: tile('#3f7d4a', '#367042', '#4a8c55'),
    path: tile('#9c8b63', '#85764f', '#a89978'),
    rug: tile('#8a3f5a', '#73334a'),
    door: tile('#caa15a', '#9a7942'),
  };
}

// ---- 家具与装饰（透明底，画在格子中央）----
// 开放目录：kind 为字符串，坐标见 tileset.FURNITURE_TILES，可放清单见 FURNITURE_CATALOG。
// 程序化兜底只覆盖少数室内件；其余只走 Kenney 图集。
export type FurnitureKind = string;
function furniture(kind: FurnitureKind): C {
  const [c, x] = mk(TILE, TILE);
  const round = (px: number, py: number, w: number, h: number, fill: string) => {
    x.fillStyle = fill;
    x.fillRect(px, py, w, h);
  };
  switch (kind) {
    case 'table':
      round(2, 6, 12, 6, '#7a4a28');
      round(2, 11, 2, 4, '#5e3a20');
      round(12, 11, 2, 4, '#5e3a20');
      break;
    case 'plant':
      round(6, 9, 4, 5, '#8a5a32');
      x.fillStyle = '#3f9a55';
      x.beginPath();
      x.arc(8, 6, 5, 0, 7);
      x.fill();
      break;
    case 'bed':
      round(2, 4, 12, 10, '#c8d2e0');
      round(2, 4, 12, 3, '#e08a9a');
      round(2, 4, 4, 10, '#b0bccd');
      break;
    case 'chair':
      round(5, 6, 6, 6, '#6a4a8a');
      round(5, 4, 6, 2, '#5a3f78');
      break;
    case 'lamp':
      round(7, 6, 2, 8, '#888');
      x.fillStyle = '#ffe08a';
      x.beginPath();
      x.arc(8, 4, 3, 0, 7);
      x.fill();
      break;
    case 'pedestal':
      round(4, 9, 8, 5, '#5b5570');
      round(5, 7, 6, 2, '#6d6688');
      round(3, 13, 10, 2, '#4a4560');
      break;
    case 'rug':
      round(1, 3, 14, 10, '#8a3f5a');
      round(3, 5, 10, 6, '#a85470');
      break;
    case 'fence':
      round(0, 6, 16, 2, '#8a6840'); // 上横杆
      round(0, 10, 16, 2, '#8a6840'); // 下横杆
      round(2, 4, 2, 11, '#6b4a2c'); // 左立柱
      round(12, 4, 2, 11, '#6b4a2c'); // 右立柱
      round(2, 4, 1, 11, '#7c5836');
      break;
    case 'mailbox': // 美式信箱:木柱 + 半圆顶铁箱 + 红旗
      round(7, 8, 2, 7, '#6b4a2c'); // 立柱
      round(7, 8, 1, 7, '#7c5836'); // 柱高光
      round(4, 3, 8, 5, '#4a5a6a'); // 箱体
      round(4, 3, 8, 1, '#6a7a8a'); // 箱顶高光
      x.fillStyle = '#4a5a6a';
      x.beginPath();
      x.arc(8, 3, 4, Math.PI, 0); // 半圆顶
      x.fill();
      round(11, 4, 1, 3, '#c2462f'); // 红旗杆
      round(11, 4, 2, 2, '#d8543a'); // 红旗
      break;
  }
  return c;
}
export function buildFurniture(): Partial<Record<FurnitureKind, C>> {
  return {
    table: furniture('table'),
    plant: furniture('plant'),
    bed: furniture('bed'),
    chair: furniture('chair'),
    lamp: furniture('lamp'),
    pedestal: furniture('pedestal'),
    rug: furniture('rug'),
    fence: furniture('fence'),
    mailbox: furniture('mailbox'),
  };
}

// ---- 角色（胶囊 + 朝向眼睛 + 2 帧微跳）----
const W = TILE;
const H = 18; // 比一格略高，脚对齐格底
function drawChar(dir: Dir, frame: number, hue: number): C {
  const [c, x] = mk(W, H);
  const bob = frame === 1 ? 1 : 0;
  const top = 2 + bob;
  const shirt = `hsl(${hue} 52% 52%)`;
  const shirtD = `hsl(${hue} 52% 40%)`;
  const skin = '#f1c89f';
  const hair = '#46342a';
  // 身体
  x.fillStyle = shirtD;
  x.fillRect(3, top + 7, 10, 8);
  x.fillStyle = shirt;
  x.fillRect(4, top + 7, 8, 7);
  // 脚
  x.fillStyle = '#2e2740';
  if (frame === 0) {
    x.fillRect(4, H - 2, 3, 2);
    x.fillRect(9, H - 2, 3, 2);
  } else {
    x.fillRect(5, H - 2, 3, 2);
    x.fillRect(8, H - 2, 3, 2);
  }
  // 头
  x.fillStyle = skin;
  x.fillRect(4, top, 8, 8);
  // 头发
  x.fillStyle = hair;
  x.fillRect(4, top, 8, 3);
  if (dir === 'up') x.fillRect(4, top, 8, 7); // 背面：后脑勺一片发
  // 眼睛
  x.fillStyle = '#241c2e';
  if (dir === 'down') {
    x.fillRect(6, top + 4, 1, 2);
    x.fillRect(9, top + 4, 1, 2);
  } else if (dir === 'left') {
    x.fillRect(5, top + 4, 1, 2);
  } else if (dir === 'right') {
    x.fillRect(10, top + 4, 1, 2);
  }
  return c;
}
export type CharFrames = Record<Dir, C[]>;
export function buildCharacter(hue: number): CharFrames {
  const dirs: Dir[] = ['down', 'up', 'left', 'right'];
  const out = {} as CharFrames;
  for (const d of dirs) out[d] = [drawChar(d, 0, hue), drawChar(d, 1, hue)];
  return out;
}

/** 由地址确定性取一个色相，给玩家上不同衣服色 */
export function hueFromAddress(address: string): number {
  const h = parseInt(address.slice(2, 8), 16);
  return h % 360;
}
