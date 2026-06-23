// 钓鱼 —— 链上可验证的渔获藏品。和崽（PET）/红包同级：纯 memo 约定层，建在“自转 + 烧币 + memo”之上，
// 不改共识、无软分叉。链只当“不可伪造的随机源 + 可验证的渔获账本”，钓鱼**只烧币、绝不发币**。
//
// 关键设计：
// - 铸成藏品 = 自转 + 烧 FISH_BURN 币（进虚空）+ memo `FISH|`。渔获 id = 该交易 txid（全网唯一）。
// - 渔获 hash = sha256(主人地址 + '|' + 该交易所在区块hash + '|' + txid)：与红包 redSeed 同源 ——
//   掺入**出块后才确定的区块 hash**，玩家抛竿/改 JS 都改不动 → 伪造不出传说鱼，重试要再烧币+落进新的不可控区块。
// - 稀有度复用挖矿那套“前导 0 比特越多越难得”（与崽同门槛），外观由 fishTraits 纯函数从 hash 推导 →
//   同一 hash 在任意客户端渲染完全一致。
import type { Block } from './block.js';
import { sha256Hex } from './crypto.js';
import { petRarity, type Rarity } from './pets.js';

/** 铸渔获 memo：`FISH|`（其后留空 = 一次普通垂钓；保留分隔符以备扩展，如 `FISH|<鱼饵>`）。 */
export const FISH_PREFIX = 'FISH|';
/** 铸成链上藏品花费（烧进虚空的 $V0ID）。很小：高频娱乐，日常瞎钓不上链、想收藏才烧。最终由 v0id 拍板。 */
export const FISH_BURN = 2;

export interface Catch {
  id: string; // 铸造交易 txid（全网唯一）
  owner: string; // 主人地址（铸造者；渔获不流转）
  catchHash: string; // 64-hex = sha256(owner + '|' + 出块区块hash + '|' + txid)
  traits: FishTraits; // 由 catchHash 确定性推导的外观
  height: number; // 上链区块高度
  ts: number; // 铸造时间戳
  burn: number; // 这次铸造烧掉的 $V0ID
}

/**
 * 渔获 hash：确定性、各节点一致、铸造者事前不可预测（掺了出块后才定的区块 hash）。
 * 同一 hash 处处推导出同一条鱼。
 */
export function fishCatchHash(owner: string, blockHash: string, txid: string): string {
  return sha256Hex(owner + '|' + blockHash + '|' + txid);
}

/**
 * 稀有度：直接复用崽的 `petRarity`（前导 0 比特数：≥12 传说 / ≥8 史诗 / ≥5 稀有 / else 普通）。
 * 同门槛、同美学 —— 稀有靠“碰巧 hash 出很多前导 0”，谁也伪造不了，呼应本链 PoW 哲学。
 */
export function fishRarity(catchHash: string): Rarity {
  return petRarity(catchHash);
}

/**
 * 由 catchHash 确定性推导外观特征。纯函数：客户端按这些索引把鱼画成像素 → 同一 hash 处处一致。
 * 取 hash 不同字节段做各部位的索引/色相，互不串扰；具体像素长相由客户端按规范（GAME-PROTOCOL.md §6）实现。
 */
export interface FishTraits {
  rarity: Rarity;
  species: number; // 该稀有度档位内的鱼种索引（0 .. N_SPECIES[rarity]-1）
  hue: number; // 主色相 0~359
  bellyHue: number; // 腹部/副色相 0~359
  finStyle: number; // 鳍/尾样式索引 0~3
  sizeCm: number; // 体长（厘米，展示用）；稀有度越高越大
  shiny: boolean; // 闪光个体（小概率，额外炫耀点）
}

/** 各稀有度档位的鱼种数（与 GAME-PROTOCOL §6 的鱼种表一一对应）。 */
export const N_SPECIES: Record<Rarity, number> = {
  common: 4, // 鲫 / 鲈 / 泥鳅 / 虾
  rare: 3, // 锦鲤 / 鳟 / 河豚
  epic: 3, // 金龙 / 电鳗 / 月鱼
  legendary: 2, // 虚空鲸 / 星之鲟
};

const N_FIN = 4;

/** 取 hash 第 i 个字节（0~255）。 */
function hashByte(hash: string, i: number): number {
  return parseInt(hash.slice(i * 2, i * 2 + 2), 16) || 0;
}

/** 各稀有度的展示体长区间（厘米）：越稀有越大。size = lo + (byte/255)*(hi-lo)。 */
const SIZE_RANGE: Record<Rarity, [number, number]> = {
  common: [8, 30],
  rare: [25, 55],
  epic: [50, 95],
  legendary: [90, 200],
};

export function fishTraits(catchHash: string): FishTraits {
  const rarity = fishRarity(catchHash);
  const [lo, hi] = SIZE_RANGE[rarity];
  return {
    rarity,
    species: hashByte(catchHash, 0) % N_SPECIES[rarity],
    hue: Math.round((hashByte(catchHash, 1) / 255) * 359),
    bellyHue: Math.round((hashByte(catchHash, 2) / 255) * 359),
    finStyle: hashByte(catchHash, 3) % N_FIN,
    sizeCm: Math.round(lo + (hashByte(catchHash, 4) / 255) * (hi - lo)),
    shiny: hashByte(catchHash, 5) < 16, // 约 1/16 闪光
  };
}

/** 校验“铸渔获”入参；本期无参数，返回固定 memo。预留扩展点（鱼饵）。仿 makePetMint。 */
export function makeFishCatch(): { ok: true; memo: string } {
  return { ok: true, memo: FISH_PREFIX };
}

/**
 * 扫整条链还原所有“铸成藏品”的渔获。规则（仿 parsePets 对孵化的校验）：
 * - memo 恰为 `FISH|`、且 from === to（自转，防止把别人的付款误判成渔获）、且 burn > 0（确实烧了铸造费）。
 *   渔获 id = 该交易 txid，hash = sha256(from + '|' + 区块hash + '|' + txid)，主人 = from。
 * 纯函数（只依赖链）→ reorg 安全；同块内多笔按交易数组顺序，确定性。最新在前。
 */
export function parseFish(chain: Block[]): Catch[] {
  const out: Catch[] = [];
  for (const b of chain) {
    for (const tx of b.transactions) {
      if (tx.memo !== FISH_PREFIX) continue;
      if (tx.from !== tx.to || (tx.burn ?? 0) <= 0) continue;
      const catchHash = fishCatchHash(tx.from, b.hash, tx.txid);
      out.push({
        id: tx.txid,
        owner: tx.from,
        catchHash,
        traits: fishTraits(catchHash),
        height: b.index,
        ts: tx.timestamp,
        burn: tx.burn ?? 0,
      });
    }
  }
  return out.sort((a, b) => b.height - a.height);
}

/** 某地址铸过的渔获（最新在前）。 */
export function fishOf(chain: Block[], address: string): Catch[] {
  return parseFish(chain).filter((c) => c.owner === address);
}
