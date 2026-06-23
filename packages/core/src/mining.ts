// 矿洞链上资产：稀有发现证明 + 可交易/合成/升级材料。
// 与崽/钓鱼/农场一致：不改共识，只用自转 + burn + memo；节点重放链即可还原资产。
import type { Block } from './block.js';
import { sha256Hex } from './crypto.js';
import { petRarity, type Rarity } from './pets.js';

export const MINE_PREFIX = 'MINE|';
export const MINE_DISC_PREFIX = `${MINE_PREFIX}DISC|`;
export const MINE_MAT_PREFIX = `${MINE_PREFIX}MAT|`;

export type MineAssetKind =
  | 'copper'
  | 'iron'
  | 'silver'
  | 'gold'
  | 'amethyst'
  | 'void_crystal'
  | 'starcore'
  | 'ancient_relic';

export type MineAssetType = 'discovery' | 'material';

export interface MineKindMeta {
  label: string;
  icon: string;
  tier: number;
  minDepth: number;
}

export const MINE_KINDS: MineAssetKind[] = [
  'copper',
  'iron',
  'silver',
  'gold',
  'amethyst',
  'void_crystal',
  'starcore',
  'ancient_relic',
];

export const MINE_KIND_META: Record<MineAssetKind, MineKindMeta> = {
  copper: { label: '铜矿', icon: '🟤', tier: 1, minDepth: 1 },
  iron: { label: '铁矿', icon: '⚙️', tier: 1, minDepth: 1 },
  silver: { label: '银矿', icon: '⚪', tier: 2, minDepth: 2 },
  gold: { label: '金矿', icon: '🟡', tier: 2, minDepth: 2 },
  amethyst: { label: '紫晶', icon: '💜', tier: 3, minDepth: 3 },
  void_crystal: { label: '虚空水晶', icon: '🔷', tier: 4, minDepth: 4 },
  starcore: { label: '星核矿', icon: '🌟', tier: 5, minDepth: 5 },
  ancient_relic: { label: '远古遗物', icon: '🏺', tier: 5, minDepth: 5 },
};

export interface MineTraits {
  rarity: Rarity;
  purity: number; // 0..100
  glowHue: number; // 0..359
  craftPower: number; // 合成/升级强度展示值
  ancient: boolean;
}

export interface MineAsset {
  id: string;
  owner: string;
  type: MineAssetType;
  kind: MineAssetKind;
  label: string;
  icon: string;
  count: number;
  depth?: number;
  x?: number;
  y?: number;
  hash: string;
  traits: MineTraits;
  height: number;
  ts: number;
  burn: number;
}

export type MineMemo =
  | { type: 'discovery'; depth: number; x: number; y: number; kind: MineAssetKind }
  | { type: 'material'; kind: MineAssetKind; count: number };

function hashByte(hash: string, i: number): number {
  return parseInt(hash.slice(i * 2, i * 2 + 2), 16) || 0;
}

export function isMineKind(kind: string): kind is MineAssetKind {
  return MINE_KINDS.includes(kind as MineAssetKind);
}

export function mineDiscoveryBurn(depth: number, kind: MineAssetKind): number {
  const d = Math.max(1, Math.trunc(depth));
  const meta = MINE_KIND_META[kind];
  return 12 + d * 3 + meta.tier * 8;
}

export function mineMaterialBurn(kind: MineAssetKind, count: number): number {
  const n = Math.max(1, Math.trunc(count));
  return n * (2 + MINE_KIND_META[kind].tier * 2);
}

export function mineAssetHash(owner: string, blockHash: string, txid: string): string {
  return sha256Hex(owner + '|' + blockHash + '|' + txid);
}

export function mineTraits(kind: MineAssetKind, depth: number | undefined, hash: string): MineTraits {
  const meta = MINE_KIND_META[kind];
  const d = Math.max(meta.minDepth, Math.trunc(depth ?? meta.minDepth));
  const rarity = petRarity(hash);
  const rarityBoost: Record<Rarity, number> = { common: 0, rare: 10, epic: 24, legendary: 42 };
  const purity = Math.min(100, 30 + meta.tier * 7 + d * 2 + rarityBoost[rarity] + (hashByte(hash, 0) % 13));
  return {
    rarity,
    purity,
    glowHue: Math.round((hashByte(hash, 1) / 255) * 359),
    craftPower: meta.tier * 10 + Math.floor(purity / 5) + d,
    ancient: hashByte(hash, 2) < 18 || kind === 'ancient_relic',
  };
}

export function makeMineDiscovery(
  depth: number,
  x: number,
  y: number,
  kind: MineAssetKind,
): { ok: boolean; memo?: string; error?: string } {
  if (!Number.isInteger(depth) || depth < 1 || depth > 999) return { ok: false, error: '矿洞深度无效' };
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) {
    return { ok: false, error: '矿点坐标无效' };
  }
  if (!isMineKind(kind)) return { ok: false, error: '未知矿物' };
  return { ok: true, memo: `${MINE_DISC_PREFIX}${depth}|${x}|${y}|${kind}` };
}

export function makeMineMaterial(
  kind: MineAssetKind,
  count: number,
): { ok: boolean; memo?: string; error?: string } {
  if (!isMineKind(kind)) return { ok: false, error: '未知矿物' };
  if (!Number.isInteger(count) || count < 1 || count > 999) return { ok: false, error: '材料数量无效' };
  return { ok: true, memo: `${MINE_MAT_PREFIX}${kind}|${count}` };
}

export function parseMineMemo(memo: string): MineMemo | null {
  if (memo.startsWith(MINE_DISC_PREFIX)) {
    const parts = memo.slice(MINE_DISC_PREFIX.length).split('|');
    if (parts.length !== 4) return null;
    const depth = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const kind = parts[3];
    if (!Number.isInteger(depth) || depth < 1 || depth > 999) return null;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) return null;
    if (!isMineKind(kind)) return null;
    return { type: 'discovery', depth, x, y, kind };
  }
  if (memo.startsWith(MINE_MAT_PREFIX)) {
    const parts = memo.slice(MINE_MAT_PREFIX.length).split('|');
    if (parts.length !== 2) return null;
    const kind = parts[0];
    const count = Number(parts[1]);
    if (!isMineKind(kind) || !Number.isInteger(count) || count < 1 || count > 999) return null;
    return { type: 'material', kind, count };
  }
  return null;
}

export function parseMines(chain: Block[]): MineAsset[] {
  const out: MineAsset[] = [];
  for (const b of chain) {
    for (const tx of b.transactions) {
      const m = parseMineMemo(tx.memo);
      if (!m) continue;
      const burn = tx.burn ?? 0;
      if (tx.from !== tx.to || burn <= 0) continue;
      const needed = m.type === 'discovery'
        ? mineDiscoveryBurn(m.depth, m.kind)
        : mineMaterialBurn(m.kind, m.count);
      if (burn < needed) continue;
      const meta = MINE_KIND_META[m.kind];
      const h = mineAssetHash(tx.from, b.hash, tx.txid);
      out.push({
        id: tx.txid,
        owner: tx.from,
        type: m.type,
        kind: m.kind,
        label: meta.label,
        icon: meta.icon,
        count: m.type === 'material' ? m.count : 1,
        depth: m.type === 'discovery' ? m.depth : undefined,
        x: m.type === 'discovery' ? m.x : undefined,
        y: m.type === 'discovery' ? m.y : undefined,
        hash: h,
        traits: mineTraits(m.kind, m.type === 'discovery' ? m.depth : undefined, h),
        height: b.index,
        ts: tx.timestamp,
        burn,
      });
    }
  }
  return out.sort((a, b) => b.height - a.height);
}

export function minesOf(chain: Block[], address: string): MineAsset[] {
  return parseMines(chain).filter((a) => a.owner === address);
}
