/**
 * 行业分类的逐日留痕（014_industry_history.sql）。
 *
 * 「为什么不能用 `watchlist.industry` 那一列、为什么一行一次变化而不是一行一天、
 * 为什么不进裁剪」全在 SQL 的头注释里。这里只补两条**读写口径**：
 *
 * 1. **`record()` 自己判重，调用方不用先查。** 与最近一条相同就什么都不写并返回
 *    `'UNCHANGED'` —— 把判重放在调用方会让「每次刷新都写一行」这种退化很容易发生，
 *    而那正是这张表要防的（79 只 × 一年 ≈ 2 万行同名重复）。
 * 2. **`at()` 取的是 `observed_date <= date` 里最新的那一条，取不到就是 `null`。**
 *    `null` 的含义是「**那天我们还没开始记**」，**不是**「那天没有行业」——
 *    调用方不许把它当成一个可用的分类值，更不许拿首行往前外推（未来函数）。
 */

import type { SecCode } from '@core/types'
import type { Database } from '../db'

/** 首条观测 vs 与上一条不同。写进 `note` 列，方便事后一眼看出哪些是真的变了 */
export type IndustryNote = 'FIRST' | 'CHANGE'

export interface IndustryRow {
  code: SecCode
  /** 北京时区的自然日 YYYY-MM-DD。是**观测日**不是变更生效日 */
  observedDate: string
  industry: string
  note: IndustryNote
}

interface Raw {
  code: string
  observed_date: string
  industry: string
  note: string
}

const toRow = (raw: Raw): IndustryRow => ({
  code: raw.code as SecCode,
  observedDate: raw.observed_date,
  industry: raw.industry,
  note: raw.note === 'FIRST' ? 'FIRST' : 'CHANGE',
})

export type RecordOutcome = 'FIRST' | 'CHANGE' | 'UNCHANGED'

export class IndustryHistoryRepo {
  constructor(private readonly db: Database) {}

  /**
   * 记一次观测。**与最近一条相同就不写。**
   *
   * 同一天重复调用是幂等的（主键 `(code, observed_date)` + `INSERT OR REPLACE`）——
   * 休市维护一天可能跑好几轮，每轮都写一行会把这张表变成一行一天。
   */
  record(code: SecCode, observedDate: string, industry: string): RecordOutcome {
    const trimmed = industry.trim()
    // 空行业不是「行业变成了空」，是「这次没取到」⇒ 一个字都不写
    if (trimmed === '') return 'UNCHANGED'

    const last = this.latest(code)
    if (last !== null && last.industry === trimmed) return 'UNCHANGED'

    const note: IndustryNote = last === null ? 'FIRST' : 'CHANGE'
    this.db
      .prepare(
        `INSERT INTO industry_history (code, observed_date, industry, note)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(code, observed_date) DO UPDATE SET
           industry = excluded.industry,
           note = excluded.note`
      )
      .run(code, observedDate, trimmed, note)
    return note
  }

  /** 最近一条观测；从没记过时 `null` */
  latest(code: SecCode): IndustryRow | null {
    const raw = this.db
      .prepare(
        `SELECT code, observed_date, industry, note FROM industry_history
          WHERE code = ? ORDER BY observed_date DESC LIMIT 1`
      )
      .get(code) as Raw | undefined
    return raw ? toRow(raw) : null
  }

  /**
   * `date` 那天这只票属于哪个行业。
   *
   * ⚠ `null` = **那天我们还没开始记**，不是「没有行业」。不许拿首行往前外推。
   */
  at(code: SecCode, date: string): IndustryRow | null {
    const raw = this.db
      .prepare(
        `SELECT code, observed_date, industry, note FROM industry_history
          WHERE code = ? AND observed_date <= ? ORDER BY observed_date DESC LIMIT 1`
      )
      .get(code, date) as Raw | undefined
    return raw ? toRow(raw) : null
  }

  /** 攒了多少天、多少只、最早一条是哪天 —— 给看板答「这条累积在不在跑」 */
  coverage(): { codes: number; rows: number; firstDate: string | null; lastDate: string | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT code) codes, COUNT(*) rows,
                MIN(observed_date) first_date, MAX(observed_date) last_date
           FROM industry_history`
      )
      .get() as { codes: number; rows: number; first_date: string | null; last_date: string | null }
    return {
      codes: row.codes,
      rows: row.rows,
      firstDate: row.first_date,
      lastDate: row.last_date,
    }
  }

  /** 某只票的全部变更历史，按时间正序 */
  history(code: SecCode): IndustryRow[] {
    const raws = this.db
      .prepare(
        `SELECT code, observed_date, industry, note FROM industry_history
          WHERE code = ? ORDER BY observed_date ASC`
      )
      .all(code) as Raw[]
    return raws.map(toRow)
  }
}
