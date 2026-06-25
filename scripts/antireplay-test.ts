// 滑动窗口防重放（antireplay.ts）单元自测。证明窗口防线既接受 Mixnet 重排的乱序 cell，又拦住一切真重放/太老/越界。
// 跑：corepack pnpm exec tsx scripts/antireplay-test.ts
import { newAntiReplay, accept, ANTIREPLAY_WINDOW } from '../packages/node/src/relay/antireplay.js';
import { MAX_CELL_CTR } from '../packages/core/src/index.js';

let failures = 0;
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failures++;
  }
};

function main() {
  // ① 首个 n=0 被接受（max 初始 -1 → 0 > -1）。
  {
    const st = newAntiReplay();
    check('① 首个 n=0 被接受', accept(st, 0) === true);
  }

  // ② 顺序递增全部接受。
  {
    const st = newAntiReplay();
    let ok = true;
    for (let n = 0; n < 100; n++) if (!accept(st, n)) ok = false;
    check('② 顺序 0..99 全部接受', ok);
  }

  // ③ 乱序但首见（窗口内）全部接受：accept 5, 然后 3, 然后 4 → 都 true。
  {
    const st = newAntiReplay();
    const a = accept(st, 5);
    const b = accept(st, 3);
    const c = accept(st, 4);
    check('③ 窗口内乱序首见 5→3→4 全部接受', a === true && b === true && c === true);
    // max 应停在 5（领先值），不被随后较小的 3/4 拉回。
    check('③ 乱序后 max 仍为领先值 5（更老的 n 不回退 max）', (st.max as number) === 5);
  }

  // ④ 重复即丢：accept 5 两次 → 第二次 false。其余已见值重复同样 false。
  {
    const st = newAntiReplay();
    const first = accept(st, 5);
    const second = accept(st, 5);
    check('④ 重复 n=5 第二次被拒（重放）', first === true && second === false);
    accept(st, 3);
    check('④ 重复 n=3 被拒（窗口内已见）', accept(st, 3) === false);
    check('④ 重复 n=0?（从未见）首见仍接受', accept(st, 0) === true && accept(st, 0) === false);
  }

  // ⑤ 太老即丢：窗口 W=8，accept 100，然后 100-8-1=91 → false（落在窗口左界外）。
  {
    const st = newAntiReplay(8);
    check('⑤ W=8：accept 100', accept(st, 100) === true);
    check('⑤ W=8：太老 n=91(=100-8-1) 被拒', accept(st, 91) === false);
    // 窗口左界恰好处：max-W = 92 是“太老”边界（n ≤ max-W 丢），93 是窗口内最老仍可接受的首见值。
    check('⑤ W=8：边界 n=92(=max-W) 被拒（恰在左界外）', accept(st, 92) === false);
    check('⑤ W=8：边界 n=93(=max-W+1) 首见被接受（窗口内最老）', accept(st, 93) === true);
    check('⑤ W=8：n=93 重复被拒', accept(st, 93) === false);
  }

  // ⑥ nonce 悬崖：n ≥ MAX_CELL_CTR、n < 0、非安全整数 → 全部 false（与流加密 nonce 安全区一致）。
  {
    const st = newAntiReplay();
    check('⑥ n = MAX_CELL_CTR 被拒', accept(st, MAX_CELL_CTR) === false);
    check('⑥ n = MAX_CELL_CTR+1 被拒', accept(st, MAX_CELL_CTR + 1) === false);
    check('⑥ n < 0 被拒', accept(st, -1) === false);
    check('⑥ 非安全整数(2^53) 被拒', accept(st, 2 ** 53) === false);
    check('⑥ NaN 被拒', accept(st, NaN) === false);
    check('⑥ 小数 3.5 被拒', accept(st, 3.5) === false);
    // 悬崖前一格 MAX_CELL_CTR-1 是合法最大值 → 接受。
    check('⑥ n = MAX_CELL_CTR-1（合法上界）被接受', accept(st, MAX_CELL_CTR - 1) === true);
    // 被拒的越界值不应污染状态（max 不变 = -1+悬崖前那次接受到 MAX-1）。
    check('⑥ 越界拒绝不污染 max', (st.max as number) === MAX_CELL_CTR - 1);
  }

  // ⑦ 远跳前进（advance ≥ W）整窗清零：W=8，accept 5、6，再 accept 1000（前进>窗）→ 老的 5/6 已遗忘且 1000 之后近邻可重新接受。
  {
    const st = newAntiReplay(8);
    accept(st, 5);
    accept(st, 6);
    check('⑦ 远跳 n=1000（前进>W）被接受', accept(st, 1000) === true);
    check('⑦ 远跳后旧 n=5 已落窗口外 → 被拒（太老，非误判为新）', accept(st, 5) === false);
    check('⑦ 远跳后 1000 重复被拒', accept(st, 1000) === false);
    check('⑦ 远跳后 999(窗口内首见) 被接受', accept(st, 999) === true);
    check('⑦ 远跳后 994(=1000-8+2,窗口内首见) 被接受', accept(st, 994) === true);
    check('⑦ 远跳后 992(=max-W) 被拒（左界外）', accept(st, 992) === false);
  }

  // ⑧ 环形位图正确性：跨越多个 W 边界的连续推进不串位（W=8，推进数百格，期间穿插重复检查）。
  {
    const st = newAntiReplay(8);
    let ok = true;
    for (let n = 0; n < 500; n++) {
      if (!accept(st, n)) ok = false; // 顺序推进每个都应首见接受
      if (accept(st, n)) ok = false; // 紧接重复必拒
    }
    check('⑧ 跨数百 W 边界顺序推进 + 紧邻重复检测无串位', ok);
  }

  // ⑨ 默认窗口宽度足够大：在 ANTIREPLAY_WINDOW 跨度内任意乱序首见都接受（模拟 Mixnet 重排）。
  {
    const st = newAntiReplay();
    // 先推进到一个高水位 max=W-1，再在 [0, W-1] 内随机乱序重放“尚未见”的——但此处全都见过了，换个法：
    // 先只接受偶数，再回头接受奇数（奇数仍在窗口内、首见）→ 全部应接受。
    const W = ANTIREPLAY_WINDOW;
    let ok = true;
    for (let n = 0; n < W; n += 2) if (!accept(st, n)) ok = false; // 偶数（max 推到 W-2）
    for (let n = 1; n < W; n += 2) if (!accept(st, n)) ok = false; // 奇数（都 < max 但窗口内首见）
    check(`⑨ 默认 W=${W}：先偶后奇（跨度≈W 的乱序首见）全部接受`, ok);
    // 全见过后任意重复都拒。
    let allDup = true;
    for (let n = 0; n < W; n++) if (accept(st, n)) allDup = false;
    check('⑨ 全部见过后任意重复都被拒', allDup);
  }

  // ⑩ 模糊测试：0..N-1 的随机排列全部首见接受、各恰一次；之后重放其中任意一个均被拒。
  {
    const N = 6000; // < 默认 W=8192 → 全程都在窗口内，任意乱序都应被接受（这正是 Mixnet 重排的核心保证）
    const st = newAntiReplay();
    const perm = Array.from({ length: N }, (_, i) => i);
    // Fisher–Yates 洗牌（测试随机源，非密码学）。
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    let acceptedCount = 0;
    for (const n of perm) if (accept(st, n)) acceptedCount++;
    check(`⑩ 0..${N - 1} 随机排列：全部恰好接受一次（${acceptedCount}/${N}）`, acceptedCount === N);
    // 再随机抽 200 个重放 → 全部被拒。
    let anyReaccepted = false;
    for (let k = 0; k < 200; k++) {
      const n = Math.floor(Math.random() * N);
      if (accept(st, n)) anyReaccepted = true;
    }
    check('⑩ 随机重放任意已见 n → 全部被拒（无重放穿透）', anyReaccepted === false);
  }

  // ⑪ 内存有界：bits 长度 = ⌈W/8⌉，与流量无关（推进百万格后仍是固定字节数）。
  {
    const st = newAntiReplay();
    const before = st.bits.length;
    for (let n = 0; n < 200000; n++) accept(st, n);
    check(`⑪ 位图固定 ⌈W/8⌉=${Math.ceil(ANTIREPLAY_WINDOW / 8)} 字节，与流量无关`, st.bits.length === before && before === Math.ceil(ANTIREPLAY_WINDOW / 8));
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}\n`, () => process.exit(failures === 0 ? 0 : 1));
}
main();
