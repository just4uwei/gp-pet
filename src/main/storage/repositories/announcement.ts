/**
 * 自选股公告仓储（012_announcement.sql）。
 *
 * 「为什么可以裁剪、为什么去重键是数据源 ID、为什么两个时刻不合并」全在 SQL 的头注释里。
 *
 * 这一层只有三条读写口径：
 *   1. **`upsertMany` 幂等**：主键是数据源给的条目 ID，重复拉同一批不会长出新行。
 *      用 `INSERT OR REPLACE` 而不是 `OR IGNORE` —— 数据源改了标题或分类时要跟着更新，
 *      而这两者确实会变（公告撤回重发时标题会带「（更正后）」）。
 *   2. **`since(codes, sinceMs)` 按发布时刻取**，不是按公告日 —— 盘前简报问的是
 *      「昨收盘之后到现在」，那是个时刻区间。
 *   3. **`prune` 按发布时刻裁**，与 `retention.ts` 的其余几张表同一形状。
 */

import type { SecCode, TradeDate } from '@core/types'
import type { Announcement } from '../../providers/types'
import type { Database } from '../db'

export interface AnnouncementRow extends Announcement {
  /** 本地入库时刻 */
  fetchedAt: number
  provider: string
}

interface Row {
  id: string
  code: string
  name: string
  title: string
  category: string | null
  published_at: number
  notice_date: string
  url: string
  fetched_at: number
  provider: string
}

function toRow(raw: Row): AnnouncementRow {
  return {
    id: raw.id,
    code: raw.code as SecCode,
    name: raw.name,
    title: raw.title,
    category: raw.category,
    publishedAt: raw.published_at,
    noticeDate: raw.notice_date as TradeDate,
    url: raw.url,
    fetchedAt: raw.fetched_at,
    provider: raw.provider,
  }
}

const COLUMNS = 'id, code, name, title, category, published_at, notice_date, url, fetched_at, provider'

export class AnnouncementRepo {
  constructor(private readonly db: Database) {}

  /**
   * 落库。返回**新增**的条数（不含被覆盖的）—— 调用方用它写日志，
   * 「今天拉到 40 条、新增 3 条」与「今天拉到 40 条」是两个意思。
   */
  upsertMany(rows: readonly AnnouncementRow[]): number {
    if (rows.length === 0) return 0
    const known = new Set(
      this.db
        .prepare(`SELECT id FROM announcement WHERE id IN (${rows.map(() => '?').join(',')})`)
        .all(...rows.map((r) => r.id))
        .map((raw) => (raw as { id: string }).id)
    )

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO announcement (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.db.transaction(() => {
      for (const row of rows) {
        stmt.run(
          row.id,
          row.code,
          row.name,
          row.title,
          // 分类拿不到时写 NULL，**不写空串** —— 下游按 null 判断「数据源没给」
          row.category,
          row.publishedAt,
          row.noticeDate,
          row.url,
          row.fetchedAt,
          row.provider
        )
      }
    })
    return rows.filter((r) => !known.has(r.id)).length
  }

  /**
   * 指定标的、发布时刻 ≥ `sinceMs` 的公告，新到旧。
   *
   * `codes` 为空时返回空数组，**不是「全部」** —— 「没有自选股」与「不限标的」
   * 是两回事，而后者在这个功能里根本不该出现（它只服务自选）。
   */
  since(codes: readonly SecCode[], sinceMs: number, limit = 200): AnnouncementRow[] {
    if (codes.length === 0) return []
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM announcement
         WHERE code IN (${codes.map(() => '?').join(',')}) AND published_at >= ?
         ORDER BY published_at DESC LIMIT ?`
      )
      .all(...codes, sinceMs, limit)
      .map((raw) => toRow(raw as unknown as Row))
  }

  /** 某一条，供「点开原文」之类的单条查询用 */
  get(id: string): AnnouncementRow | null {
    const raw = this.db.prepare(`SELECT ${COLUMNS} FROM announcement WHERE id = ?`).get(id)
    return raw ? toRow(raw as unknown as Row) : null
  }

  /** 发布时刻早于 `beforeMs` 的一律删掉。返回删除条数 */
  prune(beforeMs: number): number {
    return this.db.prepare('DELETE FROM announcement WHERE published_at < ?').run(beforeMs).changes
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM announcement').get() as { n: number }).n
  }
}
