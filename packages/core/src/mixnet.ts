// Mixnet 模式（Phase 2C）的纯采样原语 + 默认常量。Loopix/Nym 启发的**v1 基础**——不是完整 Loopix。
//
// 洋葱路由（telescoping + 定长 cell）已隐藏“谁和谁通信、走哪条路”，但有一个它单独关不上的口子：
// **全局被动观察者**可对一条电路做**输入→输出时序相关**（看到客户端在 t 发包、出口在 t+ε 出包 → 关联两端）。
// 闭这个口子的标准做法（Loopix）是两件事叠加：① **每跳混入随机延迟**（打散 input→output 的时间结构），
// ② **掩护流量(cover)**（让电路恒有流量，观察者分不清“真在发”还是“在发噪声”）。本模块只提供这两件事要用的
// 纯函数（采样）+ 调参常量；中继侧的延迟保持、客户端侧的 cover 调度分别在 relaynode.ts / client.ts 接线。
//
// 诚实边界（这是 v1 基础，不是 Loopix 全集）：
// - 延迟由**中继自采样**（每跳独立指数延迟），不是 Loopix 的“发送方经 Sphinx 头给每跳预指定延迟”——后者要 Sphinx 包格式，本链是定长流加密 cell，做不到 sender-chosen 逐跳延迟。
// - cover 仅有**客户端环路 cover**（client loop）。Loopix 还有中继环路 cover、投递到随机目标的 drop cover、SURB 应答等——均为后续工作。
// - 无正式匿名度量、无调优过的 Poisson 参数；这里给的是“能演示且时序上可分辨”的保守默认。
// （cover cell 也走前向计数器，同样受 onioncell 的 MAX_CELL_CTR 约束；本模块无需导入该常量。）

/** 每跳混入延迟的均值（毫秒），指数分布。Loopix 量级是数十~数百 ms；80ms 是教学/可用的折中。 */
export const DEFAULT_DELAY_MEAN_MS = 80;
/** 单 cell 单跳延迟的硬上限（毫秒）：指数分布长尾会偶发巨值，钳到此防“某 cell 被某跳扣几十秒”。 */
export const DEFAULT_MAX_DELAY_MS = 2000;
/** 客户端环路 cover 的默认速率（cells/秒）：Poisson 到达，均值 1/s（保守，足以让电路恒有流量而不洪泛）。 */
export const DEFAULT_COVER_RATE = 1;

/**
 * 采样一个指数分布延迟（毫秒），均值 = mean，钳到 [0, max]。
 * 反演法：X = -mean·ln(1-U)，U∈[0,1)。这是“无记忆”延迟——独立于 cell 何时到，打散 input→output 时间结构。
 * 注：Math.random 在此是 node 运行时代码（非工作流脚本），用于流量整形而非密钥/共识，足够。
 * 入参非正 mean → 退化为 0（= mixnet 关时的同步转发，便于上层用 mean=0 表达“不延迟”）。
 */
export function sampleExpMs(mean: number, max: number = DEFAULT_MAX_DELAY_MS): number {
  if (!(mean > 0)) return 0;
  const u = Math.random(); // [0,1)
  const x = -mean * Math.log(1 - u); // [0, ∞)
  return Math.min(x, max > 0 ? max : DEFAULT_MAX_DELAY_MS);
}

/**
 * 下一个 cover cell 的 Poisson 到达间隔（毫秒），平均速率 rate cells/秒。
 * 指数到达间隔：-（1000/rate）·ln(1-U)。无上限钳制——cover 间隔变长只是少发掩护，不占内存（不像被扣的真 cell）。
 * rate 非正 → 返回 +∞（= 不再调度 cover，安全退化）。
 */
export function nextCoverDelayMs(rate: number = DEFAULT_COVER_RATE): number {
  if (!(rate > 0)) return Number.POSITIVE_INFINITY;
  const u = Math.random();
  return (-1000 / rate) * Math.log(1 - u);
}
