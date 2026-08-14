/**
 * 观察点仓储与它的两处**外键顺序**（migration 003）。
 *
 * `foreign_keys = ON`，而 `watch_point` 同时指向 `watchlist(code)` 与 `signal(id)`。
 * 两个删除顺序错了的症状都是运行时 `FOREIGN KEY constraint failed`：
 *   ① 移出自选时必须先清观察点（`WatchlistRepo.remove`）
 *   ② 裁剪时必须先清观察点再删信号（`pruneAll`）
 * 这两条各有一条用例钉着 —— 它们不是理论风险，是「点一下删除就崩」。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecCode, SecProfile, TradeDate } from '@core/types'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import { pruneAll, DEFAULT_RETENTION } from '@main/storage/retention'
import type { WatchPointRow } from '@main/storage/repositories/watch'

const DRIVER = 'node:sqlite' as const
const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000
const CODE = 'SH600000' as SecCode

let dir: string
let storage: Storage

const profile: SecProfile = {
  code: CODE,
  name: '浦发银行',
  market: 'SH',
  board: 'MAIN',
  isST: false,
}

/** 观察点的两个外键都要有真行，否则 insert 自己就会被拒 */
function seed(signalId = 'sig-1', createdAt = NOW): void {
  storage.watchlist.add(profile, '默认', createdAt)
  storage.signals.insert({
    id: signalId,
    code: CODE,
    createdAt,
    tradeDate: '2026-08-13' as TradeDate,
    direction: 'BUY',
    score: 0.7,
    votes: 3,
    regime: 'TREND_UP',
    stage: 'CONFIRMED',
    priceAt: 10,
    engineVersion: '0.2.6-unvalidated',
    evidence: {
      level: 'L2',
      headline: '均线金叉 · 上升趋势',
      reasons: [],
      suppressed: false,
      subSignals: [],
      adjustments: [],
      verdicts: [],
      scoreByDirection: {},
      indicatorsAt: {},
      regimeEvidence: {},
      sufficiency: { bars: 300, limited: false, penalty: 1, note: null },
    },
  })
}

function point(overrides: Partial<WatchPointRow> = {}): WatchPointRow {
  return {
    id: 'w1',
    code: CODE,
    signalId: 'sig-1',
    source: 'AI_SUGGESTED',
    metric: 'PRICE',
    op: 'LTE',
    threshold: 8.2,
    meaning: 'INVALIDATE',
    engineVersion: '0.2.6-unvalidated',
    createdAt: NOW,
    expiresAt: NOW + 28 * DAY,
    status: 'ACTIVE',
    ...overrides,
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gp-watch-'))
  storage = createStorage(
    await openDatabase({ file: join(dir, 'market.db'), driver: DRIVER, backup: false })
  )
})

afterEach(() => {
  storage.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WatchPointRepo', () => {
  it('落库后读得回来，可选字段缺省时不出现在对象里', () => {
    seed()
    storage.watchPoints.insert(point())
    const row = storage.watchPoints.get('w1')
    expect(row).toMatchObject({ code: CODE, metric: 'PRICE', op: 'LTE', threshold: 8.2 })
    expect(row).not.toHaveProperty('note')
    expect(row).not.toHaveProperty('hitAt')
  })

  it('active() 只给 ACTIVE 的', () => {
    seed()
    storage.watchPoints.insert(point({ id: 'a' }))
    storage.watchPoints.insert(point({ id: 'b', status: 'HIT' }))
    storage.watchPoints.insert(point({ id: 'c', status: 'CANCELED' }))
    expect(storage.watchPoints.active().map((r) => r.id)).toEqual(['a'])
    expect(storage.watchPoints.countActive()).toBe(1)
  })

  /**
   * `markHit` 的 `WHERE status = 'ACTIVE'` 是**幂等闸门**：盘后会跑好几轮 tick，
   * 少了它同一个观察点每轮都会被记一次命中（而命中时刻会被后一轮覆盖）。
   */
  it('markHit 是幂等的：第二次返回 false，不覆盖命中时刻', () => {
    seed()
    storage.watchPoints.insert(point())
    expect(storage.watchPoints.markHit('w1', NOW, 8.15)).toBe(true)
    expect(storage.watchPoints.markHit('w1', NOW + 60_000, 8.0)).toBe(false)
    const row = storage.watchPoints.get('w1')
    expect(row?.hitAt).toBe(NOW)
    expect(row?.hitValue).toBe(8.15)
  })

  it('过期只对 ACTIVE 生效', () => {
    seed()
    storage.watchPoints.insert(point())
    expect(storage.watchPoints.markExpired('w1')).toBe(true)
    expect(storage.watchPoints.markExpired('w1')).toBe(false)
  })

  it('remove() 真删行，且不限状态 —— 已命中/已过期的也能清掉', () => {
    // 「不盯了」是删记录不是改状态：一条被主动放弃的观察点不构成结论，
    // 与「到期未命中」（那是「当时那个判断没兑现」）不是一回事
    seed()
    storage.watchPoints.insert(point())
    storage.watchPoints.markExpired('w1')
    expect(storage.watchPoints.remove('w1')).toBe(true)
    expect(storage.watchPoints.get('w1')).toBeNull()
    // 已经不在了：返回 false，让调用方能分辨「删掉了」与「本来就没有」
    expect(storage.watchPoints.remove('w1')).toBe(false)
  })

  it('list() 把 ACTIVE 排在最前 —— 「在盯什么」比历史重要', () => {
    seed()
    storage.watchPoints.insert(point({ id: 'old-hit', status: 'HIT', createdAt: NOW + 1000 }))
    storage.watchPoints.insert(point({ id: 'active', createdAt: NOW }))
    expect(storage.watchPoints.list().map((r) => r.id)).toEqual(['active', 'old-hit'])
  })
})

describe('外键顺序', () => {
  it('移出自选时连带清掉观察点，**不撞外键**', () => {
    seed()
    storage.watchPoints.insert(point())
    storage.positions.set(CODE, 100, 10, NOW)

    expect(() => storage.watchlist.remove(CODE)).not.toThrow()
    expect(storage.watchPoints.get('w1')).toBeNull()
  })

  it('裁剪时先清观察点再删信号，**不撞外键**', () => {
    const old = NOW - (DEFAULT_RETENTION.signalDays + 10) * DAY
    seed('sig-old', old)
    // 已结束的观察点：来源信号即将被裁掉
    storage.watchPoints.insert(
      point({ id: 'done', signalId: 'sig-old', status: 'HIT', createdAt: old })
    )

    const report = pruneAll(storage.db, NOW)
    expect(report.watchDeleted).toBe(1)
    expect(report.signalDeleted).toBe(1)
    expect(storage.watchPoints.get('done')).toBeNull()
  })

  /**
   * ACTIVE 的观察点**不许**被裁掉 —— 那是用户明确要跟踪的东西。
   * 于是它的来源信号也不能被删（外键），这一条顺带证明裁剪不会把库搞坏。
   */
  it('ACTIVE 的观察点不被裁剪，其来源信号也跟着留下', () => {
    const old = NOW - (DEFAULT_RETENTION.signalDays + 10) * DAY
    seed('sig-old', old)
    storage.watchPoints.insert(point({ id: 'alive', signalId: 'sig-old', createdAt: old }))

    // 来源信号还被 ACTIVE 观察点引着，裁剪不该删它（删了就撞外键）
    expect(() => pruneAll(storage.db, NOW)).not.toThrow()
    expect(storage.watchPoints.get('alive')?.status).toBe('ACTIVE')
    expect(storage.signals.get('sig-old')).not.toBeNull()
  })
})
