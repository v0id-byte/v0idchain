// 链上农场经济 —— Stardew 式农场，与崽（PET）/红包/钓鱼同级：纯 memo 约定层，建在“自转 + 烧币 + memo”之上，
// 不改共识、无软分叉、系统零增发。经济闭环：花币(烧进虚空) → 买地/建区块/种作物 → 按区块高度成长 → 收获链上收藏作物。
// 系统永不凭空发币——所有动作只烧币；“收入”（回血）只能靠 P2P 把作物卖给别的玩家（Phase 2），自带反通胀。
//
// 关键设计（仿 pets/fishing/redpacket）：
// - 四种动作都是玩家本地签名的一笔自转交易（from===to）+ 烧币（burn>0）+ memo。旧节点眼里只是合法“自发消息”，照收 → 不软分叉。
// - 地块/区块/作物 id 用 owner+序号 / 该交易 txid 确定性派生，防伪造/越权（同 parsePets 的归属校验铁律）。
// - 成长 = 区块高度确定性：作物记下 plantHeight，成熟度 = clamp((H - plantHeight)/GROW_BLOCKS, 0, 1)。纯由链高算，reorg 安全、跨端一致，无“时间”歧义。
// - 收成品质 = 不可伪造随机源：cropHash = sha256(owner + '|' + HARVEST交易所在区块hash + '|' + 该txid)，前导 0 比特定品质（同崽/鱼）。
//   玩家改不了链上 txid/区块hash → 伪造不出金作物；想刷好品质要再花种子+收获成本+落进不可控区块 → 经济自带反作弊。
// - 动态地价 = 全网供需的确定性 bonding curve（landPrice(farmState)）：人人同价、链上可复算、随行情走（卖得越多/最近抢得越凶越贵）。
import type { Block } from './block.js';
import { sha256Hex } from './crypto.js';
import { petRarity, type Rarity } from './pets.js';

// ———— memo 前缀（与 messages.ts 的 isProtocolMemo 一一对应，别被当私信收进收件箱）————
/** 买地：`LAND|<n>`（解锁该 owner 的第 n 号专属农场地块；n 从 0 起，必须紧接已解锁的下一号，禁止跳号）。 */
export const LAND_PREFIX = 'LAND|';
/** 建区块：`ZONE|<plotN>|<type>`（在已解锁地块 plotN 上建一个功能区；区块 id = 该交易 txid）。 */
export const ZONE_PREFIX = 'ZONE|';
/** 种植：`PLANT|<zoneId>|<crop>|<slot>`（在田地区块某格种作物；作物 id = 该交易 txid，记 plantHeight=所在区块号）。 */
export const PLANT_PREFIX = 'PLANT|';
/** 收获：`HARVEST|<plantId>`（成熟后收成 → 产出链上收藏作物，id = 该交易 txid，品质由 cropHash 事后确定）。 */
export const HARVEST_PREFIX = 'HARVEST|';
/** 作物 P2P 转让（Phase 2，先留前缀不实现）：`CROPX|<cropId>|<toAddr>`。 */
export const CROPX_PREFIX = 'CROPX|';

// ———— 经济参数（草案，最终 v0id 拍板；全部只烧进虚空，零增发；每笔再叠网络 gas MIN_FEE→矿工）————
// 动态地价 = 全整数定点 bonding curve（见 landPrice 的权威整数公式 + GAME-PROTOCOL §7.3）。
// 历史上曾用浮点 Math.pow(.,1.15)，但它进了“parseFarm 入块重算并校验 burn≥price”的可复算路径——
// 不同语言/运行时的浮点最后一位 ulp 差异会让两端对“某笔买地是否有效”判定分歧 → 农场状态跨客户端分裂。
// 故改为只含整数 +,-,*,/(向下取整) 的确定性公式：任何实现照同样整数步骤得**逐字节同一结果**（同 redpacket.computeShare 纪律）。
export const LAND_BASE = 200; // 起步地价（第一块、零行情时）= soldTotal=0、recentSales=0 时的价
export const LAND_K = 50; // 稀缺尺度：每多卖 K 块，scarcity 的“线性档”加一个 LAND_BASE
export const LAND_QUAD_DEN = 2500; // 二次档分母（= K²）：贡献 +floor(soldTotal²/QUAD_DEN)×LAND_BASE，使涨价超线性（凸）
export const LAND_VELOCITY_WINDOW = 720; // recentSales 统计窗口（区块数）
export const LAND_VELOCITY_NUM = 1; // velocity 加成分子：价格再 ×(1 + recentSales/WINDOW)，整数实现见 landPrice
/** 建一个功能区块烧币额。 */
export const ZONE_COST = 100;
/** 收获烧币额（很小：成本主要在种子+地，收获只象征性烧一点）。 */
export const HARVEST_BURN = 2;

/** 田地区块每行格数（slot 上界）。功能区块固定一行可种 ZONE_SLOTS 格作物。 */
export const ZONE_SLOTS = 6;

/** 功能区块类型。MVP 只实现田地 farmland；orchard 等留作 Phase 2（先列举不强用）。 */
export type ZoneType = 'farmland' | 'orchard';
export const ZONE_TYPES: ZoneType[] = ['farmland', 'orchard'];

/** 作物种类（MVP 几种；快菜便宜速成、稀有种贵且慢）。 */
export type Crop = 'turnip' | 'wheat' | 'pumpkin' | 'starfruit';
export const CROPS: Crop[] = ['turnip', 'wheat', 'pumpkin', 'starfruit'];

/** 各作物种子烧币额（SEED_COST）。普通菜便宜、稀有种贵。 */
export const SEED_COST: Record<Crop, number> = {
  turnip: 10, // 快菜
  wheat: 15,
  pumpkin: 25,
  starfruit: 50, // 稀有种
};

/** 各作物成熟所需区块数（GROW_BLOCKS）。快菜 30 块、果作更慢。 */
export const GROW_BLOCKS: Record<Crop, number> = {
  turnip: 30, // 快菜
  wheat: 60,
  pumpkin: 120,
  starfruit: 200, // 稀有种慢
};

// ———— 动态地价：纯链上状态函数（全网可复算，随行情浮动）————
/** 喂给 landPrice 的最小行情状态：全网已售地块总数 + 最近窗口内售出数。 */
export interface FarmMarketState {
  soldTotal: number; // 全网已售（已解锁）地块总数 —— 卖得越多越稀缺 → 越贵
  recentSales: number; // 最近 LAND_VELOCITY_WINDOW 个区块内售出的地块数 —— 最近抢得越凶 → 越贵
}

/**
 * 动态地价 —— **权威整数公式（跨实现逐字节一致；任何语言照同样整数步骤得同一结果）**。
 * 全程只用整数 `+ - * /`，其中 `/` 一律是**向下取整除法**（floor，对非负数 = 截断；本函数所有被除数/除数恒非负）。
 * 无浮点、无 Math.pow、无 ceil —— 杜绝浮点 ulp 撕裂共识（同 redpacket.computeShare 的全整数纪律）。
 *
 *   scarcity = LAND_BASE
 *            + (soldTotal / LAND_K)      * LAND_BASE     // 线性档：每多卖 K 块 +1 个 BASE
 *            + (soldTotal² / LAND_QUAD_DEN) * LAND_BASE  // 二次档：凸增、超线性涨价（替代原 ^1.15 的超线性意图）
 *   price    = scarcity
 *            + (scarcity * recentSales) / LAND_VELOCITY_WINDOW   // velocity 加成：×(1 + recentSales/WINDOW)，整数展开
 *
 * 经济意图保持：soldTotal 越多越贵（线性 + 二次，凸），最近 velocity 越高越贵；零行情时 = LAND_BASE。
 * 取舍：用“窗口内成交数”作 velocity 加成的整数权重，密度天然有界，一次抢购不会指数失控。
 * 注意整数除法的固定顺序：scarcity 的两档先各自 floor 再求和；velocity 加成是 (scarcity*recentSales) 先乘后 floor 除。
 * 这套**固定的整数算子序列**就是权威定义——原生客户端必须照此顺序复现（golden 向量见 GAME-PROTOCOL §7.3）。
 */
export function landPrice(s: FarmMarketState): number {
  const sold = s.soldTotal < 0 ? 0 : Math.trunc(s.soldTotal); // 防御：非负整数（链上 soldTotal 本就非负整数）
  const recent = s.recentSales < 0 ? 0 : Math.trunc(s.recentSales);
  const linear = Math.floor((sold * LAND_BASE) / LAND_K); // 线性档
  const quad = Math.floor((sold * sold * LAND_BASE) / LAND_QUAD_DEN); // 二次档（凸）
  const scarcity = LAND_BASE + linear + quad;
  const velocityBump = Math.floor((scarcity * recent * LAND_VELOCITY_NUM) / LAND_VELOCITY_WINDOW);
  return scarcity + velocityBump;
}

// ———— 成长 / 品质（仿钓鱼区块hash随机源）————
/**
 * 作物成熟度 0~1：clamp((当前链高 - plantHeight) / GROW_BLOCKS[crop], 0, 1)。
 * 纯由链高算 → 全网/跨端一致、reorg 安全（链重组就重算）。0=刚种(种子)，<1=生长中，≥1=成熟可收。
 */
export function cropGrowth(plantHeight: number, curHeight: number, crop: Crop): number {
  const span = GROW_BLOCKS[crop];
  const g = (curHeight - plantHeight) / span;
  return g < 0 ? 0 : g > 1 ? 1 : g;
}

/** 成长视觉阶段：0 种子 / 1 幼苗 / 2 成株（未结果）/ 3 成熟可收。由 cropGrowth 分段。 */
export function cropStage(growth: number): 0 | 1 | 2 | 3 {
  if (growth >= 1) return 3;
  if (growth >= 0.66) return 2;
  if (growth >= 0.25) return 1;
  return 0;
}

/**
 * 收成 hash：确定性、各节点一致、收获者事前不可预测（掺了出块后才定的区块 hash）。同一 hash 处处推导出同一品质。
 * 与钓鱼 catchHash / 红包 redSeed 同源 —— 玩家改不了链上 txid 与区块 hash → 伪造不出金作物。
 */
export function cropHash(owner: string, harvestBlockHash: string, harvestTxid: string): string {
  return sha256Hex(owner + '|' + harvestBlockHash + '|' + harvestTxid);
}

/**
 * 收成品质：直接复用崽/鱼的“前导 0 比特越多越难得”门槛（≥12 金 / ≥8 稀有 / ≥5 优质 / else 普通）。
 * 同美学、同不可伪造性，呼应本链 PoW 哲学。返回值复用 Rarity（common/rare/epic/legendary）。
 */
export function cropQuality(hash: string): Rarity {
  return petRarity(hash);
}

/** 取 hash 第 i 个字节（0~255）。 */
function hashByte(hash: string, i: number): number {
  return parseInt(hash.slice(i * 2, i * 2 + 2), 16) || 0;
}

/**
 * 由 cropHash 确定性推导收成外观/展示特征。纯函数：客户端按这些索引把作物画成像素 → 同一 hash 处处一致。
 * crop（种类）来自种植时记下的作物，不入 hash（种什么收什么）；品质/光泽/重量由 hash 推导。
 */
export interface CropTraits {
  crop: Crop;
  quality: Rarity; // 品质（前导 0 比特门槛，同崽/鱼）
  hue: number; // 主色相 0~359（同品质同种内的个体差异）
  giant: boolean; // 巨型个体（小概率，额外炫耀点）
  weightG: number; // 展示重量（克）；品质越高越大
}

/** 各品质的展示重量区间（克）：越稀有越重。weight = lo + (byte/255)*(hi-lo)。 */
const WEIGHT_RANGE: Record<Rarity, [number, number]> = {
  common: [80, 300],
  rare: [250, 700],
  epic: [600, 1500],
  legendary: [1400, 4000],
};

export function cropTraits(crop: Crop, hash: string): CropTraits {
  const quality = cropQuality(hash);
  const [lo, hi] = WEIGHT_RANGE[quality];
  return {
    crop,
    quality,
    hue: Math.round((hashByte(hash, 1) / 255) * 359),
    giant: hashByte(hash, 2) < 16, // 约 1/16 巨型
    weightG: Math.round(lo + (hashByte(hash, 3) / 255) * (hi - lo)),
  };
}

// ———— 入参校验 + memo 构造（仿 makePetMint/makeFishCatch；纯函数，node/web 层调用）————
/**
 * 买地 memo：`LAND|<n>`。n = 要解锁的地块号（从 0 起）。校验金额（burn≥landPrice）在 parseFarm/共识层结合状态判，这里只构造 memo。
 * 注意：调用方应先用 GET /api/farm 拿到当前 landPrice 预算，按它 burn。
 */
export function makeLandBuy(n: number): { ok: boolean; memo?: string; error?: string } {
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: '地块号必须是非负整数' };
  return { ok: true, memo: `${LAND_PREFIX}${n}` };
}

/** 建区块 memo：`ZONE|<plotN>|<type>`。校验 plotN 属于该 owner 在 parseFarm 层判。 */
export function makeZone(plotN: number, type: ZoneType): { ok: boolean; memo?: string; error?: string } {
  if (!Number.isInteger(plotN) || plotN < 0) return { ok: false, error: '地块号必须是非负整数' };
  if (!ZONE_TYPES.includes(type)) return { ok: false, error: '未知区块类型' };
  return { ok: true, memo: `${ZONE_PREFIX}${plotN}|${type}` };
}

/** 种植 memo：`PLANT|<zoneId>|<crop>|<slot>`。zoneId 须像 64-hex txid；slot ∈ [0, ZONE_SLOTS)。 */
export function makePlant(zoneId: string, crop: Crop, slot: number): { ok: boolean; memo?: string; error?: string } {
  if (!/^[0-9a-f]{64}$/.test(zoneId)) return { ok: false, error: '区块 id 必须是 64 位十六进制' };
  if (!CROPS.includes(crop)) return { ok: false, error: '未知作物' };
  if (!Number.isInteger(slot) || slot < 0 || slot >= ZONE_SLOTS) return { ok: false, error: `格位需 0~${ZONE_SLOTS - 1}` };
  return { ok: true, memo: `${PLANT_PREFIX}${zoneId}|${crop}|${slot}` };
}

/** 收获 memo：`HARVEST|<plantId>`。plantId 须像 64-hex txid。 */
export function makeHarvest(plantId: string): { ok: boolean; memo?: string; error?: string } {
  if (!/^[0-9a-f]{64}$/.test(plantId)) return { ok: false, error: '作物 id 必须是 64 位十六进制' };
  return { ok: true, memo: `${HARVEST_PREFIX}${plantId}` };
}

// ———— 链上状态还原（parseFarm，纯函数、reorg 安全；仿 parsePets/parseRedPackets）————
export interface Plot {
  id: string; // owner 命名空间下的确定性 id：`<owner>#<n>`
  owner: string;
  n: number; // 地块号
  buyHeight: number;
  pricePaid: number; // 解锁时实际烧掉的币（= 当时 landPrice）
}
export interface Zone {
  id: string; // 建造交易 txid（全网唯一）
  owner: string;
  plotN: number; // 所属地块号
  type: ZoneType;
  buildHeight: number;
}
export interface Plant {
  id: string; // 种植交易 txid（全网唯一）
  owner: string;
  zoneId: string;
  crop: Crop;
  slot: number;
  plantHeight: number; // 种植交易所在区块号（成长据此算）
  harvested: boolean; // 已收获（产出收藏作物后置 true，腾出格位）
}
export interface HarvestedCrop {
  id: string; // 收获交易 txid（全网唯一）—— 收藏作物的链上 id
  owner: string;
  plantId: string; // 来源 plant
  crop: Crop;
  hash: string; // 64-hex = cropHash(owner + '|' + 收获区块hash + '|' + txid)
  traits: CropTraits; // 由 hash + crop 确定性推导
  height: number; // 收获区块高度
  ts: number;
}

/** 整个农场世界状态（parseFarm 的返回）。 */
export interface FarmWorld {
  plots: Plot[];
  zones: Zone[];
  plants: Plant[];
  crops: HarvestedCrop[]; // 已收获的链上收藏作物
  soldTotal: number; // 全网已售地块总数（喂动态地价）
  recentSales: number; // 最近 LAND_VELOCITY_WINDOW 块内售出数（按最新链高算；喂动态地价 velocity）
  height: number; // 还原时的当前链高（plots/plants 成长据此算）
}

/** 内部：某 owner 当前已解锁的最大地块号（+1 = 下一个可买号）。用于禁止跳号、防伪造。 */
function nextPlotN(plots: Map<string, Plot>, owner: string): number {
  let max = -1;
  for (const p of plots.values()) if (p.owner === owner && p.n > max) max = p.n;
  return max + 1;
}

/**
 * 扫整条链还原全网农场状态。校验铁律（仿 parsePets）：每个动作必须 from===to（自转）、burn>0，且引用的地/区块/作物
 * **确属该 owner 且状态合法**，否则忽略。地价用“买入交易所在区块之前”的全网状态确定性算出 → 买方可预测、共识可复算。
 *
 * - 买地 LAND|<n>：n 必须正好等于该 owner 的下一个可买号（禁跳号）；burn 必须 ≥ 当时 landPrice（按截至此交易前的 soldTotal/velocity 算）。
 * - 建区块 ZONE|<plotN>|<type>：plotN 必须属于该 owner；burn === ZONE_COST。区块 id = txid。
 * - 种植 PLANT|<zoneId>|<crop>|<slot>：zone 必须属于该 owner 且为 farmland；slot 合法且当前为空（未被未收获作物占用）；burn === SEED_COST[crop]。作物 id = txid，plantHeight = 区块号。
 * - 收获 HARVEST|<plantId>：plant 必须属于该 owner、未收获、且已成熟（cropGrowth ≥ 1）；burn === HARVEST_BURN。产出收藏作物 id = txid，品质由收获区块 hash 事后确定。
 * 纯函数（只依赖链）→ reorg 安全；同块内多笔按交易数组顺序定胜负，确定性。
 */
export function parseFarm(chain: Block[]): FarmWorld {
  const plots = new Map<string, Plot>(); // key = `<owner>#<n>`
  const zones = new Map<string, Zone>(); // key = zone txid
  const plants = new Map<string, Plant>(); // key = plant txid
  const crops: HarvestedCrop[] = [];
  let soldTotal = 0;
  const saleHeights: number[] = []; // 每次售地的区块高度（按链序），用于 velocity
  const curHeight = chain.length ? chain[chain.length - 1].index : 0;

  // 某地块当前被占用的格位（zoneId|slot → 未收获 plant 存在）。用于种植时判空。
  const occupied = new Set<string>(); // key = `${zoneId}|${slot}`

  for (const b of chain) {
    for (const tx of b.transactions) {
      const m = tx.memo;
      if (!m) continue;
      // 所有农场动作都是自转 + 烧币（amount=0 + from===to + burn>0）。不满足直接跳过（含把别人付款误判）。
      const burn = tx.burn ?? 0;
      const selfBurn = tx.from === tx.to && burn > 0;

      if (m.startsWith(LAND_PREFIX)) {
        if (!selfBurn) continue;
        const n = Number(m.slice(LAND_PREFIX.length));
        if (!Number.isInteger(n) || n < 0) continue;
        if (n !== nextPlotN(plots, tx.from)) continue; // 必须紧接下一个可买号，禁跳号/重复
        // 地价 = 截至此交易“之前”的全网状态（soldTotal + 最近窗口内成交密度，相对本块高度）
        const recentBefore = saleHeights.filter((h) => h > b.index - LAND_VELOCITY_WINDOW).length;
        const price = landPrice({ soldTotal, recentSales: recentBefore });
        if (burn < price) continue; // 烧得不够（按可复算地价）→ 无效
        const id = `${tx.from}#${n}`;
        plots.set(id, { id, owner: tx.from, n, buyHeight: b.index, pricePaid: price });
        soldTotal += 1;
        saleHeights.push(b.index);
        continue;
      }

      if (m.startsWith(ZONE_PREFIX)) {
        if (!selfBurn || burn !== ZONE_COST) continue;
        const rest = m.slice(ZONE_PREFIX.length);
        const sep = rest.indexOf('|');
        if (sep < 0) continue;
        const plotN = Number(rest.slice(0, sep));
        const type = rest.slice(sep + 1) as ZoneType;
        if (!Number.isInteger(plotN) || !ZONE_TYPES.includes(type)) continue;
        if (!plots.has(`${tx.from}#${plotN}`)) continue; // 地块须属于该 owner
        zones.set(tx.txid, { id: tx.txid, owner: tx.from, plotN, type, buildHeight: b.index });
        continue;
      }

      if (m.startsWith(PLANT_PREFIX)) {
        if (!selfBurn) continue;
        const parts = m.slice(PLANT_PREFIX.length).split('|');
        if (parts.length !== 3) continue;
        const [zoneId, crop, slotStr] = parts as [string, Crop, string];
        if (!/^[0-9a-f]{64}$/.test(zoneId) || !CROPS.includes(crop)) continue;
        const slot = Number(slotStr);
        if (!Number.isInteger(slot) || slot < 0 || slot >= ZONE_SLOTS) continue;
        if (burn !== SEED_COST[crop]) continue; // 种子费须精确
        const z = zones.get(zoneId);
        if (!z || z.owner !== tx.from || z.type !== 'farmland') continue; // 区块须属于该 owner 且是田地
        const key = `${zoneId}|${slot}`;
        if (occupied.has(key)) continue; // 该格已被未收获作物占用
        plants.set(tx.txid, {
          id: tx.txid, owner: tx.from, zoneId, crop, slot, plantHeight: b.index, harvested: false,
        });
        occupied.add(key);
        continue;
      }

      if (m.startsWith(HARVEST_PREFIX)) {
        if (!selfBurn || burn !== HARVEST_BURN) continue;
        const plantId = m.slice(HARVEST_PREFIX.length);
        if (!/^[0-9a-f]{64}$/.test(plantId)) continue;
        const pl = plants.get(plantId);
        if (!pl || pl.owner !== tx.from || pl.harvested) continue; // 须属于该 owner 且未收获
        if (cropGrowth(pl.plantHeight, b.index, pl.crop) < 1) continue; // 须已成熟
        pl.harvested = true;
        occupied.delete(`${pl.zoneId}|${pl.slot}`); // 腾出格位，可再种
        const h = cropHash(tx.from, b.hash, tx.txid);
        crops.push({
          id: tx.txid, owner: tx.from, plantId, crop: pl.crop, hash: h,
          traits: cropTraits(pl.crop, h), height: b.index, ts: tx.timestamp,
        });
        continue;
      }
      // CROPX|（P2P 转让）= Phase 2：先留前缀，本期不处理（即便出现也忽略，不改归属）。
    }
  }

  const recentSales = saleHeights.filter((h) => h > curHeight - LAND_VELOCITY_WINDOW).length;
  return {
    plots: [...plots.values()].sort((a, b) => a.n - b.n),
    zones: [...zones.values()].sort((a, b) => b.buildHeight - a.buildHeight),
    plants: [...plants.values()].sort((a, b) => b.plantHeight - a.plantHeight),
    crops: crops.sort((a, b) => b.height - a.height),
    soldTotal,
    recentSales,
    height: curHeight,
  };
}

/** 某地址的农场视图（其地块/区块/作物/已收获作物 + 当前地价预算 + 当前链高）。给 /api/farm 与客户端。 */
export interface FarmView {
  address: string;
  plots: Plot[];
  zones: Zone[];
  plants: Plant[];
  crops: HarvestedCrop[];
  nextPlotN: number; // 下一个可买地块号
  landPrice: number; // 买下一块地此刻需烧的币（按全网当前行情算）
  height: number; // 当前链高（成长据此算）
}

/** 从整条链算某地址的农场视图（含可复算的当前地价）。服务器算好省客户端整链扫描。 */
export function farmOf(chain: Block[], address: string): FarmView {
  const w = parseFarm(chain);
  const plots = w.plots.filter((p) => p.owner === address);
  const next = plots.reduce((mx, p) => Math.max(mx, p.n), -1) + 1;
  return {
    address,
    plots,
    zones: w.zones.filter((z) => z.owner === address),
    plants: w.plants.filter((p) => p.owner === address && !p.harvested),
    crops: w.crops.filter((c) => c.owner === address),
    nextPlotN: next,
    landPrice: landPrice({ soldTotal: w.soldTotal, recentSales: w.recentSales }),
    height: w.height,
  };
}
