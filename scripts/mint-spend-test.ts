// 铸币厂在线核销核算（Phase A.2）：证明第三方服务方（≠铸币厂，无 MINT_ADDRESS 私钥）经铸币厂 `spend` 原子核销后——
//   ① **跨服务方双花被拦**（同一张券给第二个服务方 spend → 被全局已花集拒 = A.2 的核心安全属性）；
//   ② owed 待结算账本按服务方累加、跨重启持久化；③ spend 与 redeem 共用同一已花集（一张券只走一条路）；
//   ④ settle 把 owed 一次性成形 REDEEM 付款并清零、空 owed 拒结算。对齐 PAYWALL-PROTOCOL §3B/§4、MINT-PROTOCOL §5。
// 跑：corepack pnpm exec tsx scripts/mint-spend-test.ts
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet, REDEEM_PREFIX } from '../packages/core/src/index.js';
import { MintDaemon } from '../packages/node/src/mint/mintd.js';
import { issueToken } from '../packages/node/src/mint/token.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'v0id-mint-spend-'));
  const mint = Wallet.generate(); // 本地充当铸币厂（operator）
  const d = new MintDaemon({ dataDir: tmp, mintWallet: mint });
  const A = Wallet.generate().address; // 第三方服务方 A
  const B = Wallet.generate().address; // 第三方服务方 B
  const v5 = issueToken(5, mint.privateKey); // 访客持有的券（issueToken 直签，绕过额度=测核销逻辑）

  // ---- ① spend：服务方 A 在线核销 v5 ----
  const s1 = d.spend([v5], A);
  check('spend 返回核销面额 gross=5', s1.gross === 5);
  check('owed[A] = 5（记服务方待结算）', d.owedTo(A) === 5);

  // ---- 核心安全属性：同一张券给服务方 B 再核销 → 被全局已花集拦（跨服务方双花防住）----
  check('跨服务方双花被拦（同券给 B spend 抛错）', throws(() => d.spend([v5], B)));
  check('owed[B] 仍为 0（B 未获记账，未白服务）', d.owedTo(B) === 0);

  // ---- spend 与 redeem 共用已花集：已核销的券不能再直接 redeem ----
  check('已 spend 的券不能再 redeem（共用已花集，一张券只走一条路）', throws(() => d.redeem([v5], A, 0)));

  // ---- owed 按服务方累加 ----
  const v3 = issueToken(3, mint.privateKey);
  d.spend([v3], A);
  check('owed[A] 累加 = 8', d.owedTo(A) === 8);

  // ---- 跨重启持久化：owed + 已花集 ----
  const d2 = new MintDaemon({ dataDir: tmp, mintWallet: mint });
  check('owed 跨重启持久化（owed[A]=8）', d2.owedTo(A) === 8);
  check('已花集跨重启（v5 重启后仍不能 spend）', throws(() => d2.spend([v5], A)));

  // ---- 预览不改状态 ----
  const dry = d2.drySettle(A);
  check('drySettle 预览 gross=8 且不清零 owed', dry.gross === 8 && d2.owedTo(A) === 8);
  check('结算拆分自洽 net + fee == gross', dry.net + dry.fee === 8);

  // ---- settle：owed 一次性成形 REDEEM 付款 + 清零 ----
  const r = d2.settle(A, 0);
  check('settle 成形 REDEEM 面额=8', r.gross === 8);
  check('settle 后 owed[A] 清零', d2.owedTo(A) === 0);
  check(
    'REDEEM 交易形态正确（from=mint / to=A / amount=0 / memo=REDEEM|8）',
    r.tx.from === mint.address && r.tx.to === A && r.tx.amount === 0 && r.tx.memo === `${REDEEM_PREFIX}8`,
  );

  // ---- 空 owed 拒结算 + 清零跨重启 ----
  check('owed 为 0 时 settle 抛错（无待结算）', throws(() => d2.settle(A, 1)));
  const d3 = new MintDaemon({ dataDir: tmp, mintWallet: mint });
  check('settle 清零跨重启持久化（owed[A]=0）', d3.owedTo(A) === 0);

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}

main();
