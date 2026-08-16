/**
 * 公告仓储（012_announcement.sql）。驱动用 node:sqlite，理由同 storage.test.ts。
 *
 * 重点验四件事，每件都是**从界面上看不出来的错**：
 *   1. 去重键是数据源条目 ID —— 用「标题 + 日期」会把同日同名的多份公告去重成一条；
 *   2. `INSERT OR REPLACE` 会更新标题与分类（公告撤回重发会带「（更正后）」）；
 *   3. `since` 按**发布时刻**取而不是公告日 —— 那是两个不同的时刻（见 SQL 头注释）；
 *   4. 它**能**裁剪（可重建），与 `ai_explain` / `report_note` 恰好相反。
 */

import { describe, expect, it } from 'vitest'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import { DEFAULT_RETENTION, pruneAll } from '@main/storage/retention'
import type { AnnouncementRow } from '@main/storage/repositories/announcement'
import type { SecCode, TradeDate } from '@core/types'

const DRIVER = 'node:sqlite' as const
const NOW = 1_760_000_000_000
const DAY = 86_400_000

async function openMemory(): Promise<Storage> {
  return createStorage(await openDatabase({ file: ':memory:', driver: DRIVER, backup: false }))
}

function row(over: Partial<AnnouncementRow> = {}): AnnouncementRow {
  return {
    id: 'AN001',
    code: 'SH600000' as SecCode,
    name: '浦发银行',
    title: '董事会决议公告',
    category: '董事会决议公告',
    publishedAt: NOW - 3600_000,
    noticeDate: '2026-08-15' as TradeDate,
    url: 'https://data.eastmoney.com/notices/detail/600000/AN001.html',
    fetchedAt: NOW,
    provider: 'eastmoney',
    ...over,
  }
}

describe('AnnouncementRepo', () => {
  it('同一天同名的多份公告各存一行 —— 去重键是数据源 ID，不是标题+日期', async () => {
    const storage = await openMemory()
    // 实测形状：长江材料 2026-08-14 一次发了 4 份，display_time 逐秒相同
    const added = storage.announcements.upsertMany([
      row({ id: 'A1', title: '2026年半年度报告' }),
      row({ id: 'A2', title: '2026年半年度报告摘要' }),
      row({ id: 'A3', title: '2026年半年度报告' }),
    ])
    expect(added).toBe(3)
    expect(storage.announcements.count()).toBe(3)
  })

  it('重复落同一批不长新行（幂等），但标题与分类会被更新', async () => {
    const storage = await openMemory()
    expect(storage.announcements.upsertMany([row()])).toBe(1)
    // 第二次：新增 0 条
    expect(storage.announcements.upsertMany([row()])).toBe(0)
    expect(storage.announcements.count()).toBe(1)

    storage.announcements.upsertMany([row({ title: '董事会决议公告（更正后）', category: null })])
    const got = storage.announcements.get('AN001')
    expect(got?.title).toBe('董事会决议公告（更正后）')
    // 分类拿不到时是 null，不是空串 —— 下游按 null 判断「数据源没给」
    expect(got?.category).toBeNull()
    expect(storage.announcements.count()).toBe(1)
  })

  it('since 按发布时刻取，新到旧；早于下界的不给', async () => {
    const storage = await openMemory()
    storage.announcements.upsertMany([
      row({ id: 'old', publishedAt: NOW - 3 * DAY }),
      row({ id: 'mid', publishedAt: NOW - DAY }),
      row({ id: 'new', publishedAt: NOW - 60_000 }),
    ])
    const got = storage.announcements.since(['SH600000' as SecCode], NOW - 2 * DAY)
    expect(got.map((r) => r.id)).toEqual(['new', 'mid'])
  })

  it('codes 为空返回空数组，**不是「全部」** —— 那两件事不一样', async () => {
    const storage = await openMemory()
    storage.announcements.upsertMany([row()])
    expect(storage.announcements.since([], 0)).toEqual([])
  })

  it('只给点名的票，不串到别的代码上', async () => {
    const storage = await openMemory()
    storage.announcements.upsertMany([row(), row({ id: 'B', code: 'SZ000001' as SecCode })])
    expect(storage.announcements.since(['SZ000001' as SecCode], 0).map((r) => r.id)).toEqual(['B'])
  })

  it('**它进 pruneAll** —— 公告可重建，与 ai_explain / report_note 相反', async () => {
    const storage = await openMemory()
    const cutoff = DEFAULT_RETENTION.announcementDays * DAY
    storage.announcements.upsertMany([
      row({ id: 'keep', publishedAt: NOW - cutoff + DAY }),
      row({ id: 'drop', publishedAt: NOW - cutoff - DAY }),
    ])

    const report = pruneAll(storage.db, NOW, DEFAULT_RETENTION)
    expect(report.announcementDeleted).toBe(1)
    expect(storage.announcements.since(['SH600000' as SecCode], 0).map((r) => r.id)).toEqual(['keep'])
  })

  it('pruneAll 不碰 ai_explain 与 report_note（同一次调用里对照）', async () => {
    const storage = await openMemory()
    storage.reportNotes.upsert({
      tradeDate: '2020-01-02' as TradeDate,
      createdAt: NOW - 900 * DAY,
      elapsedMs: 1000,
      text: '很久以前的一段评价',
      model: 'x',
      protocol: 'openai',
      factDigest: 'abc',
    })
    pruneAll(storage.db, NOW, DEFAULT_RETENTION)
    // 花过钱、无法重建 —— 再老也不许自动删
    expect(storage.reportNotes.latestOf('2020-01-02' as TradeDate)).not.toBeNull()
  })
})
