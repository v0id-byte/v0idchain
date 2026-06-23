import { MINE_KIND_META, type MineAssetKind } from '@v0idchain/core/browser';
import type { Interactable, MineObject, Scene } from './scene.js';

export interface MineLayerState {
  mined: ReadonlySet<string>;
  openedChests: ReadonlySet<string>;
  defeatedMonsters: ReadonlySet<string>;
}

const W = 92;
const H = 68;

export function mineTileKey(depth: number, x: number, y: number): string {
  return `${depth}:${x}:${y}`;
}

function hashInt(depth: number, x: number, y: number, salt = 0): number {
  let h = Math.imul(depth + 0x9e3779b9, 374761393) ^ Math.imul(x + salt * 17, 668265263) ^ Math.imul(y + 13, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function hash01(depth: number, x: number, y: number, salt = 0): number {
  return hashInt(depth, x, y, salt) / 4294967296;
}

function carve(floor: boolean[][], cx: number, cy: number, rx: number, ry = rx) {
  for (let y = Math.max(1, cy - ry); y <= Math.min(H - 2, cy + ry); y++) {
    for (let x = Math.max(1, cx - rx); x <= Math.min(W - 2, cx + rx); x++) {
      const dx = (x - cx) / Math.max(1, rx);
      const dy = (y - cy) / Math.max(1, ry);
      if (dx * dx + dy * dy <= 1.15) floor[y][x] = true;
    }
  }
}

function buildFloor(depth: number): { floor: boolean[][]; up: { x: number; y: number }; down: { x: number; y: number } } {
  const floor = Array.from({ length: H }, () => Array.from({ length: W }, () => false));
  const up = { x: Math.floor(W / 2), y: H - 7 };
  const down = { x: Math.floor(W / 2) + ((depth % 5) - 2) * 3, y: 6 };
  carve(floor, up.x, up.y, 4, 3);
  carve(floor, down.x, down.y, 4, 3);

  let x = up.x;
  for (let y = up.y; y >= down.y; y--) {
    const drift = Math.round(Math.sin((y + depth * 11) * 0.23) * 5 + (hash01(depth, y, x, 1) - 0.5) * 3);
    x = Math.max(5, Math.min(W - 6, x + Math.sign(down.x + drift - x)));
    carve(floor, x, y, 2 + (hashInt(depth, x, y, 2) % 2), 2);
  }

  for (let i = 0; i < 18 + depth * 2; i++) {
    const roomX = 6 + (hashInt(depth, i, 3, 3) % (W - 12));
    const roomY = 6 + (hashInt(depth, i, 7, 4) % (H - 16));
    carve(floor, roomX, roomY, 3 + (hashInt(depth, i, 11, 5) % 6), 2 + (hashInt(depth, i, 13, 6) % 5));
    let tx = roomX;
    let ty = roomY;
    const targetX = Math.floor(W / 2 + Math.sin((roomY + depth) * 0.25) * 9);
    while (Math.abs(tx - targetX) + Math.abs(ty - up.y) > 4) {
      carve(floor, tx, ty, 1, 1);
      if (hash01(depth, tx, ty, 7) < 0.55) tx += Math.sign(targetX - tx);
      else ty += Math.sign(up.y - ty);
      tx = Math.max(2, Math.min(W - 3, tx));
      ty = Math.max(2, Math.min(H - 3, ty));
    }
  }

  return { floor, up, down };
}

function adjacentFloor(floor: boolean[][], x: number, y: number): boolean {
  return !!(floor[y - 1]?.[x] || floor[y + 1]?.[x] || floor[y]?.[x - 1] || floor[y]?.[x + 1]);
}

function oreAt(depth: number, x: number, y: number): MineAssetKind | null {
  const chance = Math.min(0.18, 0.07 + depth * 0.012);
  if (hash01(depth, x, y, 20) > chance) return null;
  const available = (Object.keys(MINE_KIND_META) as MineAssetKind[]).filter((k) => MINE_KIND_META[k].minDepth <= depth);
  const roll = hash01(depth, x, y, 21);
  const weights = available.map((k) => 1 / (MINE_KIND_META[k].tier * MINE_KIND_META[k].tier));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < available.length; i++) {
    acc += weights[i] / total;
    if (roll <= acc) return available[i];
  }
  return available[available.length - 1] ?? 'copper';
}

export function buildMine(depth: number, state: MineLayerState): Scene {
  const d = Math.max(1, Math.trunc(depth));
  const { floor, up, down } = buildFloor(d);
  const tiles: string[][] = [];
  const solid: boolean[][] = [];
  const interactables: Interactable[] = [];
  const mineObjects: MineObject[] = [];

  for (let y = 0; y < H; y++) {
    tiles[y] = [];
    solid[y] = [];
    for (let x = 0; x < W; x++) {
      const key = mineTileKey(d, x, y);
      const open = floor[y][x] || state.mined.has(key);
      tiles[y][x] = open ? 'caveFloor' : 'caveWall';
      solid[y][x] = !open || x === 0 || y === 0 || x === W - 1 || y === H - 1;
    }
  }

  const addWallInteractable = (x: number, y: number, oreKind: MineAssetKind | null) => {
    const key = mineTileKey(d, x, y);
    const mine = { kind: oreKind ? 'ore' as const : 'rock' as const, id: key, depth: d, x, y, oreKind: oreKind ?? undefined };
    interactables.push({
      x,
      y,
      type: oreKind ? 'mine_ore' : 'mine_rock',
      label: oreKind ? `开采${MINE_KIND_META[oreKind].label}` : '凿开岩壁',
      mine,
    });
    if (oreKind) mineObjects.push({ kind: 'ore', x, y, oreKind, variant: hashInt(d, x, y, 22) % 4 });
  };

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const key = mineTileKey(d, x, y);
      if (floor[y][x] || state.mined.has(key) || !adjacentFloor(floor, x, y)) continue;
      addWallInteractable(x, y, oreAt(d, x, y));
    }
  }

  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      if (!floor[y][x]) continue;
      if (Math.abs(x - up.x) + Math.abs(y - up.y) < 8 || Math.abs(x - down.x) + Math.abs(y - down.y) < 8) continue;
      const key = mineTileKey(d, x, y);
      if (!state.openedChests.has(key) && hash01(d, x, y, 40) < 0.0028) {
        mineObjects.push({ kind: 'chest', x, y, variant: hashInt(d, x, y, 41) % 3 });
        interactables.push({ x, y, type: 'mine_chest', label: '打开宝箱', mine: { kind: 'chest', id: key, depth: d, x, y } });
      } else if (!state.defeatedMonsters.has(key) && hash01(d, x, y, 50) < 0.004 + d * 0.0007) {
        mineObjects.push({ kind: 'monster', x, y, variant: hashInt(d, x, y, 51) % 4 });
        interactables.push({ x, y, type: 'mine_monster', label: '驱赶洞穴怪物', mine: { kind: 'monster', id: key, depth: d, x, y } });
      }
    }
  }

  mineObjects.push({ kind: d === 1 ? 'exit' : 'stairsUp', x: up.x, y: up.y });
  mineObjects.push({ kind: 'stairsDown', x: down.x, y: down.y });
  interactables.push({ x: up.x, y: up.y, type: 'door', label: d === 1 ? '回镇中心' : `返回第 ${d - 1} 层`, target: d === 1 ? 'town' : `mine:${d - 1}` });
  interactables.push({ x: down.x, y: down.y, type: 'door', label: `深入第 ${d + 1} 层`, target: `mine:${d + 1}` });

  return {
    id: `mine:${d}`,
    w: W,
    h: H,
    tiles,
    solid,
    furniture: [],
    effects: [],
    buildings: [],
    interactables,
    mineObjects,
    spawn: { x: up.x, y: up.y + 2 },
  };
}
