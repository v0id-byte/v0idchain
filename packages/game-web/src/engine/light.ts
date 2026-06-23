// 全局光照约定（RENDER-3D-FEEL §7-A / §7-C）。整镇共用单一光向 + 一套 hue-shift 明暗 ramp，
// 让所有手绘物件"左上受光、右下变暗"，并告别纯明度增减造成的"发闷发脏"。纯静态、可烤进缓存画布。

// 单一全局光向：从左上来光（归一化方向无关，只用符号约定 朝(-1,-1)提亮 / 朝(+1,+1)压暗）。
export const LIGHT = { dx: -1, dy: -1 } as const;

// hue-shift ramp（依据 §4.3 / R9）：提亮 ⇒ 升明度 + 偏暖（蓝加得少）；压暗 ⇒ 降明度 + 偏冷（蓝减得少，残蓝）。
// d>0 提亮、d<0 压暗。在 RGB 上近似：暖=多加红绿少加蓝；冷=多减红绿少减蓝（保留偏蓝的残量）。
function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 对一组 RGB 做 hue-shift 明暗调整（暗偏蓝、亮偏黄），返回 [r,g,b]。 */
export function rampRGB(r: number, g: number, b: number, d: number): [number, number, number] {
  if (d >= 0) {
    // 提亮偏暖：红绿足量、蓝减半 ⇒ 整体偏黄；同时轻微拉开红蓝差升一点饱和暖感。
    return [clampByte(r + d), clampByte(g + d * 0.94), clampByte(b + d * 0.5)];
  }
  // 压暗偏冷：红绿足量下压、蓝少压 ⇒ 残蓝偏冷。
  return [clampByte(r + d), clampByte(g + d * 0.92), clampByte(b + d * 0.62)];
}

/** hue-shift 版 shade：输入 #rrggbb，输出 rgb(...)。替代纯明度加减。 */
export function rampHex(hex: string, d: number): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = rampRGB((n >> 16) & 255, (n >> 8) & 255, n & 255, d);
  return `rgb(${r},${g},${b})`;
}
