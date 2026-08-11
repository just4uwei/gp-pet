/**
 * 北京时间换算。src/core 不读时钟也不认时区（ADR-0004），这一层负责把
 * 「epoch 毫秒」翻译成状态机需要的「当天日期 + 当天第几分钟」。
 *
 * 用固定 +08:00 而不是 Intl/TZ 数据库：中国自 1991 年起不再实行夏令时，
 * 偏移是常量。固定偏移的另一个好处是可复现 —— 同一个 epoch 在任何机器上
 * 算出同一个交易日，不受宿主时区与 ICU 版本影响。
 *
 * 反过来说，**不要**用 `new Date('2026-08-11 15:00')` 这类写法：它按宿主
 * 本地时区解析，在非 +08 机器上会得到另一个时刻。测试与调度一律走这里。
 */

import type { TradeDate } from '@core/types'
import { fromEpochDay, toEpochDay } from '@core/date'

export const SHANGHAI_OFFSET_MIN = 8 * 60

const MS_PER_MIN = 60_000
const MS_PER_DAY = 86_400_000

export interface ShanghaiTime {
  date: TradeDate
  /** 0..1439 */
  minuteOfDay: number
  /** 0..86_399_999，用于把 tick 对齐到整分钟 */
  msOfDay: number
}

export function shanghaiTime(epochMs: number): ShanghaiTime {
  const shifted = epochMs + SHANGHAI_OFFSET_MIN * MS_PER_MIN
  const epochDay = Math.floor(shifted / MS_PER_DAY)
  const msOfDay = shifted - epochDay * MS_PER_DAY
  return {
    date: fromEpochDay(epochDay),
    minuteOfDay: Math.floor(msOfDay / MS_PER_MIN),
    msOfDay,
  }
}

/** 反向：北京时间的某天某分钟对应的 epoch 毫秒。非法日期返回 null。 */
export function shanghaiEpochMs(date: TradeDate, minuteOfDay: number): number | null {
  const epochDay = toEpochDay(date)
  if (epochDay === null) return null
  return (epochDay * MS_PER_DAY + minuteOfDay * MS_PER_MIN) - SHANGHAI_OFFSET_MIN * MS_PER_MIN
}

/** 'HH:MM' 形式，仅用于日志与面板展示 */
export function formatShanghaiTime(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60)
  const m = minuteOfDay % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
