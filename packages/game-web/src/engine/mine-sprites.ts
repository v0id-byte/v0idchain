// Loads pixel-art mine PNGs from public/assets/mine/.
// Falls back gracefully: callers should check mineSprite(key) !== undefined.
const BASE = 'assets/mine/';

const NAMES = [
  'mineEntrance',
  'caveFloor', 'caveWall',
  'ore_copper', 'ore_iron', 'ore_silver', 'ore_gold',
  'ore_amethyst', 'ore_void_crystal', 'ore_starcore', 'ore_ancient_relic',
  'mineChest', 'mineMonster_basic',
  'stairsDown', 'stairsUp', 'mineExit',
] as const;

export type MineSpriteKey = typeof NAMES[number];

const sprites = new Map<MineSpriteKey, HTMLImageElement>();
let loading: Promise<void> | null = null;

export function loadMineSprites(): Promise<void> {
  if (loading) return loading;
  loading = Promise.all(
    NAMES.map(
      (name) =>
        new Promise<void>((resolve) => {
          const im = new Image();
          im.onload = () => { sprites.set(name, im); resolve(); };
          im.onerror = () => resolve(); // graceful: programmatic fallback stays active
          im.src = BASE + name + '.png';
        }),
    ),
  ).then(() => {});
  return loading;
}

export function mineSprite(key: MineSpriteKey): HTMLImageElement | undefined {
  return sprites.get(key);
}
