// 央行电子现金铸币厂 · devnet 全环集成验证（补齐 mint-selftest 唯一没覆盖的一环：**链上真正接受一笔 REDEEM**）。
//
// mint-selftest / mint-daemon-test 已覆盖纯逻辑 + 非授权兑现被拒，但「链接受运营者签发的 REDEEM」需要一个
// **地址 === config.MINT_ADDRESS 的掌钥运营者**——主网 MINT_ADDRESS 是占位地址（私钥已弃）→ 本地签不出被接受的 REDEEM。
// 本脚本在 devnet 用一个我掌钥的运营者把整条资金流跑通并被共识接受：**充值(上链) → 发券(链下) → 兑现(上链被接受)
// → 储备减少 / 抽成回国库 / 偿付强制**。
//
// ⚠️ 一次性 deploy-readiness 检查，不进 CI。语义：**未提供运营者密钥 → SKIP(exit 0，CI 安全)**；
//    **提供了密钥但 config 不符 → FAIL(exit 1)**（防 pre-deploy gate 只看退出码把"配置没改对"误报成功）。
// devnet 跑法（改 config 绝不 commit，运营者私钥绝不入库 —— 同 MINT_ADDRESS 掌钥即支配储备的纪律）：
//   1) 生成运营者钱包（脚本自带，避免 tsx -e 解析问题 / 打印 Uint8Array 而非 hex）：
//        V0ID_DEVNET_GEN=1 corepack pnpm exec tsx scripts/mint-devnet-e2e.ts   →  打印 SK=<私钥hex> / ADDR=<地址>
//      （真·上线前请改用运营者**已有的 0600 钱包**，不要新生成一把。）
//   2) **临时**改 packages/core/src/config.ts：MINT_ADDRESS = 该 ADDR；MINT_ACTIVATION_HEIGHT = 50（forge 快）。
//   3) 跑验证 —— **优先用 0600 钱包文件传密钥**（不落 shell 历史/进程环境）：
//        V0ID_DEVNET_OPERATOR_KEYFILE=/path/to/wallet.json corepack pnpm exec tsx scripts/mint-devnet-e2e.ts
//      （devnet 便利也可 V0ID_DEVNET_OPERATOR_SK=<hex>，但会落 shell history + 进程环境；真·上线务必用文件。）
//   4) 还原 config：git checkout packages/core/src/config.ts
import {
  Blockchain,
  Wallet,
  createTransaction,
  computeMintState,
  redeemSplit,
  MINT_ADDRESS,
  MINT_ESCROW_ADDRESS,
  MINT_ACTIVATION_HEIGHT,
  MINT_DEPOSIT_PREFIX,
  REDEEM_PREFIX,
  GENESIS_PREMINE,
  GENESIS_PREMINE_ADDRESS,
  BLOCK_REWARD,
  MIN_FEE,
  minFeeFor,
} from '../packages/core/src/index.js';
import { MintDaemon } from '../packages/node/src/mint/mintd.js';
import { forgeTo, clearCheckpointsForTest } from './forge-chain.js';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 运营者密钥来源：优先 0600 钱包文件（不落 shell 历史），回退环境变量（devnet 便利）。返回 hex 私钥或 null。 */
function loadOperatorSk(): string | null {
  const kf = process.env.V0ID_DEVNET_OPERATOR_KEYFILE;
  if (kf) {
    const raw = readFileSync(kf, 'utf8').trim();
    try {
      const j = JSON.parse(raw); // 支持 wallet.json（{privateKey: hex}）
      if (j && typeof j.privateKey === 'string') return j.privateKey;
    } catch {
      /* 非 JSON → 当作裸 hex */
    }
    return raw;
  }
  return process.env.V0ID_DEVNET_OPERATOR_SK ?? null;
}

let failed = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) failed++;
}

const supply = (bc: Blockchain) => [...bc.computeState().balances.values()].reduce((s, v) => s + v, 0);
const conserved = (bc: Blockchain) => supply(bc) === GENESIS_PREMINE + bc.height * BLOCK_REWARD;

const funder = Wallet.generate();
async function fund(bc: Blockchain, to: string, amount: number): Promise<void> {
  const tx = createTransaction(funder, to, amount, bc.nonceOf(funder.address), '', minFeeFor(amount));
  if (!bc.addTransaction(tx).ok) throw new Error('fund: 转账未进 mempool');
  await bc.mine(funder.address); // funder 既转账又挖矿 → 手续费/出块奖励回流 funder，不污染 to/国库净额
}

async function main() {
  // ---- 生成运营者钱包（自带，避免 tsx -e 解析问题 / 打印 Uint8Array）→ 打印 hex 私钥 + 地址后退出 ----
  if (process.env.V0ID_DEVNET_GEN) {
    const w = Wallet.generate();
    process.stdout.write(`SK=${w.toJSON().privateKey}\nADDR=${w.address}\n`);
    process.exit(0);
  }

  // ---- 前置门槛 ----
  // 未提供密钥 = 没打算跑 → SKIP(0)，CI 安全。
  const skHex = loadOperatorSk();
  if (!skHex) {
    console.log('⏭  SKIP: 未提供运营者密钥（V0ID_DEVNET_OPERATOR_KEYFILE / _SK）——这是 devnet deploy-readiness 检查，见文件头跑法。');
    process.exit(0);
  }
  // 一旦**显式提供**了运营者密钥 = 打算跑全程 → config 不符即 **FAIL(exit 1)**，不再 SKIP。
  // 否则 pre-deploy gate 只看退出码，会把"config 里 MINT_ADDRESS/激活高度没改对"这种恰恰阻断链上接受的错配误报成功。
  const operator = Wallet.fromPrivateKeyHex(skHex);
  if (operator.address !== MINT_ADDRESS) {
    console.error(`❌ FAIL: 运营者地址 ${operator.address} ≠ config.MINT_ADDRESS ${MINT_ADDRESS}。`);
    console.error('   已显式提供运营者密钥却地址不符 → 链不会接受其 REDEEM。请临时把 config 的 MINT_ADDRESS 改成运营者地址（文件头第 2 步）后重跑。');
    process.exit(1);
  }
  if (MINT_ACTIVATION_HEIGHT > 2_000) {
    console.error(`❌ FAIL: MINT_ACTIVATION_HEIGHT=${MINT_ACTIVATION_HEIGHT} 太高、forge 极慢。请临时改小（如 50）后重跑。`);
    process.exit(1);
  }

  clearCheckpointsForTest(); // devnet forge 链非真 PoW/非主网 hash → 关闭 checkpoint 强制
  console.log(`\n运营者(=MINT_ADDRESS) ${operator.address}`);
  console.log(`国库(=GENESIS_PREMINE_ADDRESS) ${GENESIS_PREMINE_ADDRESS}\n`);

  // ---- forge 到激活高度之上（BLOCK_REWARD=1 → 多 forge 些块让 funder 有足够余额资助整条流；非真 PoW，很快）----
  const DEP = 1000;
  const bc = new Blockchain();
  await forgeTo(bc, funder.address, MINT_ACTIVATION_HEIGHT + DEP + 300);
  check(`基底链已过激活高度（height=${bc.height} > ${MINT_ACTIVATION_HEIGHT}）`, bc.height > MINT_ACTIVATION_HEIGHT);
  check('国库起始余额 = 创世预挖（forge 未动国库）', bc.balanceOf(GENESIS_PREMINE_ADDRESS) === GENESIS_PREMINE);

  // ---- ① 充值（上链）----
  const user = Wallet.generate();
  await fund(bc, user.address, DEP + MIN_FEE);
  const depTx = createTransaction(user, MINT_ESCROW_ADDRESS, DEP, bc.nonceOf(user.address), MINT_DEPOSIT_PREFIX, MIN_FEE);
  check('充值 DEPOSIT 进 mempool', bc.addTransaction(depTx).ok);
  await bc.mine(funder.address);
  check('充值后：托管储备 = 充值额、共识 mintReserve 一致', bc.balanceOf(MINT_ESCROW_ADDRESS) === DEP && bc.computeState().mintReserve === DEP);

  // ---- ② 发券（链下：运营者守护进程）----
  const dataDir = join(tmpdir(), `v0id-mint-devnet-${process.pid}`);
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  const daemon = new MintDaemon({ dataDir, mintWallet: operator, depositConfirmations: 0 });
  daemon.syncDeposits(bc.chain);
  check('守护扫链记额度：user allowance = 充值额', daemon.allowanceOf(user.address) === DEP);
  const voucher = daemon.issue(user.address, DEP);
  check('发券成功、额度扣减归零（Σ已发 ≤ Σ充值）', voucher.denom === DEP && daemon.allowanceOf(user.address) === 0);

  // ---- ③ 兑现（上链·**被共识接受** = 本脚本要补的那一环）----
  const provider = Wallet.generate();
  await fund(bc, operator.address, MIN_FEE * 3); // 运营者需余额付 REDEEM 打包 gas
  const { net, fee } = redeemSplit(DEP);
  const treasuryBefore = bc.balanceOf(GENESIS_PREMINE_ADDRESS);
  const r = daemon.redeem([voucher], provider.address, bc.nonceOf(operator.address));
  const accepted = bc.addTransaction(r.tx);
  check('★ 链接受运营者签发的 REDEEM（mint-selftest 的部署期空白已被真链验证）', accepted.ok === true);
  await bc.mine(funder.address);

  check('整链 validateChain 通过（含被接受的 REDEEM）', Blockchain.validateChain(bc.chain).ok);
  check(`服务方实得 net=${net}（面额−抽成）`, bc.balanceOf(provider.address) === net);
  check(`抽成 fee=${fee} 回流国库`, bc.balanceOf(GENESIS_PREMINE_ADDRESS) === treasuryBefore + fee);
  check('托管储备扣掉面额 → 归零', bc.balanceOf(MINT_ESCROW_ADDRESS) === 0);
  const mv = computeMintState(bc.chain);
  check('computeMintState：redeemed=面额、feesToTreasury=抽成、reserve=0', mv.redeemed === DEP && mv.feesToTreasury === fee && mv.reserve === 0);
  check('共识 mintReserve ≡ computeMintState.reserve（=0）', bc.computeState().mintReserve === mv.reserve);
  check('兑现后全链守恒（面额只搬运、抽成不增发）', conserved(bc));

  // ---- ④ 偿付强制：储备已空，运营者再签 REDEEM 也被拒（链上强制 兑现 ≤ 储备）----
  const overRedeem = createTransaction(operator, provider.address, 0, bc.nonceOf(operator.address), `${REDEEM_PREFIX}1`, MIN_FEE);
  const overRes = bc.addTransaction(overRedeem);
  check('偿付强制：储备不足时，即便运营者签发 REDEEM 也被拒', overRes.ok === false);
  check('拒绝原因点明偿付/储备不足', /偿付|储备/.test(String(overRes.error)));

  // ---- ⑤ 分叉安全：含被接受 REDEEM 的整链被全新节点 replaceChain 接受、余额一致 ----
  const fresh = new Blockchain();
  const rep = fresh.replaceChain(JSON.parse(JSON.stringify(bc.chain)));
  check('含 REDEEM 的整链经 replaceChain 被全新节点接受', rep.replaced === true);
  check('接受后：服务方/国库/储备与源链逐项一致', fresh.balanceOf(provider.address) === net && fresh.balanceOf(GENESIS_PREMINE_ADDRESS) === treasuryBefore + fee && fresh.balanceOf(MINT_ESCROW_ADDRESS) === 0);

  rmSync(dataDir, { recursive: true, force: true });
  console.log(failed === 0 ? `\n🎉 全环通过 ALL PASS（充值→发券→兑现被链接受→偿付强制→分叉安全）\n` : `\n💥 ${failed} 项失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('崩溃:', e);
  process.exit(1);
});
