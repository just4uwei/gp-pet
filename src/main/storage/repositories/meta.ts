/**
 * meta 表：schema_version、各类「上次刷新时间」等键值。
 *
 * 用它记录刷新时间而不是文件 mtime：mtime 会被同步工具、备份、杀软改掉。
 */

import type { Database } from '../db'

export class MetaRepo {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    return this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get<{ value: string }>(key)?.value ?? null
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  getNumber(key: string): number | null {
    const raw = this.get(key)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }

  setNumber(key: string, value: number): void {
    this.set(key, String(value))
  }
}

export const META_KEYS = {
  calendarRefreshedAt: 'calendar_refreshed_at',
  profileRefreshedAt: 'profile_refreshed_at',
  lastPruneAt: 'last_prune_at',
  /**
   * 最近一次补跑过收盘确认轮的交易日（`engine/settle.ts`）。**存日期串不是时刻。**
   *
   * 它是幂等闸门：补跑本身是幂等的（签名去重 + 只动 PROVISIONAL 行 + upsert），
   * 但它要为每只标的算一遍 320 根的全套指标，没必要每轮 tick 都来。
   *
   * **不能改用「当日有没有 CONFIRMED 行」来判**：一个交易日合法地可以零信号，
   * 那样会变成每轮都重跑。
   */
  lastSettledDate: 'last_settled_date',
} as const
