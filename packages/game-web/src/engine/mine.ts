// 矿洞格子 key，用于客户端状态跟踪（挖掘/复原）
export function mineTileKey(depth: number, x: number, y: number): string {
  return `${depth}:${x}:${y}`;
}
