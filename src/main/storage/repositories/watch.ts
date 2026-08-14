/**
 * 观察点仓储（migration 003）。
 *
 * 表的性质与「它不是策略参数」那条边界见 `003_watch.sql` 的头注释。
 * 这一层只做读写，判定在 `src/main/watch/evaluate.ts`（纯函数）。
 */

import type { SecCode } from '@core/types'
import type { WatchPointView, WatchVerdict } from '@shared/ipc-types'
import type { Database } from '../db'

/** 落库行（主进程内部用）。与 `WatchPointView` 的差别是没有 `name` 与派生字段 */
export interface WatchPointRow {
  id: string
  code: SecCode
  signalId: string
  source: WatchPointView['source']
  metric: string
  op: WatchPointView['op']
  threshold: number
  meaning: WatchPointView['meaning']
  note?: string
  /** 建点时那条解读的方向结论（005_watch_verdict.sql）。归不了类时缺省，那不是错误 */
  verdict?: WatchVerdict
  verdictText?: string
  engineVersion: string
  createdAt: number
  expiresAt: number
  status: WatchPointView['status']
  hitAt?: number
  hitValue?: number
}

interface Row {
  id: string
  code: string
  signal_id: string
  source: string
  metric: string
  op: string
  threshold: number
  meaning: string
  note: string | null
  verdict: string | null
  verdict_text: string | null
  engine_version: string
  created_at: number
  expires_at: number
  status: string
  hit_at: number | null
  hit_value: number | null
}

function toRow(row: Row): WatchPointRow {
  const out: WatchPointRow = {
    id: row.id,
    code: row.code,
    signalId: row.signal_id,
    source: row.source as WatchPointRow['source'],
    metric: row.metric,
    op: row.op as WatchPointRow['op'],
    threshold: row.threshold,
    meaning: row.meaning as WatchPointRow['meaning'],
    engineVersion: row.engine_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status as WatchPointRow['status'],
  }
  // exactOptionalPropertyTypes：没有就不要这个键，而不是塞 undefined
  if (row.note !== null) out.note = row.note
  if (row.verdict !== null) out.verdict = row.verdict as WatchVerdict
  if (row.verdict_text !== null) out.verdictText = row.verdict_text
  if (row.hit_at !== null) out.hitAt = row.hit_at
  if (row.hit_value !== null) out.hitValue = row.hit_value
  return out
}

const COLUMNS = `id, code, signal_id, source, metric, op, threshold, meaning, note,
                 verdict, verdict_text,
                 engine_version, created_at, expires_at, status, hit_at, hit_value`

export class WatchPointRepo {
  constructor(private readonly db: Database) {}

  insert(row: WatchPointRow): void {
    this.db
      .prepare(
        `INSERT INTO watch_point
           (id, code, signal_id, source, metric, op, threshold, meaning, note,
            verdict, verdict_text,
            engine_version, created_at, expires_at, status, hit_at, hit_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.code,
        row.signalId,
        row.source,
        row.metric,
        row.op,
        row.threshold,
        row.meaning,
        row.note ?? null,
        row.verdict ?? null,
        row.verdictText ?? null,
        row.engineVersion,
        row.createdAt,
        row.expiresAt,
        row.status,
        row.hitAt ?? null,
        row.hitValue ?? null
      )
  }

  /**
   * 还在盯的。**不按 `expires_at` 过滤** —— 过期判定要由调用方在同一轮里做，
   * 因为「过期」本身是一个要落库并显示的结论（到期未兑现），
   * 在这里静默滤掉会让那些观察点看起来凭空消失。
   */
  active(): WatchPointRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM watch_point WHERE status = 'ACTIVE' ORDER BY created_at ASC`)
      .all<Row>()
      .map(toRow)
  }

  list(query: { status?: WatchPointRow['status']; limit?: number } = {}): WatchPointRow[] {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000)
    if (query.status !== undefined) {
      return this.db
        .prepare(
          `SELECT ${COLUMNS} FROM watch_point WHERE status = ? ORDER BY created_at DESC LIMIT ?`
        )
        .all<Row>(query.status, limit)
        .map(toRow)
    }
    return this.db
      .prepare(
        // ACTIVE 排最前：它是「软件正在盯什么」，其余是历史
        `SELECT ${COLUMNS} FROM watch_point
         ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`
      )
      .all<Row>(limit)
      .map(toRow)
  }

  get(id: string): WatchPointRow | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM watch_point WHERE id = ?`).get<Row>(id)
    return row ? toRow(row) : null
  }

  countActive(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM watch_point WHERE status = 'ACTIVE'`)
        .get<{ n: number }>()?.n ?? 0
    )
  }

  /** 命中。`WHERE status = 'ACTIVE'` 是幂等闸门：同一轮跑两次不会重复记 */
  markHit(id: string, at: number, value: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE watch_point SET status = 'HIT', hit_at = ?, hit_value = ?
           WHERE id = ? AND status = 'ACTIVE'`
        )
        .run(at, value, id).changes > 0
    )
  }

  markExpired(id: string): boolean {
    return (
      this.db
        .prepare(`UPDATE watch_point SET status = 'EXPIRED' WHERE id = ? AND status = 'ACTIVE'`)
        .run(id).changes > 0
    )
  }

  /**
   * 用户点「不盯了」：**直接删掉这一行**，不是改成 CANCELED（2026-08-14 改）。
   *
   * 一条被主动放弃的观察点不构成结论 —— 与「到期未命中」不同，后者答的是
   * 「当时那个判断没兑现」，是有信息的；而「我不想盯了」只是把列表越攒越长。
   * 所以这里是 DELETE，调用方**必须先做二次确认**（controller.removeWatchPoint 走系统模态框）。
   *
   * **`CANCELED` 这个状态值保留**：改动之前的库里可能已经有 CANCELED 行，
   * 列表要照常把它们显示成「已取消」。滤掉会让用户当初取消过的记录看起来凭空消失
   * —— 与 alert_log 里 `TRAY` / `OS_NOTIFY` 那两个已删渠道同一条处置。
   * 只是从此不再产生新的 CANCELED 行。
   *
   * 不限 `status = 'ACTIVE'`：已命中/已过期的行用户同样可以清掉。
   */
  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM watch_point WHERE id = ?`).run(id).changes > 0
  }

  /** 移出自选时连带清理（外键指向 watchlist，见 WatchlistRepo.remove） */
  removeByCode(code: SecCode): number {
    return this.db.prepare(`DELETE FROM watch_point WHERE code = ?`).run(code).changes
  }
}
