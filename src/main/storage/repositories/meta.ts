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
} as const
