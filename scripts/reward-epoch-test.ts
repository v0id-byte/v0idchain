// 奖励计算自检（Phase 3A-3）：纯函数 computeReward——合成 attestation + 质押池，断言
//   ① 份额 ∝ uptime × ROLE_REWARD_MULT[role]；② 引导期按高度翻倍（绝对池仍受限）；
//   ③ 奖励池 REWARD_EPOCH_POOL 被尊重（Σ ≤ 池）；④ 掉线/无质押/非本 epoch 不发；⑤ 预览不发任何币（纯函数零副作用）。
// 跑：corepack pnpm exec tsx scripts/reward-epoch-test.ts
import {
  ROLE_REWARD_MULT,
  REWARD_EPOCH_POOL,
  BOOTSTRAP_BONUS_UNTIL_HEIGHT,
  BOOTSTRAP_BONUS_MULT,
  type StakePool,
  type StakeRole,
} from '../packages/core/src/index.js';
import { computeReward, bootstrapBonus, type Attestation } from '../packages/node/src/relay/measurer.js';

let failed = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
};

// 造一个质押池条目（只填 computeReward 关心的字段：staker/role/amount/slashed/withdrawn）。
let idc = 0;
function pool(staker: string, role: StakeRole, opts: Partial<StakePool> = {}): [string, StakePool] {
  const id = `stake${idc++}`.padEnd(64, '0');
  return [
    id,
    { staker, role, amount: opts.amount ?? 10, lockedUntil: 0, createdHeight: 0, slashed: opts.slashed ?? 0, withdrawn: opts.withdrawn ?? false },
  ];
}
function att(relayId: string, uptime: number, epoch = 1): Attestation {
  return { epoch, relayId, uptime, online: uptime > 0, probes: 3, ok: Math.round(uptime * 3), ts: 0 };
}

const EPOCH = 1;
const REWARD_HEIGHT = BOOTSTRAP_BONUS_UNTIL_HEIGHT + 100; // 引导期之后（bonus=1），份额比例最干净

console.log(`\n— ① 份额 ∝ uptime × ROLE_REWARD_MULT：同 uptime 不同角色，权重按倍率排序 —`);
{
  const g = '0x' + 'a'.repeat(64); // guard, mult=3
  const m = '0x' + 'b'.repeat(64); // middle, mult=1
  const h = '0x' + 'c'.repeat(64); // hsdir, mult=2
  const stakes = new Map<string, StakePool>([pool(g, 'guard'), pool(m, 'middle'), pool(h, 'hsdir')]);
  const lines = computeReward([att(g, 1), att(m, 1), att(h, 1)], stakes, REWARD_HEIGHT, EPOCH);
  const byId = new Map(lines.map((l) => [l.relayId, l]));
  // 权重应正比于 ROLE_REWARD_MULT（uptime 都=1，bonus=1）：guard:hsdir:middle = 3:2:1
  check('guard 权重 = 3×middle 权重（同 uptime）', byId.get(g)!.weight === 3 * byId.get(m)!.weight);
  check('hsdir 权重 = 2×middle 权重（同 uptime）', byId.get(h)!.weight === 2 * byId.get(m)!.weight);
  // 池=5，权重 3:2:1（Σ=6）→ floor(5×3/6)=2, floor(5×2/6)=1, floor(5×1/6)=0（保留 0 行供预览）
  check('guard 实发 = floor(5×3/6) = 2', byId.get(g)!.amount === 2);
  check('hsdir 实发 = floor(5×2/6) = 1', byId.get(h)!.amount === 1);
  check('middle 实发 floor(5×1/6)=0（行保留、weight 可核对；发放时由调用方过滤 0）', byId.get(m)!.amount === 0);
  check('总发放 ≤ 奖励池 REWARD_EPOCH_POOL', lines.reduce((s, l) => s + l.amount, 0) <= REWARD_EPOCH_POOL);
}

console.log(`\n— ② 份额 ∝ uptime：同角色不同 uptime，权重正比于 uptime —`);
{
  const a = '0x' + 'd'.repeat(64);
  const b = '0x' + 'e'.repeat(64);
  const stakes = new Map<string, StakePool>([pool(a, 'middle'), pool(b, 'middle')]);
  const lines = computeReward([att(a, 1.0), att(b, 0.5)], stakes, REWARD_HEIGHT, EPOCH);
  const byId = new Map(lines.map((l) => [l.relayId, l]));
  check('uptime=1.0 的权重 = 2×(uptime=0.5 的权重)（同角色）', byId.get(a)!.weight === 2 * byId.get(b)!.weight);
}

console.log(`\n— ③ 引导期按高度翻倍：bootstrapBonus(height) 在截止高度前后切换 —`);
{
  check(`bootstrapBonus(截止前) = ${BOOTSTRAP_BONUS_MULT}`, bootstrapBonus(BOOTSTRAP_BONUS_UNTIL_HEIGHT - 1) === BOOTSTRAP_BONUS_MULT);
  check('bootstrapBonus(截止高度当点) = 1（截止为开区间上界）', bootstrapBonus(BOOTSTRAP_BONUS_UNTIL_HEIGHT) === 1);
  check('bootstrapBonus(截止后) = 1', bootstrapBonus(BOOTSTRAP_BONUS_UNTIL_HEIGHT + 1) === 1);
  const g = '0x' + '1'.repeat(64);
  const stakes = new Map<string, StakePool>([pool(g, 'guard')]);
  // 单中继独占池：引导期内与后，weight 翻倍体现在 weight 字段；但 amount 都=floor(池×1)=池（独占归一化）。
  const early = computeReward([att(g, 1)], stakes, BOOTSTRAP_BONUS_UNTIL_HEIGHT - 1, EPOCH)[0];
  const late = computeReward([att(g, 1)], stakes, BOOTSTRAP_BONUS_UNTIL_HEIGHT + 1, EPOCH)[0];
  check('引导期内单中继 weight = 后期 weight × BOOTSTRAP_BONUS_MULT', early.weight === late.weight * BOOTSTRAP_BONUS_MULT);
  check('独占中继实发 = 整个奖励池（归一化后 bonus 约掉，绝对池受限）', early.amount === REWARD_EPOCH_POOL && late.amount === REWARD_EPOCH_POOL);
}

console.log(`\n— ④ 掉线 / 无有效质押 / 已赎回 / 非本 epoch 的 attestation 不参与分配 —`);
{
  const on = '0x' + '2'.repeat(64); // 在线 + 有质押 → 应得奖励
  const off = '0x' + '3'.repeat(64); // 掉线（uptime 0）→ 不发
  const nostake = '0x' + '4'.repeat(64); // 在线但无质押 → 不发
  const wd = '0x' + '5'.repeat(64); // 在线但质押已赎回 → 不发
  const stakes = new Map<string, StakePool>([pool(on, 'middle'), pool(wd, 'middle', { withdrawn: true })]);
  const lines = computeReward(
    [att(on, 1), att(off, 0), att(nostake, 1), att(wd, 1), att(on, 1, 99) /* 非本 epoch */],
    stakes,
    REWARD_HEIGHT,
    EPOCH,
  );
  const ids = new Set(lines.map((l) => l.relayId));
  check('在线且有质押的中继获奖励', ids.has(on));
  check('掉线(uptime=0)中继不发', !ids.has(off));
  check('无质押中继不发', !ids.has(nostake));
  check('质押已赎回中继不发', !ids.has(wd));
  check('独占在线中继实发 = 池（其余都被排除）', lines.find((l) => l.relayId === on)!.amount === REWARD_EPOCH_POOL);
  check('非本 epoch 的 attestation 不额外计入（无重复行）', lines.filter((l) => l.relayId === on).length === 1);
}

console.log(`\n— ⑤ 池上限 + 预览零副作用：多中继瓜分，Σ 永不超池；computeReward 不发币（纯函数）—`);
{
  // 10 个满 uptime 的 middle 瓜分池=5：每个 floor(5×1/10)=0 → 全被过滤，Σ=0 ≤ 池（不超发、不四舍五入冒头）。
  const many = Array.from({ length: 10 }, (_, i) => '0x' + String.fromCharCode(97 + i).repeat(64));
  const stakes = new Map<string, StakePool>(many.map((a) => pool(a, 'middle')));
  const before = JSON.stringify([...stakes.entries()]); // 快照：纯函数不得改入参
  const lines = computeReward(many.map((a) => att(a, 1)), stakes, REWARD_HEIGHT, EPOCH);
  const total = lines.reduce((s, l) => s + l.amount, 0);
  check('多中继瓜分：Σ 实发 ≤ 奖励池（floor 保证不超发）', total <= REWARD_EPOCH_POOL);
  check('computeReward 不修改入参 stakes（纯函数、零副作用 = 预览不发币）', JSON.stringify([...stakes.entries()]) === before);
  // ROLE_REWARD_MULT 健全性：与公式一致（guard 最高、middle 基准）。
  check('ROLE_REWARD_MULT 合理：guard ≥ hsdir ≥ middle = 1', ROLE_REWARD_MULT.guard >= ROLE_REWARD_MULT.hsdir && ROLE_REWARD_MULT.hsdir >= ROLE_REWARD_MULT.middle && ROLE_REWARD_MULT.middle === 1);
}

console.log(failed === 0 ? `\n🎉 全部通过 ALL PASS\n` : `\n💥 ${failed} 项失败 ${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
