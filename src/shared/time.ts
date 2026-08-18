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

/*
  ## 展示用的时刻格式化（2026-08-18）

  面板上原先有五份手写的格式化，其中三处（提醒日志、信号列表、观察点）用的是
  `getHours()` —— **宿主本地时区**。在 UTC+8 上恰好对，在本机（UTC+7）上
  北京 15:00 会显示成 14:00，而页头那个「北京时间 HH:mm:ss」时钟就在同一屏上，
  两个数对不上而用户没法判断哪个对。日报的「栏目数据时刻」把这件事顶到了台面上：
  同一条提醒在日报里写 09:03、在提醒日志里写 08:03。

  所以时刻一律走这两个函数：**先加偏移再用 `getUTC*` 读**（与 `IntradayChart`
  的 x 轴、`App.tsx` 的时钟同一口径）。`getHours()` / `toLocaleTimeString()`
  在这个项目里一律是错的。
*/

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** `HH:mm`（北京时间）。与宿主时区无关 */
export function shanghaiHhmm(epochMs: number): string {
  const at = new Date(epochMs + SHANGHAI_OFFSET_MS)
  return `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}`
}

/** `HH:mm:ss`（北京时间）。秒是必要的：盘中两轮之间只差 30 秒 */
export function shanghaiHhmmss(epochMs: number): string {
  return `${shanghaiHhmm(epochMs)}:${pad2(new Date(epochMs + SHANGHAI_OFFSET_MS).getUTCSeconds())}`
}

/** `YYYY-MM-DD`（北京日）。用来判断一个时刻落在不落在某个交易日里 */
export function shanghaiDate(epochMs: number): string {
  const at = new Date(epochMs + SHANGHAI_OFFSET_MS)
  return `${at.getUTCFullYear()}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`
}

/** `MM-DD HH:mm`（北京时间）。跨天的时刻用它 —— 只给 `HH:mm` 会让昨晚的东西看起来像刚才的 */
export function shanghaiMdHhmm(epochMs: number): string {
  const at = new Date(epochMs + SHANGHAI_OFFSET_MS)
  return `${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())} ${shanghaiHhmm(epochMs)}`
}
