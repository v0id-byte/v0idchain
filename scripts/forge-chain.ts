// 测试辅助：把一条 Blockchain 便宜地 forge 到任意高度（含 ≥ STAKING_ACTIVATION_HEIGHT），
// 用于「质押激活高度 16000」这类需要高链高、但又不该跑 16000 次真 PoW 的状态机测试。
//
// 手法（保持链对 validateChain **完全合法**，不偷工）：
//   逐块 append 真实区块——真 coinbase、真 merkleRoot、真 expectedDifficulty、真 PoW（mineBlock）。
//   省钱关键：把相邻区块**时间戳拉开（默认 60s）**，使自适应难度判定为「出块过慢」→ 每个重定向点
//   难度下调，几个窗口后稳定在地板 MIN_DIFFICULTY=8 bit（v1）/ 对应 compact target（v2）。8 bit 的 PoW 仅
//   ~256 次哈希/块，于是 16000 块在几秒内 forge 完。时间戳从创世(2023-11)起以 60s 递增，16000 块也才
//   ~11 天，远早于当前真实时间 → 不触发 validateChain 的「未来时间戳」上界。
//
// 产出的链与「真挖 16000 块」在共识语义上等价（同一 validateChain、同一 applyTx），仅省了 PoW 算力。
import {
  Blockchain,
  createCoinbase,
  calcBlockHash,
  merkleRoot,
  expectedDifficulty,
  mineBlock,
  CHECKPOINTS,
  GENESIS_TIMESTAMP,
  type Block,
  type Transaction,
} from '../packages/core/src/index.js';

const SLOW_SPACING_MS = 60_000; // 相邻块时间戳间隔：远大于 8s 目标 → 难度持续下调到地板

/**
 * **测试进程内**清空出厂 CHECKPOINTS（高度 100/200/300 绑定公网种子规范链的硬编码 hash）。
 * 一条全新本地 forge 链的第 100 块绝不可能复现真种子的 PoW hash，会被 validateChain 的 checkpoint 校验拒。
 * 故 forge 到高链高（跨越 100/200/300）前，必须把内存里的 CHECKPOINTS 清空——**仅影响本测试进程，
 * 不改 config.ts、不改磁盘、不改共识**（与 scripts/labs/06-checkpoint-reorg.ts 反向同款手法：那里 push、这里清）。
 * 这不削弱安全属性：checkpoint 的意义是冻结**真种子**历史，合成测试链本就与真种子无关。
 * 幂等：多次调用安全。
 */
export function clearCheckpointsForTest(): void {
  CHECKPOINTS.length = 0;
}

/**
 * 在 bc 链顶 append 一个真实区块：coinbase 给 miner + 给定普通交易，真 PoW 满足 expectedDifficulty。
 *
 * **直接 push 到 bc.chain，绕过 addBlock 的整链 validateChain**——这是有意为之的性能取舍：
 * addBlock 每次都重校验**整条**链，append n 块即 O(n²)，forge 到 16000 会退化成上亿次交易校验、跑不完。
 * forge 出来的填充块按构造平凡合法（真 coinbase/真 merkleRoot/真难度/真 PoW，无普通交易或仅一笔已校验的 STAKE），
 * 故跳过逐步整链校验是安全的；调用方在 forge 完后做**一次** Blockchain.validateChain(bc.chain) 即可确认整链合法。
 * 调用方须保证 txs 在该高度合法（nonce/余额/质押规则）。
 * @returns 新块
 */
export async function forgeAppendBlock(bc: Blockchain, miner: string, txs: Transaction[] = []): Promise<Block> {
  const index = bc.height + 1;
  const prev = bc.latest;
  const fees = txs.reduce((s, t) => s + t.fee, 0);
  const coinbase = createCoinbase(miner, index, fees);
  const transactions = [coinbase, ...txs];
  // 时间戳：max(创世+index×间隔, prev+间隔)，保证严格递增且与创世拉开足够窗口让难度降到地板。
  const timestamp = Math.max(GENESIS_TIMESTAMP + index * SLOW_SPACING_MS, prev.timestamp + SLOW_SPACING_MS);
  const template: Omit<Block, 'hash' | 'nonce'> = {
    index,
    timestamp,
    prevHash: prev.hash,
    transactions,
    merkleRoot: merkleRoot(transactions.map((t) => t.txid)),
    // 真实自适应难度。expectedDifficulty 只读历史块（chain[index-1] 及更早的重定向窗口），从不读 chain[index]，
    // 故直接传 bc.chain（长度 = index，chain[index] 为 undefined 但不被访问）——避免每块 [...spread] 整链拷贝退化成 O(n²)。
    difficulty: expectedDifficulty(bc.chain, index),
    miner,
  };
  const block = await mineBlock(template);
  if (!block) throw new Error('forge: mineBlock 返回 null（不应发生，无 shouldStop）');
  bc.chain.push(block); // 直接 push（见上：绕过 addBlock 的 O(n²) 整链校验；最终由调用方一次性 validateChain）
  return block;
}

/**
 * 把 bc forge 到目标高度（含），coinbase 全发给 miner。已达/超过则不动。
 * @param bc 链
 * @param miner coinbase 收款（通常是要质押的中继地址，顺带攒够押金）
 * @param targetHeight 目标链高
 */
export async function forgeTo(bc: Blockchain, miner: string, targetHeight: number): Promise<void> {
  if (targetHeight >= 100) clearCheckpointsForTest(); // 将跨越出厂 checkpoint(100/200/300) → 进程内清空（仅测试，见上）
  while (bc.height < targetHeight) await forgeAppendBlock(bc, miner);
}
