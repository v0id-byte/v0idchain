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
/** 繁育花费（烧进虚空）。比孵化便宜：用已有双亲组合而非凭空造，奖励"养崽"。 */
export const PET_BREED_COST = 200;
/** 进化/培育每阶花费（烧进虚空，扁平价）。 */
export const PET_EVO_COST = 80;
/** 进化阶数上限。 */
export const MAX_EVO = 3;
/** 繁育 memo：`PETBREED|<父崽id>|<母崽id>`（双亲须当前都属发起者）。子崽 id = 该交易 txid。 */
export const PETBREED_PREFIX = 'PETBREED|';
/** 进化 memo：`PETEVO|<崽id>`（崽须属发起者；每次 +1 阶至 MAX_EVO）。 */
export const PETEVO_PREFIX = 'PETEVO|';
/** 派驻农场花费（烧进虚空）。把崽派去某田地加速作物成长（farm.ts 据此算确定性加成）。 */
export const PETFARM_COST = 50;
/** 派驻 memo：`PETFARM|<崽id>|<田地zoneId>`（崽与田地都须属发起者；派驻期间该崽被锁，不能繁育/转移）。 */
export const PETFARM_PREFIX = 'PETFARM|';
/** 召回 memo：`PETUNSTATION|<崽id>`（免费，只付 gas；解除派驻锁）。 */
export const PETUNSTATION_PREFIX = 'PETUNSTATION|';

/**
 * 派驻崽对作物成长的加速百分比（0~50）。= 5 基础 + 稀有档×8 + 进化阶×6，封顶 50%。
 * 纯整数、确定性、跨端一致；越稀有/进化越高加成越大 → 闭合 繁育/进化 → 更强农场助手 的循环。
 */
export function farmAssistPct(gene: string, evo: number): number {
  const r = petRarity(gene);
  const tier = r === 'legendary' ? 3 : r === 'epic' ? 2 : r === 'rare' ? 1 : 0;
  const e = evo < 0 ? 0 : evo > MAX_EVO ? MAX_EVO : Math.floor(evo);
  const pct = 5 + tier * 8 + e * 6;
  return pct > 50 ? 50 : pct;
}

export interface Pet {
  id: string; // 孵化/繁育交易 txid（全网唯一）
  gene: string; // 64-hex 基因 = hash(出生主人 + txid)（野生）或 breedGene(双亲)（繁育）
  owner: string; // 当前主人地址（随 PETX 流转）
  minter: string; // 最初铸造者（基因里钉死的出生主人，永不变）
  birthHeight: number; // 出生区块高度
  birthTs: number; // 出生时间戳
  parents?: [string, string]; // 繁育而生时的双亲崽 id（野生崽无此字段）
  evo?: number; // 进化阶数（0 起，至 MAX_EVO）；仅加视觉光环，不改基因长相
  stationedZone?: string; // 当前派驻的田地 zoneId（设置=被锁:不能繁育/转移，但可继续进化）；召回后清空
}

/** 崽基因：确定性、唯一、不可伪造。主人地址并入 → 即便（理论上）txid 撞车也因地址不同而基因不同。 */
export function petGene(minter: string, mintTxid: string): string {
  return sha256Hex(minter + '|' + mintTxid);
}

/**
 * 繁育子崽的基因：确定性、跨端逐字节一致、稀有度不可伪造 + 可见遗传。
 * - byte0(体型)/byte1(主色相) 取自掺了**出块后区块 hash** 的 seed → 稀有度(前导 0 比特，主要看 byte0/byte1)
 *   事前不可预测、选不出 → 杜绝"选种刷传说"。
 * - byte2-6(腹色/眼/花纹/配饰) 按 seed 的选择位从双亲各取 → 子崽"有妈的眼睛、爸的花纹"，可见遗传。
 * - byte7-31 填 seed（不入 petTraits，只可能把传说推得更前导 0，仍是传说，不影响档位边界）。
 * 任意客户端照同一步骤得**逐字节同一子基因**（同 CLIENT-PROTOCOL / redpacket 的确定性纪律）。
 */
export function breedGene(geneA: string, geneB: string, blockHash: string, txid: string): string {
  const seed = sha256Hex(geneA + '|' + geneB + '|' + blockHash + '|' + txid);
  const child: number[] = new Array(32);
  child[0] = geneByte(seed, 0); // 体型 + 稀有度档（不可预测）
  child[1] = geneByte(seed, 1); // 主色相 + 传说档（不可预测）
  const sel = geneByte(seed, 7); // 选择位：每个继承字节随父/母
  for (let i = 2; i <= 6; i++) {
    const fromA = ((sel >> (i - 2)) & 1) === 1;
    child[i] = geneByte(fromA ? geneA : geneB, i);
  }
  for (let i = 7; i < 32; i++) child[i] = geneByte(seed, i);
  return child.map((x) => x.toString(16).padStart(2, '0')).join('');
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

/** 校验繁育入参（双亲 id 须 64-hex、不可同一只）。归属/烧费校验在 parsePets 层。 */
export function makePetBreed(parentA: string, parentB: string): { ok: boolean; memo?: string; error?: string } {
  if (!/^[0-9a-f]{64}$/.test(parentA) || !/^[0-9a-f]{64}$/.test(parentB)) return { ok: false, error: '崽 id 必须是 64 位十六进制' };
  if (parentA === parentB) return { ok: false, error: '需要两只不同的崽' };
  const memo = `${PETBREED_PREFIX}${parentA}|${parentB}`;
  if ([...memo].length > MAX_MEMO) return { ok: false, error: 'memo 过长' };
  return { ok: true, memo };
}

/** 校验进化入参（崽 id 须 64-hex）。归属/阶数/烧费校验在 parsePets 层。 */
export function makePetEvolve(petId: string): { ok: boolean; memo?: string; error?: string } {
  if (!/^[0-9a-f]{64}$/.test(petId)) return { ok: false, error: '崽 id 必须是 64 位十六进制' };
  return { ok: true, memo: `${PETEVO_PREFIX}${petId}` };
}

/** 校验派驻入参（崽 id + 田地 zoneId 均须 64-hex）。归属/烧费/田地校验在 parsePets/parseFarm 层。 */
export function makePetStation(petId: string, zoneId: string): { ok: boolean; memo?: string; error?: string } {
  if (!/^[0-9a-f]{64}$/.test(petId) || !/^[0-9a-f]{64}$/.test(zoneId)) return { ok: false, error: 'id 须 64 位十六进制' };
  const memo = `${PETFARM_PREFIX}${petId}|${zoneId}`;
  if ([...memo].length > MAX_MEMO) return { ok: false, error: 'memo 过长' };
  return { ok: true, memo };
}

/** 校验召回入参（崽 id 须 64-hex）。 */
export function makePetUnstation(petId: string): { ok: boolean; memo?: string; error?: string } {
  if (!/^[0-9a-f]{64}$/.test(petId)) return { ok: false, error: '崽 id 须 64 位十六进制' };
  return { ok: true, memo: `${PETUNSTATION_PREFIX}${petId}` };
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
      } else if (m.startsWith(PETBREED_PREFIX)) {
        // 繁育：自转 + 精确烧 PET_BREED_COST。双亲须存在且当前都属发起者。子崽 id = txid，基因 = breedGene(双亲,区块hash,txid)。
        if (tx.from !== tx.to || (tx.burn ?? 0) !== PET_BREED_COST) continue;
        const parts = m.slice(PETBREED_PREFIX.length).split('|');
        if (parts.length !== 2) continue;
        const [aId, bId] = parts;
        if (aId === bId) continue;
        const pa = pets.get(aId);
        const pb = pets.get(bId);
        if (!pa || !pb || pa.owner !== tx.from || pb.owner !== tx.from) continue; // 双亲须都属发起者
        if (pa.stationedZone || pb.stationedZone) continue; // 派驻农场中的崽被锁，不能繁育
        pets.set(tx.txid, {
          id: tx.txid,
          gene: breedGene(pa.gene, pb.gene, b.hash, tx.txid),
          owner: tx.from,
          minter: tx.from,
          birthHeight: b.index,
          birthTs: tx.timestamp,
          parents: [aId, bId],
          evo: 0,
        });
      } else if (m.startsWith(PETEVO_PREFIX)) {
        // 进化：自转 + 精确烧 PET_EVO_COST。崽须属发起者且未满阶。+1 阶（仅视觉光环，不改基因）。
        if (tx.from !== tx.to || (tx.burn ?? 0) !== PET_EVO_COST) continue;
        const id = m.slice(PETEVO_PREFIX.length);
        const pet = pets.get(id);
        if (!pet || pet.owner !== tx.from) continue;
        const cur = pet.evo ?? 0;
        if (cur >= MAX_EVO) continue;
        pet.evo = cur + 1;
      } else if (m.startsWith(PETFARM_PREFIX)) {
        // 派驻：自转 + 精确烧 PETFARM_COST。崽须属发起者且未在派驻中。记 stationedZone（锁住:不能繁育/转移）。
        // 田地归属校验在 parseFarm 层（这里不持有农场状态）；派驻到非己田地只会白锁自己，不可利用。
        if (tx.from !== tx.to || (tx.burn ?? 0) !== PETFARM_COST) continue;
        const parts = m.slice(PETFARM_PREFIX.length).split('|');
        if (parts.length !== 2) continue;
        const [petId, zoneId] = parts;
        if (!/^[0-9a-f]{64}$/.test(zoneId)) continue;
        const pet = pets.get(petId);
        if (!pet || pet.owner !== tx.from || pet.stationedZone) continue; // 须属发起者且未派驻
        pet.stationedZone = zoneId;
      } else if (m.startsWith(PETUNSTATION_PREFIX)) {
        // 召回：自转（免费，只付 gas）。清除派驻锁。
        if (tx.from !== tx.to) continue;
        const petId = m.slice(PETUNSTATION_PREFIX.length);
        const pet = pets.get(petId);
        if (pet && pet.owner === tx.from && pet.stationedZone) pet.stationedZone = undefined;
      } else if (m.startsWith(PETX_PREFIX)) {
        const id = m.slice(PETX_PREFIX.length);
        const pet = pets.get(id);
        // 只有当前主人能转；接收方须是合法地址；派驻农场中的崽被锁，不能转移（须先召回）。
        if (pet && tx.from === pet.owner && !pet.stationedZone && isValidAddress(tx.to) && tx.to !== tx.from) {
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
