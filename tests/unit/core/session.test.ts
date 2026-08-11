import { describe, expect, it } from 'vitest'
import {
  CONTINUOUS_MINUTES,
  continuousMinutesElapsed,
  needsQuotes,
  producesSignals,
  sessionAt,
  tickIntervalMs,
  tradingProgress,
} from '@core/session'

const at = (h: number, m: number): number => h * 60 + m

describe('sessionAt', () => {
  it('非交易日全天 CLOSED', () => {
    for (const [h, m] of [
      [3, 0],
      [9, 30],
      [14, 0],
      [15, 5],
    ] as const) {
      expect(sessionAt(at(h, m), false)).toBe('CLOSED')
    }
  })

  // 表来自 docs/03 §3，边界一律左闭右开
  it.each([
    [8, 59, 'CLOSED'],
    [9, 0, 'PRE_OPEN'],
    [9, 14, 'PRE_OPEN'],
    [9, 15, 'AUCTION'],
    [9, 24, 'AUCTION'],
    [9, 25, 'PRE_TRADE'],
    [9, 29, 'PRE_TRADE'],
    [9, 30, 'CONTINUOUS_AM'],
    [11, 29, 'CONTINUOUS_AM'],
    [11, 30, 'LUNCH_BREAK'],
    [12, 59, 'LUNCH_BREAK'],
    [13, 0, 'CONTINUOUS_PM'],
    [14, 56, 'CONTINUOUS_PM'],
    [14, 57, 'CLOSING_AUCTION'],
    [14, 59, 'CLOSING_AUCTION'],
    [15, 0, 'SETTLE'],
    [15, 9, 'SETTLE'],
    [15, 10, 'CLOSED'],
    [23, 59, 'CLOSED'],
  ])('%s:%s → %s', (h, m, expected) => {
    expect(sessionAt(at(h, m), true)).toBe(expected)
  })
})

describe('continuousMinutesElapsed', () => {
  it('午休不计入，上限 240', () => {
    expect(continuousMinutesElapsed(at(9, 0))).toBe(0)
    expect(continuousMinutesElapsed(at(9, 30))).toBe(0)
    expect(continuousMinutesElapsed(at(10, 0))).toBe(30)
    expect(continuousMinutesElapsed(at(11, 30))).toBe(120)
    expect(continuousMinutesElapsed(at(12, 30))).toBe(120)
    expect(continuousMinutesElapsed(at(13, 0))).toBe(120)
    expect(continuousMinutesElapsed(at(14, 0))).toBe(180)
    expect(continuousMinutesElapsed(at(15, 0))).toBe(CONTINUOUS_MINUTES)
    expect(continuousMinutesElapsed(at(21, 0))).toBe(CONTINUOUS_MINUTES)
  })

  it('10:00 的进度是半日之半，而非「半天」—— 量比归一化就靠这个', () => {
    expect(tradingProgress(at(10, 0))).toBeCloseTo(30 / 240, 10)
    expect(tradingProgress(at(11, 30))).toBeCloseTo(0.5, 10)
    expect(tradingProgress(at(15, 0))).toBe(1)
  })
})

describe('tick 降频与时段能力', () => {
  it('连续竞价用用户配置的频率，其余时段用固定表', () => {
    expect(tickIntervalMs('CONTINUOUS_AM', 30)).toBe(30_000)
    expect(tickIntervalMs('CONTINUOUS_PM', 120)).toBe(120_000)
    expect(tickIntervalMs('CLOSED', 30)).toBe(300_000)
    expect(tickIntervalMs('LUNCH_BREAK', 30)).toBe(300_000)
    expect(tickIntervalMs('CLOSING_AUCTION', 30)).toBe(10_000)
    expect(tickIntervalMs('PRE_OPEN', 30)).toBe(60_000)
    expect(tickIntervalMs('AUCTION', 30)).toBe(30_000)
    expect(tickIntervalMs('PRE_TRADE', 30)).toBe(30_000)
    expect(tickIntervalMs('SETTLE', 30)).toBe(300_000)
  })

  it('休市与午休不发请求（docs/03 §2.4）', () => {
    expect(needsQuotes('CLOSED')).toBe(false)
    expect(needsQuotes('LUNCH_BREAK')).toBe(false)
    expect(needsQuotes('PRE_OPEN')).toBe(true)
    expect(needsQuotes('CONTINUOUS_AM')).toBe(true)
  })

  it('竞价时段只更新价格、不产出信号（虚价会伪造穿越）', () => {
    expect(producesSignals('AUCTION')).toBe(false)
    expect(producesSignals('PRE_TRADE')).toBe(false)
    expect(producesSignals('CLOSING_AUCTION')).toBe(false)
    expect(producesSignals('PRE_OPEN')).toBe(false)
    expect(producesSignals('CLOSED')).toBe(false)
    expect(producesSignals('LUNCH_BREAK')).toBe(false)
    expect(producesSignals('CONTINUOUS_AM')).toBe(true)
    expect(producesSignals('CONTINUOUS_PM')).toBe(true)
    expect(producesSignals('SETTLE')).toBe(true)
  })
})
