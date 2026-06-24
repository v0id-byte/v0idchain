// 场景 = 瓦片地图 + 碰撞 + 家具 + 动态物件 + 可交互点 + 出生点。瓦片名对应 tileset 的键。
import type { FurnitureKind } from './sprites.js';
import type { EffectItem } from './effects.js';
import { buildingMeta, BUILDING_STYLES, type BuildingItem } from './buildings.js';
import { ROOM_THEMES, WALKABLE, type RoomThemeId } from './tileset.js';
import { cropGrowth, cropStage, ZONE_SLOTS, type Crop, type FarmView } from '@v0idchain/core/browser';

export interface FurnitureItem {
  kind: FurnitureKind;
  x: number;
  y: number;
}
export type InteractType =
  | 'door'
  | 'pedestal'
  | 'board'
  | 'fishing'
  | 'plot'
  | 'crop'
  | 'fruit'
  | 'garden'
  | 'rent'
  | 'mine_rock'
  | 'mine_ore'
  | 'mine_chest'
  | 'mine_monster';
export type GardenStateEntry = { phase: string; crop?: Crop; stage?: 0 | 1 | 2 | 3; hash?: string };
export type FruitKind = 'apple' | 'orange' | 'berry' | 'golden_apple';
export interface MineRef {
  kind: 'rock' | 'ore' | 'chest' | 'monster';
  id: string;
  depth: number;
  x: number;
  y: number;
  oreKind?: string;
}
export interface MineObject {
  kind: 'ore' | 'chest' | 'monster' | 'stairsDown' | 'stairsUp' | 'exit' | 'mineEntrance';
  x: number;
  y: number;
  oreKind?: string;
  variant?: number;
}
/** 农场交互附带的链上引用（onInteract 据此分发到买地/建区块/种植/收获动作）。 */
export interface FarmRef {
  kind: 'buy' | 'plot' | 'slot' | 'crop'; // buy=买下一块地 / plot=空地块(建区块) / slot=田地空格(种植) / crop=作物(查看/收获)
  plotN?: number; // plot/slot：所属地块号
  zoneId?: string; // slot/crop：所属区块 id
  slot?: number; // slot/crop：格位
  plantId?: string; // crop：作物(plant) id
  crop?: Crop; // crop：作物种类
  ready?: boolean; // crop：是否已成熟可收
}
export interface Interactable {
  x: number;
  y: number;
  type: InteractType;
  label: string;
  target?: string;    // door：目标场景 id
  farm?: FarmRef;     // plot/crop：农场链上引用
  fruitId?: string;   // fruit：唯一 id（用于缓存摘取状态）
  fruitKind?: FruitKind; // fruit：果实种类
  gardenId?: string;  // garden：公共菜地格位 id
  mine?: MineRef;     // mine_*：矿洞破坏/拾取/轻战斗引用
}
/** 场景里要按成长阶段渲染的作物（引擎用 crop-render 画；纯展示，交互走同坐标的 Interactable）。 */
export interface CropSprite {
  x: number;
  y: number;
  crop: Crop;
  hash: string; // 已收获作物的 cropHash；未收获(生长中)用 plant id 当稳定占位 hash（仅决定生长中外观个体差异，不剧透品质）
  stage: 0 | 1 | 2 | 3;
}
export interface Scene {
  id: string;
  w: number;
  h: number;
  tiles: string[][];
  solid: boolean[][];
  furniture: FurnitureItem[];
  effects: EffectItem[]; // 程序化动态物件（篝火/喷泉/灯…），按 y 深度排序与家具/玩家混排
  buildings: BuildingItem[]; // 多瓦片建筑（拼装器渲染），按底边 y 深度排序
  interactables: Interactable[];
  crops?: CropSprite[]; // 农场作物（按成长阶段画，按 y 深度排序）
  mineObjects?: MineObject[]; // 矿洞对象（矿石/宝箱/怪物/楼梯），由引擎程序化绘制
  spawn: { x: number; y: number };
  petAnchor?: { x: number; y: number }; // 崽站位（基座前）
}

/** 默认起始布置（新玩家、或还没发布过房间时）。编辑器发布后用用户布局替换。 */
export const DEFAULT_ROOM_FURNITURE: FurnitureItem[] = [
  // 卧室区（右侧）
  { kind: 'bed', x: 16, y: 2 },
  { kind: 'dresser', x: 18, y: 2 },
  { kind: 'window', x: 14, y: 1 },
  { kind: 'clock', x: 12, y: 1 },
  // 客厅区（中央）
  { kind: 'sofa', x: 9, y: 7 },
  { kind: 'table', x: 11, y: 9 },
  { kind: 'chair', x: 10, y: 9 },
  { kind: 'chair', x: 12, y: 9 },
  { kind: 'rug', x: 9, y: 8 },
  { kind: 'rug', x: 10, y: 8 },
  { kind: 'rug', x: 11, y: 8 },
  { kind: 'rug', x: 12, y: 8 },
  { kind: 'lamp', x: 14, y: 7 },
  // 书房区（左侧）
  { kind: 'bookshelf', x: 1, y: 3 },
  { kind: 'bookshelf', x: 1, y: 5 },
  { kind: 'bookshelf', x: 1, y: 7 },
  { kind: 'table', x: 4, y: 4 },
  { kind: 'chair', x: 3, y: 4 },
  // 装饰
  { kind: 'plant', x: 18, y: 7 },
  { kind: 'plant', x: 1, y: 10 },
  { kind: 'cactus', x: 6, y: 3 },
];

/**
 * 你的房间（阶段 0，小 interior）。theme 决定地板/墙体材质（木屋/石厅/暖居）。
 * furniture = 当前布局（编辑器的唯一真相，pedestal 固定附加）。空数组 = 空房间。
 */
export function buildRoom(furniture: FurnitureItem[] = DEFAULT_ROOM_FURNITURE, theme: RoomThemeId = 'wood'): Scene {
  const th = ROOM_THEMES[theme];
  const w = 20;
  const h = 14;
  const doorX = 8;
  const farmDoorX = 14; // 第二道门洞 → 去自家农场
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < w; x++) {
      let t = th.floor;
      let s = false;
      if (y === 0) {
        t = th.wallTop;
        s = true;
      } else if (y === h - 1) {
        if (x === doorX || x === farmDoorX) t = th.floor; // 门洞露地板（镇中心 / 农场）
        else {
          t = th.wall;
          s = true;
        }
      } else if (x === 0 || x === w - 1) {
        t = th.wall;
        s = true;
      }
      tiles[y][x] = t;
      solid[y][x] = s;
    }
  }
  const pedestal: FurnitureItem = { kind: 'pedestal', x: 2, y: 2 };
  const all = [pedestal, ...furniture];
  for (const f of all) {
    if (!WALKABLE.has(f.kind) && solid[f.y]?.[f.x] !== undefined) solid[f.y][f.x] = true;
  }
  return {
    id: 'room',
    w,
    h,
    tiles,
    solid,
    furniture: all,
    effects: [],
    buildings: [],
    interactables: [
      { x: doorX, y: h - 1, type: 'door', label: '去镇中心', target: 'town' },
      { x: farmDoorX, y: h - 1, type: 'door', label: '去我的农场', target: 'farm' },
      { x: pedestal.x, y: pedestal.y, type: 'pedestal', label: '我的崽' },
    ],
    spawn: { x: doorX, y: h - 3 },
    petAnchor: { x: pedestal.x, y: pedestal.y + 1 },
  };
}

/**
 * 镇中心（热闹紧凑的中世纪鹅卵石商业街）。横向主街 + 北排店铺(门临街) + 南排店铺/民居(门临人行道) +
 * 中央石板广场(篝火/喷泉/名册牌) + 西北水塘(沙岸) + 开放式鱼摊 + 高树/路灯/栅栏。
 * 店门 → 回房间；广场名册牌 → 串门；鱼摊 → 钓鱼小游戏(QTE + 链上渔获)。确定性布局(自带 LCG)，刷新稳定。
 */
const FRUIT_LABEL: Record<FruitKind, string> = { apple: '苹果', orange: '橙子', berry: '浆果', golden_apple: '黄金苹果' };
// 店铺门口主题陈列（按 style 摆，给商业街烟火气；无映射的店不摆）。
const SHOP_PROP: Record<string, string> = {
  florist: 'flowerBucket', bakery: 'breadRack', smithy: 'coalPile',
  tavern: 'kegStack', inn: 'kegStack', grocer: 'cropSack', mill: 'cropSack',
  bookshop: 'bookStack', apothecary: 'potionShelf',
  bank: 'signboard', postoffice: 'signboard', tailor: 'signboard', shop: 'signboard',
};

// 固定果树位置（确认在草地上、远离建筑密集区）
const FRUIT_SPOTS: { x: number; y: number; id: string; kind: FruitKind }[] = [
  { x: 6, y: 20, id: 'fruit_nw', kind: 'apple' },
  { x: 88, y: 20, id: 'fruit_ne', kind: 'orange' },
  { x: 5, y: 47, id: 'fruit_w', kind: 'berry' },
  { x: 90, y: 47, id: 'fruit_e', kind: 'apple' },
  { x: 30, y: 28, id: 'fruit_cn', kind: 'orange' },
  { x: 65, y: 28, id: 'fruit_ce', kind: 'berry' },
  { x: 10, y: 63, id: 'fruit_sw', kind: 'apple' },
  { x: 80, y: 63, id: 'fruit_se', kind: 'golden_apple' },
];

function gardenHash(id: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0').repeat(8);
}

export function buildTown(
  depletedFruits?: ReadonlySet<string>,
  choppedTrees?: ReadonlySet<string>,
  spawnOverride?: { x: number; y: number },
  gardenState?: ReadonlyMap<string, GardenStateEntry>,
): Scene {
  const w = 96;
  const h = 120; // 加高:南侧住宅区足够放 3 行带大院子的宅地
  const cx = Math.floor(w / 2);
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < w; x++) {
      tiles[y][x] = 'grass';
      solid[y][x] = false;
    }
  }
  const furniture: FurnitureItem[] = [];
  const interactables: Interactable[] = [];
  const effects: EffectItem[] = [];
  const buildings: BuildingItem[] = [];
  const mineObjects: MineObject[] = [];

  let seed = 73113;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const setT = (x: number, y: number, t: string) => {
    if (tiles[y]?.[x] !== undefined) tiles[y][x] = t;
  };
  const fill = (x0: number, y0: number, x1: number, y1: number, t: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setT(x, y, t);
  };

  // —— 主街(横向鹅卵石,3 格高) + 竖向连接巷 + 南排前人行道 ——
  const streetY = Math.floor(h / 2) - 1;
  const swY = streetY + 7; // 南排店门前人行道行
  fill(2, streetY, w - 3, streetY + 2, 'cobble'); // 主街核心(3 高·直, 保证门连通)
  // 主街上下沿有机起伏：偶尔向草地凸出一格,破除 CAD 直边(纯铺面,不动碰撞)
  for (let x = 2; x < w - 2; x++) {
    if (Math.sin(x * 0.19) > 0.5 && tiles[streetY - 1]?.[x] === 'grass') setT(x, streetY - 1, 'cobble');
    if (Math.sin(x * 0.23 + 1.5) > 0.5 && tiles[streetY + 3]?.[x] === 'grass') setT(x, streetY + 3, 'cobble');
  }
  // 中央竖向大道：正弦蜿蜒 2 宽鹅卵石(在无建筑的 gap 内;cobble=纯视觉,行走无碍)。南至住宅区前止。
  for (let y = 3; y <= swY + 1; y++) {
    const ax = cx + Math.round(Math.sin(y * 0.12) * 2 + Math.sin(y * 0.37));
    for (let x = ax; x <= ax + 1; x++) if (tiles[y]?.[x] === 'grass') setT(x, y, 'cobble');
  }
  fill(2, swY, w - 3, swY, 'cobble'); // 南排店前人行道(直, 门连通)
  // 中央石板广场
  fill(cx - 5, streetY - 1, cx + 6, streetY + 5, 'stone');

  // —— 水塘(西北,椭圆) + 沙岸 ——
  for (let y = 3; y < 16; y++)
    for (let x = 4; x < 22; x++) {
      const dx = (x - 12) / 1.3;
      const dy = y - 9;
      if (dx * dx + dy * dy < 22) {
        setT(x, y, 'water');
        solid[y][x] = true;
      }
    }
  for (let y = 2; y < 17; y++)
    for (let x = 3; x < 23; x++)
      if (tiles[y]?.[x] === 'grass') {
        let nearW = false;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) if (tiles[y + oy]?.[x + ox] === 'water') nearW = true;
        if (nearW) setT(x, y, 'sand');
      }

  // —— 放建筑助手(挡路 + 门/摊交互 + 门前留空 + 炊烟 + 门口主题陈列) ——
  const shopDecor: FurnitureItem[] = []; // 店铺门口道具(延后落地,免被散布清理剔除)
  const place = (style: string, x: number, y: number, bw: number, bh: number) => {
    if (x < 1 || x + bw > w - 1) return;
    buildings.push({ style, x, y, w: bw, h: bh, variant: (x * 7 + bh * 3) % 8 });
    const { doorCol, chimneyCol } = buildingMeta(bw);
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) if (solid[yy]?.[xx] !== undefined) solid[yy][xx] = true;
    const st = BUILDING_STYLES[style];
    const dX = x + doorCol;
    const dY = y + bh - 1;
    interactables.push({ x: dX, y: dY, type: st?.open ? 'fishing' : 'door', label: st?.open ? '钓鱼' : '进屋', target: st?.open ? undefined : `npc:${style}` });
    if (solid[dY + 1]?.[dX] !== undefined) solid[dY + 1][dX] = false;
    if (st?.chimney) effects.push({ kind: 'chimneySmoke', x: x + chimneyCol, y: y + 1 });
    const sp = SHOP_PROP[style]; // 门旁一格摆主题陈列(门前留空那格不占)
    if (sp) shopDecor.push({ kind: sp, x: dX + 1, y: dY + 1 });
  };
  const inGap = (x: number) => x >= cx - 6 && x <= cx + 7; // 让出中央广场/竖巷

  // —— 美式带院子住宅:房子 + 围一圈栅栏院子(草坪 + 通门小径 + 花坛 + 角树/灌木 + 信箱) ——
  // 院子装饰存这里、清理后再落地(免被建筑周边散布剔除)。yard 让房子之间自然拉开间距、有留白。
  const yardDecor: FurnitureItem[] = [];
  const yardTrees: { x: number; y: number }[] = []; // 角树(挡路,清理后落地)
  // 返回院子占用矩形(含围栏)供布局避免重叠。门朝南(下),院门在前墙中线。
  const placeHouseWithYard = (style: string, hx: number, hy: number, bw: number, bh: number, m = 2) => {
    const yx0 = hx - m;
    const yy0 = hy - 1; // 房后只留 1 格(屋顶出檐),前院更深
    const yx1 = hx + bw - 1 + m;
    const yy1 = hy + bh - 1 + m; // 前院 m 格深
    if (yx0 < 1 || yx1 > w - 2 || yy0 < 1 || yy1 > h - 2) return null;
    place(style, hx, hy, bw, bh); // 房身(挡路 + 门交互 + 炊烟 + 门前留空)
    const { doorCol } = buildingMeta(bw);
    const dX = hx + doorCol;
    const gateX = dX; // 院门对齐房门
    // 草坪(确保院内是草,房后泥/沙也复绿)
    for (let yy = yy0; yy <= yy1; yy++) for (let xx = yx0; xx <= yx1; xx++) if (tiles[yy]?.[xx] !== undefined && tiles[yy][xx] !== 'water') setT(xx, yy, 'grass');
    // 通门小径(院门→房门,dirt)
    for (let yy = hy + bh; yy <= yy1; yy++) { setT(dX, yy, 'dirt'); if (solid[yy]?.[dX] !== undefined) solid[yy][dX] = false; }
    // 围栏(院周一圈,前墙留院门 1 格)
    for (let xx = yx0; xx <= yx1; xx++) {
      yardDecor.push({ kind: 'fence', x: xx, y: yy0 }); // 后栏
      if (xx !== gateX) yardDecor.push({ kind: 'fence', x: xx, y: yy1 }); // 前栏(留门)
    }
    for (let yy = yy0 + 1; yy < yy1; yy++) { yardDecor.push({ kind: 'fence', x: yx0, y: yy }); yardDecor.push({ kind: 'fence', x: yx1, y: yy }); }
    // 信箱(院门外侧一格)
    yardDecor.push({ kind: 'mailbox', x: gateX + 1 <= yx1 ? gateX + 1 : gateX - 1, y: yy1 });
    // 花坛(前院沿小径两侧)+ 角树/灌木(院内四角,避开小径与房身)
    const corners: [number, number][] = [[yx0 + 1, yy1 - 1], [yx1 - 1, yy1 - 1], [yx0 + 1, yy0 + 1], [yx1 - 1, yy0 + 1]];
    let cIdx = (hx * 13 + hy * 7) % 4;
    for (let k = 0; k < 2; k++) { // 前两个角放树/灌木
      const [cxx, cyy] = corners[(cIdx + k) % 4];
      if (Math.abs(cxx - dX) <= 1) continue; // 别压小径
      if (tiles[cyy]?.[cxx] === 'grass') yardTrees.push({ x: cxx, y: cyy });
    }
    cIdx++;
    // 花坛:门前两侧各一两株花(可踩)
    for (const fx of [dX - 1, dX + 1]) {
      const fy = yy1 - 1;
      if (tiles[fy]?.[fx] === 'grass') yardDecor.push({ kind: 'flower', x: fx, y: fy });
    }
    return { x0: yx0, y0: yy0, x1: yx1, y1: yy1 };
  };

  // 西端开放式鱼摊(3 高,底贴街)
  place('fishstall', 4, streetY - 3, 4, 3);
  // 北排商铺(门朝南临主街,4..5 高)
  const northShops = ['grocer', 'bakery', 'tavern', 'bank', 'smithy', 'apothecary', 'tailor', 'bookshop', 'florist', 'inn', 'postoffice', 'shop'];
  let bx = 10;
  while (bx < w - 7) {
    if (inGap(bx)) { bx = cx + 8; continue; }
    const bh = 4 + Math.floor(rnd() * 2);
    place(pick(northShops), bx, streetY - 1 - (bh - 1), 4, bh);
    bx += 6 + Math.floor(rnd() * 3);
  }
  // 南排店铺/民居(门朝南临人行道,4 高;屋顶朝主街)。掺入新户型,让临街排也露多样屋顶。
  const southShops = ['house', 'house2', 'house3', 'cottage', 'manor', 'slate', 'mossy', 'rosehouse', 'tudor', 'sandstone', 'mill', 'colonial', 'cape', 'saltbox', 'brownstone'];
  bx = 5;
  while (bx < w - 7) {
    if (inGap(bx)) { bx = cx + 8; continue; }
    place(pick(southShops), bx, streetY + 3, 4, 4);
    bx += 6 + Math.floor(rnd() * 3);
  }

  // —— 广场:篝火 + 喷泉 + 名册牌 ——
  effects.push({ kind: 'campfire', x: cx - 3, y: streetY + 4 });
  effects.push({ kind: 'fountain', x: cx + 4, y: streetY + 4 });
  interactables.push({ x: cx, y: streetY + 3, type: 'board', label: '名册 · 串门' });
  // 路灯沿主街
  for (const lx of [12, 26, cx - 8, cx + 9, w - 26, w - 13]) effects.push({ kind: 'lantern', x: lx, y: streetY + 2 });

  // —— 散布树/灌木/花 ——
  for (let i = 0; i < 240; i++) {
    const x = 2 + Math.floor(rnd() * (w - 4));
    const y = 2 + Math.floor(rnd() * (h - 4));
    if (tiles[y][x] === 'grass') {
      const r = rnd();
      furniture.push({ kind: r < 0.34 ? 'tree' : r < 0.56 ? 'bush' : r < 0.8 ? 'flower' : 'deadTree', x, y });
    }
  }
  // 南排店后院栅栏(分段,留口)
  const fenceY = swY + 2;
  for (let x = 4; x < w - 4; x++) if (tiles[fenceY]?.[x] === 'grass' && rnd() < 0.66) furniture.push({ kind: 'fence', x, y: fenceY });

  // 清掉建筑四周 1 格、及非草地上的散布装饰(栅栏除外)
  const nearB = (x: number, y: number) => buildings.some((b) => x >= b.x - 1 && x < b.x + b.w + 1 && y >= b.y - 1 && y < b.y + b.h + 1);
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (f.kind === 'fence') continue;
    if (nearB(f.x, f.y) || tiles[f.y]?.[f.x] !== 'grass') furniture.splice(i, 1);
  }

  // 落地店铺门口陈列(散布清理之后→免被剔除; mineClear 之前→孤儿道具随被拆店一起清)。门前留空格(dX)不占。
  for (const d of shopDecor) {
    if (tiles[d.y]?.[d.x] === undefined || tiles[d.y][d.x] === 'water') continue;
    if (buildings.some((b) => d.x >= b.x && d.x < b.x + b.w && d.y >= b.y && d.y < b.y + b.h)) continue;
    furniture.push(d);
  }

  // 广场点缀(水井 + 角灯 + 货箱木桶;放在清理之后免被当散布剔除)
  effects.push({ kind: 'well', x: cx, y: streetY });
  effects.push({ kind: 'lantern', x: cx - 5, y: streetY + 4 });
  effects.push({ kind: 'lantern', x: cx + 6, y: streetY + 4 });
  for (const [px, py, k] of [[cx - 5, streetY + 1, 'barrel'], [cx - 4, streetY + 1, 'crate'], [cx + 5, streetY + 1, 'crate'], [cx + 6, streetY + 1, 'barrel']] as [number, number, string][])
    furniture.push({ kind: k, x: px, y: py });

  // 东侧巨型矿洞入口：从主街右端清出石质广场，避免被商铺或散布装饰盖住。
  const mineX = w - 7;
  const mineY = streetY + 1;
  const mineClear = { x0: mineX - 8, y0: mineY - 5, x1: mineX + 3, y1: mineY + 4 };
  const inMineClear = (x: number, y: number) => x >= mineClear.x0 && x <= mineClear.x1 && y >= mineClear.y0 && y <= mineClear.y1;
  for (let i = buildings.length - 1; i >= 0; i--) {
    const b = buildings[i];
    if (b.x <= mineClear.x1 && b.x + b.w - 1 >= mineClear.x0 && b.y <= mineClear.y1 && b.y + b.h - 1 >= mineClear.y0) buildings.splice(i, 1);
  }
  for (let i = interactables.length - 1; i >= 0; i--) if (inMineClear(interactables[i].x, interactables[i].y)) interactables.splice(i, 1);
  for (let i = furniture.length - 1; i >= 0; i--) if (inMineClear(furniture[i].x, furniture[i].y)) furniture.splice(i, 1);
  for (let i = effects.length - 1; i >= 0; i--) if (inMineClear(effects[i].x, effects[i].y)) effects.splice(i, 1);
  fill(mineClear.x0, mineY - 1, mineX + 1, mineY + 1, 'cobble');
  fill(mineX - 4, mineY - 3, mineX + 2, mineY + 3, 'stone');
  for (let y = mineClear.y0; y <= mineClear.y1; y++) {
    for (let x = mineClear.x0; x <= mineClear.x1; x++) {
      if (solid[y]?.[x] !== undefined) solid[y][x] = false;
    }
  }
  effects.push({ kind: 'torch', x: mineX - 4, y: mineY - 2 });
  effects.push({ kind: 'torch', x: mineX - 4, y: mineY + 2 });
  mineObjects.push({ kind: 'mineEntrance', x: mineX, y: mineY, variant: 0 });
  interactables.push({ x: mineX, y: mineY, type: 'door', label: '进入巨型矿洞', target: 'mine:1' });

  // 公共田地（两块开放大农场，无围栏；8×3 格，可直接走入种地）
  const farmBlocks: [number, number, number, number][] = [
    [4, swY + 3, 8, 3],      // 左侧公共田地
    [w - 12, swY + 3, 8, 3], // 右侧公共田地
  ];
  for (const [fx, fy, fw, fh] of farmBlocks) {
    for (let yy = fy; yy < fy + fh; yy++) for (let xx = fx; xx < fx + fw; xx++) setT(xx, yy, 'dirt');
    // 四角路灯标识（装饰，不挡路）
    effects.push({ kind: 'lantern', x: fx - 1, y: fy - 1 });
    effects.push({ kind: 'lantern', x: fx + fw, y: fy - 1 });
  }

  // —— 南侧住宅区:带院子的多户型住宅,宽松网格排布(美式 suburb 留白) ——
  // 暖/冷屋顶交替(陶土红组 ↔ 青蓝苔绿组)看起来协调;按格确定性取户型,杜绝相邻两栋一样。
  const resWarm = ['farmhouse', 'colonial', 'ranch', 'brownstone', 'cape', 'manor', 'sandstone'];
  const resCool = ['cottagey', 'craftsman', 'saltbox', 'aframe', 'bungalow', 'slate', 'mossy'];
  const resY0 = swY + 6; // 住宅区起始行(让开后院菜圃)
  const lotW = 22; // 单宅地块宽(房 4~5 + 院 m=6 两侧 + 间距)
  const lotH = 16; // 单宅地块高(房 4~5 + 前院 m=6 + 行距)
  let lotRow = 0;
  for (let ly = resY0; ly + lotH <= h - 3; ly += lotH, lotRow++) {
    let lotCol = 0;
    for (let lx = 3; lx + lotW <= w - 3; lx += lotW, lotCol++) {
      // 地块内确定性抖动 + 选户型(相邻地块暖冷交替 + 不同 style)
      const jx = (lotRow * 3 + lotCol * 5) % 4; // 0..3 水平抖动
      const hx = lx + 7 + jx; // 院子左侧留 6 格 + 抖动
      const bh = 4 + ((lotRow + lotCol) % 2); // 4~5 高错落
      const bw = 4 + ((lotCol * 7 + lotRow) % 2); // 4~5 宽错落
      const warm = (lotRow + lotCol) % 2 === 0;
      const pool = warm ? resWarm : resCool;
      const style = pool[(hx * 13 + ly * 7 + lotRow) % pool.length];
      const hy = ly + 2;
      placeHouseWithYard(style, hx, hy, bw, bh, 6);
    }
  }
  // 住宅区每行前院门前各一条横向 cobble 主巷 + 路灯
  for (let row = 0; row < lotRow; row++) {
    const laneY = resY0 + row * lotH - 1;
    if (laneY >= 1 && laneY < h - 1) {
      for (let x = 3; x < w - 3; x++) if (tiles[laneY]?.[x] === 'grass') setT(x, laneY, 'cobble');
      for (const lx of [10, 28, cx, w - 28, w - 12]) if (tiles[laneY]?.[lx] !== undefined) effects.push({ kind: 'lantern', x: lx, y: laneY });
    }
  }
  const lane = resY0 - 1;

  // 落地院子装饰(栅栏/花/信箱)+ 角树:在散布清理之后,免被剔除;只占空草地、不压房身/小径。
  const onBuilding = (x: number, y: number) => buildings.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  for (const d of yardDecor) {
    if (tiles[d.y]?.[d.x] === undefined) continue;
    if (onBuilding(d.x, d.y)) continue; // 别压房身
    if (d.kind === 'flower' && tiles[d.y][d.x] !== 'grass') continue;
    furniture.push(d);
  }
  for (const t of yardTrees) if (tiles[t.y]?.[t.x] === 'grass' && !onBuilding(t.x, t.y)) furniture.push({ kind: 'bush', x: t.x, y: t.y });

  for (const e of effects) if (e.kind !== 'chimneySmoke' && solid[e.y]?.[e.x] !== undefined) solid[e.y][e.x] = true;
  for (const f of furniture) if (!WALKABLE.has(f.kind) && solid[f.y]?.[f.x] !== undefined) solid[f.y][f.x] = true;

  // —— 水塘边钓鱼点（沙滩最南侧，可安全到达）——
  const pondFishX = 22;
  const pondFishY = 16;
  if (tiles[pondFishY]?.[pondFishX] === 'sand' || tiles[pondFishY]?.[pondFishX] === 'grass') {
    interactables.push({ x: pondFishX, y: pondFishY, type: 'fishing', label: '垂钓（水塘边）' });
  }

  // —— 果树交互点（固定位置；已摘/已砍均跳过）——
  for (const spot of FRUIT_SPOTS) {
    if (depletedFruits?.has(spot.id) || choppedTrees?.has(spot.id)) continue;
    if (!tiles[spot.y]?.[spot.x] || solid[spot.y][spot.x]) continue;
    interactables.push({ x: spot.x, y: spot.y, type: 'fruit', label: `摘${FRUIT_LABEL[spot.kind]}`, fruitId: spot.id, fruitKind: spot.kind });
  }

  // —— 公共田地格位交互 + 作物精灵（两块开放农场）——
  const townCrops: CropSprite[] = [];
  for (let pi = 0; pi < farmBlocks.length; pi++) {
    const [fx, fy, fw, fh] = farmBlocks[pi];
    for (let row = 0; row < fh; row++) {
      for (let col = 0; col < fw; col++) {
        const slot = row * fw + col;
        const gardenId = `garden_${pi}_${slot}`;
        const xx = fx + col;
        const yy = fy + row;
        const entry = gardenState?.get(gardenId);
        const phase = entry?.phase ?? 'empty';
        interactables.push({ x: xx, y: yy, type: 'garden', label: '公共田地', gardenId });
        if (entry?.crop && phase !== 'empty' && entry.stage !== undefined) {
          townCrops.push({ x: xx, y: yy, crop: entry.crop, hash: entry.hash ?? gardenHash(gardenId), stage: entry.stage });
        }
      }
    }
  }

  // —— 四个世界入口 ——
  // 每个门口：清空区域 → 铺特色地 → 装饰 → 门交互点。
  const addPortal = (
    px: number, py: number,
    groundKind: string, clearR: number,
    deco: { fx?: { kind: string; x: number; y: number }[]; fu?: { kind: string; x: number; y: number }[] },
    label: string, target: string,
  ) => {
    // 清障
    for (let i = furniture.length - 1; i >= 0; i--) {
      const f = furniture[i];
      if (Math.abs(f.x - px) <= clearR && Math.abs(f.y - py) <= clearR) furniture.splice(i, 1);
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      if (Math.abs(e.x - px) <= clearR && Math.abs(e.y - py) <= clearR) effects.splice(i, 1);
    }
    for (let i = interactables.length - 1; i >= 0; i--) {
      const it = interactables[i];
      if (Math.abs(it.x - px) <= clearR && Math.abs(it.y - py) <= clearR) interactables.splice(i, 1);
    }
    // 铺地
    fill(px - clearR, py - clearR, px + clearR, py + clearR, groundKind);
    for (let yy = py - clearR; yy <= py + clearR; yy++)
      for (let xx = px - clearR; xx <= px + clearR; xx++)
        if (solid[yy]?.[xx] !== undefined) solid[yy][xx] = false;
    // 装饰
    for (const e of (deco.fx ?? [])) effects.push(e as EffectItem);
    for (const f of (deco.fu ?? [])) furniture.push(f as FurnitureItem);
    // 门
    interactables.push({ x: px, y: py, type: 'door', label, target });
  };

  // 森林秘境（西侧，主街以北）
  addPortal(4, streetY - 8, 'dirt', 3,
    { fx: [{ kind: 'lantern', x: 2, y: streetY - 9 }, { kind: 'lantern', x: 6, y: streetY - 9 }],
      fu: [{ kind: 'tree', x: 1, y: streetY - 9 }, { kind: 'tree', x: 7, y: streetY - 9 },
           { kind: 'bush', x: 1, y: streetY - 7 }, { kind: 'bush', x: 7, y: streetY - 7 }] },
    '进入森林秘境 →', 'forest');

  // 海滩码头（南端中央）
  addPortal(cx, h - 6, 'sand', 4,
    { fx: [{ kind: 'lantern', x: cx - 4, y: h - 8 }, { kind: 'lantern', x: cx + 4, y: h - 8 },
           { kind: 'fishHang', x: cx - 2, y: h - 9 }, { kind: 'fishHang', x: cx + 2, y: h - 9 }],
      fu: [{ kind: 'fence', x: cx - 5, y: h - 6 }, { kind: 'fence', x: cx + 5, y: h - 6 }] },
    '去海滩码头 →', 'beach');

  // 夜市广场（东北角）
  addPortal(w - 8, 10, 'cobble', 4,
    { fx: [{ kind: 'lantern', x: w - 12, y: 8 }, { kind: 'lantern', x: w - 4, y: 8 },
           { kind: 'lantern', x: w - 12, y: 12 }, { kind: 'lantern', x: w - 4, y: 12 },
           { kind: 'campfire', x: w - 8, y: 13 }],
      fu: [{ kind: 'barrel', x: w - 12, y: 10 }, { kind: 'crate', x: w - 4, y: 10 }] },
    '夜市广场 →', 'nightmarket');

  // 神秘废墟（北侧，偏右）
  addPortal(cx + 14, 6, 'stone', 3,
    { fx: [{ kind: 'torch', x: cx + 11, y: 5 }, { kind: 'torch', x: cx + 17, y: 5 }],
      fu: [{ kind: 'deadTree', x: cx + 11, y: 7 }, { kind: 'deadTree', x: cx + 17, y: 7 }] },
    '神秘废墟 →', 'ruins');

  // 软化路↔草硬边：草地靠路的格确定性嵌入路面碎块(外溢) ⇒ 路缘有机融入,不再 CAD 直角(纯视觉,不动碰撞)。
  const isPath = (tt?: string) => tt === 'cobble' || tt === 'stone';
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (tiles[y][x] !== 'grass' || solid[y][x]) continue;
    const n = isPath(tiles[y - 1]?.[x]) ? tiles[y - 1][x]
      : isPath(tiles[y + 1]?.[x]) ? tiles[y + 1][x]
      : isPath(tiles[y]?.[x - 1]) ? tiles[y][x - 1]
      : isPath(tiles[y]?.[x + 1]) ? tiles[y][x + 1] : null;
    if (n && ((x * 92821 + y * 53987) % 100) < 16) setT(x, y, n);
  }

  return { id: 'town', w, h, tiles, solid, furniture, effects, buildings, interactables, crops: townCrops, mineObjects, spawn: spawnOverride ?? { x: cx, y: streetY + 1 } };
}

/**
 * 自家农场（户外草地 + 泥畦）。仿 buildRoom/buildTown 的纯几何布局，由 farm 状态确定性渲染：
 * - 每块已解锁地块 = 一片围栏泥畦（一行 ZONE_SLOTS 个种植格）。地块上已建 farmland 区块 → 格位可种/已种/可收。
 * - 未建区块的地块 → 一个 'plot' 交互点（建区块）。
 * - 一个 'buy' 交互点（买下一块地，label 含动态地价）。
 * - 作物按 cropGrowth → cropStage 画（CropSprite），同坐标放 'crop' 交互点（成熟→收获）。
 * farm=null（尚未加载）时只画空地 + 买地入口。纯展示与交互分离：渲染走 scene.crops，动作走 interactables[].farm。
 */
export function buildFarm(farm: FarmView | null): Scene {
  const w = 26;
  const h = 20;
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < w; x++) {
      tiles[y][x] = 'grass';
      solid[y][x] = false;
    }
  }
  const furniture: FurnitureItem[] = [];
  const interactables: Interactable[] = [];
  const crops: CropSprite[] = [];
  const effects: EffectItem[] = [];

  const setT = (x: number, y: number, t: string) => { if (tiles[y]?.[x] !== undefined) tiles[y][x] = t; };

  // 回房间的门（北墙中间一格栅栏门洞）+ 边界树
  const gateX = Math.floor(w / 2);
  for (let x = 0; x < w; x++) { furniture.push({ kind: 'tree', x, y: 0 }); furniture.push({ kind: 'tree', x, y: h - 1 }); }
  for (let y = 1; y < h - 1; y++) { furniture.push({ kind: 'tree', x: 0, y }); furniture.push({ kind: 'tree', x: w - 1, y }); }
  // 门洞：清掉该格的边界树，铺小径
  furniture.splice(furniture.findIndex((f) => f.x === gateX && f.y === 0), 1);
  setT(gateX, 1, 'dirt');
  interactables.push({ x: gateX, y: 1, type: 'door', label: '回房间', target: 'room' });

  // 地块网格布局：每块占 (ZONE_SLOTS+2) 宽 × 4 高（含围栏 + 一行种植格），自上而下、左右排布。
  const plotW = ZONE_SLOTS + 2;
  const plotH = 4;
  const cols = Math.max(1, Math.floor((w - 4) / plotW));
  const startX = 2;
  const startY = 3;

  const plots = farm?.plots ?? [];
  const zonesByPlot = new Map<number, string>(); // plotN → farmland zoneId（取第一个 farmland 区块）
  for (const z of farm?.zones ?? []) if (z.type === 'farmland' && !zonesByPlot.has(z.plotN)) zonesByPlot.set(z.plotN, z.id);
  // 未收获作物：zoneId|slot → plant
  const plantBySlot = new Map<string, FarmView['plants'][number]>();
  for (const p of farm?.plants ?? []) if (!p.harvested) plantBySlot.set(`${p.zoneId}|${p.slot}`, p);
  const curH = farm?.height ?? 0;

  plots.forEach((plot, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const px = startX + col * plotW;
    const py = startY + row * plotH;
    if (py + plotH >= h - 1) return; // 超出地图就不画（极端多地块时；MVP 够用）
    // 泥畦 + 围栏
    for (let yy = py; yy < py + 2; yy++) for (let xx = px; xx < px + ZONE_SLOTS; xx++) setT(xx, yy, 'dirt');
    for (let xx = px - 1; xx <= px + ZONE_SLOTS; xx++) { furniture.push({ kind: 'fence', x: xx, y: py - 1 }); furniture.push({ kind: 'fence', x: xx, y: py + 2 }); }
    for (let yy = py; yy < py + 2; yy++) { furniture.push({ kind: 'fence', x: px - 1, y: yy }); furniture.push({ kind: 'fence', x: px + ZONE_SLOTS, y: yy }); }

    const zoneId = zonesByPlot.get(plot.n);
    if (!zoneId) {
      // 空地块（未建区块）：中间放一个建造交互点
      interactables.push({
        x: px + Math.floor(ZONE_SLOTS / 2), y: py, type: 'plot',
        label: `地块 #${plot.n}：建田地`, farm: { kind: 'plot', plotN: plot.n },
      });
      return;
    }
    // 田地区块：每个种植格一个交互点 + 作物渲染
    for (let s = 0; s < ZONE_SLOTS; s++) {
      const sx = px + s;
      const sy = py; // 作物种在畦的前排
      const pl = plantBySlot.get(`${zoneId}|${s}`);
      if (!pl) {
        interactables.push({
          x: sx, y: sy, type: 'plot',
          label: '空格：种植', farm: { kind: 'slot', plotN: plot.n, zoneId, slot: s },
        });
      } else {
        const g = cropGrowth(pl.plantHeight, curH, pl.crop);
        const stage = cropStage(g);
        const ready = g >= 1;
        crops.push({ x: sx, y: sy, crop: pl.crop, hash: pl.id, stage }); // 生长中用 plant id 当占位 hash
        interactables.push({
          x: sx, y: sy, type: 'crop',
          label: ready ? '成熟 · 收获' : `生长中 ${Math.floor(g * 100)}%`,
          farm: { kind: 'crop', plotN: plot.n, zoneId, slot: s, plantId: pl.id, crop: pl.crop, ready },
        });
      }
    }
  });

  // 买下一块地：放在已解锁地块网格“下一格”位置（或首块位置），label 含动态地价。
  const nextI = plots.length;
  const nbCol = nextI % cols;
  const nbRow = Math.floor(nextI / cols);
  const nbx = startX + nbCol * plotW + Math.floor(ZONE_SLOTS / 2);
  const nby = startY + nbRow * plotH;
  if (nby + plotH < h - 1) {
    const price = farm?.landPrice;
    interactables.push({
      x: nbx, y: nby, type: 'plot',
      label: price != null ? `开垦新地块（烧 ${price}）` : '开垦新地块',
      farm: { kind: 'buy', plotN: farm?.nextPlotN ?? 0 },
    });
    furniture.push({ kind: 'deadTree', x: nbx, y: nby }); // 未开垦的荒地标记
  }

  // 碰撞：非可踩家具挡路；作物所在格可走（站上去按 E 收获）。
  for (const f of furniture) if (!WALKABLE.has(f.kind) && solid[f.y]?.[f.x] !== undefined) solid[f.y][f.x] = true;
  // 但交互点所在格必须可达：清掉其碰撞（buy 的荒地标记除外——它在 interactable 同格之上，玩家从相邻格按 E）
  for (const it of interactables) if (it.type !== 'door' && solid[it.y]?.[it.x] !== undefined && it.farm?.kind !== 'buy') solid[it.y][it.x] = false;

  return { id: 'farm', w, h, tiles, solid, furniture, effects, buildings: [], interactables, crops, spawn: { x: gateX, y: 2 } };
}

// ────────────────────────────── 海滩 / 码头 ──────────────────────────────
export function buildBeach(): Scene {
  const w = 80;
  const h = 55;
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < w; x++) {
      tiles[y][x] = 'grass';
      solid[y][x] = false;
    }
  }
  const furniture: FurnitureItem[] = [];
  const interactables: Interactable[] = [];
  const effects: EffectItem[] = [];

  const setT = (x: number, y: number, t: string) => { if (tiles[y]?.[x] !== undefined) tiles[y][x] = t; };
  const fill = (x0: number, y0: number, x1: number, y1: number, t: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setT(x, y, t);
  };

  // 边界树林
  for (let x = 0; x < w; x++) { furniture.push({ kind: 'tree', x, y: 0 }); }
  for (let y = 1; y < h; y++) { furniture.push({ kind: 'tree', x: 0, y }); furniture.push({ kind: 'tree', x: w - 1, y }); }

  // 草地 → 沙滩过渡（y=2~18）
  fill(1, 1, w - 2, 17, 'grass');
  for (let y = 8; y <= 17; y++) {
    const t = y >= 14 ? 'sand' : 'grass';
    fill(1, y, w - 2, y, t);
    // 草/沙交界抖动
    if (y >= 11 && y <= 14) {
      for (let x = 1; x < w - 1; x++) {
        const h2 = ((x * 131 + y * 977) % 5);
        if ((y === 11 && h2 < 2) || (y === 13 && h2 >= 3) || (y === 12 && h2 < 3)) setT(x, y, 'sand');
      }
    }
  }

  // 沙滩主体（y=14~29）
  fill(1, 14, w - 2, 29, 'sand');
  // 海岸湿沙带（沙↔水交界，潮湿一档 + 贝壳碎）
  fill(1, 28, w - 2, 29, 'sandWet');

  // 海洋（y=30~h-1）：浅水 y=30~33，深水 y=34+
  fill(1, 30, w - 2, h - 1, 'water');
  for (let y = 30; y < h; y++) for (let x = 1; x < w - 1; x++) solid[y][x] = true;

  // 码头栈桥（木栈道，从沙滩延伸入海）
  const dockX = Math.floor(w / 2) - 2;
  const dockW = 5;
  fill(dockX, 22, dockX + dockW - 1, 36, 'plank');
  for (let y = 22; y <= 36; y++) for (let x = dockX; x < dockX + dockW; x++) solid[y][x] = false;
  // 码头木桩（两侧每 3 格一根，替代占位围栏）
  for (let y = 22; y <= 35; y += 3) {
    furniture.push({ kind: 'piling', x: dockX - 1, y });
    furniture.push({ kind: 'piling', x: dockX + dockW, y });
  }
  // 码头路灯
  for (const ly of [24, 28, 32]) {
    effects.push({ kind: 'lantern', x: dockX - 1, y: ly });
    effects.push({ kind: 'lantern', x: dockX + dockW, y: ly });
  }
  // 码头末端钓鱼点
  interactables.push({ x: dockX + 2, y: 36, type: 'fishing', label: '码头垂钓' });

  // 沙滩上的装饰：贝壳/漂流木/灌木/椰树
  const beachDecor = [
    { kind: 'bush', x: 8, y: 18 }, { kind: 'bush', x: 68, y: 19 },
    { kind: 'bush', x: 15, y: 22 }, { kind: 'bush', x: 60, y: 21 },
    { kind: 'tree', x: 6, y: 16 }, { kind: 'tree', x: 70, y: 16 },
    { kind: 'tree', x: 10, y: 14 }, { kind: 'tree', x: 65, y: 14 },
    { kind: 'shell', x: 20, y: 27 }, { kind: 'shell', x: 55, y: 26 },
    { kind: 'shell', x: 30, y: 28 }, { kind: 'shell', x: 45, y: 27 },
    { kind: 'shell', x: 26, y: 25 }, { kind: 'shell', x: 50, y: 24 }, { kind: 'shell', x: 38, y: 29 },
    { kind: 'driftwood', x: 16, y: 26 }, { kind: 'driftwood', x: 62, y: 25 },
    // 收获箱
    { kind: 'crate', x: 8, y: 20 }, { kind: 'barrel', x: 9, y: 20 },
    { kind: 'crate', x: 68, y: 20 }, { kind: 'barrel', x: 67, y: 20 },
  ];
  for (const d of beachDecor) furniture.push(d as FurnitureItem);

  // 沙滩两侧钓鱼点（岸边）
  interactables.push({ x: 5, y: 29, type: 'fishing', label: '岸边垂钓（西）' });
  interactables.push({ x: 72, y: 29, type: 'fishing', label: '岸边垂钓（东）' });

  // 悬挂鱼装饰
  effects.push({ kind: 'fishHang', x: 10, y: 18 });
  effects.push({ kind: 'fishHang', x: 66, y: 18 });
  // 篝火（沙滩）
  effects.push({ kind: 'campfire', x: 20, y: 22 });
  effects.push({ kind: 'campfire', x: 56, y: 22 });

  // 回镇入口
  const backX = Math.floor(w / 2);
  fill(backX - 1, 1, backX + 1, 3, 'cobble');
  interactables.push({ x: backX, y: 1, type: 'door', label: '← 回镇中心', target: 'town' });

  for (const f of furniture) if (!WALKABLE.has(f.kind) && solid[f.y]?.[f.x] !== undefined) solid[f.y][f.x] = true;
  for (const e of effects) if (!(['fishHang', 'chimneySmoke'] as string[]).includes(e.kind) && solid[e.y]?.[e.x] !== undefined) solid[e.y][e.x] = true;

  return { id: 'beach', w, h, tiles, solid, furniture, effects, buildings: [], interactables, spawn: { x: backX, y: 4 } };
}

// ────────────────────────────── 森林秘境 ──────────────────────────────
export function buildForest(): Scene {
  const w = 80;
  const h = 60;
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < w; x++) {
      tiles[y][x] = 'grass';
      solid[y][x] = false;
    }
  }
  const furniture: FurnitureItem[] = [];
  const interactables: Interactable[] = [];
  const effects: EffectItem[] = [];

  const setT = (x: number, y: number, t: string) => { if (tiles[y]?.[x] !== undefined) tiles[y][x] = t; };
  const fill = (x0: number, y0: number, x1: number, y1: number, t: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setT(x, y, t);
  };

  let seed = 83741;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  // 边界实体树墙
  for (let x = 0; x < w; x++) { furniture.push({ kind: 'tree', x, y: 0 }); furniture.push({ kind: 'tree', x, y: h - 1 }); }
  for (let y = 1; y < h - 1; y++) { furniture.push({ kind: 'tree', x: 0, y }); furniture.push({ kind: 'tree', x: w - 1, y }); }

  // 林地苔藓地面（整片铺 grassForest，随后由小径/空地/水潭覆盖；空地保留亮草作对比）
  fill(0, 0, w - 1, h - 1, 'grassForest');

  // 密林散布（大量树/灌木）
  for (let i = 0; i < 400; i++) {
    const x = 2 + Math.floor(rnd() * (w - 4));
    const y = 2 + Math.floor(rnd() * (h - 4));
    const r = rnd();
    furniture.push({ kind: r < 0.55 ? 'tree' : r < 0.75 ? 'bush' : r < 0.9 ? 'deadTree' : 'flower', x, y });
  }

  // 几条蜿蜒泥土小径（从入口向各方向延伸）
  const cxF = Math.floor(w / 2);
  const cyF = Math.floor(h / 2);
  // 中央小径（南北）
  for (let y = 4; y < h - 4; y++) setT(cxF, y, 'dirt');
  // 横向小径（中央附近）
  for (let x = 4; x < w - 4; x++) setT(x, cyF, 'dirt');
  // 斜径（西北 → 中央）
  for (let i = 0; i < 20; i++) { setT(cxF - 10 + i, cyF - 8 + Math.floor(i * 0.4), 'dirt'); }
  // 斜径（东北 → 中央）
  for (let i = 0; i < 18; i++) { setT(cxF + 6 + i, cyF - 6 + Math.floor(i * 0.3), 'dirt'); }

  // 清掉小径上的树
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (tiles[f.y]?.[f.x] === 'dirt') furniture.splice(i, 1);
  }

  // 中央林间空地（篝火 + 水池）
  fill(cxF - 4, cyF - 3, cxF + 4, cyF + 3, 'grass');
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (Math.abs(f.x - cxF) <= 5 && Math.abs(f.y - cyF) <= 4) furniture.splice(i, 1);
  }
  // 林间水潭（西侧空地）
  const pondX = cxF - 18, pondY = cyF + 5;
  for (let y = pondY - 4; y <= pondY + 4; y++)
    for (let x = pondX - 6; x <= pondX + 6; x++) {
      const dx = (x - pondX) / 1.2, dy = y - pondY;
      if (dx * dx + dy * dy < 20) { setT(x, y, 'water'); solid[y][x] = true; }
      else if (dx * dx + dy * dy < 26 && tiles[y]?.[x] === 'grass') setT(x, y, 'sand');
    }

  effects.push({ kind: 'campfire', x: cxF, y: cyF });
  effects.push({ kind: 'well', x: cxF + 3, y: cyF - 1 });
  for (const lx of [cxF - 3, cxF + 3]) effects.push({ kind: 'lantern', x: lx, y: cyF - 2 });

  // 果树（隐藏在林中）
  const forestFruits: { x: number; y: number; id: string; kind: FruitKind }[] = [
    { x: cxF - 12, y: cyF + 8, id: 'ff_berry', kind: 'berry' },
    { x: cxF + 14, y: cyF - 10, id: 'ff_apple', kind: 'apple' },
    { x: cxF + 8, y: cyF + 12, id: 'ff_golden', kind: 'golden_apple' },
  ];
  for (const spot of forestFruits) {
    if (tiles[spot.y]?.[spot.x] && !solid[spot.y][spot.x]) {
      setT(spot.x, spot.y, 'grass');
      interactables.push({ x: spot.x, y: spot.y, type: 'fruit', label: `摘${FRUIT_LABEL[spot.kind]}`, fruitId: spot.id, fruitKind: spot.kind });
    }
  }

  // 钓鱼（水潭边）
  interactables.push({ x: pondX + 7, y: pondY, type: 'fishing', label: '林间水潭垂钓' });

  // 立石圈（神秘遗迹感，专属立石替代占位枯树）
  const circleX = cxF + 16, circleY = cyF + 10;
  for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, -1], [-1, 1], [1, 1]])
    furniture.push({ kind: 'standingStone', x: circleX + ox, y: circleY + oy });
  effects.push({ kind: 'torch', x: circleX, y: circleY });

  // 回镇入口（北侧中央）
  const backX = cxF;
  for (let y = 1; y <= 4; y++) setT(backX, y, 'dirt');
  // 清掉入口树
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (Math.abs(f.x - backX) <= 1 && f.y <= 4) furniture.splice(i, 1);
  }
  effects.push({ kind: 'lantern', x: backX - 2, y: 2 });
  effects.push({ kind: 'lantern', x: backX + 2, y: 2 });
  interactables.push({ x: backX, y: 1, type: 'door', label: '← 回镇中心', target: 'town' });

  for (const f of furniture) if (!WALKABLE.has(f.kind) && solid[f.y]?.[f.x] !== undefined) solid[f.y][f.x] = true;
  for (const e of effects) if (solid[e.y]?.[e.x] !== undefined) solid[e.y][e.x] = true;

  return { id: 'forest', w, h, tiles, solid, furniture, effects, buildings: [], interactables, spawn: { x: backX, y: 3 } };
}

// ────────────────────────────── 夜市 / 集市 ──────────────────────────────
export function buildNightMarket(): Scene {
  const w = 88;
  const h = 60;
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < w; x++) {
      tiles[y][x] = 'cobble';
      solid[y][x] = false;
    }
  }
  const furniture: FurnitureItem[] = [];
  const interactables: Interactable[] = [];
  const effects: EffectItem[] = [];
  const buildings: BuildingItem[] = [];

  const setT = (x: number, y: number, t: string) => { if (tiles[y]?.[x] !== undefined) tiles[y][x] = t; };
  const fill = (x0: number, y0: number, x1: number, y1: number, t: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setT(x, y, t);
  };

  let seed = 54321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

  // 边界树墙
  for (let x = 0; x < w; x++) { furniture.push({ kind: 'tree', x, y: 0 }); furniture.push({ kind: 'tree', x, y: h - 1 }); }
  for (let y = 1; y < h - 1; y++) { furniture.push({ kind: 'tree', x: 0, y }); furniture.push({ kind: 'tree', x: w - 1, y }); }

  const cx = Math.floor(w / 2);

  // 地面：鹅卵石 + 石板中央广场
  fill(cx - 10, 22, cx + 10, 38, 'stone'); // 中央表演广场

  // 入口大道（南北向）
  fill(cx - 2, 1, cx + 2, h - 2, 'cobble');

  // 横向主街（两条）
  fill(4, 14, w - 5, 16, 'cobble');
  fill(4, 38, w - 5, 40, 'cobble');

  // 摊位行（商业建筑, 四排）
  const stallStyles = ['grocer', 'bakery', 'florist', 'tailor', 'apothecary', 'shop', 'postoffice'];
  // 北排摊位
  let bx = 6;
  while (bx < w - 8) {
    const style = pick(stallStyles);
    buildings.push({ style, x: bx, y: 5, w: 4, h: 5, variant: (bx * 7) % 8 });
    const { doorCol } = buildingMeta(4);
    for (let yy = 5; yy < 10; yy++) for (let xx = bx; xx < bx + 4; xx++) if (solid[yy]?.[xx] !== undefined) solid[yy][xx] = true;
    interactables.push({ x: bx + doorCol, y: 9, type: 'door', label: style, target: `npc:${style}` });
    if (solid[10]?.[bx + doorCol] !== undefined) solid[10][bx + doorCol] = false;
    bx += 7 + Math.floor(rnd() * 2);
  }
  // 南排摊位（面向南侧横街）
  bx = 6;
  while (bx < w - 8) {
    const style = pick(stallStyles);
    buildings.push({ style, x: bx, y: 42, w: 4, h: 5, variant: (bx * 5) % 8 });
    const { doorCol } = buildingMeta(4);
    for (let yy = 42; yy < 47; yy++) for (let xx = bx; xx < bx + 4; xx++) if (solid[yy]?.[xx] !== undefined) solid[yy][xx] = true;
    interactables.push({ x: bx + doorCol, y: 46, type: 'door', label: style, target: `npc:${style}` });
    if (solid[47]?.[bx + doorCol] !== undefined) solid[47][bx + doorCol] = false;
    bx += 7 + Math.floor(rnd() * 2);
  }

  // 中央广场：大型篝火 + 喷泉 + 表演区路灯
  effects.push({ kind: 'campfire', x: cx - 5, y: 30 });
  effects.push({ kind: 'fountain', x: cx + 5, y: 30 });
  effects.push({ kind: 'well', x: cx, y: 25 });
  interactables.push({ x: cx, y: 32, type: 'board', label: '集市名册' });
  for (const [lx, ly] of [[cx - 8, 23], [cx + 8, 23], [cx - 8, 37], [cx + 8, 37]])
    effects.push({ kind: 'lantern', x: lx, y: ly });
  // 条纹布棚货摊（广场两侧，给夜市自己的货摊辨识度）
  for (const sy of [24, 30, 36]) { furniture.push({ kind: 'stall', x: cx - 9, y: sy }); furniture.push({ kind: 'stall', x: cx + 9, y: sy }); }

  // 灯笼成排（主街两侧）
  for (let lx = 6; lx < w - 6; lx += 6) {
    effects.push({ kind: 'lantern', x: lx, y: 13 });
    effects.push({ kind: 'lantern', x: lx, y: 17 });
    effects.push({ kind: 'lantern', x: lx, y: 37 });
    effects.push({ kind: 'lantern', x: lx, y: 41 });
  }

  // 货物堆（桶/箱随机散落）
  for (let i = 0; i < 20; i++) {
    const x = 5 + Math.floor(rnd() * (w - 10));
    const y = 18 + Math.floor(rnd() * 20);
    if (tiles[y]?.[x] === 'cobble' || tiles[y]?.[x] === 'stone') {
      furniture.push({ kind: rnd() < 0.5 ? 'barrel' : 'crate', x, y });
    }
  }

  // 清掉建筑四周散布（桶/箱）
  const nearBldg = (x: number, y: number) => buildings.some((b) => x >= b.x - 1 && x < b.x + b.w + 1 && y >= b.y - 1 && y < b.y + b.h + 1);
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (f.kind !== 'tree' && nearBldg(f.x, f.y)) furniture.splice(i, 1);
  }

  // 回镇入口（北侧中央）
  const backX = cx;
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (Math.abs(f.x - backX) <= 2 && f.y <= 3) furniture.splice(i, 1);
  }
  effects.push({ kind: 'lantern', x: backX - 3, y: 2 });
  effects.push({ kind: 'lantern', x: backX + 3, y: 2 });
  interactables.push({ x: backX, y: 1, type: 'door', label: '← 回镇中心', target: 'town' });

  for (const e of effects) if (solid[e.y]?.[e.x] !== undefined) solid[e.y][e.x] = true;
  for (const f of furniture) if (!WALKABLE.has(f.kind) && solid[f.y]?.[f.x] !== undefined) solid[f.y][f.x] = true;

  return { id: 'nightmarket', w, h, tiles, solid, furniture, effects, buildings, interactables, spawn: { x: backX, y: 3 } };
}

// ────────────────────────────── 废墟 / 遗迹 ──────────────────────────────
export function buildRuins(): Scene {
  const w = 80;
  const h = 58;
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < w; x++) {
      tiles[y][x] = 'grass';
      solid[y][x] = false;
    }
  }
  const furniture: FurnitureItem[] = [];
  const interactables: Interactable[] = [];
  const effects: EffectItem[] = [];

  const setT = (x: number, y: number, t: string) => { if (tiles[y]?.[x] !== undefined) tiles[y][x] = t; };
  const fill = (x0: number, y0: number, x1: number, y1: number, t: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setT(x, y, t);
  };

  let seed = 99271;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const cx = Math.floor(w / 2);

  // 边界树墙
  for (let x = 0; x < w; x++) { furniture.push({ kind: 'tree', x, y: 0 }); furniture.push({ kind: 'tree', x, y: h - 1 }); }
  for (let y = 1; y < h - 1; y++) { furniture.push({ kind: 'tree', x: 0, y }); furniture.push({ kind: 'tree', x: w - 1, y }); }

  // 废墟石板地（大片，裂石变体：裂缝 + 缝隙青苔 + 缺块露土）
  fill(8, 8, w - 9, h - 9, 'stoneRuins');

  // 草丛侵蚀（废墟已被植被覆盖的感觉）
  for (let i = 0; i < 200; i++) {
    const x = 9 + Math.floor(rnd() * (w - 18));
    const y = 9 + Math.floor(rnd() * (h - 18));
    if (tiles[y]?.[x] === 'stoneRuins') setT(x, y, 'grass');
  }

  // 残破城墙段（实体障碍）
  const walls: [number, number, number, number][] = [
    [10, 10, 18, 12], [12, 20, 14, 32], [8, 38, 20, 40],
    [60, 10, 70, 12], [64, 20, 66, 32], [58, 38, 70, 40],
    [30, 12, 32, 26], [46, 12, 50, 26],
    [28, 42, 50, 44],
  ];
  for (const [x0, y0, x1, y1] of walls) {
    fill(x0, y0, x1, y1, 'stone');
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (solid[y]?.[x] !== undefined) solid[y][x] = true;
    // 墙头碎石堆（残破感）
    if (rnd() < 0.6) furniture.push({ kind: 'rubble', x: x0, y: y0 });
    if (rnd() < 0.6) furniture.push({ kind: 'rubble', x: x1, y: y1 });
  }

  // 水坑（水患遗留）
  const pools: [number, number, number, number][] = [
    [22, 28, 28, 34], [50, 28, 58, 34],
  ];
  for (const [x0, y0, x1, y1] of pools) {
    fill(x0, y0, x1, y1, 'water');
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) solid[y][x] = true;
    // 沙岸
    for (const [sx, sy] of [[x0 - 1, y0], [x1 + 1, y0], [x0, y0 - 1], [x0, y1 + 1]])
      if (tiles[sy]?.[sx] === 'grass' || tiles[sy]?.[sx] === 'stone') setT(sx, sy, 'sand');
  }

  // 中央主殿废墟（广场 + 柱子）
  fill(cx - 8, 22, cx + 8, 36, 'stoneRuins');
  // 残破石柱（专属断柱替代占位枯树）
  for (const [ox, oy] of [[-6, 24], [6, 24], [-6, 34], [6, 34], [-6, 29], [6, 29]])
    furniture.push({ kind: 'brokenColumn', x: cx + ox, y: oy });
  // 废墟祭坛（barrel 模拟）
  furniture.push({ kind: 'chest', x: cx, y: 28 });
  effects.push({ kind: 'torch', x: cx - 2, y: 27 });
  effects.push({ kind: 'torch', x: cx + 2, y: 27 });
  interactables.push({ x: cx, y: 28, type: 'mine_chest', label: '古老祭坛', mine: { kind: 'chest', id: 'ruins_altar', depth: 0, x: cx, y: 28 } });

  // 隐藏宝箱（藏在废墙后）
  furniture.push({ kind: 'chest', x: 14, y: 25 });
  interactables.push({ x: 14, y: 25, type: 'mine_chest', label: '锈迹斑斑的箱子', mine: { kind: 'chest', id: 'ruins_box_w', depth: 0, x: 14, y: 25 } });
  furniture.push({ kind: 'chest', x: 63, y: 25 });
  interactables.push({ x: 63, y: 25, type: 'mine_chest', label: '锈迹斑斑的箱子', mine: { kind: 'chest', id: 'ruins_box_e', depth: 0, x: 63, y: 25 } });

  // 散布枯树 + 灌木（废墟植被覆盖）
  for (let i = 0; i < 80; i++) {
    const x = 2 + Math.floor(rnd() * (w - 4));
    const y = 2 + Math.floor(rnd() * (h - 4));
    if (tiles[y]?.[x] === 'grass') furniture.push({ kind: rnd() < 0.4 ? 'deadTree' : 'bush', x, y });
  }

  // 火把（废墟入口两侧）
  effects.push({ kind: 'torch', x: cx - 2, y: 8 });
  effects.push({ kind: 'torch', x: cx + 2, y: 8 });

  // 回镇入口（北侧）
  const backX = cx;
  fill(backX - 1, 1, backX + 1, 5, 'cobble');
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (Math.abs(f.x - backX) <= 2 && f.y <= 6) furniture.splice(i, 1);
  }
  for (let y = 1; y <= 5; y++) for (let x = backX - 1; x <= backX + 1; x++) if (solid[y]?.[x] !== undefined) solid[y][x] = false;
  interactables.push({ x: backX, y: 1, type: 'door', label: '← 回镇中心', target: 'town' });

  for (const f of furniture) if (!WALKABLE.has(f.kind) && solid[f.y]?.[f.x] !== undefined) solid[f.y][f.x] = true;
  for (const e of effects) if (solid[e.y]?.[e.x] !== undefined) solid[e.y][e.x] = true;
  // 宝箱/祭坛交互点的格子必须可走
  for (const it of interactables) if (it.type === 'mine_chest' && solid[it.y]?.[it.x] !== undefined) solid[it.y][it.x] = false;

  return { id: 'ruins', w, h, tiles, solid, furniture, effects, buildings: [], interactables, spawn: { x: backX, y: 4 } };
}
