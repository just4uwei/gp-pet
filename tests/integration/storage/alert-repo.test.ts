/**
 * 提醒记录仓储（`alert_log`，docs/05 §6）。
 *
 * 驱动用 node:sqlite，理由同 storage.test.ts。
 *
 * 重点验三件事：
 *   - `channel` 列存的是**逗号分隔的渠道列表**，被丢弃的存 NONE（列 NOT NULL）
 *   - 「未读」只算**实际发出过**的：被冷却挡掉的那条从来没打扰过用户
 *   - `signal_id` 是外键（PRAGMA foreign_keys = ON），孤儿行插不进去 ——
 *     这正是 candidates.ts 里「拿不到 signalId 就不发」那条的依据
 */

import { describe, expect, it } from 'vitest'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import type { AlertRow } from '@main/storage/repositories/alert'
import type { SignalEvidencePayload, SignalRow } from '@main/storage/repositories/signal'

const DRIVER = 'node:sqlite' as const
const T0 = 1_700_000_000_000

async function openMemory(): Promise<Storage> {
  return createStorage(await openDatabase({ file: ':memory:', driver: DRIVER, backup: false }))
}

function evidence(headline: string): SignalEvidencePayload {
  return {
    level: 'L2',
    headline,
    reasons: ['均线金叉'],
    suppressed: false,
    subSignals: [],
    adjustments: [],
    verdicts: [],
    scoreByDirection: { BUY: 0.8, SELL: 0.1 },
    indicatorsAt: {},
    regimeEvidence: {},
    sufficiency: { bars: 400, limited: false, penalty: 1, note: null },
  }
}

function signal(id: string, overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    id,
    code: 'SH600000',
    createdAt: T0,
    tradeDate: '2026-08-13',
    direction: 'BUY',
    score: 0.81,
    votes: 3,
    regime: 'TREND_UP',
    stage: 'CONFIRMED',
    priceAt: 12.34,
    engineVersion: '0.2.6-unvalidated',
    evidence: evidence('均线金叉 · 上升趋势'),
    ...overrides,
  }
}

function alert(id: string, overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id,
    signalId: 'sig-1',
    level: 'L2',
    channels: ['PET', 'TRAY', 'BUBBLE'],
    suppressedReason: null,
    readAt: null,
    createdAt: T0,
    ...overrides,
  }
}

describe('AlertRepo', () => {
  it('渠道列表存取往返，被丢弃的存空数组', async () => {
    const storage = await openMemory()
    storage.signals.insert(signal('sig-1'))
    storage.alerts.insert(alert('a1'))
    storage.alerts.insert(alert('a2', { channels: [], suppressedReason: '同键冷却：还有 90 分钟' }))

    expect(storage.alerts.get('a1')?.channels).toEqual(['PET', 'TRAY', 'BUBBLE'])
    expect(storage.alerts.get('a2')?.channels).toEqual([])
    expect(storage.alerts.get('a2')?.suppressedReason).toContain('冷却')
    storage.close()
  })

  it('未读只算实际发出过的 —— 被闸门挡掉的那条从来没打扰过用户', async () => {
    const storage = await openMemory()
    storage.signals.insert(signal('sig-1'))
    storage.alerts.insertMany([
      alert('a1'),
      alert('a2', { channels: [], suppressedReason: '防抖' }),
      alert('a3', { channels: ['PET', 'TRAY'] }),
    ])

    expect(storage.alerts.unreadCount()).toBe(2)
    expect(storage.alerts.markAllRead(T0 + 1000)).toBe(2)
    expect(storage.alerts.unreadCount()).toBe(0)
    storage.close()
  })

  it('按 id 标记已读，已读过的不重复计数', async () => {
    const storage = await openMemory()
    storage.signals.insert(signal('sig-1'))
    storage.alerts.insertMany([alert('a1'), alert('a2')])

    expect(storage.alerts.markRead(['a1'], T0 + 1)).toBe(1)
    expect(storage.alerts.markRead(['a1'], T0 + 2)).toBe(0)
    expect(storage.alerts.unreadCount()).toBe(1)
    expect(storage.alerts.markRead([], T0 + 3)).toBe(0)
    storage.close()
  })

  it('联表取出方向、得分与 headline —— 提醒日志一行要显示的都在这', async () => {
    const storage = await openMemory()
    storage.signals.insert(signal('sig-1'))
    storage.signals.insert(
      signal('sig-2', {
        code: 'SZ000001',
        direction: 'SELL',
        score: 0.42,
        createdAt: T0 + 5000,
        evidence: evidence('触及止损线'),
      })
    )
    storage.alerts.insertMany([
      alert('a1', { signalId: 'sig-1' }),
      alert('a2', { signalId: 'sig-2', createdAt: T0 + 5000, level: 'L3' }),
    ])

    const rows = storage.alerts.query({ from: T0 })
    // 时间倒序
    expect(rows.map((r) => r.id)).toEqual(['a2', 'a1'])
    expect(rows[0]?.code).toBe('SZ000001')
    expect(rows[0]?.direction).toBe('SELL')
    expect(rows[0]?.score).toBeCloseTo(0.42, 10)
    expect(rows[0]?.headline).toBe('触及止损线')
    expect(storage.alerts.query({ code: 'SH600000' }).map((r) => r.id)).toEqual(['a1'])
    storage.close()
  })

  it('evidence 坏掉时 headline 退化为空串，整行仍能列出来', async () => {
    const storage = await openMemory()
    storage.signals.insert(signal('sig-1'))
    storage.db.prepare(`UPDATE signal SET evidence = ? WHERE id = ?`).run('{ 不是 JSON', 'sig-1')
    storage.alerts.insert(alert('a1'))

    const rows = storage.alerts.query()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.headline).toBe('')
    storage.close()
  })

  it('signal_id 是外键：孤儿提醒插不进去', async () => {
    const storage = await openMemory()
    expect(() => storage.alerts.insert(alert('a1', { signalId: '不存在' }))).toThrow()
    storage.close()
  })
})
