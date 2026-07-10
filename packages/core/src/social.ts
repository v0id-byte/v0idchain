// 公域社交帖（迷你 X）：memo 约定层，不改共识。
// 发帖 = amount 0 + burn≥POST_BURN + 自转 + memo `VPOST|1|0|<contentHash>[|<parentTxid>]`
// 正文不在链上：contentHash = sha256(canonical JSON body)；blob 由社交服务器按 hash 提供。
// 任何节点扫链即可还原帖索引（作者/时间/hash/回复指针）→ 可回溯、与 $V0ID 经济绑定。
import type { Block } from './block.js';
import { sha256Hex } from './crypto.js';
import { MAX_MEMO, MIN_FEE } from './config.js';
import { createMessage, type Transaction } from './transaction.js';
import type { Wallet } from './wallet.js';

export const VPOST_PREFIX = 'VPOST|';
export const VRP_PREFIX = 'VRP|';
export const VLIKE_PREFIX = 'VLIKE|';
export const VFOL_PREFIX = 'VFOL|';
export const VUNFOL_PREFIX = 'VUNFOL|';
export const VPROF_PREFIX = 'VPROF|';

/** 发帖默认销毁额（进虚空）；另付 MIN_FEE 给矿工。 */
export const POST_BURN = 5;
export const REPLY_BURN = 3;
export const REPOST_BURN = 2;
export const LIKE_BURN = 0; // 仅 gas；解析仍要求 amount=0 自转 + 合法 memo
export const FOLLOW_BURN = 1;

/**
 * 社交 memo 解析激活高度。该高度前 VPOST|… 不当作社交帖（防历史误伤）。
 * S1 实验网：从 0 起即可解析（此前链上几乎不可能出现合法 VPOST 形态）。
 * 公网若需更严门控，发版前改为 ≥ 实时链高 + 升级窗口。
 */
export const SOCIAL_ACTIVATION_HEIGHT = 0;

const TXID_RE = /^[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** 链下正文规范对象（hash 前必须按此序列化）。 */
export interface SocialBody {
  v: 1;
  text: string;
  lang?: string;
  links?: string[];
  media?: { hash: string; mime: string }[];
}

export interface SocialPost {
  txid: string;
  author: string;
  contentHash: string;
  parentTxid?: string;
  ver: number;
  flags: string;
  burn: number;
  height: number;
  timestamp: number;
}

/** 稳定 JSON：固定键序、无多余空白 → 跨端 contentHash 一致。 */
export function canonicalSocialBody(body: SocialBody): string {
  const o: Record<string, unknown> = { v: 1, text: body.text };
  if (body.lang !== undefined) o.lang = body.lang;
  if (body.links !== undefined) o.links = body.links;
  if (body.media !== undefined) o.media = body.media;
  return JSON.stringify(o);
}

export function hashSocialBody(body: SocialBody): string {
  return sha256Hex(canonicalSocialBody(body));
}

export function parseSocialBodyJson(raw: string): SocialBody | null {
  try {
    const j = JSON.parse(raw) as Partial<SocialBody>;
    if (j.v !== 1 || typeof j.text !== 'string') return null;
    return {
      v: 1,
      text: j.text,
      lang: typeof j.lang === 'string' ? j.lang : undefined,
      links: Array.isArray(j.links) ? j.links.filter((x): x is string => typeof x === 'string') : undefined,
      media: Array.isArray(j.media)
        ? j.media.filter(
            (m): m is { hash: string; mime: string } =>
              !!m && typeof m === 'object' && typeof (m as { hash?: string }).hash === 'string' && typeof (m as { mime?: string }).mime === 'string',
          )
        : undefined,
    };
  } catch {
    return null;
  }
}

/** 构造发帖/回复 memo。parentTxid 有值 = 回复。 */
export function makeVPost(
  contentHash: string,
  opts?: { parentTxid?: string; ver?: number; flags?: string },
): { ok: boolean; memo?: string; error?: string } {
  const h = contentHash.trim().toLowerCase();
  if (!HASH_RE.test(h)) return { ok: false, error: 'contentHash 须 64 位小写 hex' };
  const ver = opts?.ver ?? 1;
  const flags = opts?.flags ?? '0';
  if (!Number.isInteger(ver) || ver < 1) return { ok: false, error: 'ver 非法' };
  if (!/^[0-9a-zA-Z._-]{1,16}$/.test(flags)) return { ok: false, error: 'flags 非法' };
  let memo = `${VPOST_PREFIX}${ver}|${flags}|${h}`;
  if (opts?.parentTxid) {
    const p = opts.parentTxid.trim().toLowerCase();
    if (!TXID_RE.test(p)) return { ok: false, error: 'parentTxid 须 64 位 hex' };
    memo += `|${p}`;
  }
  if ([...memo].length > MAX_MEMO) return { ok: false, error: 'memo 过长' };
  return { ok: true, memo };
}

export function parseVPostMemo(memo: string): {
  ver: number;
  flags: string;
  contentHash: string;
  parentTxid?: string;
} | null {
  if (!memo.startsWith(VPOST_PREFIX)) return null;
  const rest = memo.slice(VPOST_PREFIX.length);
  const parts = rest.split('|');
  if (parts.length < 3 || parts.length > 4) return null;
  const ver = Number(parts[0]);
  if (!Number.isInteger(ver) || ver < 1) return null;
  const flags = parts[1];
  if (!flags) return null;
  const contentHash = parts[2].toLowerCase();
  if (!HASH_RE.test(contentHash)) return null;
  let parentTxid: string | undefined;
  if (parts.length === 4) {
    parentTxid = parts[3].toLowerCase();
    if (!TXID_RE.test(parentTxid)) return null;
  }
  return { ver, flags, contentHash, parentTxid };
}

/** 签名一笔发帖交易：自转、amount 0、烧 POST_BURN（回复用 REPLY_BURN）。 */
export function createVPostTx(
  wallet: Wallet,
  contentHash: string,
  nonce: number,
  opts?: { parentTxid?: string; burn?: number; fee?: number },
): { ok: true; tx: Transaction } | { ok: false; error: string } {
  const made = makeVPost(contentHash, { parentTxid: opts?.parentTxid });
  if (!made.ok || !made.memo) return { ok: false, error: made.error ?? 'memo' };
  const burn = opts?.burn ?? (opts?.parentTxid ? REPLY_BURN : POST_BURN);
  if (burn < 0) return { ok: false, error: 'burn 非法' };
  // 点赞式 0 burn 不允许走发帖；发帖至少 1（与消息同形态 amount0+burn>0）
  if (burn <= 0) return { ok: false, error: '发帖 burn 须 > 0' };
  const fee = opts?.fee ?? MIN_FEE;
  const tx = createMessage(wallet, wallet.address, made.memo, nonce, burn, fee);
  return { ok: true, tx };
}

/**
 * 扫链还原公域帖（最新不排序；调用方可 sort）。
 * 条件：高度 ≥ 激活 · amount 0 · burn≥门槛 · 自转 · 合法 VPOST memo。
 */
export function parseSocialPosts(chain: Block[]): SocialPost[] {
  const out: SocialPost[] = [];
  for (const b of chain) {
    if (b.index < SOCIAL_ACTIVATION_HEIGHT) continue;
    for (const tx of b.transactions) {
      const burn = tx.burn ?? 0;
      if (tx.amount !== 0 || burn <= 0) continue;
      if (tx.from !== tx.to) continue;
      const parsed = parseVPostMemo(tx.memo);
      if (!parsed) continue;
      const minBurn = parsed.parentTxid ? REPLY_BURN : POST_BURN;
      if (burn < minBurn) continue;
      out.push({
        txid: tx.txid,
        author: tx.from,
        contentHash: parsed.contentHash,
        parentTxid: parsed.parentTxid,
        ver: parsed.ver,
        flags: parsed.flags,
        burn,
        height: b.index,
        timestamp: tx.timestamp,
      });
    }
  }
  return out;
}

/** 最新在前。 */
export function parseSocialPostsNewestFirst(chain: Block[]): SocialPost[] {
  return parseSocialPosts(chain).sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return b.timestamp - a.timestamp;
  });
}

export function postsOf(chain: Block[], address: string): SocialPost[] {
  return parseSocialPostsNewestFirst(chain).filter((p) => p.author === address);
}

export function isSocialProtocolMemo(memo: string): boolean {
  return (
    memo.startsWith(VPOST_PREFIX) ||
    memo.startsWith(VRP_PREFIX) ||
    memo.startsWith(VLIKE_PREFIX) ||
    memo.startsWith(VFOL_PREFIX) ||
    memo.startsWith(VUNFOL_PREFIX) ||
    memo.startsWith(VPROF_PREFIX)
  );
}
