/**
 * 观察点仓储（migration 003）。
 *
 * 表的性质与「它不是策略参数」那条边界见 `003_watch.sql` 的头注释。
 * 这一层只做读写，判定在 `src/main/watch/evaluate.ts`（纯函数）。
 */

import type { SecCode } from '@core/types'
import type { WatchCondition, WatchPointView, WatchVerdict } from '@shared/ipc-types'
import type { Database } from '../db'

/** 落库行（主进程内部用）。与 `WatchPointView` 的差别是没有 `name` 与派生字段 */
export interface WatchPointRow {
  id: string
  code: SecCode
  signalId: string
  source: WatchPointView['source']
  /** **至少一条**。多条 = 同一轮全部成立才算命中（015_watch_multi.sql） */
  conditions: WatchCondition[]
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
  /** 命中时各条件的实际值，与 `conditions` 同序同长 */
  hitValues?: number[]
}

interface Row {
  id: string
  code: string
  signal_id: string
  source: string
  metric: string
  op: string
  threshold: number
  conditions: string | null
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
  hit_values: string | null
}

/**
 * `conditions` 列 → 条件数组。**绝不抛**：解析不出来（旧行、坏 JSON、缺字段）
 * 一律返回 null，由调用方回落到 metric/op/threshold 那三列。
 * 一行坏数据不该让整个观察点列表打不开。
 */
function parseConditions(raw: string | null): WatchCondition[] | null {
  if (raw === null || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const out: WatchCondition[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return null
      const { metric, op, threshold } = item as Record<string, unknown>
      if (typeof metric !== 'string' || metric === '') return null
      if (op !== 'LTE' && op !== 'GTE') return null
      if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null
      out.push({ metric, op, threshold })
    }
    return out
  } catch {
    return null
  }
}

/** `hit_values` 列 → 数值数组。同样绝不抛；长度对不上时按缺失处理（少说好过编数） */
function parseHitValues(raw: string | null): number[] | null {
  if (raw === null || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const out: number[] = []
    for (const item of parsed) {
      if (typeof item !== 'number' || !Number.isFinite(item)) return null
      out.push(item)
    }
    return out.length === 0 ? null : out
  } catch {
    return null
  }
}

function toRow(row: Row): WatchPointRow {
  const out: WatchPointRow = {
    id: row.id,
    code: row.code,
    signalId: row.signal_id,
    source: row.source as WatchPointRow['source'],
    // 015 之前的行没有 conditions 列 —— 回落到那三列，读出来就是一条条件
    conditions: parseConditions(row.conditions) ?? [
      { metric: row.metric, op: row.op as WatchCondition['op'], threshold: row.threshold },
    ],
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
  const hitValues = parseHitValues(row.hit_values) ?? (row.hit_value === null ? null : [row.hit_value])
  if (hitValues !== null) out.hitValues = hitValues
  return out
}

const COLUMNS = `id, code, signal_id, source, metric, op, threshold, conditions, meaning, note,
                 verdict, verdict_text,
                 engine_version, created_at, expires_at, status, hit_at, hit_value, hit_values`

export class WatchPointRepo {
  constructor(private readonly db: Database) {}

  /**
   * 落一行。
   *
   * **`metric` / `op` / `threshold` 那三列写的是 `conditions[0]` 的镜像**：它们是
   * NOT NULL、留着是为了旧版本的行照常可读。⚠ 它们**不是判据** —— 直接读会把
   * 「a 且 b」读成只盯 a（更宽松），见 015_watch_multi.sql 头注释。
   */
  insert(row: WatchPointRow): void {
    const first = row.conditions[0]
    if (first === undefined) throw new Error('观察点至少要有一个条件')
    this.db
      .prepare(
        `INSERT INTO watch_point
           (id, code, signal_id, source, metric, op, threshold, conditions, meaning, note,
            verdict, verdict_text,
            engine_version, created_at, expires_at, status, hit_at, hit_value, hit_values)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.code,
        row.signalId,
        row.source,
        first.metric,
        first.op,
        first.threshold,
        JSON.stringify(row.conditions),
        row.meaning,
        row.note ?? null,
        row.verdict ?? null,
        row.verdictText ?? null,
        row.engineVersion,
        row.createdAt,
        row.expiresAt,
        row.status,
        row.hitAt ?? null,
        row.hitValues?.[0] ?? null,
        row.hitValues === undefined ? null : JSON.stringify(row.hitValues)
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

  /**
   * 命中。`WHERE status = 'ACTIVE'` 是幂等闸门：同一轮跑两次不会重复记。
   *
   * `values` 与该点的 `conditions` 同序同长（组合条件下每条都成立才会走到这里）。
   * `hit_value` 那一列同样只是 `values[0]` 的镜像。
   */
  markHit(id: string, at: number, values: readonly number[]): boolean {
    return (
      this.db
        .prepare(
          `UPDATE watch_point SET status = 'HIT', hit_at = ?, hit_value = ?, hit_values = ?
           WHERE id = ? AND status = 'ACTIVE'`
        )
        .run(at, values[0] ?? null, JSON.stringify(values), id).changes > 0
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
