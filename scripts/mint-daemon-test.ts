// 铸币厂守护进程自检（Phase A · 链下逻辑）。跑：corepack pnpm exec tsx scripts/mint-daemon-test.ts
// 覆盖：记名券签发/验签/防篡改、额度账本(充值→额度→发券扣减)、绝不超发、兑现验券+防双花(已花/批内重复)+
//       REDEEM 交易成形(parseRedeem 回环/拆分/自洽签名)、收款系统地址被拒、状态持久化恢复。
// 分工：本测试用**合成区块**喂 syncDeposits（只验链下账本逻辑，快）；链上共识合法性由 scripts/mint-selftest.ts 覆盖。
// 边界：mint 钱包为本地生成（地址 ≠ MINT_ADDRESS 常量）→ 只验 REDEEM 交易**成形**，链上**被接受**属部署期（见 mint-selftest）。
import { rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Wallet,
  createTransaction,
  verifyTransaction,
  parseRedeem,
  redeemSplit,
  minFeeFor,
  MIN_FEE,
  MINT_ESCROW_ADDRESS,
  MINT_DEPOSIT_PREFIX,
  MINT_ACTIVATION_HEIGHT,
  REDEEM_PREFIX,
  type Block,
  type Transaction,
} from '../packages/core/src/index.js';
import { issueToken, verifyToken } from '../packages/node/src/mint/token.js';
import { MintDaemon } from '../packages/node/src/mint/mintd.js';

let failed = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** 合成一个只含给定交易的区块（仅供链下账本逻辑测试；不做 PoW/校验，字段占位）。 */
function fakeBlock(index: number, txs: Transaction[]): Block {
  return {
    index,
    timestamp: 1_700_000_000_000 + index * 8_000,
    prevHash: '0'.repeat(64),
    transactions: txs,
    merkleRoot: '0'.repeat(64),
    difficulty: 8,
    nonce: 0,
    miner: '0x' + '0'.repeat(64),
    hash: '0'.repeat(64),
  };
}

function main() {
  const mint = Wallet.generate(); // 铸币厂签名钱包（本地生成 → 地址≠MINT_ADDRESS，故 REDEEM 链上接受属部署期）
  const other = Wallet.generate();

  console.log(`\n— 记名券密码学：issueToken / verifyToken（防篡改）—`);
  const tok = issueToken(500, mint.privateKey);
  check('verifyToken(券, 铸币厂地址) → true', verifyToken(tok, mint.address) === true);
  check('verifyToken(券, 别的地址) → false（非本铸币厂签发）', verifyToken(tok, other.address) === false);
  check('篡改面额 → 验签失败', verifyToken({ ...tok, denom: tok.denom + 1 }, mint.address) === false);
  check('篡改序列号 → 验签失败', verifyToken({ ...tok, serial: 'f'.repeat(32) }, mint.address) === false);
  check('篡改签名 → 验签失败', verifyToken({ ...tok, sig: '0'.repeat(tok.sig.length) }, mint.address) === false);
  check('非法序列号格式 → false', verifyToken({ ...tok, serial: 'xyz' }, mint.address) === false);
  check('面额 0 签发抛错', throws(() => issueToken(0, mint.privateKey)));

  console.log(`\n— 额度账本：syncDeposits 记额度、issue 扣减、绝不超发 —`);
  const dataDir = join(tmpdir(), `v0id-mint-test-${process.pid}`);
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  const d = new MintDaemon({ dataDir, mintWallet: mint, depositConfirmations: 0 }); // 账本逻辑测试免确认深度
  const userA = Wallet.generate();
  const userB = Wallet.generate();
  const H = MINT_ACTIVATION_HEIGHT;
  const chain: Block[] = [
    fakeBlock(H, [createTransaction(userA, MINT_ESCROW_ADDRESS, 1000, 0, MINT_DEPOSIT_PREFIX, minFeeFor(1000))]),
    fakeBlock(H + 1, [createTransaction(userB, MINT_ESCROW_ADDRESS, 300, 0, MINT_DEPOSIT_PREFIX, minFeeFor(300))]),
  ];
  d.syncDeposits(chain);
  check('userA 充值 1000 → 额度 1000', d.allowanceOf(userA.address) === 1000);
  check('userB 充值 300 → 额度 300', d.allowanceOf(userB.address) === 300);
  const tA1 = d.issue(userA.address, 400);
  check('发券后 userA 额度 1000→600、券面额 400', d.allowanceOf(userA.address) === 600 && tA1.denom === 400);
  const tA2 = d.issue(userA.address, 600);
  check('再发 600 → userA 额度归零', d.allowanceOf(userA.address) === 0);
  check('超额度发券被拒（绝不超发：Σ已发 ≤ Σ充值）', throws(() => d.issue(userA.address, 1)));
  check('重复 syncDeposits 不重复计充值（游标幂等）', (() => { d.syncDeposits(chain); return d.allowanceOf(userB.address) === 300; })());
  check('发券给非法地址被拒（防原型链键 constructor 无额度也发券）', throws(() => d.issue('constructor', 1)));
  check('发券给格式非法地址被拒', throws(() => d.issue('not-an-address', 1)));

  console.log(`\n— 兑现：验券 + REDEEM 交易成形（拆分/回环/自洽签名）—`);
  const provider = Wallet.generate();
  const dry1 = d.dryRedeem([tA1, tA2], provider.address);
  const dry2 = d.dryRedeem([tA1, tA2], provider.address);
  check('dryRedeem 预览不消耗券（两次 gross 均 1000，未标记已花）', dry1.gross === 1000 && dry2.gross === 1000);
  const r = d.redeem([tA1, tA2], provider.address, 0);
  check('gross = 面额之和 1000', r.gross === 1000);
  check('拆分 net/fee 与 redeemSplit 一致（950/50）', r.net === redeemSplit(1000).net && r.fee === redeemSplit(1000).fee);
  check('REDEEM 交易：from=铸币厂 / to=服务方 / amount=0', r.tx.from === mint.address && r.tx.to === provider.address && r.tx.amount === 0);
  check('REDEEM 备注回环：parseRedeem(memo).gross === 1000', parseRedeem(r.tx.memo)?.gross === 1000 && r.tx.memo === `${REDEEM_PREFIX}1000`);
  check('REDEEM 交易自洽（verifyTransaction 通过；链上被接受另需 from===MINT_ADDRESS，属部署期）', verifyTransaction(r.tx) === true);

  console.log(`\n— 防双花 + 收款校验 —`);
  check('已兑现的券再兑现被拒（双花）', throws(() => d.redeem([tA1], provider.address, 1)));
  const tB = d.issue(userB.address, 100);
  check('同一批内重复券被拒', throws(() => d.redeem([tB, tB], provider.address, 1)));
  check('收款为系统/托管地址被拒', throws(() => d.redeem([tB], MINT_ESCROW_ADDRESS, 1)));
  check('收款格式非法被拒（不白白报废券：先拦再标记已花）', throws(() => d.redeem([tB], 'not-an-address', 1)));
  check('被非法收款拒后 tB 未被标记已花（仍可正常兑现）', d.dryRedeem([tB], provider.address).gross === 100);
  const forged = issueToken(100, other.privateKey); // 别的钱包签的“伪券”（非本铸币厂）
  check('非本铸币厂签发的伪券兑现被拒（验签失败）', throws(() => d.redeem([forged], provider.address, 1)));

  console.log(`\n— 状态持久化：重开守护进程恢复额度/已花序列号 —`);
  const d2 = new MintDaemon({ dataDir, mintWallet: mint, depositConfirmations: 0 });
  check('重开后 userB 额度恢复（=200，已发 100）', d2.allowanceOf(userB.address) === 200);
  check('重开后已花序列号仍拦双花（tA1 再兑现被拒）', throws(() => d2.redeem([tA1], provider.address, 1)));
  const rv = d2.reserve(chain);
  // 已发 = 400+600+100 = 1100；未兑 = 已发 − 链上已兑现(本测试合成链无 REDEEM 上链 → 0) = 1100（保守：兑现交易未上链前仍计未兑）。
  check('储备视图：链上储备=1300、已发=1100、未兑=1100', rv.onchain.reserve === 1300 && rv.issued === 1100 && rv.outstanding === 1100);
  check('偿付：链上储备 ≥ 未兑券面额（1300 ≥ 1100）', rv.onchain.reserve >= rv.outstanding);

  console.log(`\n— 充值确认深度：未确认窗口内的充值不记额度，确认后才记 —`);
  {
    const cdDir = join(tmpdir(), `v0id-mint-cd-${process.pid}`);
    if (existsSync(cdDir)) rmSync(cdDir, { recursive: true, force: true });
    const cd = new MintDaemon({ dataDir: cdDir, mintWallet: mint }); // 默认确认深度 6
    const u = Wallet.generate();
    const H2 = MINT_ACTIVATION_HEIGHT;
    const depBlock = fakeBlock(H2, [createTransaction(u, MINT_ESCROW_ADDRESS, 500, 0, MINT_DEPOSIT_PREFIX, minFeeFor(500))]);
    // tip 仅 H2+3（< 6 确认）→ 充值未确认，不记额度
    const shallow = [depBlock, ...[1, 2, 3].map((k) => fakeBlock(H2 + k, []))];
    cd.syncDeposits(shallow);
    check('充值仅 3 块确认（<6）→ 未记额度', cd.allowanceOf(u.address) === 0);
    // 链延伸到 H2+6（充值满 6 确认）→ 记额度
    const deep = [depBlock, ...[1, 2, 3, 4, 5, 6].map((k) => fakeBlock(H2 + k, []))];
    cd.syncDeposits(deep);
    check('充值满 6 确认 → 记额度 500', cd.allowanceOf(u.address) === 500);
    rmSync(cdDir, { recursive: true, force: true });
  }

  console.log(`\n— 金融账本 fail-closed：状态文件损坏 → 拒绝启动（不静默重置）—`);
  {
    const corruptDir = join(tmpdir(), `v0id-mint-corrupt-${process.pid}`);
    if (existsSync(corruptDir)) rmSync(corruptDir, { recursive: true, force: true });
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'mint-state.json'), '{ this is not valid json', { mode: 0o600 });
    check('损坏的 mint-state.json → 构造抛错（fail closed，绝不重置账本）',
      throws(() => new MintDaemon({ dataDir: corruptDir, mintWallet: mint })));
    rmSync(corruptDir, { recursive: true, force: true });
  }

  rmSync(dataDir, { recursive: true, force: true });
  console.log(failed === 0 ? `\n🎉 全部通过 ALL PASS\n` : `\n💥 ${failed} 项失败 ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
