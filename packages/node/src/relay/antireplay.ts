// 滑动窗口防重放（RFC 6479 风格）。Phase 2C Mixnet 的前置：每跳独立随机延迟会**重排** cell，
// 故“n 必须严格增”的旧防线会把被重排到后面的合法 cell误判成重放而丢弃 → 流丢包。改用窗口防线：
// 接受“窗口内尚未见过的”任意乱序 cell，只丢“重复见过的”和“老到窗口外、已无法证明非重放的”。
//
// 与严格单调相比保留的全部安全性质：
// - 重复 n（已置位）→ 丢（真重放被拦）。
// - n ≤ max - W（滑出窗口、已遗忘）→ 丢（无法证明非重放则保守拒绝；攻击者无法靠“极旧 n”绕过）。
// - nonce 悬崖：n ≥ MAX_CELL_CTR / n < 0 / 非安全整数 → 丢（与旧 isValidCellCounter 同界，绝不让流加密 (key,nonce) 重用）。
// - 首个 cell n=0 必被接受一次（max 初始 -1 → 0 > -1 → 推进窗口、置位、返回 true）。
//
// 内存有界：每个窗口固定 ⌈W/8⌉ 字节位图 + 一个 max 整数，与电路/通道数线性、与流量无关。
import { MAX_CELL_CTR } from '@v0idchain/core';

/**
 * 默认窗口宽度（计数器个数）。**W 必须大于 mixnet 下的最大重排跨度**，否则被延迟最久的 cell 滑出窗口被误丢。
 * 重排跨度上界 ≈ maxDelayMs × 单电路 cell 速率：本链默认 maxDelayMs=2000ms、单电路前向限速 cellRate=500/s
 * → 跨度 ≤ 2000ms × 500/s = 1000。8192 远大于此（亦覆盖更激进的 2000ms × ~4000/s ≈ 8000 场景），留足安全余量；
 * 位图仅 8192/8 = 1024 字节/窗口，内存代价可忽略。可在测试里覆写 W 以验证“太老即丢”等边界。
 */
export const ANTIREPLAY_WINDOW = 8192;

/** 一个方向的窗口防重放状态。max=已接受的最高 n（-1=尚未接受任何 cell）；bits=覆盖 (max-W, max] 的位图。 */
export interface AntiReplayState {
  max: number;
  readonly window: number; // 本状态的窗口宽度 W（默认 ANTIREPLAY_WINDOW；测试可注入更小值）
  readonly bits: Uint8Array; // ⌈W/8⌉ 字节；bit(n) = 是否已接受过计数器 n（仅对 n∈(max-W, max] 有意义）
}

/** 新建一个窗口防重放状态（max=-1 使首个 n=0 被接受一次）。w 可覆写窗口宽度（测试用）。 */
export function newAntiReplay(w: number = ANTIREPLAY_WINDOW): AntiReplayState {
  return { max: -1, window: w, bits: new Uint8Array(Math.ceil(w / 8)) };
}

// 位图按“计数器值 n 模 W 落到位”寻址（环形）。窗口推进时把滑过的旧位清零，保证读到的位永远属于当前窗口区间。
function getBit(st: AntiReplayState, n: number): boolean {
  const idx = ((n % st.window) + st.window) % st.window;
  return (st.bits[idx >> 3] & (1 << (idx & 7))) !== 0;
}
function setBit(st: AntiReplayState, n: number, v: boolean): void {
  const idx = ((n % st.window) + st.window) % st.window;
  const byte = idx >> 3;
  const mask = 1 << (idx & 7);
  if (v) st.bits[byte] |= mask;
  else st.bits[byte] &= ~mask;
}

/**
 * 判定一个计数器 n 是否“新且可接受”，并在接受时记录之。返回 true=接受（首见），false=丢弃（重放/太老/越界）。
 *
 * 三种情形：
 *  - n > max（领先于已见最高）：把窗口前移 (n-max)，清掉因前移而滑出窗口的旧位（它们对应的计数器已落到新窗口外，
 *    其位必须代表“新窗口里尚未见”=0）；置 n 位、推进 max；返回 true。前移 ≥ W 时整窗清零（旧位全部失效）。
 *  - n ≤ max - W（落在窗口左界外，已遗忘）：无法证明非重放 → 返回 false（丢）。
 *  - 否则 n∈(max-W, max]（窗口内）：位已置 → 重放 → false；位未置 → 首见 → 置位、返回 true。
 */
export function accept(st: AntiReplayState, n: number): boolean {
  // nonce 悬崖 / 非法计数器：与旧 isValidCellCounter 完全同界，绝不接受（流加密 nonce 安全区 [0, 2^48)）。
  if (!Number.isSafeInteger(n) || n < 0 || n >= MAX_CELL_CTR) return false;

  if (n > st.max) {
    const advance = n - st.max;
    if (advance >= st.window) {
      st.bits.fill(0); // 前移超过整窗 → 旧窗口全部失效，整位图清零
    } else {
      // 清掉 (oldMax, n] 这段新滑入窗口的计数器对应的位（它们的环形槽此前属于更老的、现已滑出的计数器）。
      for (let k = st.max + 1; k <= n; k++) setBit(st, k, false);
    }
    setBit(st, n, true);
    st.max = n;
    return true;
  }

  if (n <= st.max - st.window) return false; // 太老（窗口外，已遗忘）→ 保守丢

  if (getBit(st, n)) return false; // 窗口内、已见 → 重放 → 丢
  setBit(st, n, true); // 窗口内、首见 → 接受
  return true;
}
