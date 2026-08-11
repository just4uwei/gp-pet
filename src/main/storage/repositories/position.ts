/**
 * 用户手工录入的持仓（docs/03 §4.2）。
 *
 * 成本价是**不复权**真实成交价 —— 用户的成本就是当时付的钱，
 * 拿前复权价算止损会在除权后凭空触发一次卖出提醒（docs/03 §2.3）。
 *
 * M1 只提供读写；风控如何使用它是 M3 的事。
 */

import type { Position, SecCode } from '@core/types'
import type { Database } from '../db'

interface Row {
  code: string
  shares: number
  cost: number
  peak_price: number | null
  opened_at: number
}

function toPosition(row: Row): Position {
  return {
    code: row.code,
    shares: row.shares,
    cost: row.cost,
    // peak_price 为空时用成本价兜底：持有期最高价至少是买入价
    peakPrice: row.peak_price ?? row.cost,
    openedAt: row.opened_at,
  }
}

export class PositionRepo {
  constructor(private readonly db: Database) {}

  set(code: SecCode, shares: number, cost: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO position (code, shares, cost, peak_price, opened_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET shares = excluded.shares, cost = excluded.cost`
      )
      .run(code, Math.round(shares), cost, cost, now)
  }

  /** 移动止损/回撤提醒依赖持有期最高价，只允许上调 */
  bumpPeak(code: SecCode, price: number): void {
    this.db
      .prepare(`UPDATE position SET peak_price = MAX(COALESCE(peak_price, cost), ?) WHERE code = ?`)
      .run(price, code)
  }

  clear(code: SecCode): boolean {
    return this.db.prepare(`DELETE FROM position WHERE code = ?`).run(code).changes > 0
  }

  get(code: SecCode): Position | null {
    const row = this.db
      .prepare(`SELECT code, shares, cost, peak_price, opened_at FROM position WHERE code = ?`)
      .get<Row>(code)
    return row ? toPosition(row) : null
  }

  list(): Position[] {
    return this.db
      .prepare(`SELECT code, shares, cost, peak_price, opened_at FROM position ORDER BY code ASC`)
      .all<Row>()
      .map(toPosition)
  }

  codes(): Set<SecCode> {
    return new Set(
      this.db
        .prepare(`SELECT code FROM position`)
        .all<{ code: string }>()
        .map((r) => r.code)
    )
  }
}
