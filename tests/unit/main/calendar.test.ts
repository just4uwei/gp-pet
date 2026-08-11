/**
 * 交易日历与北京时间换算（docs/03 §3）。
 *
 * 这里的核心断言只有一条：**「不知道」不能当成「休市」**。
 * 其余用例都是围着这条打转 —— 判错成休市会让软件在真交易日彻底静默。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TradeDate } from '@core/types'
import { isWeekend } from '@core/date'
import {
  type CalendarStore,
  type HolidayTable,
  createTradingCalendar,
  parseHolidayTable,
} from '@main/scheduler/calendar'
import { formatShanghaiTime, shanghaiEpochMs, shanghaiTime } from '@main/scheduler/clock'
import { loadHolidayTable } from '@main/scheduler/holidays'

function store(rows: Record<string, boolean> = {}): CalendarStore & { written: [string, boolean, string][] } {
  const written: [string, boolean, string][] = []
  return {
    written,
    isOpen: (date) => rows[date] ?? null,
    upsertMany: (items, source) => {
      for (const item of items) {
        rows[item.date] = item.isOpen
        written.push([item.date, item.isOpen, source])
      }
      return items.length
    },
    coverageEnd: () => {
      const keys = Object.keys(rows).sort()
      return (keys.at(-1) as TradeDate | undefined) ?? null
    },
  }
}

const TABLE: HolidayTable = {
  updatedAt: '2026-08-11',
  verifiedYears: [2025],
  holidays: {
    '2025': ['2025-10-01', '2025-10-02'],
    '2026': ['2026-10-01'],
  },
}

describe('北京时间换算', () => {
  it('固定 +08:00，与宿主时区无关', () => {
    // 2026-08-11 15:34:59 北京 = 07:34:59Z
    const at = Date.UTC(2026, 7, 11, 7, 34, 59)
    expect(shanghaiTime(at)).toMatchObject({ date: '2026-08-11', minuteOfDay: 15 * 60 + 34 })
  })

  it('跨日：北京 00:30 属于当天，UTC 还在前一天', () => {
    const at = Date.UTC(2026, 7, 10, 16, 30)
    expect(shanghaiTime(at).date).toBe('2026-08-11')
    expect(shanghaiTime(at).minuteOfDay).toBe(30)
  })

  it('UTC 当天 15:00 在北京已是次日 23:00', () => {
    expect(shanghaiTime(Date.UTC(2026, 7, 10, 15, 0)).date).toBe('2026-08-10')
    expect(shanghaiTime(Date.UTC(2026, 7, 10, 16, 0)).date).toBe('2026-08-11')
  })

  it('与 shanghaiEpochMs 互逆', () => {
    const ms = shanghaiEpochMs('2026-08-11', 9 * 60 + 30)
    expect(ms).not.toBeNull()
    expect(shanghaiTime(ms ?? 0)).toMatchObject({ date: '2026-08-11', minuteOfDay: 570 })
    // 09:30 北京 = 01:30Z
    expect(new Date(ms ?? 0).toISOString()).toBe('2026-08-11T01:30:00.000Z')
  })

  it('非法日期返回 null 而不是当成 1970', () => {
    expect(shanghaiEpochMs('2026-13-01', 0)).toBeNull()
  })

  it('HH:MM 展示', () => {
    expect(formatShanghaiTime(9 * 60 + 5)).toBe('09:05')
    expect(formatShanghaiTime(14 * 60 + 57)).toBe('14:57')
  })
})

describe('TradingCalendar · 判据优先级', () => {
  it('本地表命中即为事实，不再看内置表', () => {
    // 2026-10-01 在内置表里是休市，但本地表说开市（比如指数当天真有 K 线）
    const calendar = createTradingCalendar({
      store: store({ '2026-10-01': true }),
      holidays: TABLE,
    })
    expect(calendar.resolve('2026-10-01')).toEqual({
      date: '2026-10-01',
      isOpen: true,
      source: 'db',
      uncertain: false,
    })
  })

  it('周末休市是历法事实，不带 uncertain', () => {
    const calendar = createTradingCalendar({ store: store(), holidays: TABLE })
    // 2026-08-15 是周六
    expect(calendar.resolve('2026-08-15')).toMatchObject({
      isOpen: false,
      source: 'weekday',
      uncertain: false,
    })
  })

  it('已核对年份的内置表：休市结论是确定的', () => {
    const calendar = createTradingCalendar({ store: store(), holidays: TABLE })
    expect(calendar.resolve('2025-10-01')).toMatchObject({
      isOpen: false,
      source: 'builtin',
      uncertain: false,
    })
  })

  it('未核对年份的内置表：结论照用，但标 uncertain 等探测纠正', () => {
    const calendar = createTradingCalendar({ store: store(), holidays: TABLE })
    expect(calendar.resolve('2026-10-01')).toMatchObject({
      isOpen: false,
      source: 'builtin',
      uncertain: true,
    })
  })

  it('内置表覆盖到的年份里、不在休市名单的工作日 → 开市', () => {
    const calendar = createTradingCalendar({ store: store(), holidays: TABLE })
    expect(calendar.resolve('2026-08-11')).toMatchObject({ isOpen: true, source: 'builtin' })
  })

  it('表里没有这一年 → 退到「周一至周五」，且必须是开市 + uncertain', () => {
    const calendar = createTradingCalendar({ store: store(), holidays: TABLE })
    // 2030 年不在表里；1 月 1 日实际必然休市，但我们不知道，只能按开市处理
    expect(calendar.resolve('2030-01-01')).toEqual({
      date: '2030-01-01',
      isOpen: true,
      source: 'weekday',
      uncertain: true,
    })
  })

  it('完全没有内置表也能工作', () => {
    const calendar = createTradingCalendar({ store: store() })
    expect(calendar.resolve('2026-08-11')).toMatchObject({ isOpen: true, source: 'weekday' })
    expect(calendar.resolve('2026-08-15')).toMatchObject({ isOpen: false, source: 'weekday' })
    expect(calendar.builtinUpdatedAt()).toBeNull()
  })

  it('非法日期不猜休市', () => {
    const calendar = createTradingCalendar({ store: store(), holidays: TABLE })
    expect(calendar.resolve('2026-02-30')).toMatchObject({ isOpen: true, uncertain: true })
  })

  it('markObserved 把观测结果写成事实', () => {
    const s = store()
    const calendar = createTradingCalendar({ store: s, holidays: TABLE })
    expect(calendar.resolve('2026-10-01').isOpen).toBe(false)

    calendar.markObserved('2026-10-01', true)
    expect(s.written).toEqual([['2026-10-01', true, 'observed']])
    expect(calendar.resolve('2026-10-01')).toMatchObject({ isOpen: true, source: 'db' })
  })
})

describe('TradingCalendar · 刷新', () => {
  it('从数据源刷新并落库，记录用的是哪个源', async () => {
    const s = store()
    const registry = {
      fetchCalendar: vi.fn().mockResolvedValue({
        value: [
          { date: '2026-01-01', isOpen: false },
          { date: '2026-01-02', isOpen: true },
        ],
        provider: 'tencent',
        degraded: false,
        attempts: [],
      }),
    }
    const calendar = createTradingCalendar({
      store: s,
      registry: registry as never,
    })

    const result = await calendar.refresh([2026])
    expect(result).toEqual([{ year: 2026, ok: true, written: 2, provider: 'tencent' }])
    expect(s.written).toEqual([
      ['2026-01-01', false, 'provider:tencent'],
      ['2026-01-02', true, 'provider:tencent'],
    ])
    expect(calendar.resolve('2026-01-01')).toMatchObject({ isOpen: false, source: 'db' })
  })

  it('刷新失败不抛出，退回内置表继续跑，但留下原因', async () => {
    const registry = { fetchCalendar: vi.fn().mockRejectedValue(new Error('全都挂了')) }
    const calendar = createTradingCalendar({
      store: store(),
      holidays: TABLE,
      registry: registry as never,
    })

    const result = await calendar.refresh([2026])
    expect(result[0]).toMatchObject({ year: 2026, ok: false, written: 0, error: '全都挂了' })
    expect(calendar.resolve('2026-10-01').source).toBe('builtin')
  })

  it('没有数据源时明确说没有，而不是假装刷新成功', async () => {
    const calendar = createTradingCalendar({ store: store() })
    expect((await calendar.refresh([2026]))[0]).toMatchObject({ ok: false, error: '没有配置数据源' })
  })
})

describe('holidays.json', () => {
  const raw: unknown = JSON.parse(
    readFileSync(join(process.cwd(), 'resources', 'data', 'holidays.json'), 'utf-8')
  )

  it('随包分发的表结构合法', () => {
    expect(parseHolidayTable(raw)).not.toBeNull()
  })

  it('不列周末 —— 周末由历法兜底，列进来是冗余且容易写错', () => {
    const table = parseHolidayTable(raw)
    const weekendEntries = Object.values(table?.holidays ?? {})
      .flat()
      .filter((date) => isWeekend(date))
    expect(weekendEntries).toEqual([])
  })

  it('每个年份的日期都属于该年份且升序', () => {
    const table = parseHolidayTable(raw)
    for (const [year, dates] of Object.entries(table?.holidays ?? {})) {
      expect(dates.every((d) => d.startsWith(year))).toBe(true)
      expect(dates).toEqual([...dates].sort())
    }
  })

  it('verifiedYears 为空时，当前年份的结论必须是 uncertain —— 未核对就不能装作确定', () => {
    const table = parseHolidayTable(raw)
    const calendar = createTradingCalendar({ store: store(), holidays: table ?? undefined })
    const anyHoliday = table?.holidays['2026']?.[0]
    expect(anyHoliday).toBeDefined()
    expect(calendar.resolve(anyHoliday as TradeDate)).toMatchObject({
      isOpen: false,
      uncertain: !table?.verifiedYears.includes(2026),
    })
  })

  it('坏表当作没有表 —— 宁可退到「周一至周五」，也不按半张表判休市', () => {
    expect(parseHolidayTable(null)).toBeNull()
    expect(parseHolidayTable({ holidays: {} })).toBeNull()
    expect(parseHolidayTable({ updatedAt: '不是日期', holidays: {} })).toBeNull()
    // 年份键与日期不一致
    expect(parseHolidayTable({ updatedAt: '2026-01-01', holidays: { '2026': ['2025-10-01'] } })).toBeNull()
    // 日期非法
    expect(parseHolidayTable({ updatedAt: '2026-01-01', holidays: { '2026': ['2026-02-30'] } })).toBeNull()
  })

  it('缺省 verifiedYears 视为「一年都没核对」', () => {
    const table = parseHolidayTable({ updatedAt: '2026-01-01', holidays: { '2026': ['2026-10-01'] } })
    expect(table?.verifiedYears).toEqual([])
  })

  it('文件读不到时返回原因而不是抛错', () => {
    const result = loadHolidayTable(join(process.cwd(), '不存在的目录'))
    expect(result.table).toBeNull()
    expect(result.error).toContain('holidays.json')
  })

  it('从 resources 根目录加载成功', () => {
    const result = loadHolidayTable(join(process.cwd(), 'resources'))
    expect(result.error).toBeNull()
    expect(result.table?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
