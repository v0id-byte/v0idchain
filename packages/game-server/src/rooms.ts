// 房间布局存储（便利层）：链上只存“属主 + 布局版本 hash”（memo `ROOM|<hash>`），实际字节存这里。
// 属主离线时别人也能串门（字节在服务器）。客户端会拿 hash 与链上版本比对，不一致即标“未验证”。
import { join } from 'node:path';
import { sha256Hex } from '@v0idchain/core';
import { DATA_DIR } from './config.js';
import { readJson, writeJson } from './store.js';

export interface RoomRecord {
  layout: string; // 布局字节（客户端自定义编码的字符串：家具坐标/朝向等）
  hash: string; // sha256(layout)，= 客户端应发布到链上的版本 hash
  at: number; // 最近更新时刻
  versionTx?: string; // 属主签名发布该版本的交易 txid（可选，供审计/展示）
}

const FILE = join(DATA_DIR, 'rooms.json');
const rooms = readJson<Record<string, RoomRecord>>(FILE, {});

export function getRoom(address: string): RoomRecord | null {
  return rooms[address] ?? null;
}

/** 所有已发布房间的属主地址（供串门名册）。 */
export function listRoomAddresses(): string[] {
  return Object.keys(rooms);
}

/** 属主更新布局。服务器只存字节并算 hash；“是否属主/版本是否上链”由客户端按链校验，不在此处替链背书。 */
export function putRoom(address: string, layout: string, versionTx?: string): RoomRecord {
  const rec: RoomRecord = { layout, hash: sha256Hex(layout), at: Date.now(), versionTx };
  rooms[address] = rec;
  writeJson(FILE, rooms);
  return rec;
}
