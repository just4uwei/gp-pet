/**
 * 北京时间的日界（2026-08-15）。**主进程与渲染层共用这一份。**
 *
 * ## 为什么不能用本机本地日
 *
 * 改动之前有三处各写了一遍「今天 00:00」，用的都是宿主本地时区：
 * `AlertDispatcher.localStartOfDay`（提醒配额的跨日重置）、
 * 悬浮条与面板的「今天」筛选（`new Date().setHours(0,0,0,0)`）。
 *
 * 在 UTC+8 上它们恰好是对的，在 UTC+7 上日界落到北京时间 01:00 —— 无害，
 * 因为那个钟点不会有提醒。但**在西半球它会落进交易时段中间**：
 * UTC−5 的本机 00:00 是北京 13:00，于是「每日 L2+L3 ≤ 4」「当日 L3 一次」
 * 会在午盘开盘那一刻重置，面板的「今天」列表也会当场清空一半。
 * 这与 `IntradayChart` 那条「用 `getHours()` 会让 09:30 的竖线跑到曲线中间」
 * 是同一形状的坑，只是更隐蔽 —— 配额多给了几条，没有人看得出来。
 *
 * ## 为什么是纯算术而不是 Intl
 *
 * 与 `src/main/scheduler/clock.ts` 同一条理由：中国自 1991 年起不再实行夏令时，
 * 偏移是常量；固定偏移可复现，不受宿主时区与 ICU 版本影响。
 * 这里刻意不 import `@core/date` —— 渲染层只依赖 `src/shared`，
 * 而这几行算术不值得为它拉一条新的依赖边。
 */

/** 北京时间相对 UTC 的固定偏移。`IntradayChart` 原先那份 `CST_OFFSET_MS` 已并入这里 */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

const MS_PER_DAY = 86_400_000

/**
 * `epochMs` 所在**北京日**的 00:00:00.000，返回 epoch ms。
 *
 * 与宿主时区无关：同一个 epoch 在任何机器上得到同一个日界。
 */
export function shanghaiDayStartMs(epochMs: number): number {
  const shifted = epochMs + SHANGHAI_OFFSET_MS
  return Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY - SHANGHAI_OFFSET_MS
}
