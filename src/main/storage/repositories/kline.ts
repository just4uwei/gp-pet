/**
 * 日线表访问（docs/03 §4.2）。
 *
 * 两条硬规则：
 *   1. **provisional K 线不落库。** 盘中那根由快照拼出来的临时 K 线每 tick 都在变，
 *      写进去会让「历史」随时间改写，回测立刻失真（docs/04 §6）。这里直接过滤掉。
 *   2. 前复权与不复权并存。指标读 *_adj，展示与成本读原始价（docs/03 §2.3）。
 */

import type { Candle, SecCode, TradeDate } from '@core/types'
import type { Database } from '../db'

interface Row {
  trade_date: string
  open: number
  high: number
  low: number
  close: number
  open_adj: number
  high_adj: number
  low_adj: number
  close_adj: number
  volume: number
  amount: number | null
  has_gap: number
}

function toCandle(row: Row): Candle {
  const candle: Candle = {
    date: row.trade_date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    openAdj: row.open_adj,
    highAdj: row.high_adj,
    lowAdj: row.low_adj,
    closeAdj: row.close_adj,
    volume: row.volume,
    amount: row.amount,
  }
  if (row.has_gap === 1) candle.hasGap = true
  return candle
}

const SELECT_COLUMNS = `trade_date, open, high, low, close, open_adj, high_adj, low_adj, close_adj,
  volume, amount, has_gap`

export class KlineRepo {
  constructor(private readonly db: Database) {}

  /** 返回实际写入的根数（provisional 被跳过，不计入） */
  upsertMany(code: SecCode, candles: readonly Candle[], provider: string): number {
    const rows = candles.filter((c) => c.provisional !== true)
    if (rows.length === 0) return 0

    const stmt = this.db.prepare(
      `INSERT INTO kline_daily (code, trade_date, open, high, low, close,
         open_adj, high_adj, low_adj, close_adj, volume, amount, turnover_rate, adj_factor, has_gap, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(code, trade_date) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
         open_adj = excluded.open_adj, high_adj = excluded.high_adj,
         low_adj = excluded.low_adj, close_adj = excluded.close_adj,
         volume = excluded.volume, amount = excluded.amount,
         adj_factor = excluded.adj_factor, has_gap = excluded.has_gap, provider = excluded.provider`
    )

    this.db.transaction(() => {
      for (const c of rows) {
        // adj_factor 由两套价格反算：数据源不一定给，但 closeAdj / close 就是它，
        // 存下来才能在增量补齐时检出复权口径变化（docs/07 §4）
        const factor = c.close > 0 ? c.closeAdj / c.close : null
        stmt.run(
          code,
          c.date,
          c.open,
          c.high,
          c.low,
          c.close,
          c.openAdj,
          c.highAdj,
          c.lowAdj,
          c.closeAdj,
          Math.round(c.volume),
          c.amount,
          factor,
          c.hasGap === true ? 1 : 0,
          provider
        )
      }
    })
    return rows.length
  }

  lastDate(code: SecCode): TradeDate | null {
    return (
      this.db
        .prepare(`SELECT MAX(trade_date) AS d FROM kline_daily WHERE code = ?`)
        .get<{ d: string | null }>(code)?.d ?? null
    )
  }

  count(code: SecCode): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM kline_daily WHERE code = ?`).get<{ n: number }>(code)?.n ?? 0
    )
  }

  /** 最近 limit 根，**升序**返回 —— 指标一律按时间正序计算 */
  recent(code: SecCode, limit: number): Candle[] {
    return this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM (
           SELECT ${SELECT_COLUMNS} FROM kline_daily WHERE code = ? ORDER BY trade_date DESC LIMIT ?
         ) ORDER BY trade_date ASC`
      )
      .all<Row>(code, Math.max(0, Math.floor(limit)))
      .map(toCandle)
  }

  range(code: SecCode, from: TradeDate, to: TradeDate): Candle[] {
    return this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM kline_daily
         WHERE code = ? AND trade_date >= ? AND trade_date <= ? ORDER BY trade_date ASC`
      )
      .all<Row>(code, from, to)
      .map(toCandle)
  }

  /** 复权口径变化时整只重拉，旧数据必须先清掉 —— 两套口径混存等于伪造行情 */
  deleteAll(code: SecCode): number {
    return this.db.prepare(`DELETE FROM kline_daily WHERE code = ?`).run(code).changes
  }

  /** 每只保留最近 keep 根（docs/03 §4.3） */
  prune(code: SecCode, keep: number): number {
    return this.db
      .prepare(
        `DELETE FROM kline_daily WHERE code = ? AND trade_date NOT IN (
           SELECT trade_date FROM kline_daily WHERE code = ? ORDER BY trade_date DESC LIMIT ?
         )`
      )
      .run(code, code, Math.max(1, Math.floor(keep))).changes
  }

  /** 已入库的全部代码，含已从自选股移除的残留 —— 裁剪要照顾到它们 */
  storedCodes(): SecCode[] {
    return this.db
      .prepare(`SELECT DISTINCT code FROM kline_daily`)
      .all<{ code: string }>()
      .map((r) => r.code)
  }
}
