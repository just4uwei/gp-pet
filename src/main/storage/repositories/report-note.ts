/**
 * 收盘日报的 AI 评价仓储（010_report_note.sql）。
 *
 * 「为什么不复用 ai_explain、为什么 trade_date 是主键、为什么不进裁剪」全在 SQL 的头注释里。
 *
 * 两条读写口径：
 *   1. **`latestOf(date)` 是防重复计费那条路**：`AiService.explain()` 内存缓存没命中时查它，
 *      命中就直接返回全文、一个请求都不发。所以它只认交易日，不加别的条件。
 *   2. **`upsert` 覆盖同一天**：用户要的是「这一天」的评价，不是它的版本史。
 *      重新生成时旧的那条没有保留价值（而留着会让「历史里多了一条」这件事
 *      在界面上完全看不出来）。
 */

import type { TradeDate } from '@core/types'
import type { AiProtocol } from '../../ai/types'
import type { Database } from '../db'

export interface ReportNoteRow {
  tradeDate: TradeDate
  /** 发起时刻 */
  createdAt: number
  elapsedMs: number
  text: string
  model: string
  protocol: AiProtocol
  /** 生成时那份事实层的指纹 —— 定稿之后据它提示「这段基于盘中数据写的」 */
  factDigest: string
}

interface Row {
  trade_date: string
  created_at: number
  elapsed_ms: number
  text: string
  model: string
  protocol: string
  fact_digest: string
}

function toRow(raw: Row): ReportNoteRow {
  return {
    tradeDate: raw.trade_date as TradeDate,
    createdAt: raw.created_at,
    elapsedMs: raw.elapsed_ms,
    text: raw.text,
    model: raw.model,
    protocol: raw.protocol === 'anthropic' ? 'anthropic' : 'openai',
    factDigest: raw.fact_digest,
  }
}

export class ReportNoteRepo {
  constructor(private readonly db: Database) {}

  /** 这一天的评价；没有则 null。**防重复计费走它** */
  latestOf(date: TradeDate): ReportNoteRow | null {
    const raw = this.db
      .prepare(
        `SELECT trade_date, created_at, elapsed_ms, text, model, protocol, fact_digest
         FROM report_note WHERE trade_date = ?`
      )
      .get<Row>(date)
    return raw ? toRow(raw) : null
  }

  /** 一天一条，重新生成时覆盖（见文件头第 2 条） */
  upsert(row: ReportNoteRow): void {
    this.db
      .prepare(
        `INSERT INTO report_note (trade_date, created_at, elapsed_ms, text, model, protocol, fact_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trade_date) DO UPDATE SET
           created_at = excluded.created_at,
           elapsed_ms = excluded.elapsed_ms,
           text = excluded.text,
           model = excluded.model,
           protocol = excluded.protocol,
           fact_digest = excluded.fact_digest`
      )
      .run(row.tradeDate, row.createdAt, row.elapsedMs, row.text, row.model, row.protocol, row.factDigest)
  }

  /** 用户手动删。**没有任何自动删除路径**（见 SQL 头注释第 2 条） */
  remove(date: TradeDate): boolean {
    return this.db.prepare(`DELETE FROM report_note WHERE trade_date = ?`).run(date).changes > 0
  }
}
