/**
 * 'YYYY-MM-DD' 上的整数日期运算。
 *
 * 为什么自己实现而不用 Date：ADR-0004 禁止 src/core 读时钟，ESLint 直接禁用了 `Date` 全局。
 * 而「两根 K 线之间隔了几个交易日」这类判断又必须做 —— 于是用 Howard Hinnant 的
 * civil_from_days / days_from_civil 整数算法，纯函数、无时区、无夏令时、可回测复现。
 */

import type { TradeDate } from './types'

/** 'YYYY-MM-DD' 的严格解析。非法格式返回 null 而不是抛错 —— 调用方多半想给出提示而非崩溃。 */
export function parseTradeDate(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null
  return { y, m: mo, d }
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

/** 1970-01-01 起的天数。非法日期返回 null。 */
export function toEpochDay(date: TradeDate): number | null {
  const parts = parseTradeDate(date)
  if (!parts) return null
  const { y, m, d } = parts
  // days_from_civil：把 3 月当作年首，闰日落在年尾，从而消掉所有分支
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

export function fromEpochDay(epochDay: number): TradeDate {
  const z = epochDay + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return format(m <= 2 ? y + 1 : y, m, d)
}

export function format(y: number, m: number, d: number): TradeDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 非法输入原样返回 —— 这里不是校验点，校验在 parseTradeDate。 */
export function addDays(date: TradeDate, days: number): TradeDate {
  const epoch = toEpochDay(date)
  return epoch === null ? date : fromEpochDay(epoch + days)
}

/** 1 = 周一 … 7 = 周日（ISO）。非法日期返回 null。 */
export function weekdayOf(date: TradeDate): number | null {
  const epoch = toEpochDay(date)
  if (epoch === null) return null
  // 1970-01-01 是周四（ISO 4）
  return ((((epoch + 3) % 7) + 7) % 7) + 1
}

export function isWeekend(date: TradeDate): boolean {
  const w = weekdayOf(date)
  return w === 6 || w === 7
}

/**
 * 默认的「可能开市日」判据：周一至周五。
 * 节假日表由 src/main 注入 —— core 不持有会过期的数据（docs/03 §3）。
 */
export function isWeekday(date: TradeDate): boolean {
  return !isWeekend(date)
}

/** ISO 周的周一。周线聚合按自然周分组（docs/04 §1.8），组键就是这个。 */
export function weekStart(date: TradeDate): TradeDate {
  const w = weekdayOf(date)
  const epoch = toEpochDay(date)
  if (w === null || epoch === null) return date
  return fromEpochDay(epoch - (w - 1))
}

/** a 与 b 之间（左开右开）满足 predicate 的天数。用于「跳过了几个交易日」。 */
export function countDaysBetween(
  a: TradeDate,
  b: TradeDate,
  predicate: (date: TradeDate) => boolean
): number {
  const from = toEpochDay(a)
  const to = toEpochDay(b)
  if (from === null || to === null || to <= from + 1) return 0
  let n = 0
  for (let epoch = from + 1; epoch < to; epoch++) {
    if (predicate(fromEpochDay(epoch))) n++
  }
  return n
}
