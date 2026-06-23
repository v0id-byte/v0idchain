// 崽（PET）—— 链上独一无二的像素宠物 NFT。完全建在“转账 + memo”之上，不改共识、无软分叉。
// 孵化 = 自转 + 烧 PET_HATCH_COST 币 + memo `PET|`；送崽/转移 = 转 1 币给对方 + memo `PETX|<崽id>`。
// 任何节点扫一遍链就能还原“谁拥有哪只崽”，崽的外观由基因确定性生成 —— 零中心化、随链永久可查。
//
// 关键设计：
// - 崽 id = 孵化交易的 txid（全网唯一、不可伪造）。
// - 基因 gene = hash(主人地址 + 孵化txid)：确定性、唯一、不可伪造（改不动 txid 就造不出指定基因）。
// - 外观（petTraits）由基因纯函数推导 → 同一基因在任意客户端渲染完全一致（PRD 6.5 验收）。
// - 归属随链序流转：只有“当前主人”发出的 PETX 才生效，与红包/集市同样靠链序定胜负 → reorg 安全。
import type { Block } from './block.js';
import { sha256Hex, leadingZeroBits, isValidAddress } from './crypto.js';
import { MAX_MEMO } from './config.js';

/** 孵化交易 memo：`PET|`（其后留空 = 一只“野生”原生崽；未来繁殖可扩展为 `PET|<父>|<母>`，故保留分隔符）。 */
export const PET_PREFIX = 'PET|';
/** 转移/送崽 memo：`PETX|<崽id>`。 */
export const PETX_PREFIX = 'PETX|';
/** 孵化花费（烧进虚空的 $V0ID）。整数币。央行会被矿工回补，崽贵一些以体现稀缺与炫耀价值。 */
export const PET_HATCH_COST = 300;

export interface Pet {
  id: string; // 孵化交易 txid（全网唯一）
  gene: string; // 64-hex 基因 = hash(出生时主人地址 + 孵化txid)
  owner: string; // 当前主人地址（随 PETX 流转）
  minter: string; // 最初孵化者（基因里钉死的出生主人，永不变）
  birthHeight: number; // 出生区块高度
  birthTs: number; // 出生时间戳
}

/** 崽基因：确定性、唯一、不可伪造。主人地址并入 → 即便（理论上）txid 撞车也因地址不同而基因不同。 */
export function petGene(minter: string, mintTxid: string): string {
  return sha256Hex(minter + '|' + mintTxid);
}

/**
 * 稀有度：复用挖矿那套“前导 0 比特越多越难得”的美学 —— 基因 hash 的前导 0 比特数决定稀有度档位。
 * 这天然呼应本链的 PoW 哲学：稀有靠的是“碰巧 hash 出很多前导 0”，谁也伪造不了。
 */
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export function petRarity(gene: string): Rarity {
  const z = leadingZeroBits(gene);
  if (z >= 12) return 'legendary';
  if (z >= 8) return 'epic';
  if (z >= 5) return 'rare';
  return 'common';
}

/**
 * 由基因确定性推导外观特征。纯函数：客户端按这些索引把崽画成像素 → 同一基因处处一致。
 * 取基因不同字节段做各部位的索引/色相，互不串扰；具体像素长相由客户端按规范（GAME-PROTOCOL.md）实现。
 */
export interface PetTraits {
  body: number; // 体型轮廓索引
  hue: number; // 主色相 0~359
  bellyHue: number; // 腹部/副色相 0~359
  eyes: number; // 眼睛样式索引
  pattern: number; // 花纹索引
  accessory: number; // 配饰索引
  rarity: Rarity;
}

const N_BODY = 6;
const N_EYES = 6;
const N_PATTERN = 6;
const N_ACCESSORY = 8; // 0 = 无配饰

/** 取基因第 i 个字节（0~255） */
function geneByte(gene: string, i: number): number {
  return parseInt(gene.slice(i * 2, i * 2 + 2), 16) || 0;
}

export function petTraits(gene: string): PetTraits {
  return {
    body: geneByte(gene, 0) % N_BODY,
    hue: Math.round((geneByte(gene, 1) / 255) * 359),
    bellyHue: Math.round((geneByte(gene, 2) / 255) * 359),
    eyes: geneByte(gene, 3) % N_EYES,
    pattern: geneByte(gene, 4) % N_PATTERN,
    // 稀有崽更可能带配饰：用一个字节决定有无，再用另一字节选具体配饰
    accessory: geneByte(gene, 5) < 96 ? 0 : 1 + (geneByte(gene, 6) % (N_ACCESSORY - 1)),
    rarity: petRarity(gene),
  };
}

/** 校验“孵化”入参；本期无参数（野生崽），返回固定 memo。预留扩展点。 */
export function makePetMint(): { ok: true; memo: string } {
  return { ok: true, memo: PET_PREFIX };
}

/** 校验“转移/送崽”入参（崽 id 必须是 64-hex txid 形态）；返回 memo 或错误。 */
export function makePetTransfer(petId: string): { ok: boolean; memo?: string; error?: string } {
  if (!/^[0-9a-f]{64}$/.test(petId)) return { ok: false, error: '崽 id 必须是 64 位十六进制' };
  const memo = `${PETX_PREFIX}${petId}`;
  if ([...memo].length > MAX_MEMO) return { ok: false, error: '崽 id 过长' };
  return { ok: true, memo };
}

/**
 * 扫整条链还原所有崽与其归属。规则：
 * - 孵化：memo 恰为 `PET|`、且 from === to（自转，防止把别人的付款误判成孵化）、且 burn > 0（确实烧了孵化费）。
 *   崽 id = 该交易 txid，基因 = hash(from + txid)，初始主人 = from。
 * - 转移：memo `PETX|<崽id>`，且 from === 该崽当前主人 → 主人变为 tx.to（须是合法地址）。非当前主人发起一律忽略。
 * 纯函数（只依赖链）→ reorg 安全；同块内多笔按交易数组顺序定胜负，确定性。
 */
export function parsePets(chain: Block[]): Pet[] {
  const pets = new Map<string, Pet>();
  for (const b of chain) {
    for (const tx of b.transactions) {
      const m = tx.memo;
      if (!m) continue;
      if (m === PET_PREFIX) {
        // 孵化：自转 + 烧币。txid 全网唯一 → 不会与已有崽撞 id。
        if (tx.from !== tx.to || (tx.burn ?? 0) <= 0) continue;
        pets.set(tx.txid, {
          id: tx.txid,
          gene: petGene(tx.from, tx.txid),
          owner: tx.from,
          minter: tx.from,
          birthHeight: b.index,
          birthTs: tx.timestamp,
        });
      } else if (m.startsWith(PETX_PREFIX)) {
        const id = m.slice(PETX_PREFIX.length);
        const pet = pets.get(id);
        // 只有当前主人能转；接收方须是合法地址（杜绝把崽转进非法/空地址而“烧没”）。
        if (pet && tx.from === pet.owner && isValidAddress(tx.to) && tx.to !== tx.from) {
          pet.owner = tx.to;
        }
      }
    }
  }
  return [...pets.values()].sort((a, b) => b.birthHeight - a.birthHeight);
}

/** 某地址当前拥有的崽 */
export function petsOf(chain: Block[], address: string): Pet[] {
  return parsePets(chain).filter((p) => p.owner === address);
}
