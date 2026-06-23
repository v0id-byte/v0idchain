// 房间布局：序列化 → sha256 → 发布(链上只记版本 hash,字节存服务器)。串门时按 hash 校验。
import { Wallet, createTransaction, sha256Hex } from '@v0idchain/core/browser';
import type { FurnitureItem } from './engine/scene';
import type { RoomThemeId } from './engine/tileset';
import { api } from './api';

export const ROOM_PREFIX = 'ROOM|';

export interface RoomLayout {
  theme: RoomThemeId;
  furniture: FurnitureItem[];
}

/** 紧凑、确定性序列化:家具按位置排序 → 同布局必得同 hash(全网可复算)。 */
export function serializeLayout(l: RoomLayout): string {
  const fs = [...l.furniture].sort((a, b) => a.y - b.y || a.x - b.x || a.kind.localeCompare(b.kind));
  return JSON.stringify({ t: l.theme, f: fs.map((f) => [f.kind, f.x, f.y]) });
}
export function layoutHash(l: RoomLayout): string {
  return sha256Hex(serializeLayout(l));
}
export function parseLayout(s: string | null | undefined): RoomLayout | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as { t: RoomThemeId; f: [string, number, number][] };
    return { theme: o.t, furniture: o.f.map(([kind, x, y]) => ({ kind, x, y })) };
  } catch {
    return null;
  }
}

/** 发布房间:本地签名 `ROOM|<hash>` 自转上链(属主确权版本) + 把布局字节 PUT 到服务器。 */
export async function publishRoom(wallet: Wallet, layout: RoomLayout): Promise<{ hash: string; txid: string }> {
  const hash = layoutHash(layout);
  const { nonce } = await api.nonce(wallet.address);
  const tx = createTransaction(wallet, wallet.address, 1, nonce, ROOM_PREFIX + hash); // 自转 1 + memo,净付手续费
  const r = await api.submitTx(tx);
  await api.putRoom(wallet.address, serializeLayout(layout), r.txid);
  return { hash, txid: r.txid };
}

export interface LoadedRoom {
  layout: RoomLayout | null;
  verified: boolean; // 服务器布局 hash 与链上最新 ROOM| 版本一致
}
export async function loadRoom(address: string): Promise<LoadedRoom> {
  const r = await api.getRoom(address).catch(() => null);
  const layout = parseLayout(r?.layout);
  const verified = !!layout && !!r?.chainHash && layoutHash(layout) === r.chainHash;
  return { layout, verified };
}
