/**
 * 交易日历（docs/03 §3）。三级判据，优先级从高到低：
 *
 *   1. `db`      —— 本地 trade_calendar 表。由基准指数日线反推（provider.fetchCalendar），
 *                   或由「实际观测到行情」写入。对过去的日期这是事实。
 *   2. `builtin` —— resources/data/holidays.json 内置节假日表。**未经核对**，需每年更新。
 *   3. `weekday` —— 周一至周五。最后兜底。
 *
 * 一条硬规则：**「不知道」绝不当成「休市」**（CalendarRepo 的三态注释同理）。
 * 判错成休市会让软件在真交易日彻底静默，那是最坏的失败方式；判错成开市只是
 * 多打几次接口、面板显示陈旧价 —— 代价不对等，所以默认偏向「开市」。
 *
 * 因此非 db 来源的「休市」结论一律带 `uncertain: true`，由 Scheduler 在交易时段内
 * 定期探一次（见 index.ts 的 probe），观测到真行情就用 markObserved 纠正本地日历。
 */

import type { TradeDate } from '@core/types'
import { isWeekend, parseTradeDate } from '@core/date'
import type { CalendarRow } from '../storage/repositories/calendar'
import type { ProviderId } from '../providers/types'
import type { ProviderRegistry } from '../providers/registry'

export type CalendarSource = 'db' | 'builtin' | 'weekday'

export interface DayVerdict {
  date: TradeDate
  isOpen: boolean
  source: CalendarSource
  /**
   * 依据不够硬。UI 应提示「日历可能过期」（docs/03 §3），
   * 且不要据此宣布「今天休市，不用看了」。
   */
  uncertain: boolean
}

/** resources/data/holidays.json 的形状 */
export interface HolidayTable {
  /** 表本身的更新日期，用于在面板上说明「内置日历截至何时」 */
  updatedAt: TradeDate
  /**
   * 已按交易所公告核对过的年份。没进这个列表的年份即使有数据也算 uncertain
   * —— 内置表是转述，不是公告（同 ADR-0003 的立场）。
   */
  verifiedYears: number[]
  /** 年份 → 该年的非周末休市日。周末不必列，兜底判据已经排除了 */
  holidays: Record<string, TradeDate[]>
}

export interface CalendarStore {
  isOpen(date: TradeDate): boolean | null
  upsertMany(rows: readonly CalendarRow[], source: string): number
  coverageEnd(): TradeDate | null
}

export interface TradingCalendarOptions {
  store: CalendarStore
  /** 缺省表示没有内置表可用，直接退到 weekday */
  holidays?: HolidayTable | undefined
  registry?: ProviderRegistry | undefined
}

export interface RefreshResult {
  year: number
  ok: boolean
  written: number
  provider?: ProviderId
  error?: string
}

export interface TradingCalendar {
  resolve(date: TradeDate): DayVerdict
  /** 内置表的更新日期，null 表示没装内置表 */
  builtinUpdatedAt(): TradeDate | null
  coverageEnd(): TradeDate | null
  /** 从数据源刷新指定年份（每周一次即可，docs/03 §1） */
  refresh(years: readonly number[]): Promise<RefreshResult[]>
  /** 实际观测到（或确认没有）行情后回写，把 uncertain 的判断变成事实 */
  markObserved(date: TradeDate, isOpen: boolean): void
}

export function createTradingCalendar(options: TradingCalendarOptions): TradingCalendar {
  const { store, holidays, registry } = options

  const holidaySet = new Map<string, Set<string>>()
  if (holidays) {
    for (const [year, dates] of Object.entries(holidays.holidays)) {
      holidaySet.set(year, new Set(dates))
    }
  }

  function verified(year: number): boolean {
    return holidays?.verifiedYears.includes(year) ?? false
  }

  return {
    resolve(date) {
      // 非法日期不猜：当成「不知道，按开市处理」，让上层的代码校验去报错
      const parts = parseTradeDate(date)
      if (!parts) return { date, isOpen: true, source: 'weekday', uncertain: true }

      const fromDb = store.isOpen(date)
      if (fromDb !== null) return { date, isOpen: fromDb, source: 'db', uncertain: false }

      if (isWeekend(date)) {
        // 周末休市是历法事实，不需要任何数据源确认（调休上班日股市也不开市）
        return { date, isOpen: false, source: 'weekday', uncertain: false }
      }

      const year = String(parts.y)
      const table = holidaySet.get(year)
      if (table?.has(date)) {
        return { date, isOpen: false, source: 'builtin', uncertain: !verified(parts.y) }
      }
      if (table) {
        // 表里有这一年、且这天不在休市名单 → 开市。判错的代价只是多打几次接口
        return { date, isOpen: true, source: 'builtin', uncertain: !verified(parts.y) }
      }
      return { date, isOpen: true, source: 'weekday', uncertain: true }
    },

    builtinUpdatedAt() {
      return holidays?.updatedAt ?? null
    },

    coverageEnd() {
      return store.coverageEnd()
    },

    async refresh(years) {
      const out: RefreshResult[] = []
      for (const year of years) {
        if (!registry) {
          out.push({ year, ok: false, written: 0, error: '没有配置数据源' })
          continue
        }
        try {
          const result = await registry.fetchCalendar(year)
          const written = store.upsertMany(result.value, `provider:${result.provider}`)
          out.push({ year, ok: true, written, provider: result.provider })
        } catch (error) {
          // 刷新失败不是致命错误：退到内置表继续跑，但必须留痕
          out.push({
            year,
            ok: false,
            written: 0,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return out
    },

    markObserved(date, isOpen) {
      store.upsertMany([{ date, isOpen }], 'observed')
    },
  }
}

/** 内置表的最小校验。坏表当作没有表 —— 宁可退到 weekday，也不要按半张表判休市 */
export function parseHolidayTable(raw: unknown): HolidayTable | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const updatedAt = obj['updatedAt']
  if (typeof updatedAt !== 'string' || parseTradeDate(updatedAt) === null) return null

  const verifiedYears = Array.isArray(obj['verifiedYears'])
    ? obj['verifiedYears'].filter((y): y is number => typeof y === 'number' && Number.isInteger(y))
    : []

  const rawHolidays = obj['holidays']
  if (rawHolidays === null || typeof rawHolidays !== 'object' || Array.isArray(rawHolidays)) return null

  const holidays: Record<string, TradeDate[]> = {}
  for (const [year, dates] of Object.entries(rawHolidays as Record<string, unknown>)) {
    if (!/^\d{4}$/.test(year) || !Array.isArray(dates)) return null
    const clean = dates.filter(
      (d): d is TradeDate => typeof d === 'string' && parseTradeDate(d) !== null && d.startsWith(year)
    )
    if (clean.length !== dates.length) return null
    holidays[year] = clean
  }

  return { updatedAt, verifiedYears, holidays }
}
