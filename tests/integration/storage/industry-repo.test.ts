/**
 * 行业留痕仓储（014_industry_history.sql）。驱动用 node:sqlite，理由同 storage.test.ts。
 *
 * 这张表存在的理由是**「今天不做就永久少一天」** —— 数据源只给当前行业名，
 * 拿它回标历史是未来函数。所以这里钉的四件事都是「攒出来的东西会不会被悄悄毁掉」：
 *
 *   1. **只在变化时写行** —— 同一个行业名反复观测必须是零增长（否则 79 只 × 一年 ≈ 2 万行同名重复）；
 *   2. **同一天重复调用幂等** —— 休市维护一天可能跑好几轮；
 *   3. **`at()` 取不到时是 `null` 而不是最早那条** —— `null` 的含义是「那天我们还没开始记」，
 *      把首行往前外推正是这张表要防的未来函数；
 *   4. **不进裁剪** —— 与影子账本同一档（无法重建）。
 */

import { describe, expect, it } from 'vitest'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import { DEFAULT_RETENTION, pruneAll } from '@main/storage/retention'
import type { SecCode } from '@core/types'

const DRIVER = 'node:sqlite' as const
const CODE = 'SH600000' as SecCode

async function openMemory(): Promise<Storage> {
  return createStorage(await openDatabase({ file: ':memory:', driver: DRIVER, backup: false }))
}

describe('IndustryHistoryRepo', () => {
  it('首条是 FIRST，重复观测同一个行业不再写行', async () => {
    const storage = await openMemory()
    expect(storage.industries.record(CODE, '2026-08-22', '银行')).toBe('FIRST')
    expect(storage.industries.record(CODE, '2026-08-23', '银行')).toBe('UNCHANGED')
    expect(storage.industries.record(CODE, '2026-09-01', '银行')).toBe('UNCHANGED')
    expect(storage.industries.history(CODE)).toHaveLength(1)
  })

  it('行业名变了才写第二行，且标 CHANGE', async () => {
    const storage = await openMemory()
    storage.industries.record(CODE, '2026-08-22', '银行')
    expect(storage.industries.record(CODE, '2026-10-01', '多元金融')).toBe('CHANGE')
    const rows = storage.industries.history(CODE)
    expect(rows.map((r) => [r.observedDate, r.industry, r.note])).toEqual([
      ['2026-08-22', '银行', 'FIRST'],
      ['2026-10-01', '多元金融', 'CHANGE'],
    ])
  })

  it('同一天重复调用幂等 —— 休市维护一天会跑好几轮', async () => {
    const storage = await openMemory()
    storage.industries.record(CODE, '2026-08-22', '银行')
    storage.industries.record(CODE, '2026-08-22', '银行')
    storage.industries.record(CODE, '2026-08-22', '银行')
    expect(storage.industries.history(CODE)).toHaveLength(1)
  })

  it('空行业一个字都不写 —— 「这次没取到」不是「行业变成了空」', async () => {
    const storage = await openMemory()
    expect(storage.industries.record(CODE, '2026-08-22', '')).toBe('UNCHANGED')
    expect(storage.industries.record(CODE, '2026-08-22', '   ')).toBe('UNCHANGED')
    expect(storage.industries.history(CODE)).toHaveLength(0)
    // 而且它不能把已有的那条冲掉
    storage.industries.record(CODE, '2026-08-22', '银行')
    expect(storage.industries.record(CODE, '2026-08-23', '')).toBe('UNCHANGED')
    expect(storage.industries.latest(CODE)?.industry).toBe('银行')
  })

  it('at() 在开始记录之前是 null，不是最早那条 —— 不许把首行往前外推', async () => {
    const storage = await openMemory()
    storage.industries.record(CODE, '2026-08-22', '银行')
    storage.industries.record(CODE, '2026-10-01', '多元金融')

    expect(storage.industries.at(CODE, '2020-01-01')).toBeNull()
    expect(storage.industries.at(CODE, '2026-08-21')).toBeNull()
    expect(storage.industries.at(CODE, '2026-08-22')?.industry).toBe('银行')
    expect(storage.industries.at(CODE, '2026-09-30')?.industry).toBe('银行')
    expect(storage.industries.at(CODE, '2026-10-01')?.industry).toBe('多元金融')
    expect(storage.industries.at(CODE, '2027-01-01')?.industry).toBe('多元金融')
  })

  it('不进裁剪 —— 与影子账本同一档，攒出来的日子买不回来', async () => {
    const storage = await openMemory()
    storage.industries.record(CODE, '2020-01-01', '银行')
    // 远早于任何保留窗口
    pruneAll(storage.db, Date.parse('2026-08-22T00:00:00Z'), DEFAULT_RETENTION)
    expect(storage.industries.history(CODE)).toHaveLength(1)
  })

  it('coverage() 答「这条累积在不在跑」', async () => {
    const storage = await openMemory()
    expect(storage.industries.coverage()).toEqual({
      codes: 0,
      rows: 0,
      firstDate: null,
      lastDate: null,
    })
    storage.industries.record(CODE, '2026-08-22', '银行')
    storage.industries.record('SZ000001' as SecCode, '2026-08-25', '银行')
    expect(storage.industries.coverage()).toEqual({
      codes: 2,
      rows: 2,
      firstDate: '2026-08-22',
      lastDate: '2026-08-25',
    })
  })
})
