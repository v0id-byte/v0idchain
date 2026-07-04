// 链上消息：完全建在“消息交易”（amount 0 + burn>0 + memo 正文）之上。
// 任何节点扫一遍链，就能把这些交易还原成消息列表 —— 消息随链全网同步、永久可查，零中心化服务器。
// 收件箱 = to 是我的消息；发件箱 = from 是我的消息。memo 即正文，无需任何前缀。
import type { Block } from './block.js';
import {
  NULL_ADDRESS,
  MESSAGE_FREE_MEMO_CHARS,
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
  IDENTITY_STAKE_MIN,
  IDRELEASE_PREFIX,
  ROOM_PREFIX,
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
import {
  MINE_PREFIX,
  parseMineMemo,
  mineDiscoveryBurn,
  mineMaterialBurn,
  makeMineDiscovery,
  makeMineMaterial,
} from './mining.js';
import { NAME_PREFIX, isValidName } from './names.js';
import { MKT_PREFIX, BUY_PREFIX, DEL_PREFIX, MAX_TITLE } from './market.js';
import { RELAY_PREFIX, parseRelayMemo, buildRelayMemo } from './relays.js';
import { parseRedCreate } from './redpacket.js';

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
 * 是否“该受消息防刷底线约束”的候选交易。三条**并列**规则（or，任一命中即候选）：
 *
 * (1) isMessageTx（amount=0 + burn>0）：最常见的“张三发消息给李四”，本就是消息，全额受门槛。
 * (2) 自转（from===to）+ memo 非空（amount 可 >0）：把消息伪装成“自己转给自己 N 个币 + 附言”——
 *     钱转回自己手里、无真实价值转移、唯一目的是塞内容，经济实质就是一条消息，必须受门槛。
 * (3) memo 长度 > MESSAGE_FREE_MEMO_CHARS：**任意**带超长备注的交易，无论 from/to/amount。这条封堵
 *     “双钱包接力”——A→自己控制的第二个钱包 amount=1 + 超长 memo，因既非 amount=0 消息、又非自转，
 *     漏过 (1)(2) 只付 minFeeFor(amount) 就塞满 512 码点。链上无法证明两地址是否同属一人，无法靠
 *     from/to 区分真实付款与自我接力，故改用**长度**判：≤ 额度的备注（真实付款的一行短附言）完全免费；
 *     超额则不管怎么路由都受门槛。接力攻击每笔最多免费夹带 MESSAGE_FREE_MEMO_CHARS 码点，灌水成本抬高。
 *
 * ⚠️ (1) 必须保留、不能被后两条替代：否则最常见的“发消息给别人”（from!==to、可能 <额度）会漏出候选。
 *
 * 真实的“转账给别人 + **短**备注”（from!==to、amount>0、memo ≤ 额度）仍完全不受约束——有价值转移的合法
 * 场景，产品上允许自由（短）附言。只有当备注长到 > 额度、更像灌水载体而非附言时，才一并受门槛。
 *
 * 协议层 memo（RELAY/PLANT 等本就可能 >额度）由 isProtocolMemo 在 isRealMessage 里单独豁免，不受 (3) 误伤。
 * 用于展示（收件箱）的语义仍由 isMessageTx 单独把关，不跟着扩大——付款+长备注不是私信，不进消息列表。
 */
export function isMemoSpamCandidate(tx: { amount: number; burn?: number; from: string; to: string; memo: string }): boolean {
  if (isMessageTx(tx)) return true; // (1)
  if (tx.from === tx.to && tx.memo.length > 0) return true; // (2)
  return [...tx.memo].length > MESSAGE_FREE_MEMO_CHARS; // (3) 按 Unicode 码点计，同 MAX_MEMO/minMessageBurnFor 口径
}

const HEX64 = /^[0-9a-f]{64}$/;
// 数字类 payload（地块号/区块号/格位号）的位数上限：9 位（最大 999999999）远超任何真实场景可能达到的
// 数量级，纯粹用来堵住“塞几百位数字当幌子”的套壳——真正的业务范围校验仍在 parseFarm 里。
const DIGITS = /^\d{1,9}$/;

// 全部协议层 memo 前缀（用于「历史字符串签名」的纯前缀判定——见 isProtocolMemo 的字符串入参分支）。
// 与下面 isProtocolMemo 对象分支覆盖的前缀保持一致；ENC| 刻意不含（端到端私信正文，本就该进收件箱）。
const PROTOCOL_MEMO_PREFIXES = [
  UNSTAKE_PREFIX, SLASH_PREFIX, CLAIM_PREFIX, REFUND_PREFIX,
  STAKE_PREFIX, RED_PREFIX, IDCLAIM_PREFIX, IDRELEASE_PREFIX,
  PET_PREFIX, PETX_PREFIX, PETBREED_PREFIX, PETEVO_PREFIX, PETFARM_PREFIX, PETUNSTATION_PREFIX,
  FISH_PREFIX, CROPX_PREFIX, LAND_PREFIX, ZONE_PREFIX, PLANT_PREFIX, HARVEST_PREFIX, MINE_PREFIX,
  NAME_PREFIX, MKT_PREFIX, BUY_PREFIX, DEL_PREFIX, RELAY_PREFIX, ROOM_PREFIX,
];

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
 *    此时仍判定为协议层会让它免费绕过消息门槛，故还需核对 `atHeight >= 对应激活高度`。RED/IDCLAIM 还须
 *    核对 `amount` 达标（RED 用 parseRedCreate 反推的 `count`；IDCLAIM 用 `IDENTITY_STAKE_MIN`）——
 *    `amount` 不足时 applyTx 的门槛判断恒假，consensus 不会当真操作接受，只是普通烧币到托管地址，此时
 *    若仍判定为协议层，会让「合法前缀 + burn>0 + amount 不足」组合免费绕开消息门槛（真正 amount 达标、
 *    发给托管地址的合法创建操作是有价值转移的第三方转账，天然不落入 isMemoSpamCandidate 的候选范围，
 *    不受此处影响）。STAKE 因其门槛 `computeStakeMin` 依赖区块难度、此处拿不到，暂不做同款收紧
 *    （已知缺口，留待后续单独处理——本轮改动范围外）。
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
 * ⑤ NAME/MKT/DEL/RELAY/ROOM（自转、burn 恒为 0 的纯展示层约定）：昵称抢注/集市上架/集市撤单/中继发布/
 *    房间布局发布都是“自转 1 币 + memo，burn=0”。isMemoSpamCandidate 收紧为“自转+memo 非空”（不再要求
 *    amount=0）后，这几个不能再像旧版那样靠“burn=0 被 isMessageTx 天然排除”蒙混过关，必须显式核对
 *    payload 格式（复用 names.ts/market.ts/relays.ts 的现成校验；ROOM 无独立 core 模块，直接核对
 *    64-hex hash）+ `burn === 0`（真实形态恒定，容不得套壳夹带垃圾还绕开门槛——套壳者只要 burn>0
 *    就已经不是这几个协议的合法形态，会落回消息门槛）。
 *
 * ⚠️ 刻意**不含** `ENC|`（端到端加密私信，本就是私信正文，必须留在收件箱）。
 *
 * 入参兼容：本函数历史签名是 `isProtocolMemo(memo: string)`，做**收件箱展示过滤**用（判断一条 memo 像不像
 * 协议 memo、以便不当私信显示）。本轮加固后改为需要完整交易语境的对象签名，做**经济门槛豁免**判定。二者
 * 的“保守方向”正好相反：展示层缺信息时应偏向“当协议、别显示”（纯前缀命中即真），经济层缺信息时应偏向
 * “当真消息、照收门槛”。故字符串入参**沿用历史纯前缀语义**（命中任一协议前缀即 true，见 PROTOCOL_MEMO_PREFIXES）——
 * 精确复刻旧版展示行为、不把 PET/FISH 等协议 memo 泄进收件箱；对象入参才走下面完整的语境化豁免判定
 * （消息门槛只由对象调用点 isRealMessage→redOpError 驱动，永远传对象，故字符串分支绝不参与经济门槛、
 * 不会因纯前缀放行而在门槛侧开绕过口子）。字符串调用方若需精确豁免判定应改传完整交易。
 */
export function isProtocolMemo(
  tx:
    | string
    | {
        memo: string;
        burn?: number;
        from?: string;
        to?: string;
        amount?: number;
        atHeight?: number;
      },
): boolean {
  // 历史字符串签名（展示过滤）：纯前缀判定，命中任一协议前缀即视为协议 memo（与旧版逐字一致）。
  if (typeof tx === 'string') return PROTOCOL_MEMO_PREFIXES.some((p) => tx.startsWith(p));
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
  if (memo.startsWith(RED_PREFIX)) {
    // 红包从创世即生效，无激活高度；但 amount 须达标（applyTx 要求 amount >= meta.count）才是真红包。
    const meta = parseRedCreate(memo);
    return to === RED_ESCROW_ADDRESS && meta !== null && amount >= meta.count;
  }
  if (memo.startsWith(IDCLAIM_PREFIX)) {
    return to === IDENTITY_ESCROW_ADDRESS && atHeight >= IDENTITY_ACTIVATION_HEIGHT && amount >= IDENTITY_STAKE_MIN;
  }

  // ③ IDRELEASE：拒绝条件依赖 amount（未激活门控只拦 amount=0 新边界），故不能归进①的无条件 startsWith；
  //    只有「已激活 + amount=0」才是真正会被 consensus 当解锁处理的形态，其余（含未激活+amount≠0）不豁免。
  if (memo.startsWith(IDRELEASE_PREFIX)) return atHeight >= IDENTITY_ACTIVATION_HEIGHT && amount === 0;

  // ④ 仅应用层校验的游戏前缀：payload 格式 + 烧币额 + from/to/amount 语境，防「伪装成协议操作」绕过消息门槛
  // 孵化/铸渔获：parsePets/parseFish 都要求 burn>0（见各自 `tx.from!==tx.to || (tx.burn??0)<=0` 早退）；
  // 此前这里没核对 burn，burn=0 的精确 `PET|`/`FISH|` 自转会被误判成真实铸造而免费绕开消息门槛（虽然
  // 因是精确匹配、无 payload 可塞，spam 规模有限，但判定本身错误——它根本不是一次真实铸造）。
  if (memo === PET_PREFIX) return selfTransfer && burn > 0; // 孵化：memo 精确、自转、burn>0（无固定值），无 payload 可塞
  if (memo === FISH_PREFIX) return selfTransfer && burn > 0; // 铸渔获：同上
  if (memo === CROPX_PREFIX) return selfTransfer; // 预留前缀（尚未实现转移逻辑，parseFarm 无条件忽略，无 burn 要求），精确匹配最保守

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
    // parseFarm 的 selfBurn 门槛要求 burn>0（地价恒为正）——此前这里没核对，burn=0 的「LAND|<n>」
    // 自转会被误判成真实买地而免费绕开消息门槛。
    return selfTransfer && burn > 0 && DIGITS.test(memo.slice(LAND_PREFIX.length));
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
    // 深度/坐标/数量字段用 Number() 归一化，前导零填充可把 memo 撑满 512 码点仍解析出合法小值；
    // 用同一套 make* 建造函数反推规范 memo 做逐字节比对，堵住这条填充绕开消息门槛的路。
    const rebuilt = m.type === 'discovery' ? makeMineDiscovery(m.depth, m.x, m.y, m.kind) : makeMineMaterial(m.kind, m.count);
    if (!rebuilt.ok || rebuilt.memo !== memo) return false;
    const needed = m.type === 'discovery' ? mineDiscoveryBurn(m.depth, m.kind) : mineMaterialBurn(m.kind, m.count);
    return burn >= needed;
  }

  // ⑤ 自转、burn 恒为 0 的纯展示层约定：昵称抢注 / 集市上架 / 集市撤单 / 中继发布
  if (memo.startsWith(NAME_PREFIX)) {
    if (!selfTransfer || burn !== 0) return false;
    // 不 trim：parseNames 会 trim 后再判定合法性（容忍意外首尾空白），但这里若照抄 trim，会让「真实
    // 内容只有 1 个字符、靠几百个空格填充撑满 512 码点」的套壳被 isValidName 放过；NAME_RE 本就不含
    // 空白字符，不 trim 直接判定既保留大小写不敏感、又堵死这条空白填充路径。
    const name = memo.slice(NAME_PREFIX.length).toLowerCase();
    return isValidName(name);
  }
  if (memo.startsWith(MKT_PREFIX)) {
    if (!selfTransfer || burn !== 0) return false;
    const rest = memo.slice(MKT_PREFIX.length);
    const sep = rest.indexOf('|');
    if (sep < 0) return false;
    const priceToken = rest.slice(0, sep);
    const price = Number(priceToken);
    const title = rest.slice(sep + 1);
    // 价格字段须是其数值的规范十进制形式（无前导零/正号/科学计数法等），否则可用几百位填充撑满 512
    // 码点、仍被 Number() 归一成合法小价格，绕开消息门槛。
    return (
      Number.isInteger(price) && price > 0 && String(price) === priceToken &&
      title.length > 0 && [...title].length <= MAX_TITLE
    );
  }
  if (memo.startsWith(DEL_PREFIX)) {
    // 撤单：V0idNode.marketDelist() 固定自转 1 币 + burn=0；payload = 上架交易 txid（64-hex）。
    return selfTransfer && burn === 0 && HEX64.test(memo.slice(DEL_PREFIX.length));
  }
  if (memo.startsWith(BUY_PREFIX)) {
    // ⑥ 集市购买：唯一「付款给别人（非自转）」形态的协议 memo——V0idNode.marketBuy() 付 price 给卖家
    //   （from≠to、amount>0、burn=0），payload = 上架交易 txid（64-hex，定长不可填充）。`BUY|<64hex>` 恒为
    //   68 码点 > 免费额度，若不在此豁免，激活后每一笔集市购买都会被消息门槛误杀（#1 的长度网副作用）。
    //   payload 定长 + hex-only，无法当灌水载体，豁免安全。金额是否 ≥ 标价由 parseMarket 结合状态判，此处
    //   只核结构形态。
    return !selfTransfer && amount > 0 && burn === 0 && HEX64.test(memo.slice(BUY_PREFIX.length));
  }
  if (memo.startsWith(RELAY_PREFIX)) {
    if (!selfTransfer || burn !== 0) return false;
    const m = parseRelayMemo(memo);
    // port 等数字字段同样能被前导零填充撑满 512 码点仍解析出合法小值；用 buildRelayMemo 反推规范
    // memo 逐字节比对，堵住这条绕开消息门槛的路。
    return m !== null && buildRelayMemo(m.onionPubHex, m.host, m.port, m.bandwidth, m.stakeTxid) === memo;
  }
  if (memo.startsWith(ROOM_PREFIX)) {
    // 房间布局发布：game-web publishRoom() 固定自转 1 币 + burn=0；payload = 布局 hash（64-hex）。
    return selfTransfer && burn === 0 && HEX64.test(memo.slice(ROOM_PREFIX.length));
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
