/**
 * 影子账本的存储层（schema v2，migrations/002_shadow.sql）。
 *
 * 两条重点：
 *
 * 1. **影子记录不受保留策略裁剪。** `shadow_trade` 刻意**不加**指向 signal(id) 的外键，
 *    因为 signal 按 2 年裁剪，而绩效记录要长期留着。加了外键，裁剪那天会连带删掉
 *    影子历史 —— 那等于把「绩效记录」挂在「日志保留策略」上。
 * 2. **`hasDate` 是推进的幂等闸门。** 它错了，盘后每轮 tick 都会多加一根净值点，
 *    而净值曲线会看起来「多了一段」，从收益率上完全看不出来。
 *
 * 驱动用 node:sqlite，理由同 storage.test.ts。
 */

import { describe, expect, it } from 'vitest'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import { LATEST_SCHEMA_VERSION } from '@main/storage/migrations'
import { SHADOW_KEYS } from '@main/storage/repositories/shadow'
import { pruneAll } from '@main/storage/retention'
import type { ShadowOrder, ShadowPosition, ShadowTrade } from '@main/shadow'

const DRIVER = 'node:sqlite' as const

async function openMemory(): Promise<Storage> {
  return createStorage(await openDatabase({ file: ':memory:', driver: DRIVER, backup: false }))
}

function order(over: Partial<ShadowOrder> = {}): ShadowOrder {
  return {
    code: 'SH600000',
    action: 'BUY',
    placedDate: '2026-08-12',
    rule: 'T1_MA_CROSS',
    score: 0.7,
    regime: 'RANGE',
    signalId: 'sig-1',
    deferred: 0,
    ...over,
  }
}

function position(over: Partial<ShadowPosition> = {}): ShadowPosition {
  return {
    code: 'SH600000',
    shares: 1000,
    entryDate: '2026-08-05',
    entryPriceAdj: 10.01,
    entryPriceRaw: 10.01,
    entryCosts: 12.5,
    entryRegime: 'RANGE',
    entryScore: 0.7,
    entryRule: 'T1_MA_CROSS',
    peakRaw: 11,
    lastCloseAdj: 10.8,
    barsHeld: 6,
    engineVersion: 'v1',
    ...over,
  }
}

function trade(over: Partial<ShadowTrade> = {}): ShadowTrade {
  return {
    id: 't1',
    code: 'SH600000',
    entryDate: '2026-08-05',
    exitDate: '2026-08-12',
    entryPrice: 10.01,
    exitPrice: 10.99,
    entryPriceRaw: 10,
    exitPriceRaw: 11,
    shares: 1000,
    pnl: 950,
    pnlPct: 0.098,
    holdingBars: 6,
    costs: 30,
    regimeAtEntry: 'RANGE',
    entryScore: 0.7,
    exitRule: 'RISK_STOP_LOSS',
    partial: false,
    engineVersion: 'v1',
    ...over,
  }
}

describe('迁移', () => {
  it('schema 版本至少到 v2（影子表在这一版加进来）', async () => {
    const storage = await openMemory()
    try {
      expect(storage.db.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(2)
      // 四张表都建出来了
      expect(storage.shadow.orders()).toEqual([])
      expect(storage.shadow.positions()).toEqual([])
      expect(storage.shadow.trades()).toEqual([])
      expect(storage.shadow.equity()).toEqual([])
    } finally {
      storage.close()
    }
  })
})

describe('委托与持仓', () => {
  it('一只标的同时最多一张委托，重复 put 是覆盖', async () => {
    const storage = await openMemory()
    try {
      storage.shadow.putOrder(order())
      storage.shadow.putOrder(order({ action: 'SELL', deferred: 2 }))
      const rows = storage.shadow.orders()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.action).toBe('SELL')
      expect(rows[0]?.deferred).toBe(2)

      storage.shadow.clearOrder('SH600000')
      expect(storage.shadow.orders()).toEqual([])
    } finally {
      storage.close()
    }
  })

  it('持仓往返不丢字段（双轨价格、峰值、持有根数）', async () => {
    const storage = await openMemory()
    try {
      const held = position()
      storage.shadow.putPosition(held)
      expect(storage.shadow.position('SH600000')).toEqual(held)
      expect(storage.shadow.position('SZ000001')).toBeNull()
    } finally {
      storage.close()
    }
  })

  it('signalId 允许为空 —— 拿不到 signal 行时委托照样要能落库', async () => {
    const storage = await openMemory()
    try {
      storage.shadow.putOrder(order({ signalId: null }))
      expect(storage.shadow.orders()[0]?.signalId).toBeNull()
    } finally {
      storage.close()
    }
  })
})

describe('交易', () => {
  it('trades() 默认按时间正序，带 limit 时取最近若干条并翻回正序', async () => {
    const storage = await openMemory()
    try {
      storage.shadow.insertTrade(trade({ id: 'a', exitDate: '2026-08-01' }))
      storage.shadow.insertTrade(trade({ id: 'b', exitDate: '2026-08-05' }))
      storage.shadow.insertTrade(trade({ id: 'c', exitDate: '2026-08-12' }))

      expect(storage.shadow.trades().map((t) => t.id)).toEqual(['a', 'b', 'c'])
      expect(storage.shadow.trades(2).map((t) => t.id)).toEqual(['b', 'c'])
      expect(storage.shadow.tradeCount()).toBe(3)
    } finally {
      storage.close()
    }
  })

  it('partial 的布尔往返正确（库里是 0/1）', async () => {
    const storage = await openMemory()
    try {
      storage.shadow.insertTrade(trade({ id: 'a', partial: true }))
      storage.shadow.insertTrade(trade({ id: 'b', partial: false }))
      const rows = storage.shadow.trades()
      expect(rows.find((t) => t.id === 'a')?.partial).toBe(true)
      expect(rows.find((t) => t.id === 'b')?.partial).toBe(false)
    } finally {
      storage.close()
    }
  })
})

describe('净值曲线', () => {
  it('trade_date 是主键 → 重复写同一天是覆盖，不是追加', async () => {
    const storage = await openMemory()
    try {
      storage.shadow.putEquity({
        date: '2026-08-12',
        cash: 1_000_000,
        positionValue: 0,
        equity: 1_000_000,
        benchmark: 4000,
      })
      storage.shadow.putEquity({
        date: '2026-08-12',
        cash: 900_000,
        positionValue: 110_000,
        equity: 1_010_000,
        benchmark: 4010,
      })
      const rows = storage.shadow.equity()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.equity).toBe(1_010_000)
      expect(storage.shadow.barCount()).toBe(1)
    } finally {
      storage.close()
    }
  })

  it('hasDate 是推进的幂等闸门', async () => {
    const storage = await openMemory()
    try {
      expect(storage.shadow.hasDate('2026-08-12')).toBe(false)
      storage.shadow.putEquity({
        date: '2026-08-12',
        cash: 1,
        positionValue: 0,
        equity: 1,
        benchmark: null,
      })
      expect(storage.shadow.hasDate('2026-08-12')).toBe(true)
      expect(storage.shadow.hasDate('2026-08-13')).toBe(false)
    } finally {
      storage.close()
    }
  })

  it('benchmark 允许为 null —— 那天拿不到基准时不填 0（0 会被读成基准归零）', async () => {
    const storage = await openMemory()
    try {
      storage.shadow.putEquity({
        date: '2026-08-12',
        cash: 1,
        positionValue: 0,
        equity: 1,
        benchmark: null,
      })
      expect(storage.shadow.equity()[0]?.benchmark).toBeNull()
    } finally {
      storage.close()
    }
  })
})

describe('与保留策略的关系', () => {
  it('裁剪不动影子账本 —— 绩效记录不该挂在日志保留策略上', async () => {
    const storage = await openMemory()
    try {
      // 一条 3 年前的模拟交易：若挂了外键或被 alertDays 一类的窗口带上，这里就会归零
      storage.shadow.insertTrade(trade({ id: 'old', entryDate: '2023-01-05', exitDate: '2023-01-12' }))
      storage.shadow.putEquity({
        date: '2023-01-12',
        cash: 1_000_000,
        positionValue: 0,
        equity: 1_000_000,
        benchmark: 4000,
      })
      storage.shadow.putPosition(position())
      storage.shadow.putOrder(order())

      pruneAll(storage.db, Date.UTC(2026, 7, 13))

      expect(storage.shadow.tradeCount()).toBe(1)
      expect(storage.shadow.barCount()).toBe(1)
      expect(storage.shadow.positions()).toHaveLength(1)
      expect(storage.shadow.orders()).toHaveLength(1)
    } finally {
      storage.close()
    }
  })
})

describe('reset', () => {
  it('清四张表并清掉全部 meta 状态键', async () => {
    const storage = await openMemory()
    try {
      storage.shadow.putOrder(order())
      storage.shadow.putPosition(position())
      storage.shadow.insertTrade(trade())
      storage.shadow.putEquity({
        date: '2026-08-12',
        cash: 1,
        positionValue: 0,
        equity: 1,
        benchmark: null,
      })
      storage.meta.setNumber(SHADOW_KEYS.startedAt, 123)
      storage.meta.setNumber(SHADOW_KEYS.cash, 999)
      storage.meta.set(SHADOW_KEYS.engineVersion, 'v1')

      storage.shadow.reset()

      expect(storage.shadow.orders()).toEqual([])
      expect(storage.shadow.positions()).toEqual([])
      expect(storage.shadow.trades()).toEqual([])
      expect(storage.shadow.equity()).toEqual([])
      for (const key of Object.values(SHADOW_KEYS)) {
        expect(storage.meta.get(key)).toBeNull()
      }
    } finally {
      storage.close()
    }
  })

  it('不碰自选、持仓与 K 线 —— reset 只清影子账本', async () => {
    const storage = await openMemory()
    try {
      storage.watchlist.add(
        { code: 'SH600000', name: '浦发银行', market: 'SH', board: 'MAIN', isST: false },
        '自选',
        1
      )
      storage.positions.set('SH600000', 1000, 10, 1)
      storage.shadow.reset()
      expect(storage.watchlist.count()).toBe(1)
      expect(storage.positions.list()).toHaveLength(1)
    } finally {
      storage.close()
    }
  })
})
