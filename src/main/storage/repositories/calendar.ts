/**
 * 交易日历表访问（docs/03 §3、§4.2）。
 *
 * `isOpen` 返回三态：true / false / null。null 表示「本地没有这一天的记录」，
 * 由上层退化到「周一至周五 + 内置节假日表」并在 UI 提示日历可能过期 ——
 * 把「不知道」当成「休市」会让软件在真交易日彻底静默，那是最坏的失败方式。
 */

import type { TradeDate } from '@core/types'
import type { Database } from '../db'

export interface CalendarRow {
  date: TradeDate
  isOpen: boolean
}

export class CalendarRepo {
  constructor(private readonly db: Database) {}

  upsertMany(rows: readonly CalendarRow[], source: string): number {
    if (rows.length === 0) return 0
    const stmt = this.db.prepare(
      `INSERT INTO trade_calendar (trade_date, is_open, source) VALUES (?, ?, ?)
       ON CONFLICT(trade_date) DO UPDATE SET is_open = excluded.is_open, source = excluded.source`
    )
    this.db.transaction(() => {
      for (const row of rows) stmt.run(row.date, row.isOpen ? 1 : 0, source)
    })
    return rows.length
  }

  isOpen(date: TradeDate): boolean | null {
    const row = this.db
      .prepare(`SELECT is_open FROM trade_calendar WHERE trade_date = ?`)
      .get<{ is_open: number }>(date)
    return row ? row.is_open === 1 : null
  }

  /** 区间内的开市日，升序 */
  openDays(from: TradeDate, to: TradeDate): TradeDate[] {
    return this.db
      .prepare(
        `SELECT trade_date FROM trade_calendar
         WHERE is_open = 1 AND trade_date >= ? AND trade_date <= ? ORDER BY trade_date ASC`
      )
      .all<{ trade_date: string }>(from, to)
      .map((r) => r.trade_date)
  }

  /** 本地日历覆盖到的最后一天，用于判断是否需要刷新 */
  coverageEnd(): TradeDate | null {
    return this.db.prepare(`SELECT MAX(trade_date) AS d FROM trade_calendar`).get<{ d: string | null }>()?.d ?? null
  }

  count(): number {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM trade_calendar`).get<{ n: number }>()?.n ?? 0
  }
}
