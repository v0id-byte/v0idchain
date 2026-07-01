import type { Block } from './block.js';
import { genesisBlock } from './blockchain.js';
import { CHECKPOINTS, NULL_ADDRESS } from './config.js';
import { isValidAddress } from './crypto.js';
import { blockHeader, blockMerkleRootMatches, type BlockHeader, type TxInclusionProof, verifyHeaderChain, verifyTxInclusionProof } from './light.js';
import { isCoinbase, type Transaction, verifyTransaction } from './transaction.js';

export const CLIENT_RECENT_BLOCKS = 10_000;
export const CLIENT_RECENT_MS = 3 * 24 * 60 * 60 * 1000;

export interface ClientReplayState {
  balances: Map<string, number>;
  nonces: Map<string, number>;
}

export interface ClientAddressReplay {
  address: string;
  balance: number;
  nonce: number;
  proofs: TxInclusionProof[];
}

export type ClientProtocolResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HeaderVerifyOptions {
  requireGenesis?: boolean;
  checkpoints?: { index: number; hash: string }[];
}

export interface RecentWindow {
  maxBlocks: number;
  minTimestamp: number;
}

export interface LightSyncSnapshot {
  headers: BlockHeader[];
  recentBlocks: Block[];
  maxBlocks?: number;
  minTimestamp?: number;
}

export type LightClientOutgoingMessage =
  | { type: 'HELLO'; address: string; height: number; listen: string }
  | { type: 'QUERY_HEADERS'; from?: number; to?: number }
  | { type: 'QUERY_RECENT'; maxBlocks?: number; minTimestamp?: number }
  | { type: 'QUERY_BLOCK_RANGE'; from: number; to: number }
  | { type: 'QUERY_TX_PROOF'; txid: string }
  | { type: 'QUERY_ADDRESS_PROOFS'; address: string; from?: number; to?: number }
  | { type: 'TX'; tx: Transaction }
  | { type: 'QUERY_PEERS' };

export function createClientReplayState(): ClientReplayState {
  return { balances: new Map(), nonces: new Map() };
}

function credit(st: ClientReplayState, address: string, amount: number): void {
  st.balances.set(address, (st.balances.get(address) ?? 0) + amount);
}

function debit(st: ClientReplayState, address: string, amount: number): void {
  st.balances.set(address, (st.balances.get(address) ?? 0) - amount);
}

export function applyClientTransaction(st: ClientReplayState, tx: Transaction): void {
  if (isCoinbase(tx)) {
    credit(st, tx.to, tx.amount);
    return;
  }

  const burn = tx.burn ?? 0;
  debit(st, tx.from, tx.amount + tx.fee + burn);
  if (burn > 0) credit(st, NULL_ADDRESS, burn);
  st.nonces.set(tx.from, (st.nonces.get(tx.from) ?? 0) + 1);
  credit(st, tx.to, tx.amount);
}

export function replayClientState(blocks: Block[]): ClientReplayState {
  const st = createClientReplayState();
  for (const block of blocks) {
    for (const tx of block.transactions) applyClientTransaction(st, tx);
  }
  return st;
}

export function clientBalanceOf(st: ClientReplayState, address: string): number {
  return st.balances.get(address) ?? 0;
}

export function clientNonceOf(st: ClientReplayState, address: string): number {
  return st.nonces.get(address) ?? 0;
}

export function nextClientNonce(st: ClientReplayState, address: string, pendingCount = 0): number {
  return clientNonceOf(st, address) + pendingCount;
}

export function recentSyncWindow(now = Date.now(), maxBlocks = CLIENT_RECENT_BLOCKS, lookbackMs = CLIENT_RECENT_MS): RecentWindow {
  return { maxBlocks, minTimestamp: now - lookbackMs };
}

export function lightClientHello(address: string, height = 0, listen = `light://${address}/${Date.now().toString(36)}`): LightClientOutgoingMessage {
  return { type: 'HELLO', address, height, listen };
}

export function queryHeaders(from = 0, to?: number): LightClientOutgoingMessage {
  return to === undefined ? { type: 'QUERY_HEADERS', from } : { type: 'QUERY_HEADERS', from, to };
}

export function queryRecent(window: RecentWindow = recentSyncWindow()): LightClientOutgoingMessage {
  return { type: 'QUERY_RECENT', maxBlocks: window.maxBlocks, minTimestamp: window.minTimestamp };
}

export function queryBlockRange(from: number, to: number): LightClientOutgoingMessage {
  return { type: 'QUERY_BLOCK_RANGE', from, to };
}

export function queryTxProof(txid: string): LightClientOutgoingMessage {
  return { type: 'QUERY_TX_PROOF', txid };
}

export function queryAddressProofs(address: string, from = 0, to?: number): LightClientOutgoingMessage {
  return to === undefined ? { type: 'QUERY_ADDRESS_PROOFS', address, from } : { type: 'QUERY_ADDRESS_PROOFS', address, from, to };
}

export function submitClientTx(tx: Transaction): LightClientOutgoingMessage {
  return { type: 'TX', tx };
}

export function verifyClientHeaders(
  headers: BlockHeader[],
  opts: HeaderVerifyOptions = {},
): ClientProtocolResult<{ work: bigint; tip: BlockHeader }> {
  const requireGenesis = opts.requireGenesis ?? true;
  if (headers.length === 0) return { ok: false, error: '空 header 链' };
  if (requireGenesis && headers[0].index !== 0) return { ok: false, error: 'header 链必须从创世高度开始' };
  if (requireGenesis && headers[0].hash !== genesisBlock().hash) return { ok: false, error: '创世 header 不一致' };

  const checked = verifyHeaderChain(headers);
  if (!checked.ok || checked.work === undefined) return { ok: false, error: checked.error ?? 'header 链校验失败' };

  const byHeight = new Map(headers.map((h) => [h.index, h]));
  for (const cp of opts.checkpoints ?? CHECKPOINTS) {
    const h = byHeight.get(cp.index);
    if (h && h.hash !== cp.hash) return { ok: false, error: `#${cp.index} 与 checkpoint 不一致` };
    if (requireGenesis && headers[headers.length - 1].index >= cp.index && !h) {
      return { ok: false, error: `缺少 checkpoint #${cp.index} 的 header` };
    }
  }

  return { ok: true, value: { work: checked.work, tip: headers[headers.length - 1] } };
}

export function verifyBlockAgainstHeaders(block: Block, headers: BlockHeader[]): ClientProtocolResult<BlockHeader> {
  const header = headers.find((h) => h.index === block.index);
  if (!header) return { ok: false, error: `缺少 #${block.index} header` };
  if (header.hash !== block.hash) return { ok: false, error: `#${block.index} hash 不在 header 链中` };
  if (blockHeader(block).merkleRoot !== header.merkleRoot) return { ok: false, error: `#${block.index} merkleRoot 与 header 不一致` };
  if (!blockMerkleRootMatches(block)) return { ok: false, error: `#${block.index} merkleRoot 不匹配` };
  for (const tx of block.transactions) {
    if (!verifyTransaction(tx)) return { ok: false, error: `#${block.index} 交易 ${tx.txid.slice(0, 12)} 自洽性失败` };
  }
  return { ok: true, value: header };
}

export function verifyRecentBlocks(
  headers: BlockHeader[],
  blocks: Block[],
  window: Partial<RecentWindow> = {},
): ClientProtocolResult<Block[]> {
  if (window.maxBlocks !== undefined && blocks.length > window.maxBlocks) {
    return { ok: false, error: `recent blocks 超过窗口上限 ${window.maxBlocks}` };
  }
  for (const block of blocks) {
    if (window.minTimestamp !== undefined && block.timestamp < window.minTimestamp) {
      return { ok: false, error: `#${block.index} 早于 recent minTimestamp` };
    }
    const checked = verifyBlockAgainstHeaders(block, headers);
    if (!checked.ok) return { ok: false, error: checked.error };
  }
  return { ok: true, value: blocks };
}

export function verifyLightSyncSnapshot(snapshot: LightSyncSnapshot): ClientProtocolResult<{ work: bigint; tip: BlockHeader }> {
  const headers = verifyClientHeaders(snapshot.headers);
  if (!headers.ok) return headers;
  const recent = verifyRecentBlocks(snapshot.headers, snapshot.recentBlocks, {
    maxBlocks: snapshot.maxBlocks ?? CLIENT_RECENT_BLOCKS,
    minTimestamp: snapshot.minTimestamp,
  });
  if (!recent.ok) return { ok: false, error: recent.error };
  return headers;
}

export function verifyProofAgainstHeaders(proof: TxInclusionProof, headers: BlockHeader[]): ClientProtocolResult<TxInclusionProof> {
  const header = headers.find((h) => h.index === proof.block.index);
  if (!header) return { ok: false, error: `缺少 #${proof.block.index} header` };
  if (header.hash !== proof.block.hash) return { ok: false, error: `#${proof.block.index} proof 不在 header 链中` };
  if (!verifyTxInclusionProof(proof)) return { ok: false, error: `交易 ${proof.tx.txid.slice(0, 12)} Merkle proof 无效` };
  if (!verifyTransaction(proof.tx)) return { ok: false, error: `交易 ${proof.tx.txid.slice(0, 12)} 自洽性失败` };
  return { ok: true, value: proof };
}

export function replayAddressProofs(
  address: string,
  proofs: TxInclusionProof[],
  headers?: BlockHeader[],
): ClientProtocolResult<ClientAddressReplay> {
  if (!isValidAddress(address)) return { ok: false, error: 'address 必须是合法地址' };

  let balance = 0;
  let nonce = 0;
  const seen = new Set<string>();
  const ordered = [...proofs].sort((a, b) => a.block.index - b.block.index || a.txIndex - b.txIndex || a.tx.txid.localeCompare(b.tx.txid));
  const accepted: TxInclusionProof[] = [];

  for (const proof of ordered) {
    if (headers) {
      const checked = verifyProofAgainstHeaders(proof, headers);
      if (!checked.ok) return { ok: false, error: checked.error };
    } else if (!verifyTxInclusionProof(proof)) {
      return { ok: false, error: `交易 ${proof.tx.txid.slice(0, 12)} Merkle proof 无效` };
    } else if (!verifyTransaction(proof.tx)) {
      return { ok: false, error: `交易 ${proof.tx.txid.slice(0, 12)} 自洽性失败` };
    }

    const tx = proof.tx;
    if (tx.from !== address && tx.to !== address) return { ok: false, error: `交易 ${tx.txid.slice(0, 12)} 与地址无关` };
    if (seen.has(tx.txid)) continue;
    seen.add(tx.txid);
    accepted.push(proof);

    if (tx.to === address) balance += tx.amount;
    if (tx.from === address) {
      balance -= tx.amount + tx.fee + (tx.burn ?? 0);
      nonce += 1;
    }
  }

  return { ok: true, value: { address, balance, nonce, proofs: accepted } };
}
