import { describe, expect, it } from 'vitest'
import {
  addDays,
  countDaysBetween,
  daysInMonth,
  format,
  fromEpochDay,
  isLeapYear,
  isWeekday,
  isWeekend,
  parseTradeDate,
  toEpochDay,
  weekdayOf,
  weekStart,
} from '@core/date'

describe('parseTradeDate', () => {
  it('只接受严格的 YYYY-MM-DD', () => {
    expect(parseTradeDate('2024-01-02')).toEqual({ y: 2024, m: 1, d: 2 })
    for (const bad of ['2024-1-2', '20240102', '2024-13-01', '2024-00-01', '2024-02-30', '', 'x']) {
      expect(parseTradeDate(bad)).toBeNull()
    }
  })

  it('闰年 2 月 29 日成立，平年不成立', () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2100)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2023, 2)).toBe(28)
    expect(daysInMonth(2024, 4)).toBe(30)
    expect(daysInMonth(2024, 12)).toBe(31)
    expect(parseTradeDate('2024-02-29')).not.toBeNull()
    expect(parseTradeDate('2023-02-29')).toBeNull()
  })
})

describe('epoch day 往返', () => {
  it('已知锚点', () => {
    expect(toEpochDay('1970-01-01')).toBe(0)
    expect(toEpochDay('2024-01-02')).toBe(19724)
    expect(fromEpochDay(0)).toBe('1970-01-01')
    expect(fromEpochDay(19724)).toBe('2024-01-02')
    expect(toEpochDay('bad')).toBeNull()
  })

  it('连续 4000 天往返一致（跨闰年与世纪）', () => {
    for (let epoch = 10_000; epoch < 14_000; epoch++) {
      const date = fromEpochDay(epoch)
      expect(toEpochDay(date)).toBe(epoch)
    }
  })

  it('format 补零', () => {
    expect(format(2024, 1, 2)).toBe('2024-01-02')
  })
})

describe('addDays / weekdayOf', () => {
  it('跨月、跨年、跨闰日', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01')
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01')
    expect(addDays('2024-01-01', -1)).toBe('2023-12-31')
    expect(addDays('bad', 1)).toBe('bad')
  })

  it('1970-01-01 是周四，2026-08-11 是周二', () => {
    expect(weekdayOf('1970-01-01')).toBe(4)
    expect(weekdayOf('2026-08-11')).toBe(2)
    expect(weekdayOf('2024-01-06')).toBe(6)
    expect(weekdayOf('2024-01-07')).toBe(7)
    expect(weekdayOf('bad')).toBeNull()
    expect(isWeekend('2024-01-06')).toBe(true)
    expect(isWeekend('2024-01-08')).toBe(false)
    expect(isWeekday('2024-01-08')).toBe(true)
  })

  it('weekStart 取 ISO 周一', () => {
    expect(weekStart('2024-01-03')).toBe('2024-01-01')
    expect(weekStart('2024-01-07')).toBe('2024-01-01')
    expect(weekStart('2024-01-08')).toBe('2024-01-08')
    expect(weekStart('bad')).toBe('bad')
  })
})

describe('countDaysBetween', () => {
  it('左开右开，只数满足判据的日子', () => {
    // 周五 → 下周一：中间只有周六周日，工作日缺口为 0
    expect(countDaysBetween('2024-01-05', '2024-01-08', isWeekday)).toBe(0)
    // 周一 → 周三：中间夹着周二
    expect(countDaysBetween('2024-01-08', '2024-01-10', isWeekday)).toBe(1)
    // 相邻两天没有间隔
    expect(countDaysBetween('2024-01-08', '2024-01-09', isWeekday)).toBe(0)
    // 逆序或非法一律 0，由调用方另行处理乱序
    expect(countDaysBetween('2024-01-10', '2024-01-08', isWeekday)).toBe(0)
    expect(countDaysBetween('bad', '2024-01-08', isWeekday)).toBe(0)
    // 注入节假日判据后，春节长假不算缺口
    const holidays = new Set(['2024-02-12', '2024-02-13', '2024-02-14', '2024-02-15', '2024-02-16'])
    const isTradingDay = (d: string): boolean => isWeekday(d) && !holidays.has(d)
    expect(countDaysBetween('2024-02-09', '2024-02-19', isTradingDay)).toBe(0)
    expect(countDaysBetween('2024-02-09', '2024-02-19', isWeekday)).toBe(5)
  })
})
