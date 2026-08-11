/**
 * 交易时段状态机（docs/03 §3）。
 *
 * 纯函数：输入「当天第几分钟（Asia/Shanghai）」+「今天是不是交易日」，输出时段。
 * 时区换算与日历查询留在 src/main —— core 不读时钟（ADR-0004）。
 */

import type { TradingSession } from './types'

/** 各时段边界，单位为「当天第几分钟」。左闭右开。 */
export const SESSION_BOUNDS = {
  /** 09:00 */ preOpen: 9 * 60,
  /** 09:15 */ auction: 9 * 60 + 15,
  /** 09:25 */ preTrade: 9 * 60 + 25,
  /** 09:30 */ open: 9 * 60 + 30,
  /** 11:30 */ amClose: 11 * 60 + 30,
  /** 13:00 */ pmOpen: 13 * 60,
  /** 14:57 */ closingAuction: 14 * 60 + 57,
  /** 15:00 */ close: 15 * 60,
  /** 15:10 */ settleEnd: 15 * 60 + 10,
} as const

/** 连续竞价总分钟数。量比的时间归一化以此为分母（docs/04 §1.7）。 */
export const CONTINUOUS_MINUTES = 240

export function sessionAt(minuteOfDay: number, isTradingDay: boolean): TradingSession {
  if (!isTradingDay) return 'CLOSED'
  const m = minuteOfDay
  const B = SESSION_BOUNDS
  if (m < B.preOpen) return 'CLOSED'
  if (m < B.auction) return 'PRE_OPEN'
  if (m < B.preTrade) return 'AUCTION'
  if (m < B.open) return 'PRE_TRADE'
  if (m < B.amClose) return 'CONTINUOUS_AM'
  if (m < B.pmOpen) return 'LUNCH_BREAK'
  if (m < B.closingAuction) return 'CONTINUOUS_PM'
  if (m < B.close) return 'CLOSING_AUCTION'
  if (m < B.settleEnd) return 'SETTLE'
  return 'CLOSED'
}

/**
 * 已完成的连续竞价分钟数，0..240（午休不计）。
 *
 * 注意与 params.risk.lateBuyCutoffMinutes 的口径不同：那个 320 是含午休的自然分钟
 * （09:30 → 14:50），是提醒层的时钟判断；本函数是指标层的成交量归一化分母。
 * 两者都对，但不可混用。
 */
export function continuousMinutesElapsed(minuteOfDay: number): number {
  const B = SESSION_BOUNDS
  if (minuteOfDay <= B.open) return 0
  if (minuteOfDay <= B.amClose) return minuteOfDay - B.open
  if (minuteOfDay <= B.pmOpen) return B.amClose - B.open
  if (minuteOfDay <= B.close) return B.amClose - B.open + (minuteOfDay - B.pmOpen)
  return CONTINUOUS_MINUTES
}

/** 交易时间占比 0..1，量比归一化直接用它（docs/04 §1.7）。 */
export function tradingProgress(minuteOfDay: number): number {
  return continuousMinutesElapsed(minuteOfDay) / CONTINUOUS_MINUTES
}

/**
 * 各时段的 tick 间隔（秒）。null 表示「用用户配置的轮询频率」。
 * 表来自 docs/03 §3，改这里等于改请求礼节（docs/03 §2.4），不要凭手感调。
 */
export const SESSION_TICK_SEC: Record<TradingSession, number | null> = {
  CLOSED: 300,
  PRE_OPEN: 60,
  AUCTION: 30,
  PRE_TRADE: 30,
  CONTINUOUS_AM: null,
  LUNCH_BREAK: 300,
  CONTINUOUS_PM: null,
  CLOSING_AUCTION: 10,
  SETTLE: 300,
}

export function tickIntervalMs(session: TradingSession, pollIntervalSec: number): number {
  const fixed = SESSION_TICK_SEC[session]
  return (fixed ?? pollIntervalSec) * 1000
}

/** 该时段是否需要拉行情。休市与午休完全不发请求（docs/03 §2.4）。 */
export function needsQuotes(session: TradingSession): boolean {
  switch (session) {
    case 'CLOSED':
    case 'LUNCH_BREAK':
      return false
    default:
      return true
  }
}

/**
 * 该时段是否允许产出信号。
 * 集合竞价与收盘竞价只更新价格展示 —— 竞价阶段的虚价会伪造出穿越（docs/03 §3）。
 */
export function producesSignals(session: TradingSession): boolean {
  switch (session) {
    case 'CONTINUOUS_AM':
    case 'CONTINUOUS_PM':
    case 'SETTLE':
      return true
    default:
      return false
  }
}
