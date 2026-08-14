/**
 * 成交流水仓储（007_trade_log.sql）。
 *
 * 这一层只做读写，记账规则在 `src/main/trades/ledger.ts`（纯函数、可测）。
 * 表的性质与「为什么不加外键、为什么不进裁剪」见 SQL 的头注释。
 */

import type { SecCode } from '@core/types'
import type { Database } from '../db'

/** BUY 买入 | SELL 卖出 | OPENING 期初建仓（迁移或配置导入补的，不是一次真实成交） */
export type TradeSideRow = 'BUY' | 'SELL' | 'OPENING'

export interface TradeRow {
  id: string
  code: SecCode
  side: TradeSideRow
  tradedAt: number
  price: number
  shares: number
  fee: number
  /** 卖出结转的已实现盈亏。买入与期初为 undefined —— **不是 0**（约束 4） */
  realized?: number
  note?: string
  createdAt: number
}

interface Row {
  id: string
  code: string
  side: string
  traded_at: number
  price: number
  shares: number
  fee: number
  realized: number | null
  note: string | null
  created_at: number
}

function toRow(row: Row): TradeRow {
  const out: TradeRow = {
    id: row.id,
    code: row.code,
    side: row.side as TradeSideRow,
    tradedAt: row.traded_at,
    price: row.price,
    shares: row.shares,
    fee: row.fee,
    createdAt: row.created_at,
  }
  // exactOptionalPropertyTypes：没有就不要这个键，而不是塞 undefined
  if (row.realized !== null) out.realized = row.realized
  if (row.note !== null) out.note = row.note
  return out
}

const COLUMNS = `id, code, side, traded_at, price, shares, fee, realized, note, created_at`

export class TradeRepo {
  constructor(private readonly db: Database) {}

  insert(row: TradeRow): void {
    this.db
      .prepare(`INSERT INTO trade_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id,
        row.code,
        row.side,
        Math.round(row.tradedAt),
        row.price,
        Math.trunc(row.shares),
        row.fee,
        row.realized ?? null,
        row.note ?? null,
        Math.round(row.createdAt)
      )
  }

  /**
   * 某只票的全部流水，**按成交时刻升序** —— 重放要的就是这个顺序。
   * 展示要倒序的话由调用方翻转：让仓储只出一种顺序，省得两处各记一半。
   *
   * 同一时刻的多笔按 `created_at` 兜底排序：补录的两笔可能填了同一个日期，
   * 没有兜底的话重放结果会随 SQLite 的返回顺序变。
   */
  listByCode(code: SecCode): TradeRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM trade_log WHERE code = ? ORDER BY traded_at ASC, created_at ASC`)
      .all<Row>(code)
      .map(toRow)
  }

  get(id: string): TradeRow | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM trade_log WHERE id = ?`).get<Row>(id)
    return row ? toRow(row) : null
  }

  /** 覆盖式导入时清掉该标的的旧账本 —— 上一份配置的成交记录不能与新持仓混在一起 */
  removeByCode(code: SecCode): number {
    return this.db.prepare(`DELETE FROM trade_log WHERE code = ?`).run(code).changes
  }

  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM trade_log WHERE id = ?`).run(id).changes > 0
  }

  /** 已实现盈亏合计。没有任何卖出时返回 0 —— 这里 0 是对的：一笔都没卖就是没实现 */
  sumRealized(code: SecCode): number {
    return (
      this.db
        .prepare(`SELECT COALESCE(SUM(realized), 0) AS total FROM trade_log WHERE code = ?`)
        .get<{ total: number }>(code)?.total ?? 0
    )
  }

  sumFees(code: SecCode): number {
    return (
      this.db
        .prepare(`SELECT COALESCE(SUM(fee), 0) AS total FROM trade_log WHERE code = ?`)
        .get<{ total: number }>(code)?.total ?? 0
    )
  }
}
