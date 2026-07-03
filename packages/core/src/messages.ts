// 链上消息：完全建在“消息交易”（amount 0 + burn>0 + memo 正文）之上。
// 任何节点扫一遍链，就能把这些交易还原成消息列表 —— 消息随链全网同步、永久可查，零中心化服务器。
// 收件箱 = to 是我的消息；发件箱 = from 是我的消息。memo 即正文，无需任何前缀。
import type { Block } from './block.js';
import {
  NULL_ADDRESS,
  RED_PREFIX,
  RED_ESCROW_ADDRESS,
  CLAIM_PREFIX,
  REFUND_PREFIX,
  STAKE_PREFIX,
  STAKE_ESCROW_ADDRESS,
  STAKING_ACTIVATION_HEIGHT,
  UNSTAKE_PREFIX,
  SLASH_PREFIX,
  IDCLAIM_PREFIX,
  IDENTITY_ESCROW_ADDRESS,
  IDENTITY_ACTIVATION_HEIGHT,
  IDRELEASE_PREFIX,
} from './config.js';
import {
  PET_PREFIX,
  PETX_PREFIX,
  PETBREED_PREFIX,
  PETEVO_PREFIX,
  PETFARM_PREFIX,
  PETUNSTATION_PREFIX,
  PET_BREED_COST,
  PET_EVO_COST,
  PETFARM_COST,
} from './pets.js';
import { FISH_PREFIX } from './fishing.js';
import {
  LAND_PREFIX,
  ZONE_PREFIX,
  PLANT_PREFIX,
  HARVEST_PREFIX,
  CROPX_PREFIX,
  ZONE_TYPES,
  CROPS,
  SEED_COST,
  ZONE_COST,
  HARVEST_BURN,
  type Crop,
} from './farm.js';
import { MINE_PREFIX, parseMineMemo, mineDiscoveryBurn, mineMaterialBurn } from './mining.js';

export interface ChainMessage {
  txid: string;
  from: string; // 发件人
  to: string; // 收件人
  text: string; // 正文（= 交易 memo）
  burn: number; // 这条消息烧掉的 $V0ID
  timestamp: number;
  height: number; // 所在区块高度
}

/** 一笔交易是否“链上消息”：不转币（amount 0）但销毁了币（burn>0）。coinbase/创世天然不满足，自动排除。 */
export function isMessageTx(tx: { amount: number; burn?: number }): boolean {
  return tx.amount === 0 && (tx.burn ?? 0) > 0;
}

const HEX64 = /^[0-9a-f]{64}$/;
// 数字类 payload（地块号/区块号/格位号）的位数上限：9 位（最大 999999999）远超任何真实场景可能达到的
// 数量级，纯粹用来堵住“塞几百位数字当幌子”的套壳——真正的业务范围校验仍在 parseFarm 里。
const DIGITS = /^\d{1,9}$/;

/**
 * 某笔交易是否属于“协议层约定”（崽/红包/钓鱼/农场/矿洞等建在 memo 上的子系统），而非真人私信正文。
 * 这些子系统也会发出 `amount=0 + burn>0` 形态的交易（如孵崽 `PET|`、铸渔获 `FISH|`、买地 `LAND|`/种植 `PLANT|` 都是自转烧币），
 * 与链上消息的形态撞型 → 不排除的话会被 parseMessages 误收进收件箱。消息防刷底线上线后，这个判定还多了一层
 * 经济含义：被排除的交易不受烧币下限约束，故此处按两类前缀区别对待：
 *
 * ① CLAIM/REFUND/UNSTAKE/SLASH/IDRELEASE（id 引用类，amount=0）：**共识层**（blockchain.ts redOpError）
 *    校验时完全不看 `to`（只认 memo 里引用的 id + 发起人权限），不合法形态（id 不存在/格式错/权限不对）
 *    根本进不了链，`startsWith` 足够，不构成绕过消息门槛的风险。这几个各自也有“激活前 amount=0 新边界
 *    直接拒绝”的门控（见 blockchain.ts redOpError 早期分支），不需要在此重复判断高度。
 * ② STAKE/RED/IDCLAIM（转托管创建类）：consensus 只在 `to === 对应托管地址` 时才校验其合法性——若发往
 *    别的地址，redOpError 的对应分支根本不会触发，交易会落到 NORMAL 兜底，此时若仍判定为“协议层”会让它
 *    绕过消息门槛。故必须额外核对 `to === 对应托管地址`。STAKE/IDCLAIM 还各自有共识激活高度（RED 从创世
 *    即生效，没有）——**激活前它们是 amount>0 的普通转账，会被 consensus 直接接受但不会被当协议操作**，
 *    此时仍判定为协议层会让它免费绕过消息门槛，故还需核对 `atHeight >= 对应激活高度`。
 * ③ PET/FISH/LAND/ZONE/PLANT/HARVEST/CROPX/MINE 系：共识层完全不管，合法性全靠各自 parseXxx(chain) 在
 *    展示层重放判定，且几乎全部要求 `from === to`（自转烧币，见各模块 `selfBurn`/`tx.from!==tx.to` 判断），
 *    `PETX`（送崽转移）例外——要求 `to !== from` 且 `amount>0`（转账）。纯 `startsWith` 或只核对 payload/
 *    烧币额仍不够：不满足自转/转移语境的“伪装成协议操作的普通转账”也会被误判排除；数字类 payload
 *    （地块号/区块号/格位号）若不限长度，也能被塞成任意长度的数字串当垃圾载体（这几个字段的真实业务
 *    范围校验在 parseFarm 里，此处只做“像不像一个正常数字标识符”的语法粗筛，用 DIGITS 卡位数上限）。
 *    故这里同时核对 payload 格式 + 该操作要求的精确/达标烧币额 + `from`/`to`/`amount` 语境，**复用各
 *    模块导出的现成常量/函数**而非在此重复定义一套规则，避免与游戏模块演进脱节。
 *
 * ⚠️ 刻意**不含** `ENC|`（端到端加密私信，本就是私信正文，必须留在收件箱）与 `NAME|`（抢注是 burn=0 的自转，
 * 形态上压根不是消息，isMessageTx 已天然排除，无需也不该在此列）。
 */
export function isProtocolMemo(tx: {
  memo: string;
  burn?: number;
  from?: string;
  to?: string;
  amount?: number;
  atHeight?: number;
}): boolean {
  const { memo, from, to } = tx;
  const burn = tx.burn ?? 0;
  const amount = tx.amount ?? 0;
  const atHeight = tx.atHeight ?? Infinity; // 未传高度（如旧调用点/纯单元测试）时按“已激活”处理，不新增拒绝面
  const selfTransfer = from !== undefined && to !== undefined && from === to;

  // ① id 引用类：consensus 不看 to，不合法形态（含激活前 amount=0 新边界）进不了链，startsWith 足够
  if (
    memo.startsWith(UNSTAKE_PREFIX) ||
    memo.startsWith(SLASH_PREFIX) ||
    memo.startsWith(CLAIM_PREFIX) ||
    memo.startsWith(REFUND_PREFIX) ||
    memo.startsWith(IDRELEASE_PREFIX)
  ) {
    return true;
  }

  // ② 转托管创建类：只有真的发往对应托管地址 + 已过激活高度，consensus 才会校验/接纳，否则等于普通转账
  if (memo.startsWith(STAKE_PREFIX)) return to === STAKE_ESCROW_ADDRESS && atHeight >= STAKING_ACTIVATION_HEIGHT;
  if (memo.startsWith(RED_PREFIX)) return to === RED_ESCROW_ADDRESS; // 红包从创世即生效，无激活高度
  if (memo.startsWith(IDCLAIM_PREFIX)) return to === IDENTITY_ESCROW_ADDRESS && atHeight >= IDENTITY_ACTIVATION_HEIGHT;

  // ③ 仅应用层校验的游戏前缀：payload 格式 + 烧币额 + from/to/amount 语境，防「伪装成协议操作」绕过消息门槛
  if (memo === PET_PREFIX) return selfTransfer; // 孵化：memo 精确、自转、burn 只要求 >0（无固定值），无 payload 可塞
  if (memo === FISH_PREFIX) return selfTransfer; // 铸渔获：同上
  if (memo === CROPX_PREFIX) return selfTransfer; // 预留前缀（尚未实现转移逻辑），无已知格式，精确匹配最保守

  if (memo.startsWith(PETX_PREFIX)) {
    // 送崽：转移给别人（非自转）+ 真的转了币，payload=petId。amount=0 的「转移」不是真实语义，不豁免。
    return !selfTransfer && amount > 0 && HEX64.test(memo.slice(PETX_PREFIX.length));
  }
  if (memo.startsWith(PETUNSTATION_PREFIX)) return selfTransfer && HEX64.test(memo.slice(PETUNSTATION_PREFIX.length)); // 召回：自转、免费，payload=petId
  if (memo.startsWith(PETBREED_PREFIX)) {
    const parts = memo.slice(PETBREED_PREFIX.length).split('|');
    return selfTransfer && parts.length === 2 && parts.every((p) => HEX64.test(p)) && burn === PET_BREED_COST;
  }
  if (memo.startsWith(PETEVO_PREFIX)) {
    return selfTransfer && HEX64.test(memo.slice(PETEVO_PREFIX.length)) && burn === PET_EVO_COST;
  }
  if (memo.startsWith(PETFARM_PREFIX)) {
    const parts = memo.slice(PETFARM_PREFIX.length).split('|');
    return selfTransfer && parts.length === 2 && parts.every((p) => HEX64.test(p)) && burn === PETFARM_COST;
  }
  if (memo.startsWith(LAND_PREFIX)) {
    // 地价随链上状态浮动（下限需重放 soldTotal/velocity 才能算出），此处无法精确核验金额；
    // 但 payload 收紧为「≤9 位数字 + 自转」已杜绝夹带任意长度字符串，真实地价下限仍由 parseFarm/共识层把关。
    return selfTransfer && DIGITS.test(memo.slice(LAND_PREFIX.length));
  }
  if (memo.startsWith(ZONE_PREFIX)) {
    if (!selfTransfer) return false;
    const rest = memo.slice(ZONE_PREFIX.length);
    const sep = rest.indexOf('|');
    if (sep < 0) return false;
    const plotN = rest.slice(0, sep);
    const type = rest.slice(sep + 1);
    return DIGITS.test(plotN) && (ZONE_TYPES as readonly string[]).includes(type) && burn === ZONE_COST;
  }
  if (memo.startsWith(PLANT_PREFIX)) {
    if (!selfTransfer) return false;
    const parts = memo.slice(PLANT_PREFIX.length).split('|');
    if (parts.length !== 3) return false;
    const [zoneId, crop, slot] = parts;
    if (!HEX64.test(zoneId) || !(CROPS as readonly string[]).includes(crop) || !DIGITS.test(slot)) return false;
    return burn === SEED_COST[crop as Crop];
  }
  if (memo.startsWith(HARVEST_PREFIX)) {
    return selfTransfer && HEX64.test(memo.slice(HARVEST_PREFIX.length)) && burn === HARVEST_BURN;
  }
  if (memo.startsWith(MINE_PREFIX)) {
    if (!selfTransfer) return false;
    const m = parseMineMemo(memo);
    if (!m) return false;
    const needed = m.type === 'discovery' ? mineDiscoveryBurn(m.depth, m.kind) : mineMaterialBurn(m.kind, m.count);
    return burn >= needed;
  }

  return false;
}

/** 是否“真实消息”（应受消息防刷底线约束，见 config.ts minMessageBurnFor）：amount=0+burn>0 且非协议层 memo。 */
export function isRealMessage(tx: {
  amount: number;
  burn?: number;
  memo: string;
  from: string;
  to: string;
  atHeight: number;
}): boolean {
  return isMessageTx(tx) && !isProtocolMemo(tx);
}

/** 扫整条链，把所有消息交易还原成消息列表（最新在前）。协议层 memo（PET/RED/FISH…）不算私信，跳过。 */
export function parseMessages(chain: Block[]): ChainMessage[] {
  const out: ChainMessage[] = [];
  for (const b of chain) {
    for (const tx of b.transactions) {
      if (!isMessageTx(tx)) continue;
      if (isProtocolMemo({ ...tx, atHeight: b.index })) continue;
      out.push({
        txid: tx.txid,
        from: tx.from,
        to: tx.to,
        text: tx.memo,
        burn: tx.burn ?? 0,
        timestamp: tx.timestamp,
        height: b.index,
      });
    }
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/** 收集链上出现过的全部地址（作为 from 或 to），用于“新地址首次上链”发现。排除虚空地址。 */
export function collectAddresses(chain: Block[]): Set<string> {
  const set = new Set<string>();
  for (const b of chain) {
    for (const tx of b.transactions) {
      if (tx.from !== NULL_ADDRESS) set.add(tx.from);
      if (tx.to !== NULL_ADDRESS) set.add(tx.to);
    }
  }
  return set;
}
