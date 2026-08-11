/**
 * 自选股表访问（docs/03 §4.2）。
 *
 * 代码一律以规范化形态（SH600000）入库 —— 规范化在 IPC 入口做（docs/03 §5），
 * 仓储层只信任已规范化的输入，不做二次猜测。
 */

import { isSTName } from '@core/code'
import type { Board, Market, SecCode, SecProfile } from '@core/types'
import type { Database } from '../db'

export interface WatchEntry {
  profile: SecProfile
  group: string
  sortOrder: number
  createdAt: number
}

interface Row {
  code: string
  name: string
  market: string
  board: string | null
  industry: string | null
  group_name: string
  sort_order: number
  created_at: number
}

function toEntry(row: Row): WatchEntry {
  const profile: SecProfile = {
    code: row.code,
    name: row.name,
    market: row.market as Market,
    board: (row.board ?? 'MAIN') as Board,
    isST: isSTName(row.name),
  }
  // exactOptionalPropertyTypes：industry 缺失就不要这个键，而不是塞 undefined
  if (row.industry) profile.industry = row.industry
  return { profile, group: row.group_name, sortOrder: row.sort_order, createdAt: row.created_at }
}

export class WatchlistRepo {
  constructor(private readonly db: Database) {}

  list(): WatchEntry[] {
    return this.db
      .prepare(
        `SELECT code, name, market, board, industry, group_name, sort_order, created_at
         FROM watchlist ORDER BY sort_order ASC, code ASC`
      )
      .all<Row>()
      .map(toEntry)
  }

  get(code: SecCode): WatchEntry | null {
    const row = this.db
      .prepare(
        `SELECT code, name, market, board, industry, group_name, sort_order, created_at
         FROM watchlist WHERE code = ?`
      )
      .get<Row>(code)
    return row ? toEntry(row) : null
  }

  codes(): SecCode[] {
    return this.db
      .prepare(`SELECT code FROM watchlist ORDER BY sort_order ASC, code ASC`)
      .all<{ code: string }>()
      .map((r) => r.code)
  }

  count(): number {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM watchlist`).get<{ n: number }>()?.n ?? 0
  }

  /**
   * 幂等：已存在则刷新名称/行业并保留分组与排序。
   * 重复添加是常见操作（用户忘了自己加过），报错不如原地更新。
   */
  add(profile: SecProfile, group: string, now: number): WatchEntry {
    const nextOrder =
      (this.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM watchlist`).get<{ m: number }>()?.m ??
        -1) + 1

    this.db
      .prepare(
        `INSERT INTO watchlist (code, name, market, board, industry, group_name, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name,
           market = excluded.market,
           board = excluded.board,
           industry = COALESCE(excluded.industry, watchlist.industry)`
      )
      .run(
        profile.code,
        profile.name,
        profile.market,
        profile.board,
        profile.industry ?? null,
        group,
        nextOrder,
        now
      )

    const entry = this.get(profile.code)
    if (!entry) throw new Error(`写入自选股失败：${profile.code}`)
    return entry
  }

  remove(code: SecCode): boolean {
    // 持仓外键指向 watchlist，先清持仓再删自选，否则 foreign_keys = ON 会拒绝
    this.db.prepare(`DELETE FROM position WHERE code = ?`).run(code)
    return this.db.prepare(`DELETE FROM watchlist WHERE code = ?`).run(code).changes > 0
  }

  /** 按给定顺序重排；未出现在列表里的保持相对次序排在其后 */
  reorder(codes: SecCode[]): void {
    const update = this.db.prepare(`UPDATE watchlist SET sort_order = ? WHERE code = ?`)
    this.db.transaction(() => {
      codes.forEach((code, index) => update.run(index, code))
      const rest = this.db
        .prepare(
          `SELECT code FROM watchlist WHERE code NOT IN (${codes.map(() => '?').join(',') || 'NULL'})
           ORDER BY sort_order ASC, code ASC`
        )
        .all<{ code: string }>(...codes)
      rest.forEach((row, index) => update.run(codes.length + index, row.code))
    })
  }

  updateIndustry(code: SecCode, industry: string | null): void {
    this.db.prepare(`UPDATE watchlist SET industry = ? WHERE code = ?`).run(industry, code)
  }
}
