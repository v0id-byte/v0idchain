// 串门足迹（便利层）：谁串过谁的门。链上不记串门（不值得烧币），仅服务器侧落盘做“访客计数”社交点。
// 丢了不致命（同房间布局：便利层数据）。形状 = { 被访地址: { 访客地址: { at } } } → 天然去重（同访客多次串门只记最新）。
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { readJson, writeJson } from './store.js';

interface VisitMark {
  at: number; // 最近一次串门时刻（服务器运行时，非共识 → 用 Date.now() 即可）
}

const FILE = join(DATA_DIR, 'visits.json');
const visits = readJson<Record<string, Record<string, VisitMark>>>(FILE, {});

/** 记一次串门：visitor 串了 target 的门。自串（visitor===target）不记。 */
export function recordVisit(visitor: string, target: string): void {
  if (visitor === target) return;
  const marks = (visits[target] ??= {});
  marks[visitor] = { at: Date.now() };
  writeJson(FILE, visits);
}

/** target 被多少个**不同**访客串过门（排除自己）。 */
export function getVisitCount(target: string): number {
  const marks = visits[target];
  if (!marks) return 0;
  let n = 0;
  for (const visitor of Object.keys(marks)) if (visitor !== target) n++;
  return n;
}
