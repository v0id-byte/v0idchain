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
import { NAME_PREFIX, isValidName } from './names.js';
import { MKT_PREFIX, DEL_PREFIX, MAX_TITLE } from './market.js';
import { RELAY_PREFIX, parseRelayMemo } from './relays.js';

export interface ChainMessage {
  txid: string;
  from: string; // 发件人
  to: string; // 收件人
  text: string; // 正文（= 交易 memo）
  burn: number; // 这条消息烧掉的 $V0ID
  timestamp: number;
  height: number; // 所在区块高度
}

/** 一笔交易是否“链上消息”（用于收件箱展示）：不转币（amount 0）但销毁了币（burn>0）。coinbase/创世天然不满足，自动排除。 */
export function isMessageTx(tx: { amount: number; burn?: number }): boolean {
  return tx.amount === 0 && (tx.burn ?? 0) > 0;
}

/**
 * 是否“该受消息防刷底线约束”的候选交易。在原有 isMessageTx（amount=0+burn>0，发给任何人，含
 * 最常见的“张三发消息给李四”场景）**基础上追加**一种新形态，而不是取代它——
 * 自转（from===to）+ memo 非空 + amount 可以 >0：这是本次修复要堵的口子，把消息伪装成
 * “自己转给自己 N 个币 + 附言”（amount>0, burn 可以是 0），因为不满足 isMessageTx 的 amount=0
 * 形态而被完全放过，只需付最低手续费 minFeeFor(amount) 就能在链上塞任意长度文本（512 码点），
 * 等于绕开了整条消息防刷底线（该场景在经济实质上就是一条消息——钱转回自己手里，没有真实价值
 * 转移，唯一目的是塞内容）。
 *
 * ⚠️ 这里必须是“or”不是“替代”：如果误把 isMessageTx 判断丢掉、只留自转分支，会导致最常见的
 * “发消息给别人”（from!==to）反而被排除在候选之外、完全绕开消息门槛——比本次要修的漏洞更严重。
 *
 * 真实的“转账给别人 + 备注”（amount>0, from!==to）不受这条新增分支影响——那是有价值转移的合法
 * 场景，产品上允许自由备注，且转账金额越大手续费越高，天然区别于“零成本刷屏”，不该被消息门槛约束。
 *
 * 用于展示（收件箱）的语义仍由 isMessageTx 单独把关，不跟着扩大——“自转夹带”被 Feature A 经济门槛
 * 约束住即可，它依然不该出现在消息列表里（没有真实收件人）。
 */
export function isMemoSpamCandidate(tx: { amount: number; burn?: number; from: string; to: string; memo: string }): boolean {
  if (isMessageTx(tx)) return true;
  return tx.from === tx.to && tx.memo.length > 0;
}

const HEX64 = /^[0-9a-f]{64}$/;
// 数字类 payload（地块号/区块号/格位号）的位数上限：9 位（最大 999999999）远超任何真实场景可能达到的
// 数量级，纯粹用来堵住“塞几百位数字当幌子”的套壳——真正的业务范围校验仍在 parseFarm 里。
const DIGITS = /^\d{1,9}$/;

/**
 * 某笔交易是否属于“协议层约定”（崽/红包/钓鱼/农场/矿洞/昵称/集市/中继等建在 memo 上的子系统），
 * 而非真人私信正文。这些子系统也会发出与链上消息撞型的交易——不排除的话会被 parseMessages 误收进
 * 收件箱，激活消息防刷底线后还会被误判成可以豁免烧币下限。此处按四类前缀区别对待：
 *
 * ① CLAIM/REFUND/UNSTAKE/SLASH（id 引用类，amount=0，consensus 拒绝条件不依赖 amount）：**共识层**
 *    （blockchain.ts redOpError）校验时完全不看 `to`（只认 memo 里引用的 id + 发起人权限），且未激活/
 *    格式错/权限不对时**无条件**拒绝（不看 amount 是多少），不合法形态根本进不了链，`startsWith` 足够。
 * ② STAKE/RED/IDCLAIM（转托管创建类）：consensus 只在 `to === 对应托管地址` 时才校验其合法性——若发往
 *    别的地址，redOpError 的对应分支根本不会触发，交易会落到 NORMAL 兜底，此时若仍判定为“协议层”会让它
 *    绕过消息门槛。故必须额外核对 `to === 对应托管地址`。STAKE/IDCLAIM 还各自有共识激活高度（RED 从创世
 *    即生效，没有）——**激活前它们是 amount>0 的普通转账，会被 consensus 直接接受但不会被当协议操作**，
 *    此时仍判定为协议层会让它免费绕过消息门槛，故还需核对 `atHeight >= 对应激活高度`。
 * ③ IDRELEASE（id 引用类，但拒绝条件依赖 amount，单独一类，不能归进①）：**redOpError 的未激活门控只在
 *    `tx.amount === 0` 时才触发**（`!identityActive && startsWith(IDRELEASE) && amount===0` 才拒绝），
 *    这是刻意设计——避免 retroactive 拒绝激活前 amount>0 的历史普通转账。副作用是「amount≠0 + 未激活」
 *    这个组合会漏过 redOpError 所有 IDRELEASE 专属分支、落到 NORMAL 当普通转账接受，此时若 isProtocolMemo
 *    仍无条件按前缀判定为协议操作，就会被免费用来绕过消息门槛（自转 1 币 + 超长 IDRELEASE| 内容 + burn=0）。
 *    故必须核对 `atHeight >= IDENTITY_ACTIVATION_HEIGHT && amount === 0`——真正会被 consensus 当解锁
 *    处理的唯一形态。
 * ④ PET/FISH/LAND/ZONE/PLANT/HARVEST/CROPX/MINE 系：共识层完全不管，合法性全靠各自 parseXxx(chain) 在
 *    展示层重放判定，且几乎全部要求 `from === to`（自转烧币，见各模块 `selfBurn`/`tx.from!==tx.to` 判断），
 *    `PETX`（送崽转移）例外——要求 `to !== from` 且 `amount>0`（转账）。纯 `startsWith` 或只核对 payload/
 *    烧币额仍不够：不满足自转/转移语境的“伪装成协议操作的普通转账”也会被误判排除；数字类 payload
 *    （地块号/区块号/格位号）若不限长度，也能被塞成任意长度的数字串当垃圾载体（这几个字段的真实业务
 *    范围校验在 parseFarm 里，此处只做“像不像一个正常数字标识符”的语法粗筛，用 DIGITS 卡位数上限）。
 *    故这里同时核对 payload 格式 + 该操作要求的精确/达标烧币额 + `from`/`to`/`amount` 语境，**复用各
 *    模块导出的现成常量/函数**而非在此重复定义一套规则，避免与游戏模块演进脱节。
 * ⑤ NAME/MKT/DEL/RELAY（自转、burn 恒为 0 的纯展示层约定）：昵称抢注/集市上架/集市撤单/中继发布都是
 *    “自转 1 币 + memo，burn=0”。isMemoSpamCandidate 收紧为“自转+memo 非空”（不再要求 amount=0）后，
 *    这几个不能再像旧版那样靠“burn=0 被 isMessageTx 天然排除”蒙混过关，必须显式核对 payload 格式
 *    （复用 names.ts/market.ts/relays.ts 的现成校验）+ `burn === 0`（真实形态恒定，容不得套壳夹带垃圾
 *    还绕开门槛——套壳者只要 burn>0 就已经不是这几个协议的合法形态，会落回消息门槛）。
 *
 * ⚠️ 刻意**不含** `ENC|`（端到端加密私信，本就是私信正文，必须留在收件箱）。
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

  // ① id 引用类（拒绝条件不依赖 amount）：consensus 不看 to、未激活/格式错/权限不对时无条件拒绝，startsWith 足够
  if (
    memo.startsWith(UNSTAKE_PREFIX) ||
    memo.startsWith(SLASH_PREFIX) ||
    memo.startsWith(CLAIM_PREFIX) ||
    memo.startsWith(REFUND_PREFIX)
  ) {
    return true;
  }

  // ② 转托管创建类：只有真的发往对应托管地址 + 已过激活高度，consensus 才会校验/接纳，否则等于普通转账
  if (memo.startsWith(STAKE_PREFIX)) return to === STAKE_ESCROW_ADDRESS && atHeight >= STAKING_ACTIVATION_HEIGHT;
  if (memo.startsWith(RED_PREFIX)) return to === RED_ESCROW_ADDRESS; // 红包从创世即生效，无激活高度
  if (memo.startsWith(IDCLAIM_PREFIX)) return to === IDENTITY_ESCROW_ADDRESS && atHeight >= IDENTITY_ACTIVATION_HEIGHT;

  // ③ IDRELEASE：拒绝条件依赖 amount（未激活门控只拦 amount=0 新边界），故不能归进①的无条件 startsWith；
  //    只有「已激活 + amount=0」才是真正会被 consensus 当解锁处理的形态，其余（含未激活+amount≠0）不豁免。
  if (memo.startsWith(IDRELEASE_PREFIX)) return atHeight >= IDENTITY_ACTIVATION_HEIGHT && amount === 0;

  // ④ 仅应用层校验的游戏前缀：payload 格式 + 烧币额 + from/to/amount 语境，防「伪装成协议操作」绕过消息门槛
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

  // ⑤ 自转、burn 恒为 0 的纯展示层约定：昵称抢注 / 集市上架 / 集市撤单 / 中继发布
  if (memo.startsWith(NAME_PREFIX)) {
    if (!selfTransfer || burn !== 0) return false;
    const name = memo.slice(NAME_PREFIX.length).trim().toLowerCase(); // 归一化口径同 parseNames
    return isValidName(name);
  }
  if (memo.startsWith(MKT_PREFIX)) {
    if (!selfTransfer || burn !== 0) return false;
    const rest = memo.slice(MKT_PREFIX.length);
    const sep = rest.indexOf('|');
    if (sep < 0) return false;
    const price = Number(rest.slice(0, sep));
    const title = rest.slice(sep + 1);
    return Number.isInteger(price) && price > 0 && title.length > 0 && [...title].length <= MAX_TITLE;
  }
  if (memo.startsWith(DEL_PREFIX)) {
    // 撤单：V0idNode.marketDelist() 固定自转 1 币 + burn=0；payload = 上架交易 txid（64-hex）。
    return selfTransfer && burn === 0 && HEX64.test(memo.slice(DEL_PREFIX.length));
  }
  if (memo.startsWith(RELAY_PREFIX)) {
    return selfTransfer && burn === 0 && parseRelayMemo(memo) !== null;
  }

  return false;
}

/** 是否“真实消息”（应受消息防刷底线约束，见 config.ts minMessageBurnFor）：消息防刷候选 + 非协议层 memo。 */
export function isRealMessage(tx: {
  amount: number;
  burn?: number;
  memo: string;
  from: string;
  to: string;
  atHeight: number;
}): boolean {
  return isMemoSpamCandidate(tx) && !isProtocolMemo(tx);
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
