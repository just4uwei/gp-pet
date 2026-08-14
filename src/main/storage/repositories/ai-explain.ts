/**
 * AI 解读历史仓储（008_ai_explain.sql）。
 *
 * 「为什么不加外键、为什么不进裁剪、为什么信号字段要冗余存一份」全在 SQL 的头注释里，
 * 改这里之前先看一眼 —— 那三条都是「改了之后不会报错，只会在两年后静默丢东西」的那类。
 *
 * 两条读写口径：
 *   1. **`listByCode` 按 `created_at` 倒序**（新的在上），与提醒日志、信号列表同向。
 *      排序键是**发起时刻**不是完成时刻 —— 用户记得的是「我什么时候点的」。
 *   2. **`latestOf` 是防重复计费那条路**：`AiService.explain()` 内存缓存没命中时查它，
 *      命中就直接返回全文、一个请求都不发。所以它必须只认 `signal_id`，
 *      不能顺手加上「只看今天」之类的条件。
 */

import type { GatedDirection, SecCode, SignalStage } from '@core/types'
import type { AiProtocol } from '../../ai/types'
import type { Database } from '../db'

export interface AiExplainRow {
  id: string
  signalId: string
  code: SecCode
  /** 发起时刻 */
  createdAt: number
  elapsedMs: number
  text: string
  model: string
  protocol: AiProtocol
  /** ↓ 信号当时的样子。冗余存的，原信号被裁剪之后这几项就是仅有的上下文 */
  direction: GatedDirection
  stage: SignalStage
  score: number
  /** 拿不到时 undefined —— **不是 0**（约束 4） */
  priceAt?: number
  signalAt: number
}

interface Row {
  id: string
  signal_id: string
  code: string
  created_at: number
  elapsed_ms: number
  text: string
  model: string
  protocol: string
  direction: string
  stage: string
  score: number
  price_at: number | null
  signal_at: number
}

function toRow(row: Row): AiExplainRow {
  const out: AiExplainRow = {
    id: row.id,
    signalId: row.signal_id,
    code: row.code,
    createdAt: row.created_at,
    elapsedMs: row.elapsed_ms,
    text: row.text,
    model: row.model,
    protocol: row.protocol as AiProtocol,
    direction: row.direction as GatedDirection,
    stage: row.stage as SignalStage,
    score: row.score,
    signalAt: row.signal_at,
  }
  // exactOptionalPropertyTypes：没有就不要这个键，而不是塞 undefined
  if (row.price_at !== null) out.priceAt = row.price_at
  return out
}

const COLUMNS =
  `id, signal_id, code, created_at, elapsed_ms, text, model, protocol, ` +
  `direction, stage, score, price_at, signal_at`

export class AiExplainRepo {
  constructor(private readonly db: Database) {}

  insert(row: AiExplainRow): void {
    this.db
      .prepare(`INSERT INTO ai_explain (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id,
        row.signalId,
        row.code,
        Math.round(row.createdAt),
        Math.round(row.elapsedMs),
        row.text,
        row.model,
        row.protocol,
        row.direction,
        row.stage,
        row.score,
        row.priceAt ?? null,
        Math.round(row.signalAt)
      )
  }

  /** 这只票的全部解读，新的在上。`limit` 缺省 100 —— 抽屉里那份列表用它 */
  listByCode(code: SecCode, limit = 100): AiExplainRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM ai_explain WHERE code = ? ORDER BY created_at DESC LIMIT ?`)
      .all<Row>(code, Math.max(1, Math.trunc(limit)))
      .map(toRow)
  }

  /**
   * 这条信号最近一次解读的全文。**防重复计费走这一条**：
   * 没有它的话，重启一次就会对同一条信号再花一次钱（见 SQL 头注释）。
   */
  latestOf(signalId: string): AiExplainRow | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM ai_explain WHERE signal_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get<Row>(signalId)
    return row ? toRow(row) : null
  }

  get(id: string): AiExplainRow | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM ai_explain WHERE id = ?`).get<Row>(id)
    return row ? toRow(row) : null
  }

  countByCode(code: SecCode): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM ai_explain WHERE code = ?`)
        .get<{ n: number }>(code)?.n ?? 0
    )
  }

  /** 用户手动删。**这是删除的唯一入口** —— 没有任何自动裁剪会碰这张表 */
  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM ai_explain WHERE id = ?`).run(id).changes > 0
  }
}
