// 场景 = 瓦片地图 + 碰撞 + 家具 + 动态物件 + 可交互点 + 出生点。瓦片名对应 tileset 的键。
import type { FurnitureKind } from './sprites.js';
import type { EffectItem } from './effects.js';
import { buildingMeta, BUILDING_STYLES, type BuildingItem } from './buildings.js';
import { ROOM_THEMES, WALKABLE, type RoomThemeId } from './tileset.js';

export interface FurnitureItem {
  kind: FurnitureKind;
  x: number;
  y: number;
}
export type InteractType = 'door' | 'pedestal' | 'board' | 'fishing';
export interface Interactable {
  x: number;
  y: number;
  type: InteractType;
  label: string;
  target?: string; // door：目标场景 id
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
  spawn: { x: number; y: number };
  petAnchor?: { x: number; y: number }; // 崽站位（基座前）
}

/** 默认起始布置（新玩家、或还没发布过房间时）。编辑器发布后用用户布局替换。 */
export const DEFAULT_ROOM_FURNITURE: FurnitureItem[] = [
  { kind: 'bed', x: 9, y: 1 },
  { kind: 'dresser', x: 1, y: 1 },
  { kind: 'bookshelf', x: 10, y: 3 },
  { kind: 'plant', x: 1, y: 6 },
  { kind: 'table', x: 4, y: 5 },
  { kind: 'chair', x: 3, y: 5 },
  { kind: 'rug', x: 6, y: 5 },
  { kind: 'lamp', x: 10, y: 6 },
  { kind: 'clock', x: 5, y: 1 },
];

/**
 * 你的房间（阶段 0，小 interior）。theme 决定地板/墙体材质（木屋/石厅/暖居）。
 * furniture = 当前布局（编辑器的唯一真相，pedestal 固定附加）。空数组 = 空房间。
 */
export function buildRoom(furniture: FurnitureItem[] = DEFAULT_ROOM_FURNITURE, theme: RoomThemeId = 'wood'): Scene {
  const th = ROOM_THEMES[theme];
  const w = 12;
  const h = 9;
  const doorX = 6;
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
        if (x === doorX) t = th.floor; // 门洞露地板
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
export function buildTown(): Scene {
  const w = 96; // 加宽:容下更松散的住宅区
  const h = 78; // 加高:南侧扩出一片带院子的住宅区
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
  fill(2, streetY, w - 3, streetY + 2, 'cobble');
  fill(cx, 3, cx + 1, h - 4, 'cobble');
  fill(2, swY, w - 3, swY, 'cobble');
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

  // —— 放建筑助手(挡路 + 门/摊交互 + 门前留空 + 炊烟) ——
  const place = (style: string, x: number, y: number, bw: number, bh: number) => {
    if (x < 1 || x + bw > w - 1) return;
    buildings.push({ style, x, y, w: bw, h: bh, variant: (x * 7 + bh * 3) % 8 });
    const { doorCol, chimneyCol } = buildingMeta(bw);
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) if (solid[yy]?.[xx] !== undefined) solid[yy][xx] = true;
    const st = BUILDING_STYLES[style];
    const dX = x + doorCol;
    const dY = y + bh - 1;
    interactables.push({ x: dX, y: dY, type: st?.open ? 'fishing' : 'door', label: st?.open ? '钓鱼' : '进屋', target: st?.open ? undefined : 'room' });
    if (solid[dY + 1]?.[dX] !== undefined) solid[dY + 1][dX] = false;
    if (st?.chimney) effects.push({ kind: 'chimneySmoke', x: x + chimneyCol, y: y + 1 });
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

  // —— 边界高树 + 散布树/灌木/花 ——
  for (let x = 0; x < w; x++) { furniture.push({ kind: 'tree', x, y: 0 }); furniture.push({ kind: 'tree', x, y: h - 1 }); }
  for (let y = 1; y < h - 1; y++) { furniture.push({ kind: 'tree', x: 0, y }); furniture.push({ kind: 'tree', x: w - 1, y }); }
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

  // 广场点缀(水井 + 角灯 + 货箱木桶;放在清理之后免被当散布剔除)
  effects.push({ kind: 'well', x: cx, y: streetY });
  effects.push({ kind: 'lantern', x: cx - 5, y: streetY + 4 });
  effects.push({ kind: 'lantern', x: cx + 6, y: streetY + 4 });
  for (const [px, py, k] of [[cx - 5, streetY + 1, 'barrel'], [cx - 4, streetY + 1, 'crate'], [cx + 5, streetY + 1, 'crate'], [cx + 6, streetY + 1, 'barrel']] as [number, number, string][])
    furniture.push({ kind: k, x: px, y: py });

  // 后院菜圃(围栏 + 土畦 + 作物花;放清理后免被剔除)。读作房前/屋后的小园子。
  for (const [gx, gy] of [[9, swY + 3], [26, swY + 3], [w - 30, swY + 3], [w - 15, swY + 3]] as [number, number][]) {
    for (let yy = gy; yy < gy + 2; yy++) for (let xx = gx; xx < gx + 4; xx++) setT(xx, yy, 'dirt');
    for (let xx = gx - 1; xx <= gx + 4; xx++) { furniture.push({ kind: 'fence', x: xx, y: gy - 1 }); furniture.push({ kind: 'fence', x: xx, y: gy + 2 }); }
    for (let yy = gy; yy < gy + 2; yy++) { furniture.push({ kind: 'fence', x: gx - 1, y: yy }); furniture.push({ kind: 'fence', x: gx + 4, y: yy }); }
    for (let yy = gy; yy < gy + 2; yy++) for (let xx = gx; xx < gx + 4; xx++) if (((xx + yy) & 1) === 0) furniture.push({ kind: 'flower', x: xx, y: yy });
  }

  // —— 南侧住宅区:带院子的多户型住宅,宽松网格排布(美式 suburb 留白) ——
  // 暖/冷屋顶交替(陶土红组 ↔ 青蓝苔绿组)看起来协调;按格确定性取户型,杜绝相邻两栋一样。
  const resWarm = ['farmhouse', 'colonial', 'ranch', 'brownstone', 'cape', 'manor', 'sandstone'];
  const resCool = ['cottagey', 'craftsman', 'saltbox', 'aframe', 'bungalow', 'slate', 'mossy'];
  const resY0 = swY + 6; // 住宅区起始行(让开后院菜圃)
  const lotW = 13; // 单宅地块宽(房 4~5 + 院 + 间距)
  const lotH = 11; // 单宅地块高(房 4 + 前院 + 行距)
  let lotRow = 0;
  for (let ly = resY0; ly + lotH <= h - 3; ly += lotH, lotRow++) {
    let lotCol = 0;
    for (let lx = 3; lx + lotW <= w - 3; lx += lotW, lotCol++) {
      // 地块内确定性抖动 + 选户型(相邻地块暖冷交替 + 不同 style)
      const jx = (lotRow * 3 + lotCol * 5) % 3; // 0..2 水平抖动
      const hx = lx + 1 + jx;
      const bh = 4 + ((lotRow + lotCol) % 2); // 4~5 高错落
      const bw = 4 + ((lotCol * 7 + lotRow) % 2); // 4~5 宽错落
      const warm = (lotRow + lotCol) % 2 === 0;
      const pool = warm ? resWarm : resCool;
      const style = pool[(hx * 13 + ly * 7 + lotRow) % pool.length];
      const hy = ly + 2;
      placeHouseWithYard(style, hx, hy, bw, bh, 2);
    }
  }
  // 住宅区一条主巷(横向 cobble,串起各前院门)+ 几盏路灯
  const lane = resY0 - 1;
  for (let x = 3; x < w - 3; x++) if (tiles[lane]?.[x] === 'grass') setT(x, lane, 'cobble');
  for (const lx of [10, 28, cx, w - 28, w - 12]) if (tiles[lane]?.[lx] !== undefined) effects.push({ kind: 'lantern', x: lx, y: lane });

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

  return { id: 'town', w, h, tiles, solid, furniture, effects, buildings, interactables, spawn: { x: cx, y: streetY + 1 } };
}
