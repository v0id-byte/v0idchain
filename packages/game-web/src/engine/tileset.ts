// 语义瓦片名 → Kenney 图集坐标 [列,行]（经 ?pick 工具精确读出）。
// 地形 autotile 块中心 = 纯色填充；建筑区拿到木/石/灰泥墙面与室内石地板。

export const TILESET: Record<string, [number, number]> = {
  // 地板（室内）
  floorWood: [1, 28],
  floorStone: [4, 28], // 干净灰石（[22,19] 是旗帜贴图,弃用）
  floorSand: [7, 28],
  // 墙体（面 + 顶沿）
  wallWood: [34, 13],
  wallWoodTop: [34, 12],
  wallStone: [20, 13],
  wallStoneTop: [20, 12],
  wallPlaster: [18, 13],
  wallPlasterTop: [18, 12],
  // 室外地形
  grass: [10, 28],
  water: [11, 8],
  dirt: [13, 28],
  stone: [4, 28],
  sand: [7, 28],
};

// 同材质多变体：渲染时按格子坐标确定性选一张，纹理更丰富不死板（细化贴图）。
export const VARIANTS: Record<string, [number, number][]> = {
  floorWood: [[1, 28], [0, 28], [2, 28]], // 木地板纹理走向变化
  grass: [[10, 28], [9, 28], [11, 28]], // 草地细微变化
  dirt: [[13, 28], [12, 28], [14, 28]],
  water: [[11, 8], [10, 8], [12, 8]],
};

/** 名+坐标 → 图集坐标（有变体则按位置确定性挑一张）。 */
export function tileCoord(name: string, x: number, y: number): [number, number] | undefined {
  const v = VARIANTS[name];
  if (v) {
    const i = (((x * 131 + y * 977) % v.length) + v.length) % v.length;
    return v[i];
  }
  return TILESET[name];
}

// 房型主题：地板 + 墙体材质组合。用户先选房型，再进编辑器摆家具（#10）。
export interface RoomTheme {
  label: string;
  floor: string;
  wall: string;
  wallTop: string;
}
export const ROOM_THEMES: Record<string, RoomTheme> = {
  wood: { label: '木屋', floor: 'floorWood', wall: 'wallWood', wallTop: 'wallWoodTop' },
  stone: { label: '石厅', floor: 'floorStone', wall: 'wallStone', wallTop: 'wallStoneTop' },
  cozy: { label: '暖居', floor: 'floorSand', wall: 'wallPlaster', wallTop: 'wallPlasterTop' },
};
export type RoomThemeId = keyof typeof ROOM_THEMES;

// 家具 / 装饰目录 → 图集坐标。室内 + 室外装饰。可踩的见 WALKABLE。
export const FURNITURE_TILES: Record<string, [number, number]> = {
  // 室内家具
  bed: [11, 6],
  bedGreen: [16, 6],
  sofa: [17, 6],
  table: [15, 7],
  chair: [13, 7],
  dresser: [28, 5],
  bookshelf: [28, 8],
  chest: [29, 10],
  crate: [32, 10],
  barrel: [39, 10],
  plant: [14, 6],
  cactus: [28, 9],
  lamp: [15, 8],
  candelabra: [19, 7],
  mirror: [24, 7],
  stove: [26, 7],
  clock: [27, 8],
  window: [40, 5],
  pedestal: [10, 6], // 崽基座
  rug: [7, 28],
  // 室外装饰
  tree: [16, 9],
  bush: [13, 9],
  deadTree: [27, 9],
  flower: [23, 10],
  house: [32, 11], // 房子门面/门
};

// 同一装饰多形态:按格子坐标确定性选一张 ⇒ 一片树林/花丛不再是克隆体（坐标经 ?pick 读出）。
// 仅列“有多形态”的;没列的走 FURNITURE_TILES 单图。
export const FURNITURE_VARIANTS: Record<string, [number, number][]> = {
  tree: [[16, 9], [18, 9], [13, 9], [15, 9], [17, 9], [14, 9]], // 绿松/深松/圆绿/圆青柠/橙松/秋黄
  bush: [[13, 9], [19, 9], [20, 9], [21, 9], [24, 9]],
  flower: [[23, 10], [28, 9], [29, 9], [30, 9], [31, 9]], // 杂色小花
  deadTree: [[27, 9], [27, 10], [27, 11]],
};

/** 装饰名+坐标 → 图集坐标（有多形态则按位置确定性挑一张，否则取单图）。 */
export function furnitureCoord(kind: string, x: number, y: number): [number, number] | undefined {
  const v = FURNITURE_VARIANTS[kind];
  if (v) {
    const i = (((x * 131 + y * 977) % v.length) + v.length) % v.length;
    return v[i];
  }
  return FURNITURE_TILES[kind];
}

// 可踩过去的装饰（地毯/花/窗贴墙）；其余挡路。
export const WALKABLE = new Set<string>(['rug', 'flower', 'window']);

// 编辑器家具调色板（可放清单）。label 给 UI；solid 决定是否挡路。
export interface CatalogItem {
  kind: string;
  label: string;
}
export const FURNITURE_CATALOG: CatalogItem[] = [
  { kind: 'bed', label: '床' },
  { kind: 'bedGreen', label: '绿床' },
  { kind: 'sofa', label: '沙发' },
  { kind: 'table', label: '桌子' },
  { kind: 'chair', label: '椅子' },
  { kind: 'dresser', label: '柜子' },
  { kind: 'bookshelf', label: '书架' },
  { kind: 'chest', label: '箱子' },
  { kind: 'crate', label: '木箱' },
  { kind: 'barrel', label: '木桶' },
  { kind: 'plant', label: '盆栽' },
  { kind: 'cactus', label: '仙人掌' },
  { kind: 'lamp', label: '灯' },
  { kind: 'candelabra', label: '烛台' },
  { kind: 'mirror', label: '镜子' },
  { kind: 'stove', label: '炉子' },
  { kind: 'clock', label: '时钟' },
  { kind: 'window', label: '窗' },
  { kind: 'rug', label: '地毯' },
  { kind: 'plant', label: '植物' },
];
