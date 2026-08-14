/**
 * 当日分时留痕表访问（004_quote_tick.sql）。
 *
 * 只服务面板上那张走势图：引擎、回测、指标一个字都不读它。
 * 那张表的头注释写清了「它不是什么」，改这里之前先看一眼。
 *
 * 两条：
 *   1. **写入是 INSERT OR IGNORE**，靠主键 `(code, ts)` 幂等 —— 盘后会跑好几轮 tick，
 *      快照时刻不变时重复写不该攒出新点。
 *   2. **`series()` 返回的序列可能有洞**（午休、应用当时没开着）。
 *      调用方必须把洞画出来，不许当成连续序列直连 —— 见渲染层 IntradayChart。
 */

import type { SecCode } from '@core/types'
import type { Database } from '../db'

export interface QuoteTickInput {
  code: SecCode
  ts: number
  last: number
  /** 拿不到时传 null，**不要传 0** */
  preClose: number | null
}

export interface QuoteTickPoint {
  ts: number
  last: number
}

export class QuoteTickRepo {
  constructor(private readonly db: Database) {}

  /** 返回本次真正写进去的行数（被主键挡掉的不计） */
  record(rows: readonly QuoteTickInput[]): number {
    if (rows.length === 0) return 0
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO quote_tick (code, ts, last, pre_close) VALUES (?, ?, ?, ?)`
    )
    let written = 0
    this.db.transaction(() => {
      for (const row of rows) {
        if (!Number.isFinite(row.last)) continue
        const preClose = row.preClose !== null && Number.isFinite(row.preClose) ? row.preClose : null
        written += stmt.run(row.code, Math.round(row.ts), row.last, preClose).changes
      }
    })
    return written
  }

  /** [from, to] 闭区间，按 ts 升序 */
  series(code: SecCode, from: number, to: number): QuoteTickPoint[] {
    return this.db
      .prepare(
        `SELECT ts, last FROM quote_tick
         WHERE code = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`
      )
      .all<QuoteTickPoint>(code, Math.round(from), Math.round(to))
  }

  /**
   * 该区间里最后一个非空昨收。取「最后一个」而不是第一个：
   * 跨日的区间里，晚的那个才是当天的昨收。
   */
  preCloseOf(code: SecCode, from: number, to: number): number | null {
    return (
      this.db
        .prepare(
          `SELECT pre_close FROM quote_tick
           WHERE code = ? AND ts >= ? AND ts <= ? AND pre_close IS NOT NULL
           ORDER BY ts DESC LIMIT 1`
        )
        .get<{ pre_close: number | null }>(code, Math.round(from), Math.round(to))?.pre_close ?? null
    )
  }

  /** 删掉 before 之前的全部点（docs/03 §4.3） */
  prune(before: number): number {
    return this.db.prepare(`DELETE FROM quote_tick WHERE ts < ?`).run(Math.round(before)).changes
  }
}
