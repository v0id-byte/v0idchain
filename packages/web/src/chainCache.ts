// 本地区块缓存（IndexedDB）：钱包重开时不用每次都把整条链拉一遍。
// 只存"已校验过完整性"的区块；读出来的链尾高度就是下次增量同步的起点。
import type { Block } from './api';

const DB_NAME = 'v0id-chain-cache';
const STORE = 'blocks';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'index' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 读出本地缓存的整条链，按高度升序。空缓存返回 []。 */
export async function loadCachedChain(): Promise<Block[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as Block[]).sort((a, b) => a.index - b.index));
    req.onerror = () => reject(req.error);
  });
}

/** 追加/覆盖一批区块（按 index 覆盖，用于新块或整链重灌）。 */
export async function putBlocks(blocks: Block[]): Promise<void> {
  if (blocks.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const b of blocks) store.put(b);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 清空缓存：本地链与节点对不上（分叉/损坏）时整链重灌用。 */
export async function clearCache(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
