// 实验 4：双花 / 超额 / 乱序 nonce —— mempool 是第一道礼貌拦截，整链校验才是最终权威。
// 每个发送方有自增 nonce（防重放）+ 余额校验（防双花/超额），两层都拦。
//
// 跑：corepack pnpm tsx scripts/labs/04-double-spend-nonce.ts
import {
  Blockchain,
  Wallet,
  createTransaction,
  createCoinbase,
  expectedDifficulty,
  mineBlock,
  merkleRoot,
} from '../../packages/core/src/index.js';

const bc = new Blockchain();
const bob = Wallet.generate();
const alice = Wallet.generate();
for (let i = 0; i < 2; i++) await bc.mine(bob.address); // bob 余额 = 2

console.log(`bob 余额 = ${bc.balanceOf(bob.address)}，nonce = ${bc.nonceOf(bob.address)}\n`);
console.log('—— mempool 层（交易广播即被拦，给出明确报错）——');

// (1) 超额：bob 只有 2，想转 999999
const over = createTransaction(bob, alice.address, 999_999, bc.nonceOf(bob.address));
console.log(`  (1) 超额转账        → ${bc.addTransaction(over).error}`);

// (2) 乱序 nonce：跳号（期望 0，却用 5）
const gap = createTransaction(bob, alice.address, 1, 5);
console.log(`  (2) 乱序/跳号 nonce → ${bc.addTransaction(gap).error}`);

// (3) 防重放：把一笔已经花掉、已上链的交易再广播一次
const spend = createTransaction(bob, alice.address, 1, bc.nonceOf(bob.address));
bc.addTransaction(spend);
await bc.mine(bob.address); // 打进区块，bob 的 nonce 前进到 1
console.log(`  (3) 重放已花交易    → ${bc.addTransaction(spend).error}`);

console.log('\n—— 整链校验层（攻击者绕过 mempool，手工把重复交易塞进新区块）——');
// 攻击者自己造一个区块，把「同一笔已花交易」再塞一次，挖出合法 PoW，整链送审
const idx = bc.height + 1;
const txs = [createCoinbase(bob.address, idx, spend.fee), spend]; // coinbase + 重复的已花交易
const tmpl = {
  index: idx,
  timestamp: Date.now(),
  prevHash: bc.latest.hash,
  transactions: txs,
  merkleRoot: merkleRoot(txs.map((t) => t.txid)),
  difficulty: expectedDifficulty(bc.chain, idx),
  miner: bob.address,
};
const evilBlock = await mineBlock(tmpl);
const evilChain = [...bc.chain, evilBlock!];
console.log(`  (4) 重复交易塞进链   → ${Blockchain.validateChain(evilChain).error}`);
console.log(`\n  → mempool 拒了是“客气”，就算攻击者自己挖块绕过它，整链校验从创世重放 nonce，照样识破。`);
