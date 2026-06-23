// NPC 主题房间：每种建筑风格对应一套确定性室内布局。
// 尺寸 20×14（16px*3缩放=960×672px，单屏可见）。门在底墙 x=DOOR_X=10。
// 三种户型模板：
//   interior — 全通矩形（商业/展示空间）
//   lshape   — 右上角裁去 cutW×cutH（L 形工坊/专卖店；cx0=W-cutW=12）
//   split    — 水平隔墙 y=6~7 + 开口 x=DOOR_X（前厅 y=8..12 / 后室 y=1..5）
import type { Scene, FurnitureItem, Interactable } from './scene.js';
import type { EffectItem } from './effects.js';
import { ROOM_THEMES, type RoomThemeId } from './tileset.js';

const W = 20;
const H = 14;
const DOOR_X = 10;
const WALKABLE = new Set(['rug', 'flower', 'window']);

// ── 基础矩形室内 ──
function interior(
  theme: RoomThemeId,
  furniture: FurnitureItem[],
  effects: EffectItem[] = [],
  extras: Interactable[] = [],
): Scene {
  const th = ROOM_THEMES[theme];
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < H; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < W; x++) {
      let t = th.floor;
      let s = false;
      if (y === 0) { t = th.wallTop; s = true; }
      else if (y === H - 1) { if (x !== DOOR_X) { t = th.wall; s = true; } }
      else if (x === 0 || x === W - 1) { t = th.wall; s = true; }
      tiles[y][x] = t;
      solid[y][x] = s;
    }
  }
  for (const f of furniture) if (!WALKABLE.has(f.kind) && solid[f.y]?.[f.x] !== undefined) solid[f.y][f.x] = true;
  for (const e of effects) if (solid[e.y]?.[e.x] !== undefined) solid[e.y][e.x] = true;
  return {
    id: 'npc', w: W, h: H, tiles, solid,
    furniture, effects, buildings: [],
    interactables: [
      { x: DOOR_X, y: H - 1, type: 'door', label: '出门', target: 'town' },
      ...extras,
    ],
    spawn: { x: DOOR_X, y: H - 3 },
  };
}

// ── L 形：右上角 cutW×cutH 裁去，cx0=W-cutW ──
function lshape(
  theme: RoomThemeId,
  furniture: FurnitureItem[],
  effects: EffectItem[] = [],
  extras: Interactable[] = [],
  cutW = 8, cutH = 7,
): Scene {
  const sc = interior(theme, furniture, effects, extras);
  const th = ROOM_THEMES[theme];
  const cx0 = W - cutW;
  for (let y = 0; y < cutH; y++) {
    for (let x = cx0; x < W; x++) {
      sc.tiles[y][x] = (x === cx0 || y === cutH - 1) ? th.wallTop : th.wall;
      sc.solid[y][x] = true;
    }
  }
  for (let y = 0; y < cutH; y++) { sc.tiles[y][cx0] = th.wallTop; sc.solid[y][cx0] = true; }
  return sc;
}

// ── 前后两室：y=6~7 处横墙，x=DOOR_X 留过道 ──
function split(
  theme: RoomThemeId,
  frontFurniture: FurnitureItem[],
  backFurniture: FurnitureItem[],
  effects: EffectItem[] = [],
  extras: Interactable[] = [],
): Scene {
  const all = [...frontFurniture, ...backFurniture];
  const sc = interior(theme, all, effects, extras);
  const th = ROOM_THEMES[theme];
  const wallY = 7;
  for (let x = 1; x < W - 1; x++) {
    if (x === DOOR_X) continue;
    sc.tiles[wallY][x] = th.wall;
    sc.solid[wallY][x] = true;
    sc.tiles[wallY - 1][x] = th.wallTop;
    sc.solid[wallY - 1][x] = true;
  }
  return sc;
}

// ─────────────── 各房间布局 ───────────────

const LAYOUTS: Record<string, () => Scene> = {

  // ── 面包坊：3 炉台 + 2 排桌椅 + 前台书架 ──
  bakery: () => interior('cozy', [
    { kind: 'stove', x: 2, y: 2 }, { kind: 'stove', x: 3, y: 2 }, { kind: 'stove', x: 4, y: 2 },
    { kind: 'stove', x: 14, y: 2 }, { kind: 'stove', x: 15, y: 2 },
    { kind: 'table', x: 6, y: 4 }, { kind: 'table', x: 7, y: 4 },
    { kind: 'table', x: 11, y: 4 }, { kind: 'table', x: 12, y: 4 },
    { kind: 'chair', x: 5, y: 4 }, { kind: 'chair', x: 8, y: 4 },
    { kind: 'chair', x: 10, y: 4 }, { kind: 'chair', x: 13, y: 4 },
    { kind: 'crate', x: 2, y: 6 }, { kind: 'crate', x: 3, y: 6 }, { kind: 'barrel', x: 4, y: 6 },
    { kind: 'crate', x: 15, y: 6 }, { kind: 'barrel', x: 16, y: 6 },
    { kind: 'table', x: 6, y: 9 }, { kind: 'table', x: 7, y: 9 },
    { kind: 'table', x: 11, y: 9 }, { kind: 'table', x: 12, y: 9 },
    { kind: 'chair', x: 5, y: 9 }, { kind: 'chair', x: 8, y: 9 },
    { kind: 'chair', x: 10, y: 9 }, { kind: 'chair', x: 13, y: 9 },
    { kind: 'rug', x: 8, y: 11 }, { kind: 'rug', x: 9, y: 11 },
    { kind: 'rug', x: 10, y: 11 }, { kind: 'rug', x: 11, y: 11 },
    { kind: 'bookshelf', x: 15, y: 7 }, { kind: 'bookshelf', x: 16, y: 7 },
    { kind: 'plant', x: 2, y: 11 }, { kind: 'plant', x: 17, y: 11 },
    { kind: 'lamp', x: 17, y: 4 }, { kind: 'lamp', x: 2, y: 9 },
  ], [
    { kind: 'campfire', x: 13, y: 4 },
    { kind: 'lantern', x: 9, y: 3 }, { kind: 'lantern', x: 9, y: 7 },
  ]),

  // ── 铁匠铺：L 形，左区锻造间 + 下区工作台 ──
  smithy: () => lshape('stone', [
    { kind: 'dresser', x: 2, y: 2 }, { kind: 'dresser', x: 3, y: 2 }, { kind: 'dresser', x: 4, y: 2 },
    { kind: 'crate', x: 2, y: 5 }, { kind: 'crate', x: 3, y: 5 }, { kind: 'barrel', x: 4, y: 5 },
    { kind: 'chest', x: 8, y: 5 }, { kind: 'chest', x: 9, y: 5 },
    { kind: 'barrel', x: 12, y: 7 }, { kind: 'barrel', x: 13, y: 7 }, { kind: 'crate', x: 14, y: 7 },
    { kind: 'table', x: 6, y: 9 }, { kind: 'table', x: 7, y: 9 }, { kind: 'table', x: 8, y: 9 },
    { kind: 'chair', x: 5, y: 9 }, { kind: 'chair', x: 9, y: 9 },
    { kind: 'rug', x: 7, y: 11 }, { kind: 'rug', x: 8, y: 11 }, { kind: 'rug', x: 9, y: 11 },
    { kind: 'lamp', x: 2, y: 11 }, { kind: 'lamp', x: 17, y: 11 },
  ], [
    { kind: 'campfire', x: 6, y: 3 }, { kind: 'campfire', x: 9, y: 3 },
    { kind: 'torch', x: 5, y: 2 }, { kind: 'torch', x: 10, y: 2 },
    { kind: 'torch', x: 5, y: 6 }, { kind: 'torch', x: 10, y: 6 },
  ], [], 8, 7),

  // ── 酒馆：3 列双桌 × 2 排 + 壁炉角 ──
  tavern: () => interior('wood', [
    { kind: 'barrel', x: 2, y: 2 }, { kind: 'barrel', x: 3, y: 2 }, { kind: 'barrel', x: 4, y: 2 },
    { kind: 'barrel', x: 14, y: 2 }, { kind: 'barrel', x: 15, y: 2 }, { kind: 'barrel', x: 16, y: 2 },
    { kind: 'table', x: 5, y: 5 }, { kind: 'table', x: 6, y: 5 },
    { kind: 'chair', x: 4, y: 5 }, { kind: 'chair', x: 7, y: 5 },
    { kind: 'table', x: 9, y: 5 }, { kind: 'table', x: 10, y: 5 },
    { kind: 'chair', x: 8, y: 5 }, { kind: 'chair', x: 11, y: 5 },
    { kind: 'table', x: 13, y: 5 }, { kind: 'table', x: 14, y: 5 },
    { kind: 'chair', x: 12, y: 5 }, { kind: 'chair', x: 15, y: 5 },
    { kind: 'table', x: 5, y: 9 }, { kind: 'table', x: 6, y: 9 },
    { kind: 'chair', x: 4, y: 9 }, { kind: 'chair', x: 7, y: 9 },
    { kind: 'table', x: 9, y: 9 }, { kind: 'table', x: 10, y: 9 },
    { kind: 'chair', x: 8, y: 9 }, { kind: 'chair', x: 11, y: 9 },
    { kind: 'table', x: 13, y: 9 }, { kind: 'table', x: 14, y: 9 },
    { kind: 'chair', x: 12, y: 9 }, { kind: 'chair', x: 15, y: 9 },
    { kind: 'sofa', x: 2, y: 11 }, { kind: 'sofa', x: 3, y: 11 }, { kind: 'table', x: 5, y: 11 },
    { kind: 'rug', x: 9, y: 11 }, { kind: 'rug', x: 10, y: 11 }, { kind: 'rug', x: 11, y: 11 },
    { kind: 'candelabra', x: 17, y: 2 }, { kind: 'candelabra', x: 17, y: 9 },
    { kind: 'clock', x: 10, y: 1 },
  ], [
    { kind: 'campfire', x: 16, y: 9 },
    { kind: 'lantern', x: 7, y: 3 }, { kind: 'lantern', x: 12, y: 3 },
  ]),

  // ── 杂货铺：前展示架 + 后仓储 ──
  grocer: () => split('wood', [
    // 前厅（y=8..12）：货架陈列
    { kind: 'bookshelf', x: 2, y: 9 }, { kind: 'bookshelf', x: 3, y: 9 },
    { kind: 'bookshelf', x: 15, y: 9 }, { kind: 'bookshelf', x: 16, y: 9 },
    { kind: 'bookshelf', x: 2, y: 11 }, { kind: 'bookshelf', x: 3, y: 11 },
    { kind: 'bookshelf', x: 15, y: 11 }, { kind: 'bookshelf', x: 16, y: 11 },
    { kind: 'table', x: 7, y: 9 }, { kind: 'table', x: 8, y: 9 },
    { kind: 'table', x: 11, y: 9 }, { kind: 'table', x: 12, y: 9 },
    { kind: 'plant', x: 2, y: 12 }, { kind: 'plant', x: 17, y: 12 },
    { kind: 'rug', x: 8, y: 11 }, { kind: 'rug', x: 9, y: 11 },
    { kind: 'rug', x: 10, y: 11 }, { kind: 'rug', x: 11, y: 11 },
  ], [
    // 后室（y=1..5）：仓储
    { kind: 'crate', x: 2, y: 2 }, { kind: 'crate', x: 3, y: 2 }, { kind: 'crate', x: 4, y: 2 },
    { kind: 'crate', x: 14, y: 2 }, { kind: 'crate', x: 15, y: 2 }, { kind: 'crate', x: 16, y: 2 },
    { kind: 'barrel', x: 5, y: 2 }, { kind: 'barrel', x: 13, y: 2 },
    { kind: 'barrel', x: 2, y: 4 }, { kind: 'barrel', x: 3, y: 4 },
    { kind: 'dresser', x: 9, y: 3 }, { kind: 'dresser', x: 10, y: 3 }, { kind: 'dresser', x: 11, y: 3 },
  ], [
    { kind: 'lantern', x: 10, y: 4 },
    { kind: 'lantern', x: 6, y: 10 }, { kind: 'lantern', x: 13, y: 10 },
  ]),

  // ── 旅馆：后室 6 张床 + 前厅沙发休息区 ──
  inn: () => split('wood', [
    // 前厅（y=8..12）
    { kind: 'sofa', x: 2, y: 9 }, { kind: 'sofa', x: 3, y: 9 },
    { kind: 'table', x: 5, y: 10 }, { kind: 'chair', x: 4, y: 10 }, { kind: 'chair', x: 6, y: 10 },
    { kind: 'rug', x: 8, y: 9 }, { kind: 'rug', x: 9, y: 9 }, { kind: 'rug', x: 10, y: 9 }, { kind: 'rug', x: 11, y: 9 },
    { kind: 'rug', x: 8, y: 10 }, { kind: 'rug', x: 9, y: 10 }, { kind: 'rug', x: 10, y: 10 }, { kind: 'rug', x: 11, y: 10 },
    { kind: 'lamp', x: 17, y: 9 }, { kind: 'clock', x: 10, y: 8 }, { kind: 'plant', x: 17, y: 11 },
  ], [
    // 后室（y=1..5）：3 × 2 床位
    { kind: 'bed', x: 3, y: 2 }, { kind: 'dresser', x: 2, y: 2 },
    { kind: 'bed', x: 9, y: 2 }, { kind: 'dresser', x: 8, y: 2 },
    { kind: 'bed', x: 15, y: 2 }, { kind: 'dresser', x: 14, y: 2 },
    { kind: 'bedGreen', x: 3, y: 4 }, { kind: 'dresser', x: 2, y: 4 },
    { kind: 'bedGreen', x: 9, y: 4 }, { kind: 'dresser', x: 8, y: 4 },
    { kind: 'bedGreen', x: 15, y: 4 }, { kind: 'dresser', x: 14, y: 4 },
  ], [
    { kind: 'torch', x: 2, y: 5 }, { kind: 'torch', x: 17, y: 5 },
    { kind: 'lantern', x: 10, y: 3 },
  ]),

  // ── 书店：L 形，顶排书架 + 阅读区 + 沙发角 ──
  bookshop: () => lshape('wood', [
    { kind: 'bookshelf', x: 2, y: 2 }, { kind: 'bookshelf', x: 3, y: 2 }, { kind: 'bookshelf', x: 4, y: 2 },
    { kind: 'bookshelf', x: 5, y: 2 }, { kind: 'bookshelf', x: 6, y: 2 }, { kind: 'bookshelf', x: 7, y: 2 },
    { kind: 'bookshelf', x: 8, y: 2 }, { kind: 'bookshelf', x: 9, y: 2 }, { kind: 'bookshelf', x: 10, y: 2 },
    { kind: 'bookshelf', x: 2, y: 4 }, { kind: 'bookshelf', x: 2, y: 5 }, { kind: 'bookshelf', x: 2, y: 6 },
    { kind: 'table', x: 5, y: 9 }, { kind: 'table', x: 6, y: 9 },
    { kind: 'chair', x: 4, y: 9 }, { kind: 'chair', x: 7, y: 9 },
    { kind: 'table', x: 10, y: 9 }, { kind: 'table', x: 11, y: 9 },
    { kind: 'chair', x: 9, y: 9 }, { kind: 'chair', x: 12, y: 9 },
    { kind: 'sofa', x: 2, y: 11 }, { kind: 'sofa', x: 3, y: 11 }, { kind: 'table', x: 5, y: 11 },
    { kind: 'rug', x: 7, y: 10 }, { kind: 'rug', x: 8, y: 10 }, { kind: 'rug', x: 9, y: 10 }, { kind: 'rug', x: 10, y: 10 },
    { kind: 'rug', x: 7, y: 11 }, { kind: 'rug', x: 8, y: 11 }, { kind: 'rug', x: 9, y: 11 }, { kind: 'rug', x: 10, y: 11 },
    { kind: 'clock', x: 2, y: 7 }, { kind: 'lamp', x: 12, y: 9 }, { kind: 'plant', x: 12, y: 11 },
  ], [
    { kind: 'lantern', x: 6, y: 4 }, { kind: 'lantern', x: 6, y: 9 },
  ]),

  // ── 药铺：L 形，药柜前台 + 炼药台 + 稀奇植物 ──
  apothecary: () => lshape('cozy', [
    { kind: 'dresser', x: 2, y: 2 }, { kind: 'dresser', x: 3, y: 2 }, { kind: 'dresser', x: 4, y: 2 },
    { kind: 'dresser', x: 5, y: 2 }, { kind: 'dresser', x: 6, y: 2 },
    { kind: 'chest', x: 8, y: 2 }, { kind: 'chest', x: 9, y: 2 },
    { kind: 'table', x: 3, y: 4 }, { kind: 'table', x: 4, y: 4 }, { kind: 'table', x: 5, y: 4 },
    { kind: 'chair', x: 2, y: 4 }, { kind: 'chair', x: 6, y: 4 },
    { kind: 'plant', x: 2, y: 8 }, { kind: 'plant', x: 7, y: 8 }, { kind: 'cactus', x: 10, y: 8 },
    { kind: 'mirror', x: 4, y: 8 }, { kind: 'mirror', x: 5, y: 8 },
    { kind: 'table', x: 6, y: 10 }, { kind: 'table', x: 7, y: 10 }, { kind: 'table', x: 8, y: 10 },
    { kind: 'rug', x: 7, y: 11 }, { kind: 'rug', x: 8, y: 11 }, { kind: 'rug', x: 9, y: 11 }, { kind: 'rug', x: 10, y: 11 },
    { kind: 'lamp', x: 2, y: 11 }, { kind: 'lamp', x: 11, y: 10 },
  ], [
    { kind: 'lantern', x: 7, y: 4 }, { kind: 'lantern', x: 7, y: 9 },
  ]),

  // ── 裁缝：前镜展示间 + 后工作室 ──
  tailor: () => split('cozy', [
    // 前厅（y=8..12）：镜子展示 + 地毯
    { kind: 'mirror', x: 4, y: 9 }, { kind: 'mirror', x: 5, y: 9 },
    { kind: 'mirror', x: 13, y: 9 }, { kind: 'mirror', x: 14, y: 9 },
    { kind: 'dresser', x: 2, y: 10 }, { kind: 'dresser', x: 3, y: 10 },
    { kind: 'dresser', x: 15, y: 10 }, { kind: 'dresser', x: 16, y: 10 }, { kind: 'dresser', x: 17, y: 10 },
    { kind: 'rug', x: 7, y: 9 }, { kind: 'rug', x: 8, y: 9 }, { kind: 'rug', x: 9, y: 9 }, { kind: 'rug', x: 10, y: 9 }, { kind: 'rug', x: 11, y: 9 },
    { kind: 'rug', x: 7, y: 10 }, { kind: 'rug', x: 8, y: 10 }, { kind: 'rug', x: 9, y: 10 }, { kind: 'rug', x: 10, y: 10 }, { kind: 'rug', x: 11, y: 10 },
    { kind: 'candelabra', x: 17, y: 11 }, { kind: 'plant', x: 2, y: 11 },
  ], [
    // 后室（y=1..5）：工作台
    { kind: 'table', x: 4, y: 3 }, { kind: 'table', x: 5, y: 3 },
    { kind: 'table', x: 13, y: 3 }, { kind: 'table', x: 14, y: 3 },
    { kind: 'dresser', x: 2, y: 2 }, { kind: 'dresser', x: 3, y: 2 },
    { kind: 'dresser', x: 15, y: 2 }, { kind: 'dresser', x: 16, y: 2 }, { kind: 'dresser', x: 17, y: 2 },
    { kind: 'clock', x: 10, y: 2 }, { kind: 'lamp', x: 2, y: 5 }, { kind: 'lamp', x: 17, y: 5 },
  ], [
    { kind: 'lantern', x: 10, y: 3 },
    { kind: 'lantern', x: 5, y: 10 }, { kind: 'lantern', x: 14, y: 10 },
  ]),

  // ── 花店：植物铺满，花行展示 ──
  florist: () => interior('cozy', [
    { kind: 'plant', x: 2, y: 2 }, { kind: 'plant', x: 3, y: 2 }, { kind: 'plant', x: 5, y: 2 },
    { kind: 'cactus', x: 7, y: 2 }, { kind: 'plant', x: 14, y: 2 }, { kind: 'cactus', x: 16, y: 2 }, { kind: 'plant', x: 17, y: 2 },
    { kind: 'flower', x: 3, y: 5 }, { kind: 'flower', x: 4, y: 5 }, { kind: 'flower', x: 5, y: 5 },
    { kind: 'flower', x: 6, y: 5 }, { kind: 'flower', x: 7, y: 5 },
    { kind: 'flower', x: 12, y: 5 }, { kind: 'flower', x: 13, y: 5 }, { kind: 'flower', x: 14, y: 5 },
    { kind: 'flower', x: 15, y: 5 }, { kind: 'flower', x: 16, y: 5 },
    { kind: 'flower', x: 3, y: 8 }, { kind: 'flower', x: 4, y: 8 }, { kind: 'flower', x: 5, y: 8 }, { kind: 'flower', x: 6, y: 8 },
    { kind: 'table', x: 9, y: 4 }, { kind: 'table', x: 10, y: 4 },
    { kind: 'table', x: 9, y: 9 }, { kind: 'table', x: 10, y: 9 }, { kind: 'table', x: 11, y: 9 },
    { kind: 'rug', x: 8, y: 11 }, { kind: 'rug', x: 9, y: 11 }, { kind: 'rug', x: 10, y: 11 },
    { kind: 'rug', x: 11, y: 11 }, { kind: 'rug', x: 12, y: 11 },
    { kind: 'plant', x: 2, y: 11 }, { kind: 'plant', x: 17, y: 11 },
    { kind: 'lamp', x: 17, y: 5 }, { kind: 'lamp', x: 2, y: 9 },
  ], [
    { kind: 'lantern', x: 9, y: 5 }, { kind: 'lantern', x: 12, y: 5 }, { kind: 'lantern', x: 10, y: 8 },
  ]),

  // ── 银行：对称石厅，金库感 ──
  bank: () => interior('stone', [
    { kind: 'chest', x: 2, y: 2 }, { kind: 'chest', x: 3, y: 2 }, { kind: 'chest', x: 4, y: 2 },
    { kind: 'chest', x: 14, y: 2 }, { kind: 'chest', x: 15, y: 2 }, { kind: 'chest', x: 16, y: 2 },
    { kind: 'dresser', x: 6, y: 2 }, { kind: 'dresser', x: 7, y: 2 },
    { kind: 'dresser', x: 11, y: 2 }, { kind: 'dresser', x: 12, y: 2 },
    { kind: 'mirror', x: 9, y: 2 }, { kind: 'clock', x: 10, y: 1 },
    { kind: 'candelabra', x: 2, y: 5 }, { kind: 'candelabra', x: 17, y: 5 },
    { kind: 'candelabra', x: 2, y: 10 }, { kind: 'candelabra', x: 17, y: 10 },
    { kind: 'table', x: 6, y: 6 }, { kind: 'table', x: 7, y: 6 },
    { kind: 'chair', x: 5, y: 6 }, { kind: 'chair', x: 8, y: 6 },
    { kind: 'table', x: 11, y: 6 }, { kind: 'table', x: 12, y: 6 },
    { kind: 'chair', x: 10, y: 6 }, { kind: 'chair', x: 13, y: 6 },
    { kind: 'table', x: 7, y: 10 }, { kind: 'table', x: 8, y: 10 },
    { kind: 'chair', x: 6, y: 10 }, { kind: 'chair', x: 9, y: 10 },
    { kind: 'table', x: 11, y: 10 }, { kind: 'table', x: 12, y: 10 },
    { kind: 'chair', x: 10, y: 10 }, { kind: 'chair', x: 13, y: 10 },
    { kind: 'rug', x: 8, y: 11 }, { kind: 'rug', x: 9, y: 11 }, { kind: 'rug', x: 10, y: 11 }, { kind: 'rug', x: 11, y: 11 },
    { kind: 'lamp', x: 9, y: 5 },
  ], [
    { kind: 'lantern', x: 4, y: 5 }, { kind: 'lantern', x: 14, y: 5 },
    { kind: 'lantern', x: 4, y: 10 }, { kind: 'lantern', x: 14, y: 10 },
  ]),

  // ── 邮局：前窗口台 + 后分拣室 ──
  postoffice: () => split('stone', [
    // 前厅（y=8..12）：窗口柜台
    { kind: 'table', x: 3, y: 9 }, { kind: 'table', x: 4, y: 9 }, { kind: 'table', x: 5, y: 9 },
    { kind: 'table', x: 13, y: 9 }, { kind: 'table', x: 14, y: 9 }, { kind: 'table', x: 15, y: 9 },
    { kind: 'table', x: 8, y: 10 }, { kind: 'table', x: 9, y: 10 }, { kind: 'table', x: 10, y: 10 }, { kind: 'table', x: 11, y: 10 },
    { kind: 'chair', x: 8, y: 12 }, { kind: 'chair', x: 11, y: 12 },
    { kind: 'rug', x: 9, y: 11 }, { kind: 'rug', x: 10, y: 11 }, { kind: 'rug', x: 11, y: 11 }, { kind: 'rug', x: 12, y: 11 },
    { kind: 'lamp', x: 17, y: 11 }, { kind: 'plant', x: 2, y: 11 },
  ], [
    // 后室（y=1..5）：分拣仓储
    { kind: 'dresser', x: 2, y: 2 }, { kind: 'dresser', x: 3, y: 2 }, { kind: 'dresser', x: 4, y: 2 },
    { kind: 'dresser', x: 14, y: 2 }, { kind: 'dresser', x: 15, y: 2 }, { kind: 'dresser', x: 16, y: 2 },
    { kind: 'crate', x: 6, y: 2 }, { kind: 'crate', x: 7, y: 2 },
    { kind: 'crate', x: 11, y: 2 }, { kind: 'crate', x: 12, y: 2 },
    { kind: 'barrel', x: 9, y: 3 }, { kind: 'barrel', x: 10, y: 3 },
    { kind: 'lamp', x: 2, y: 5 }, { kind: 'lamp', x: 17, y: 5 },
  ], [
    { kind: 'lantern', x: 10, y: 4 },
    { kind: 'lantern', x: 6, y: 10 }, { kind: 'lantern', x: 13, y: 10 },
  ]),

  // ── 磨坊：大开间，满屋木桶与作业台 ──
  mill: () => interior('wood', [
    { kind: 'crate', x: 2, y: 2 }, { kind: 'crate', x: 3, y: 2 }, { kind: 'crate', x: 4, y: 2 },
    { kind: 'crate', x: 5, y: 2 }, { kind: 'crate', x: 6, y: 2 },
    { kind: 'barrel', x: 8, y: 2 }, { kind: 'barrel', x: 9, y: 2 }, { kind: 'barrel', x: 10, y: 2 },
    { kind: 'barrel', x: 11, y: 2 }, { kind: 'barrel', x: 12, y: 2 },
    { kind: 'crate', x: 13, y: 2 }, { kind: 'crate', x: 14, y: 2 }, { kind: 'crate', x: 15, y: 2 },
    { kind: 'crate', x: 16, y: 2 }, { kind: 'crate', x: 17, y: 2 },
    { kind: 'barrel', x: 2, y: 6 }, { kind: 'barrel', x: 3, y: 6 },
    { kind: 'barrel', x: 16, y: 6 }, { kind: 'barrel', x: 17, y: 6 },
    { kind: 'table', x: 7, y: 7 }, { kind: 'table', x: 8, y: 7 }, { kind: 'table', x: 9, y: 7 }, { kind: 'table', x: 10, y: 7 },
    { kind: 'table', x: 7, y: 10 }, { kind: 'table', x: 8, y: 10 }, { kind: 'table', x: 9, y: 10 },
    { kind: 'rug', x: 8, y: 12 }, { kind: 'rug', x: 9, y: 12 }, { kind: 'rug', x: 10, y: 12 },
    { kind: 'lamp', x: 2, y: 9 }, { kind: 'lamp', x: 17, y: 9 }, { kind: 'plant', x: 2, y: 12 },
  ], [
    { kind: 'torch', x: 6, y: 5 }, { kind: 'torch', x: 14, y: 5 },
    { kind: 'torch', x: 6, y: 10 }, { kind: 'torch', x: 14, y: 10 },
  ]),

  // ── 通用小店：L 形，前台货架 + 仓储角 ──
  shop: () => lshape('wood', [
    { kind: 'bookshelf', x: 2, y: 2 }, { kind: 'bookshelf', x: 3, y: 2 },
    { kind: 'crate', x: 5, y: 2 }, { kind: 'crate', x: 6, y: 2 },
    { kind: 'barrel', x: 8, y: 2 }, { kind: 'barrel', x: 9, y: 2 },
    { kind: 'dresser', x: 10, y: 2 }, { kind: 'dresser', x: 11, y: 2 },
    { kind: 'crate', x: 2, y: 4 }, { kind: 'barrel', x: 3, y: 4 }, { kind: 'barrel', x: 4, y: 4 },
    { kind: 'table', x: 5, y: 8 }, { kind: 'table', x: 6, y: 8 }, { kind: 'table', x: 7, y: 8 },
    { kind: 'chair', x: 4, y: 8 }, { kind: 'chair', x: 8, y: 8 },
    { kind: 'table', x: 5, y: 10 }, { kind: 'table', x: 6, y: 10 },
    { kind: 'rug', x: 6, y: 11 }, { kind: 'rug', x: 7, y: 11 }, { kind: 'rug', x: 8, y: 11 },
    { kind: 'rug', x: 9, y: 11 }, { kind: 'rug', x: 10, y: 11 },
    { kind: 'plant', x: 2, y: 11 }, { kind: 'lamp', x: 12, y: 9 }, { kind: 'lamp', x: 12, y: 11 },
  ], [
    { kind: 'lantern', x: 7, y: 4 }, { kind: 'lantern', x: 7, y: 8 },
  ]),
};

const COMMERCIAL = new Set(Object.keys(LAYOUTS));

export function buildNpcRoom(style: string): Scene {
  const fn = COMMERCIAL.has(style) ? LAYOUTS[style] : null;
  const scene = fn ? fn() : interior('wood', [
    { kind: 'clock', x: 9, y: 1 },
    { kind: 'plant', x: 2, y: 11 }, { kind: 'lamp', x: 17, y: 11 },
    { kind: 'rug', x: 8, y: 10 }, { kind: 'rug', x: 9, y: 10 }, { kind: 'rug', x: 10, y: 10 }, { kind: 'rug', x: 11, y: 10 },
  ], [], [
    { x: 10, y: 7, type: 'rent', label: '此房出租 · 查看详情' },
  ]);
  scene.id = `npc:${style}`;
  return scene;
}
