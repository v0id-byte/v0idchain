// 轻客户端同步基础测试：headers / recent blocks / Merkle inclusion proofs。
import { rmSync } from 'node:fs';
import {
  Wallet,
  verifyHeaderChain,
  verifyTxInclusionProof,
  findTxInclusionProof,
  type TxInclusionProof,
} from '../packages/core/src/index.js';
import { V0idNode, startHttpApi } from '../packages/node/src/index.js';

const DIR = '.data/light-sync-test';
rmSync(DIR, { recursive: true, force: true });

let failed = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

async function waitForWsMessage(ws: WebSocket, type: string, ms = 3000): Promise<any | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), ms);
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === type) {
          clearTimeout(timeout);
          resolve(msg);
        }
      } catch {
        // ignore non-JSON frames
      }
    });
  });
}

const node = new V0idNode({ dataDir: DIR, p2pPort: 6811 });
node.start();
const server = startHttpApi(node, 7811, 'light-token');
await sleep(150);

const recipient = Wallet.generate();
for (let i = 0; i < 5; i++) await node.mineOnce();
const sent = node.send(recipient.address, 2);
check('测试交易进入 mempool', sent.ok && !!sent.tx);
await node.mineOnce();

const txid = sent.tx!.txid;
const localProof = findTxInclusionProof(node.bc.chain, txid);
check('core 能为交易生成 inclusion proof', !!localProof);
check('core inclusion proof 可验证', !!localProof && verifyTxInclusionProof(localProof));

const headersRes = await fetchJSON<{ headers: any[] }>('http://127.0.0.1:7811/headers');
check('GET /headers 成功', headersRes.status === 200);
check('headers 可独立校验 PoW/header hash/link', verifyHeaderChain(headersRes.body.headers).ok);
const partialHeadersRes = await fetchJSON<{ headers: any[] }>('http://127.0.0.1:7811/headers?from=1&to=3');
check('非创世 header 片段也检查 PoW 并通过', verifyHeaderChain(partialHeadersRes.body.headers).ok);

const blocksRes = await fetchJSON<{ blocks: any[] }>('http://127.0.0.1:7811/blocks?from=1&to=3');
check('GET /blocks 按高度范围返回完整块', blocksRes.status === 200 && blocksRes.body.blocks.length === 3);

const minTimestamp = Date.now() - 60_000;
const recentRes = await fetchJSON<{ blocks: any[] }>(
  `http://127.0.0.1:7811/recent?maxBlocks=3&minTimestamp=${minTimestamp}`,
);
check('GET /recent 同时满足最近块数与时间窗口', recentRes.status === 200 && recentRes.body.blocks.length <= 3);
check('GET /recent 不返回早于 minTimestamp 的块', recentRes.body.blocks.every((b) => b.timestamp >= minTimestamp));

const proofRes = await fetchJSON<TxInclusionProof>(`http://127.0.0.1:7811/tx-proof?txid=${txid}`);
check('GET /tx-proof 返回证明', proofRes.status === 200);
check('HTTP tx proof 可验证', verifyTxInclusionProof(proofRes.body));

const addrRes = await fetchJSON<{ proofs: TxInclusionProof[] }>(
  `http://127.0.0.1:7811/address-proofs?address=${recipient.address}`,
);
check('GET /address-proofs 返回地址相关交易证明', addrRes.status === 200 && addrRes.body.proofs.some((p) => p.tx.txid === txid));
check('address proofs 每条都可验证', addrRes.body.proofs.every(verifyTxInclusionProof));

const ws = new WebSocket('ws://127.0.0.1:6811');
await new Promise<void>((resolve) => {
  ws.onopen = () => resolve();
  ws.onerror = () => resolve();
});
ws.send(JSON.stringify({ type: 'QUERY_HEADERS', from: 0, to: node.bc.height }));
const headerMsg = await waitForWsMessage(ws, 'HEADERS');
check('P2P QUERY_HEADERS 返回 HEADERS', !!headerMsg && headerMsg.headers.length === node.bc.chain.length);
check('P2P headers 可验证', !!headerMsg && verifyHeaderChain(headerMsg.headers).ok);

ws.send(JSON.stringify({ type: 'QUERY_TX_PROOF', txid }));
const txProofMsg = await waitForWsMessage(ws, 'TX_PROOF');
check('P2P QUERY_TX_PROOF 返回 TX_PROOF', !!txProofMsg?.proof);
check('P2P tx proof 可验证', !!txProofMsg?.proof && verifyTxInclusionProof(txProofMsg.proof));

ws.close();
node.p2p.stop();
await new Promise<void>((resolve) => server.close(() => resolve()));

console.log(failed === 0 ? '\n🎉 轻同步测试全部通过\n' : `\n💥 ${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
