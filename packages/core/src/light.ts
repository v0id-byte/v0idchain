import type { Block } from './block.js';
import { calcBlockHash, meetsDifficulty, workForDifficulty } from './block.js';
import { merkleRoot, sha256Hex } from './crypto.js';
import type { Transaction } from './transaction.js';

export type BlockHeader = Omit<Block, 'transactions'>;

export interface MerkleProofStep {
  side: 'left' | 'right';
  hash: string;
}

export interface TxInclusionProof {
  block: BlockHeader;
  tx: Transaction;
  txIndex: number;
  proof: MerkleProofStep[];
}

export function blockHeader(block: Block): BlockHeader {
  const { transactions: _transactions, ...header } = block;
  return header;
}

export function blockHeaders(chain: Block[]): BlockHeader[] {
  return chain.map(blockHeader);
}

export function calcHeaderHash(header: BlockHeader): string {
  return calcBlockHash({ ...header, transactions: [] });
}

export function createMerkleProof(txids: string[], txIndex: number): MerkleProofStep[] | null {
  if (!Number.isInteger(txIndex) || txIndex < 0 || txIndex >= txids.length) return null;
  const proof: MerkleProofStep[] = [];
  let index = txIndex;
  let layer = txids.slice();
  while (layer.length > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = layer[siblingIndex] ?? layer[index];
    proof.push({ side: index % 2 === 0 ? 'right' : 'left', hash: sibling });

    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = i + 1 < layer.length ? layer[i + 1] : a;
      next.push(sha256Hex(a + b));
    }
    layer = next;
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyMerkleProof(txid: string, proof: MerkleProofStep[], expectedRoot: string): boolean {
  let h = txid;
  for (const step of proof) {
    if (step.side === 'left') h = sha256Hex(step.hash + h);
    else if (step.side === 'right') h = sha256Hex(h + step.hash);
    else return false;
  }
  return h === expectedRoot;
}

export function txInclusionProof(block: Block, txid: string): TxInclusionProof | null {
  const txIndex = block.transactions.findIndex((tx) => tx.txid === txid);
  if (txIndex < 0) return null;
  const proof = createMerkleProof(block.transactions.map((tx) => tx.txid), txIndex);
  if (!proof) return null;
  return { block: blockHeader(block), tx: block.transactions[txIndex], txIndex, proof };
}

export function findTxInclusionProof(chain: Block[], txid: string): TxInclusionProof | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const proof = txInclusionProof(chain[i], txid);
    if (proof) return proof;
  }
  return null;
}

export function addressInclusionProofs(
  chain: Block[],
  address: string,
  fromHeight = 0,
  toHeight = chain.length - 1,
): TxInclusionProof[] {
  const out: TxInclusionProof[] = [];
  const from = Math.max(0, Math.floor(fromHeight));
  const to = Math.min(chain.length - 1, Math.floor(toHeight));
  for (let i = from; i <= to; i++) {
    const block = chain[i];
    for (const tx of block.transactions) {
      if (tx.from !== address && tx.to !== address) continue;
      const proof = txInclusionProof(block, tx.txid);
      if (proof) out.push(proof);
    }
  }
  return out;
}

export function recentBlockWindow(chain: Block[], maxBlocks: number, minTimestamp: number): Block[] {
  const count = Math.max(0, Math.floor(maxBlocks));
  if (count === 0) return [];
  const start = Math.max(0, chain.length - count);
  return chain.slice(start).filter((block) => block.timestamp >= minTimestamp);
}

export function verifyHeaderChain(headers: BlockHeader[]): { ok: boolean; error?: string; work?: bigint } {
  if (headers.length === 0) return { ok: false, error: '空 header 链' };
  let work = 0n;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (calcHeaderHash(h) !== h.hash) return { ok: false, error: `#${h.index} header hash 不匹配` };
    if (h.index !== 0 && !meetsDifficulty(h.hash, h.difficulty)) return { ok: false, error: `#${h.index} PoW 不满足难度` };
    if (i > 0) {
      const prev = headers[i - 1];
      if (h.index !== prev.index + 1) return { ok: false, error: `#${h.index} 高度不连续` };
      if (h.prevHash !== prev.hash) return { ok: false, error: `#${h.index} prevHash 不匹配` };
      if (h.timestamp < prev.timestamp) return { ok: false, error: `#${h.index} 时间戳倒退` };
    }
    work += workForDifficulty(h.difficulty);
  }
  return { ok: true, work };
}

export function verifyTxInclusionProof(proof: TxInclusionProof): boolean {
  if (proof.txIndex < 0) return false;
  if (calcHeaderHash(proof.block) !== proof.block.hash) return false;
  return verifyMerkleProof(proof.tx.txid, proof.proof, proof.block.merkleRoot);
}

export function blockMerkleRootMatches(block: Block): boolean {
  return block.merkleRoot === merkleRoot(block.transactions.map((tx) => tx.txid));
}
