// 社交世界动态流（feed）：把整条链上的各子系统 memo 交易聚合成一条“全网最近发生了什么”的时间线。
// 纯读 / 聚合层：零新链上协议、零增发，只重放既有 memo（昵称/崽/钓鱼/农场/红包/私信）。
// 与 parsePets/parseFish/parseFarm/parseRedPackets/parseMessages 同源同纪律：纯函数、只依赖链 → reorg 安全、跨端一致。
// 稀有度复用各子系统既有门槛（崽=基因前导0、鱼=catchHash、收成=cropHash），不另立标准。
// ⚠️ 纯且确定性：只用 block.timestamp / block.index，**不得**碰 Date.now()/Math.random()（否则两端动态流不一致）。
import type { Block } from './block.js';
import { PET_PREFIX, petGene, petRarity } from './pets.js';
import { FISH_PREFIX, fishCatchHash, fishRarity, fishTraits } from './fishing.js';
import {
  LAND_PREFIX,
  HARVEST_PREFIX,
  cropHash,
  cropQuality,
} from './farm.js';
import { parseMineMemo, mineAssetHash, mineTraits } from './mining.js';
import { NAME_PREFIX, isValidName } from './names.js';
import { RED_PREFIX, RED_ESCROW_ADDRESS } from './config.js';
import { parseRedCreate, parseClaimId } from './redpacket.js';
import { isMessageTx, isProtocolMemo } from './messages.js';

/**
 * 一条动态：把某笔 memo 交易归类成可展示事件。actor = 发起人地址（tx.from），客户端自行用昵称解析显示。
 * 各字段按 type 选填（如 pet/fish/harvest 才有 rarity；redCreate 才有 n/amount；message/name 才有 text）。
 */
export interface FeedEvent {
  type: 'name' | 'pet' | 'fish' | 'land' | 'harvest' | 'mine' | 'redCreate' | 'redClaim' | 'message';
  actor: string; // 发起人地址（= tx.from）；不在此解析昵称（客户端做）
  rarity?: 'common' | 'rare' | 'epic' | 'legendary'; // pet/fish/harvest 的稀有度/品质
  refId?: string; // pet/fish 的藏品 id；redCreate=红包 id；redClaim=所抢红包 id
  n?: number; // redCreate=份数；land=地块号
  amount?: number; // redCreate=红包总额
  text?: string; // name=昵称；message=正文（memo）
  species?: string; // fish=鱼种索引（字符串化）
  crop?: string; // harvest=作物名
  mineKind?: string; // mine=矿物种类
  depth?: number; // mine=发现深度
  count?: number; // mine=材料数量
  height: number; // 所在区块高度
  timestamp: number; // 该交易时间戳
  txid: string;
}

/**
 * 扫整条链聚合出动态流（最新在前）。规则（与各子系统 parse* 的归类一致，但只取“发生了这件事”不重放余额/归属）：
 * - 昵称 NAME|<名字>：自转、burn=0（形态上非消息）、名字合法 → text=名字。
 * - 崽 PET|：自转 + 烧币 → rarity = petRarity(petGene(from, txid))，refId=崽 id（txid）。
 * - 钓鱼 FISH|：自转 + 烧币 → rarity/species 由 fishCatchHash(from, 区块hash, txid) 推导，refId=渔获 id。
 * - 买地 LAND|<n>：自转 + 烧币 → n=地块号。
 * - 收获 HARVEST|<plantId>：自转 + 烧币 → crop + rarity(品质) 由 cropHash(from, 区块hash, txid) 推导，refId=收获 id。
 * - 发红包 RED|<份数>|<r|e>（to=托管地址、amount≥份数）→ n=份数, amount=总额, refId=红包 id（txid）。
 * - 抢红包 CLAIM|<红包id> → refId=所抢红包 id。
 * - 私信：amount=0 + burn>0 + !isProtocolMemo → text=正文（memo）。
 * 纯函数（只依赖链）→ reorg 安全；NEWEST-FIRST（从链尾区块、块内倒序）扫，凑满 limit 即停。
 */
export function deriveFeed(chain: Block[], limit = 80): FeedEvent[] {
  const out: FeedEvent[] = [];
  // 从最新区块、块内最后一笔起倒扫 → 天然“最新在前”；凑满 limit 即可提前结束。
  for (let bi = chain.length - 1; bi >= 0 && out.length < limit; bi--) {
    const b = chain[bi];
    for (let ti = b.transactions.length - 1; ti >= 0 && out.length < limit; ti--) {
      const tx = b.transactions[ti];
      const m = tx.memo;
      if (!m) continue;
      const burn = tx.burn ?? 0;
      const selfBurn = tx.from === tx.to && burn > 0;
      const base = { actor: tx.from, height: b.index, timestamp: tx.timestamp, txid: tx.txid };

      if (m.startsWith(NAME_PREFIX)) {
        // 抢注是 burn=0 的自转（非消息）；名字须合法，与 parseNames 的入链校验一致。
        if (tx.from !== tx.to || burn > 0) continue;
        const name = m.slice(NAME_PREFIX.length).trim().toLowerCase();
        if (!isValidName(name)) continue;
        out.push({ type: 'name', ...base, text: name });
        continue;
      }

      if (m === PET_PREFIX) {
        if (!selfBurn) continue;
        const gene = petGene(tx.from, tx.txid);
        out.push({ type: 'pet', ...base, rarity: petRarity(gene), refId: tx.txid });
        continue;
      }

      if (m === FISH_PREFIX) {
        if (!selfBurn) continue;
        const h = fishCatchHash(tx.from, b.hash, tx.txid);
        out.push({
          type: 'fish', ...base,
          rarity: fishRarity(h),
          species: String(fishTraits(h).species),
          refId: tx.txid,
        });
        continue;
      }

      if (m.startsWith(LAND_PREFIX)) {
        if (!selfBurn) continue;
        const n = Number(m.slice(LAND_PREFIX.length));
        if (!Number.isInteger(n) || n < 0) continue;
        out.push({ type: 'land', ...base, n });
        continue;
      }

      if (m.startsWith(HARVEST_PREFIX)) {
        if (!selfBurn) continue;
        const plantId = m.slice(HARVEST_PREFIX.length);
        if (!/^[0-9a-f]{64}$/.test(plantId)) continue;
        // crop 名需由来源 plant 决定（种什么收什么），但动态流不重放整链归属；
        // 这里只展示“某人收获了”，作物名留空由客户端按 refId 查 /api/farm 补全。
        const h = cropHash(tx.from, b.hash, tx.txid);
        out.push({ type: 'harvest', ...base, rarity: cropQuality(h), refId: tx.txid });
        continue;
      }

      const mine = parseMineMemo(m);
      if (mine) {
        if (!selfBurn) continue;
        const h = mineAssetHash(tx.from, b.hash, tx.txid);
        out.push({
          type: 'mine',
          ...base,
          rarity: mineTraits(mine.kind, mine.type === 'discovery' ? mine.depth : undefined, h).rarity,
          refId: tx.txid,
          mineKind: mine.kind,
          depth: mine.type === 'discovery' ? mine.depth : undefined,
          count: mine.type === 'material' ? mine.count : 1,
        });
        continue;
      }

      if (m.startsWith(RED_PREFIX) && tx.to === RED_ESCROW_ADDRESS) {
        // 发红包：转给托管地址 + RED| memo，且总额 ≥ 份数（与 parseRedPackets 的入池校验一致）。
        const red = parseRedCreate(m);
        if (!red || tx.amount < red.count) continue;
        out.push({ type: 'redCreate', ...base, n: red.count, amount: tx.amount, refId: tx.txid });
        continue;
      }

      const claimId = parseClaimId(m);
      if (claimId) {
        out.push({ type: 'redClaim', ...base, refId: claimId });
        continue;
      }

      // 私信：amount=0 + burn>0 + 非协议 memo（与 parseMessages 一致）。
      if (isMessageTx(tx) && !isProtocolMemo(m)) {
        out.push({ type: 'message', ...base, text: m });
        continue;
      }
    }
  }
  return out;
}
