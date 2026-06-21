// 实验 1：篡改某区块里的交易金额 → 整链校验「逐层」拦截。
// 攻击者每“补一层”，就被更深一层的承诺拦下：txid → merkleRoot → 区块hash → PoW → 签名。
// 最后的根是 ed25519 签名：没有受害者私钥，怎么补都过不了。
//
// 跑：corepack pnpm tsx scripts/labs/01-tamper-amount.ts
import {
  Blockchain,
  Wallet,
  createTransaction,
  verifyTransaction,
  merkleRoot,
  calcBlockHash,
  mineBlock,
  sha256Hex,
} from '../../packages/core/src/index.js';

const clone = (c: unknown) => JSON.parse(JSON.stringify(c));
// 攻击者“重算 txid”——与 transaction.ts 的 payloadHash 同款公式（金额/手续费/销毁额全进 hash）。
const recomputeTxid = (t: any) => {
  const fields: unknown[] = [t.from, t.to, t.amount, t.fee, t.nonce, t.timestamp, t.memo];
  if ((t.burn ?? 0) > 0) fields.push(t.burn);
  return sha256Hex(JSON.stringify(fields));
};

// —— 准备一条诚实链：bob 挖 2 块拿 2 币，转 1 给 alice，再挖 1 块把这笔确认进区块 ——
const bc = new Blockchain();
const bob = Wallet.generate();
const alice = Wallet.generate();
await bc.mine(bob.address);
await bc.mine(bob.address);
const tx = createTransaction(bob, alice.address, 1, bc.nonceOf(bob.address)); // 金额 1 + 手续费 1
bc.addTransaction(tx);
await bc.mine(bob.address);
const H = bc.chain.findIndex((b) => b.transactions.some((t) => t.txid === tx.txid));
console.log(`诚实链合法？ ${Blockchain.validateChain(bc.chain).ok}（bob→alice 这笔在区块 #${H}）`);
console.log(`\n攻击者想把这笔转账金额从 1 偷偷改成 999999，逐层“补漏”：\n`);

// 第 1 层：只改金额（txid 不动）
let a = clone(bc.chain);
let victim = a[H].transactions.find((t: any) => t.txid === tx.txid);
victim.amount = 999_999;
console.log(`  [1] 只改 amount        → ${Blockchain.validateChain(a).error}`);

// 第 2 层：连 txid 一起重算（让“交易自洽”），但区块的 merkleRoot 仍承诺旧 txid
a = clone(bc.chain);
victim = a[H].transactions.find((t: any) => t.txid === tx.txid);
victim.amount = 999_999;
victim.txid = recomputeTxid(victim);
console.log(`  [2] 再重算 txid        → ${Blockchain.validateChain(a).error}`);

// 第 3 层：再把 merkleRoot 也改成新 txid 集的根，但区块 hash 仍是旧的
a[H].merkleRoot = merkleRoot(a[H].transactions.map((t: any) => t.txid));
console.log(`  [3] 再补 merkleRoot    → ${Blockchain.validateChain(a).error}`);

// 第 4 层：再把区块 hash 也重算（calcBlockHash），但旧 nonce 配不上新 hash 的难度
a[H].hash = calcBlockHash(a[H]);
console.log(`  [4] 再补区块 hash      → ${Blockchain.validateChain(a).error}`);

// 第 5 层：攻击者甚至重新挖矿，凑出满足难度的 nonce（难度 16，本地秒级）——仍过不了签名
const { hash: _omitH, nonce: _omitN, ...tmpl } = a[H];
const remined = await mineBlock(tmpl);
a[H] = remined!;
console.log(`  [5] 甚至重新挖出合法PoW → ${Blockchain.validateChain(a).error}`);

console.log(`\n根因：被篡改交易的签名仍是对“旧 txid”签的，verifyTransaction = ${verifyTransaction(victim)}`);
console.log(`攻击者没有 bob 的私钥，无法重签 → 金额经 txid→merkleRoot→区块hash→PoW 被牢牢钉死。`);
