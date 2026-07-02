// 付费墙券库 → 铸币厂兑现的桥接（Phase A.1 运营者收款端）：证明——
//   服务方托管付费站点收到的券（PaywallStore.accepted）能① 跨重启持久化；② 直接喂给 MintDaemon 兑现（格式桥通）；
//   ③ markRedeemed 只删已兑现的 accepted、**保留 spentSerials**（防访问双花在兑现后依旧生效）；④ 券库损坏 fail-closed；
//   ⑤ 即便券库没清理，同一张券在 daemon 侧也兑不了第二次（防重兑独立兜底）。
// 这对应 CLI `v0id mint redeem --paywall <path>`：运营者攒够访客付的券后 REDEEM 得款。
// 跑：corepack pnpm exec tsx scripts/paywall-redeem-test.ts
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from '../packages/core/src/index.js';
import { PaywallStore } from '../packages/node/src/relay/paywall-store.js';
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

function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'v0id-paywall-redeem-'));
  const storeFile = join(tmp, 'paywall-demo.json'); // 完整路径（模拟运营者的 paywall-<id>.json）
  const mint = Wallet.generate(); // 本地充当铸币厂（operator==mint）
  const v1 = issueToken(100, mint.privateKey);
  const v2 = issueToken(60, mint.privateKey);

  // ---- 模拟两次付费访问：VoucherAcceptor.onAccept → store.record ----
  const s = new PaywallStore(storeFile); // 全路径构造（id 省略）
  s.record([v1], [v1.serial]);
  s.record([v2], [v2.serial]);
  check('record 后 pending = 已收两张券', s.pending.length === 2);
  check('已花集含两张券序列号', s.spent.has(v1.serial) && s.spent.has(v2.serial));

  // ---- 跨重启：新实例读回同一文件 ----
  const s2 = new PaywallStore(storeFile);
  check('跨重启 pending 持久化（读回两张）', s2.pending.length === 2);
  check('跨重启 已花集持久化', s2.spent.has(v1.serial) && s2.spent.has(v2.serial));

  // ---- 桥接：已收券直接喂给 MintDaemon 兑现（预览）----
  const provider = Wallet.generate().address; // 收款服务方（普通地址）
  const d = new MintDaemon({ dataDir: join(tmp, 'mintd'), mintWallet: mint });
  const dry = d.dryRedeem(s2.pending, provider);
  check('已收券可被 dryRedeem 兑现（PaywallStore→redeem 格式桥通）', dry.gross === 160);
  check('拆分自洽：net + fee == gross', dry.net + dry.fee === dry.gross);

  // ---- markRedeemed：删已兑现的 accepted，保留 spentSerials ----
  s2.markRedeemed([v1.serial]);
  check('markRedeemed 后 pending 仅剩未兑现的那张', s2.pending.length === 1 && s2.pending[0].serial === v2.serial);
  check('关键不变量：兑现后已花集仍保留（防访问双花不失效）', s2.spent.has(v1.serial) && s2.spent.has(v2.serial));

  // ---- 跨重启确认 markRedeemed 已落盘 ----
  const s3 = new PaywallStore(storeFile);
  check('跨重启：已兑现券不再出现在 pending', s3.pending.length === 1 && s3.pending[0].serial === v2.serial);
  check('跨重启：已花集仍含两张（含已兑现的）', s3.spent.has(v1.serial) && s3.spent.has(v2.serial));

  // ---- fail-closed：损坏券库拒读 ----
  const badFile = join(tmp, 'paywall-bad.json');
  writeFileSync(badFile, '{ not json at all', { mode: 0o600 });
  let failClosed = false;
  try {
    new PaywallStore(badFile);
  } catch {
    failClosed = true;
  }
  check('损坏券库 fail-closed 拒读（不静默重置丢已花集）', failClosed);

  // ---- 防重兑独立兜底：即便券库不清理，daemon 也拦第二次兑现 ----
  const r = d.redeem([v2], provider, 0); // 正式兑现 v2（标记 daemon 侧已花）
  check('redeem v2 成功（gross=60）', r.gross === 60);
  let doubleBlocked = false;
  try {
    d.dryRedeem([v2], provider);
  } catch {
    doubleBlocked = true;
  }
  check('同券再兑现被 daemon 拦（防重兑，独立于券库清理）', doubleBlocked);

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}

main();
