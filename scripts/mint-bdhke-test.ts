// BDHKE 盲签原语测试（Phase B Slice 1）。三层验证——
//   ① 对拍 Cashu NUT-00 公开测试向量（hashToCurve 3 条 / 盲化 B_ 2 条 / 签名 C_ 2 条，精确 hex 相等）
//      → 证明实现与经审计的参考构造逐位一致，不是"自洽但实现错"的自制曲线映射；
//   ② 随机往返 blind→sign→unblind→verify + **去盲结果 C 与盲化因子 r 无关（C=k·Y）** → 匿名不可链接的数学核心；
//   ③ 负例：换秘密 / 换铸币私钥 / 他券 C / 错 r 去盲，全被 verify 拒；序列化与落域校验。
// 跑：corepack pnpm exec tsx scripts/mint-bdhke-test.ts
import { randomBytes } from 'node:crypto';
import {
  hashToCurve,
  blind,
  blindSign,
  unblind,
  verifyUnblinded,
  generateMintKeypair,
  mintKeypairFromScalar,
  pointToHex,
  pointFromHex,
  scalarToHex,
  scalarFromHex,
  randomScalar,
} from '../packages/core/src/index.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

// ── NUT-00 公开测试向量（来源：github.com/cashubtc/nuts/tests/00-tests.md，MIT）──
const H2C: Array<[string, string]> = [
  ['00'.repeat(32), '024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725'],
  ['00'.repeat(31) + '01', '022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf'],
  ['00'.repeat(31) + '02', '026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f'],
];
const BLIND_VEC = [
  {
    x: 'd341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6',
    r: '99fce58439fc37412ab3468b73db0569322588f62fb3a49182d67e23d877824a',
    B_: '033b1a9737a40cc3fd9b6af4b723632b76a67a36782596304612a6c2bfb5197e6d',
  },
  {
    x: 'f1aaf16c2239746f369572c0784d9dd3d032d952c2d992175873fb58fae31a60',
    r: 'f78476ea7cc9ade20f9e05e58a804cf19533f03ea805ece5fee88c8e2874ba50',
    B_: '029bdf2d716ee366eddf599ba252786c1033f47e230248a4612a5670ab931f1763',
  },
];
const SIGN_VEC = [
  {
    k: '00'.repeat(31) + '01',
    B_: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2',
    C_: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2',
  },
  {
    k: '7f'.repeat(32),
    B_: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2',
    C_: '0398bc70ce8184d27ba89834d19f5199c84443c31131e48d3c1214db24247d005d',
  },
];

function main() {
  // ── ① NUT-00 向量对拍 ──
  for (const [msg, expect] of H2C) {
    check(`① hashToCurve(${msg.slice(0, 4)}…) 命中 NUT-00 向量`, pointToHex(hashToCurve(bytes(msg))) === expect);
  }
  for (const v of BLIND_VEC) {
    const { B_ } = blind(bytes(v.x), scalarFromHex(v.r));
    check(`① blind B_ = Y + r·G 命中 NUT-00 向量(${v.B_.slice(0, 6)}…)`, pointToHex(B_) === v.B_);
  }
  for (const v of SIGN_VEC) {
    const C_ = blindSign(pointFromHex(v.B_), scalarFromHex(v.k));
    check(`① blindSign C_ = k·B_ 命中 NUT-00 向量(k=${v.k.slice(0, 4)}…)`, pointToHex(C_) === v.C_);
  }
  // hashToCurve 确定性：同输入两次同点
  check('hashToCurve 确定性（同输入→同点）', pointToHex(hashToCurve(bytes('0a'.repeat(32)))) === pointToHex(hashToCurve(bytes('0a'.repeat(32)))));

  // ── ② 随机往返 + 去盲与 r 无关（C=k·Y）──
  let roundtrip = true;
  let independent = true;
  for (let i = 0; i < 200; i++) {
    const kp = generateMintKeypair();
    const secret = randomBytes(32);
    const { B_, r } = blind(secret);
    const C = unblind(blindSign(B_, kp.k), r, kp.K);
    if (!verifyUnblinded(secret, C, kp.k)) {
      roundtrip = false;
      break;
    }
    // 同一秘密、另一盲化因子 → 去盲后必须得到**同一个 C**（C=k·Y 与 r 无关 = 不可链接的根据）
    const b2 = blind(secret);
    const C2 = unblind(blindSign(b2.B_, kp.k), b2.r, kp.K);
    if (pointToHex(C) !== pointToHex(C2)) {
      independent = false;
      break;
    }
  }
  check('② 200 次随机往返 blind→sign→unblind→verify 全通过', roundtrip);
  check('★② 去盲结果 C 与盲化因子 r 无关（C=k·Y）→ 铸币厂无法凭 r 关联发/兑现', independent);
  // 盲化点确实盖住了 Y（B_ ≠ Y），且不同 r 给出不同 B_
  {
    const secret = randomBytes(32);
    const a = blind(secret);
    const b = blind(secret);
    check('盲化点 B_ ≠ Y（确实盲化了）', pointToHex(a.B_) !== pointToHex(a.Y));
    check('不同盲化因子 → 不同 B_（每次连接不可关联）', pointToHex(a.B_) !== pointToHex(b.B_));
  }

  // ── ③ 负例 ──
  {
    const kp = generateMintKeypair();
    const secret = randomBytes(32);
    const { B_, r } = blind(secret);
    const C_ = blindSign(B_, kp.k);
    const C = unblind(C_, r, kp.K);
    check('③ 正例：verifyUnblinded 认本厂签发的券', verifyUnblinded(secret, C, kp.k));
    check('③ 换秘密 → 拒（券绑定 secret）', !verifyUnblinded(randomBytes(32), C, kp.k));
    check('③ 换铸币私钥 → 拒（别家 k 验不过）', !verifyUnblinded(secret, C, generateMintKeypair().k));
    // 伪造 C：拿另一秘密的合法券签名冒充本 secret 的 C
    const other = randomBytes(32);
    const otherC = unblind(blindSign(blind(other).B_, kp.k), blind(other).r, kp.K);
    check('③ 他券 C 冒充 → 拒', !verifyUnblinded(secret, otherC, kp.k));
    // 去盲用错 r → 错 C → 拒
    const wrongC = unblind(C_, randomScalar(), kp.K);
    check('③ 错盲化因子去盲 → 得错 C → 拒', !verifyUnblinded(secret, wrongC, kp.k));
  }

  // ── 序列化 + 落域校验 ──
  {
    const kp = mintKeypairFromScalar(scalarFromHex('7f'.repeat(32)));
    check('点压缩 hex 往返一致', pointFromHex(pointToHex(kp.K)).equals(kp.K));
    check('标量 hex 往返一致', scalarFromHex(scalarToHex(kp.k)) === kp.k);
    check('pointToHex 为 33B 压缩（66 hex）', pointToHex(kp.K).length === 66);
    check('scalarFromHex 拒 0（越下界）', throws(() => scalarFromHex('00'.repeat(32))));
    check('scalarFromHex 拒 ≥n（越上界）', throws(() => scalarFromHex('ff'.repeat(32))));
    check('pointFromHex 拒非法点', throws(() => pointFromHex('deadbeef')));
    check('mintKeypairFromScalar 拒 0', throws(() => mintKeypairFromScalar(0n)));
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}

main();
