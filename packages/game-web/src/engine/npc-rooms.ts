// NPC 主题房间：每种建筑风格对应一套确定性室内布局。
// 和 buildRoom() 同结构（12×9，四壁一门），仅家具/效果/主题不同。
// 商业风格 → 有主题家具；住宅风格 → 出租/出售占位提示。
import type { Scene, FurnitureItem, Interactable } from './scene.js';
import type { EffectItem } from './effects.js';
import { ROOM_THEMES, type RoomThemeId } from './tileset.js';

const W = 12;
const H = 9;
const DOOR_X = 6;
const WALKABLE = new Set(['rug', 'flower', 'window']);

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
    id: 'npc',
    w: W, h: H, tiles, solid,
    furniture, effects, buildings: [],
    interactables: [
      { x: DOOR_X, y: H - 1, type: 'door', label: '出门', target: 'town' },
      ...extras,
    ],
    spawn: { x: DOOR_X, y: H - 3 },
  };
}

const LAYOUTS: Record<string, () => Scene> = {
  bakery: () => interior('cozy', [
    { kind: 'stove', x: 9, y: 1 }, { kind: 'stove', x: 10, y: 1 },
    { kind: 'table', x: 4, y: 3 }, { kind: 'table', x: 7, y: 3 },
    { kind: 'chair', x: 3, y: 3 }, { kind: 'chair', x: 6, y: 3 },
    { kind: 'crate', x: 1, y: 2 }, { kind: 'crate', x: 2, y: 2 },
    { kind: 'barrel', x: 1, y: 4 },
    { kind: 'lamp', x: 10, y: 4 },
    { kind: 'rug', x: 6, y: 5 },
    { kind: 'bookshelf', x: 1, y: 6 },
    { kind: 'plant', x: 10, y: 6 },
  ], [{ kind: 'campfire', x: 9, y: 3 }]),

  smithy: () => interior('stone', [
    { kind: 'dresser', x: 1, y: 2 }, { kind: 'dresser', x: 2, y: 2 },
    { kind: 'crate', x: 10, y: 2 }, { kind: 'barrel', x: 9, y: 2 },
    { kind: 'barrel', x: 1, y: 5 }, { kind: 'chest', x: 10, y: 5 },
    { kind: 'rug', x: 5, y: 4 }, { kind: 'rug', x: 6, y: 4 }, { kind: 'rug', x: 7, y: 4 },
  ], [{ kind: 'campfire', x: 9, y: 3 }, { kind: 'torch', x: 3, y: 4 }, { kind: 'torch', x: 8, y: 2 }]),

  tavern: () => interior('wood', [
    { kind: 'barrel', x: 1, y: 2 }, { kind: 'barrel', x: 2, y: 2 }, { kind: 'barrel', x: 3, y: 2 },
    { kind: 'table', x: 4, y: 4 }, { kind: 'table', x: 8, y: 4 },
    { kind: 'chair', x: 3, y: 4 }, { kind: 'chair', x: 5, y: 4 }, { kind: 'chair', x: 7, y: 4 }, { kind: 'chair', x: 9, y: 4 },
    { kind: 'table', x: 4, y: 6 }, { kind: 'table', x: 8, y: 6 },
    { kind: 'chair', x: 3, y: 6 }, { kind: 'chair', x: 5, y: 6 }, { kind: 'chair', x: 7, y: 6 }, { kind: 'chair', x: 9, y: 6 },
    { kind: 'sofa', x: 10, y: 5 },
    { kind: 'rug', x: 6, y: 5 },
    { kind: 'candelabra', x: 10, y: 2 },
  ], [{ kind: 'campfire', x: 1, y: 5 }, { kind: 'lantern', x: 5, y: 2 }, { kind: 'lantern', x: 7, y: 2 }]),

  grocer: () => interior('wood', [
    { kind: 'bookshelf', x: 1, y: 2 }, { kind: 'bookshelf', x: 2, y: 2 }, { kind: 'bookshelf', x: 10, y: 2 }, { kind: 'bookshelf', x: 9, y: 2 },
    { kind: 'crate', x: 4, y: 2 }, { kind: 'crate', x: 5, y: 2 }, { kind: 'crate', x: 6, y: 2 }, { kind: 'crate', x: 7, y: 2 },
    { kind: 'barrel', x: 3, y: 4 }, { kind: 'barrel', x: 4, y: 4 },
    { kind: 'table', x: 6, y: 4 }, { kind: 'table', x: 7, y: 4 },
    { kind: 'plant', x: 1, y: 6 }, { kind: 'lamp', x: 10, y: 5 },
    { kind: 'rug', x: 5, y: 6 }, { kind: 'rug', x: 6, y: 6 }, { kind: 'rug', x: 7, y: 6 },
  ], [{ kind: 'lantern', x: 5, y: 5 }]),

  inn: () => interior('wood', [
    { kind: 'bed', x: 2, y: 2 }, { kind: 'dresser', x: 1, y: 2 },
    { kind: 'bed', x: 5, y: 2 }, { kind: 'dresser', x: 4, y: 2 },
    { kind: 'bed', x: 9, y: 2 }, { kind: 'dresser', x: 10, y: 2 },
    { kind: 'table', x: 5, y: 5 }, { kind: 'chair', x: 4, y: 5 }, { kind: 'chair', x: 6, y: 5 },
    { kind: 'sofa', x: 1, y: 6 },
    { kind: 'rug', x: 5, y: 6 }, { kind: 'rug', x: 6, y: 6 },
    { kind: 'lamp', x: 10, y: 5 }, { kind: 'clock', x: 7, y: 2 },
  ], [{ kind: 'lantern', x: 5, y: 4 }, { kind: 'torch', x: 1, y: 4 }, { kind: 'torch', x: 10, y: 4 }]),

  bookshop: () => interior('wood', [
    { kind: 'bookshelf', x: 1, y: 2 }, { kind: 'bookshelf', x: 2, y: 2 }, { kind: 'bookshelf', x: 3, y: 2 },
    { kind: 'bookshelf', x: 9, y: 2 }, { kind: 'bookshelf', x: 10, y: 2 },
    { kind: 'bookshelf', x: 1, y: 4 }, { kind: 'bookshelf', x: 1, y: 5 }, { kind: 'bookshelf', x: 10, y: 4 },
    { kind: 'table', x: 5, y: 4 }, { kind: 'table', x: 6, y: 4 },
    { kind: 'chair', x: 4, y: 4 }, { kind: 'chair', x: 7, y: 4 },
    { kind: 'rug', x: 5, y: 5 }, { kind: 'rug', x: 6, y: 5 },
    { kind: 'lamp', x: 5, y: 3 }, { kind: 'plant', x: 10, y: 6 }, { kind: 'clock', x: 3, y: 1 },
  ], [{ kind: 'lantern', x: 2, y: 4 }]),

  apothecary: () => interior('cozy', [
    { kind: 'dresser', x: 1, y: 2 }, { kind: 'dresser', x: 2, y: 2 }, { kind: 'dresser', x: 10, y: 2 }, { kind: 'dresser', x: 9, y: 2 },
    { kind: 'chest', x: 3, y: 2 }, { kind: 'crate', x: 8, y: 2 },
    { kind: 'table', x: 5, y: 3 }, { kind: 'table', x: 6, y: 3 },
    { kind: 'plant', x: 1, y: 6 }, { kind: 'plant', x: 10, y: 6 },
    { kind: 'cactus', x: 5, y: 5 },
    { kind: 'lamp', x: 10, y: 4 }, { kind: 'lamp', x: 1, y: 4 },
    { kind: 'rug', x: 5, y: 6 }, { kind: 'rug', x: 6, y: 6 },
    { kind: 'mirror', x: 3, y: 5 },
  ], [{ kind: 'lantern', x: 5, y: 4 }]),

  tailor: () => interior('cozy', [
    { kind: 'dresser', x: 1, y: 2 }, { kind: 'dresser', x: 2, y: 2 }, { kind: 'dresser', x: 10, y: 2 }, { kind: 'dresser', x: 9, y: 2 },
    { kind: 'mirror', x: 5, y: 2 }, { kind: 'mirror', x: 6, y: 2 },
    { kind: 'table', x: 4, y: 5 }, { kind: 'table', x: 5, y: 5 },
    { kind: 'rug', x: 6, y: 5 }, { kind: 'rug', x: 7, y: 5 }, { kind: 'rug', x: 8, y: 5 },
    { kind: 'candelabra', x: 10, y: 5 }, { kind: 'lamp', x: 1, y: 5 },
    { kind: 'plant', x: 3, y: 6 }, { kind: 'clock', x: 7, y: 2 },
  ], [{ kind: 'lantern', x: 5, y: 4 }]),

  florist: () => interior('cozy', [
    { kind: 'plant', x: 1, y: 2 }, { kind: 'plant', x: 2, y: 3 }, { kind: 'plant', x: 10, y: 2 }, { kind: 'plant', x: 9, y: 3 },
    { kind: 'cactus', x: 4, y: 2 }, { kind: 'cactus', x: 7, y: 2 },
    { kind: 'flower', x: 3, y: 4 }, { kind: 'flower', x: 4, y: 4 }, { kind: 'flower', x: 5, y: 4 },
    { kind: 'flower', x: 6, y: 4 }, { kind: 'flower', x: 7, y: 4 }, { kind: 'flower', x: 8, y: 4 },
    { kind: 'plant', x: 1, y: 5 }, { kind: 'plant', x: 10, y: 5 },
    { kind: 'table', x: 5, y: 6 }, { kind: 'table', x: 6, y: 6 },
    { kind: 'lamp', x: 10, y: 6 },
  ], [{ kind: 'lantern', x: 5, y: 3 }]),

  bank: () => interior('stone', [
    { kind: 'chest', x: 1, y: 2 }, { kind: 'chest', x: 2, y: 2 }, { kind: 'chest', x: 10, y: 2 }, { kind: 'chest', x: 9, y: 2 },
    { kind: 'dresser', x: 3, y: 2 }, { kind: 'dresser', x: 8, y: 2 },
    { kind: 'candelabra', x: 10, y: 4 }, { kind: 'candelabra', x: 1, y: 4 },
    { kind: 'mirror', x: 5, y: 2 },
    { kind: 'table', x: 5, y: 5 }, { kind: 'table', x: 6, y: 5 },
    { kind: 'chair', x: 4, y: 5 }, { kind: 'chair', x: 7, y: 5 },
    { kind: 'lamp', x: 5, y: 4 },
    { kind: 'rug', x: 5, y: 6 }, { kind: 'rug', x: 6, y: 6 }, { kind: 'clock', x: 3, y: 1 },
  ], [{ kind: 'lantern', x: 2, y: 5 }, { kind: 'lantern', x: 9, y: 5 }]),

  postoffice: () => interior('stone', [
    { kind: 'dresser', x: 1, y: 2 }, { kind: 'dresser', x: 2, y: 2 }, { kind: 'dresser', x: 10, y: 2 }, { kind: 'dresser', x: 9, y: 2 },
    { kind: 'table', x: 4, y: 3 }, { kind: 'table', x: 5, y: 3 }, { kind: 'table', x: 6, y: 3 }, { kind: 'table', x: 7, y: 3 },
    { kind: 'crate', x: 3, y: 5 }, { kind: 'crate', x: 4, y: 5 }, { kind: 'crate', x: 8, y: 5 },
    { kind: 'lamp', x: 5, y: 2 }, { kind: 'lamp', x: 7, y: 2 },
    { kind: 'chair', x: 4, y: 6 }, { kind: 'chair', x: 7, y: 6 },
    { kind: 'rug', x: 5, y: 6 }, { kind: 'rug', x: 6, y: 6 },
  ], [{ kind: 'lantern', x: 5, y: 5 }]),

  chapel: () => interior('stone', [
    { kind: 'candelabra', x: 1, y: 2 }, { kind: 'candelabra', x: 10, y: 2 },
    { kind: 'candelabra', x: 1, y: 4 }, { kind: 'candelabra', x: 10, y: 4 },
    { kind: 'rug', x: 5, y: 3 }, { kind: 'rug', x: 6, y: 3 }, { kind: 'rug', x: 5, y: 4 }, { kind: 'rug', x: 6, y: 4 },
    { kind: 'rug', x: 5, y: 5 }, { kind: 'rug', x: 6, y: 5 }, { kind: 'rug', x: 5, y: 6 }, { kind: 'rug', x: 6, y: 6 },
    { kind: 'plant', x: 4, y: 2 }, { kind: 'plant', x: 7, y: 2 },
    { kind: 'chair', x: 3, y: 4 }, { kind: 'chair', x: 4, y: 4 }, { kind: 'chair', x: 7, y: 4 }, { kind: 'chair', x: 8, y: 4 },
    { kind: 'chair', x: 3, y: 5 }, { kind: 'chair', x: 4, y: 5 }, { kind: 'chair', x: 7, y: 5 }, { kind: 'chair', x: 8, y: 5 },
    { kind: 'table', x: 5, y: 2 }, { kind: 'table', x: 6, y: 2 },
  ], [{ kind: 'torch', x: 3, y: 2 }, { kind: 'torch', x: 8, y: 2 }, { kind: 'lantern', x: 5, y: 1 }]),

  mill: () => interior('wood', [
    { kind: 'crate', x: 1, y: 2 }, { kind: 'crate', x: 2, y: 2 }, { kind: 'crate', x: 3, y: 2 },
    { kind: 'barrel', x: 4, y: 2 }, { kind: 'barrel', x: 5, y: 2 }, { kind: 'barrel', x: 6, y: 2 }, { kind: 'barrel', x: 7, y: 2 }, { kind: 'barrel', x: 8, y: 2 },
    { kind: 'crate', x: 9, y: 2 }, { kind: 'crate', x: 10, y: 2 },
    { kind: 'table', x: 5, y: 5 }, { kind: 'table', x: 6, y: 5 },
    { kind: 'lamp', x: 10, y: 4 }, { kind: 'lamp', x: 1, y: 4 },
    { kind: 'rug', x: 5, y: 6 }, { kind: 'rug', x: 6, y: 6 }, { kind: 'plant', x: 3, y: 6 },
  ], [{ kind: 'torch', x: 3, y: 4 }, { kind: 'torch', x: 8, y: 4 }]),

  shop: () => interior('wood', [
    { kind: 'bookshelf', x: 1, y: 2 }, { kind: 'bookshelf', x: 10, y: 2 },
    { kind: 'crate', x: 2, y: 2 }, { kind: 'crate', x: 9, y: 2 },
    { kind: 'barrel', x: 3, y: 2 }, { kind: 'barrel', x: 8, y: 2 },
    { kind: 'table', x: 5, y: 4 }, { kind: 'table', x: 6, y: 4 },
    { kind: 'lamp', x: 10, y: 4 },
    { kind: 'rug', x: 5, y: 5 }, { kind: 'rug', x: 6, y: 5 }, { kind: 'plant', x: 1, y: 6 },
  ], [{ kind: 'lantern', x: 5, y: 5 }]),
};

const COMMERCIAL = new Set(Object.keys(LAYOUTS));

export function buildNpcRoom(style: string): Scene {
  const fn = COMMERCIAL.has(style) ? LAYOUTS[style] : null;
  const scene = fn ? fn() : interior('wood', [
    { kind: 'clock', x: 5, y: 1 },
    { kind: 'plant', x: 1, y: 6 },
    { kind: 'lamp', x: 10, y: 6 },
  ], [], [
    { x: 5, y: 4, type: 'rent', label: '此房出租 · 查看详情' },
  ]);
  scene.id = `npc:${style}`;
  return scene;
}
