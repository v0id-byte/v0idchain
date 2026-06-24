// 矿洞系统：材料类型 + 链上资产 + 铸造/燃烧计算
export type MineAssetKind = 'copper' | 'iron' | 'silver' | 'gold' | 'void_crystal';

export interface MineKindMeta {
  label: string;
  icon: string;
  tier: number;    // 1-5，tier 越高越稀有
  minDepth: number;
}

export const MINE_KIND_META: Record<MineAssetKind, MineKindMeta> = {
  copper:      { label: '铜',     icon: '🟤', tier: 1, minDepth: 0 },
  iron:        { label: '铁',     icon: '⚪', tier: 2, minDepth: 2 },
  silver:      { label: '银',     icon: '🪙', tier: 3, minDepth: 4 },
  gold:        { label: '金',     icon: '🟡', tier: 4, minDepth: 6 },
  void_crystal:{ label: '虚空水晶', icon: '💎', tier: 5, minDepth: 8 },
};

export const MINE_KINDS: MineAssetKind[] = ['copper', 'iron', 'silver', 'gold', 'void_crystal'];

export interface MineAsset {
  id: string;
  type: 'discovery' | 'material';
  kind: MineAssetKind;
  label: string;
  icon: string;
  depth?: number;
  count?: number;
  traits: { rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'; purity: number };
}

export interface FeedEvent {
  from: string;
  type: string;
  memo?: string;
  height?: number;
}

/** 铸造矿洞发现证明的 memo 字符串 */
export function makeMineDiscovery(depth: number, x: number, y: number, kind: MineAssetKind): string {
  return `MINE_DISC|${kind}|${depth}|${x}|${y}`;
}

/** 铸造矿洞材料的 memo 字符串 */
export function makeMineMaterial(kind: MineAssetKind, count: number): string {
  return `MINE_MAT|${kind}|${count}`;
}

/** 矿洞发现证明铸造的燃烧 V0ID 量（与深度和种类正相关） */
export function mineDiscoveryBurn(depth: number, kind: MineAssetKind): number {
  const tier = MINE_KIND_META[kind]?.tier ?? 1;
  return (depth + 1) * tier * 10;
}

/** 矿洞材料铸造的燃烧量 */
export function mineMaterialBurn(kind: MineAssetKind, count: number): number {
  const tier = MINE_KIND_META[kind]?.tier ?? 1;
  return tier * count * 5;
}
