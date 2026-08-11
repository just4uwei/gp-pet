import { describe, expect, it } from 'vitest'
import { isQuiet, MARKET_CLOSE_HOUR, MARKET_CLOSE_MINUTE, quietUntil } from '@main/util/quiet'

/**
 * 免打扰用「截止时间戳」而非「布尔 + 定时器」表达（见 src/main/util/quiet.ts 的说明）。
 * 这些用例锁住的是那个决定：过期即自动失效，不依赖任何定时器按时触发。
 */
describe('quietUntil', () => {
  const now = Date.parse('2026-08-11T10:30:00+08:00')

  it('30 分钟 / 2 小时是相对当前时刻的偏移', () => {
    expect(quietUntil(now, 'min30') - now).toBe(30 * 60_000)
    expect(quietUntil(now, 'hour2') - now).toBe(120 * 60_000)
  })

  it('至收盘 = 当日本地 15:00', () => {
    const at = new Date(quietUntil(now, 'untilClose'))
    expect(at.getHours()).toBe(MARKET_CLOSE_HOUR)
    expect(at.getMinutes()).toBe(MARKET_CLOSE_MINUTE)
    expect(at.getSeconds()).toBe(0)
    expect(at.getMilliseconds()).toBe(0)
  })

  it('已过收盘则顺延到下一日收盘，而不是给出一个已经过期的时间', () => {
    const afterClose = new Date(now)
    afterClose.setHours(MARKET_CLOSE_HOUR + 3, 0, 0, 0)
    const until = quietUntil(afterClose.getTime(), 'untilClose')

    expect(until).toBeGreaterThan(afterClose.getTime())
    const at = new Date(until)
    expect(at.getHours()).toBe(MARKET_CLOSE_HOUR)
    expect(at.getDate()).toBe(afterClose.getDate() + 1)
  })

  it('恰好 15:00:00 视为已过，顺延到次日', () => {
    const exactly = new Date(now)
    exactly.setHours(MARKET_CLOSE_HOUR, MARKET_CLOSE_MINUTE, 0, 0)
    const until = quietUntil(exactly.getTime(), 'untilClose')
    expect(new Date(until).getDate()).toBe(exactly.getDate() + 1)
  })
})

describe('isQuiet', () => {
  const now = 1_000_000

  it('null 表示未静默', () => {
    expect(isQuiet(null, now)).toBe(false)
  })

  it('过期的截止时间自动失效 —— 不需要定时器来解除', () => {
    expect(isQuiet(now - 1, now)).toBe(false)
    expect(isQuiet(now, now)).toBe(false)
    expect(isQuiet(now + 1, now)).toBe(true)
  })
})
