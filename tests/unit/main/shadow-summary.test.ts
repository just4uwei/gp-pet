/**
 * 影子运行的绩效汇总口径（docs/07 §2.3）。
 *
 * 这里守的是**措辞与口径**，不是算术 —— 算术在 `backtest/metrics` 那边已经有测试。
 * 每一条都对应一种「数字对了但会被读错」的写法：
 *
 * - 「还没开始」不能显示成一屏 0（那读作「跑了但没赚到」）
 * - 满 90 天前 `seasoned` 必须为 false，UI 据它决定能不能下结论
 * - 胜率两个口径必须都算且**不相等**（减仓会把一次建仓拆成多笔）
 * - 算不出来的一律 null，不用 0 顶替
 */

import { describe, expect, it } from 'vitest'
import { SEASONING_DAYS, emptyShadowSummary, summarize, toTradeView } from '@main/shadow'
import type { ShadowPosition, ShadowTrade } from '@main/shadow'
import type { ShadowEquityPoint } from '@main/storage/repositories/shadow'

const DAY = 24 * 60 * 60 * 1000
const START = Date.UTC(2026, 0, 5)

function equity(rows: [string, number, number | null][]): ShadowEquityPoint[] {
  return rows.map(([date, value, benchmark]) => ({
    date,
    cash: value,
    positionValue: 0,
    equity: value,
    benchmark,
  }))
}

function trade(over: Partial<ShadowTrade> = {}): ShadowTrade {
  return {
    id: 't1',
    code: 'SH600000',
    entryDate: '2026-01-05',
    exitDate: '2026-01-12',
    entryPrice: 10,
    exitPrice: 11,
    entryPriceRaw: 10,
    exitPriceRaw: 11,
    shares: 1000,
    pnl: 900,
    pnlPct: 0.1,
    holdingBars: 5,
    costs: 100,
    regimeAtEntry: 'RANGE',
    entryScore: 0.7,
    exitRule: 'T1_MA_CROSS',
    partial: false,
    engineVersion: 'v1',
    ...over,
  }
}

function base(over: Partial<Parameters<typeof summarize>[0]> = {}): Parameters<typeof summarize>[0] {
  return {
    startedAt: START,
    startedDate: '2026-01-05',
    startCapital: 1_000_000,
    equity: [],
    trades: [],
    positions: [],
    orders: [],
    skippedNoCash: 0,
    limitBlocked: 0,
    engineVersion: 'v1',
    stalledEngineVersion: null,
    lastTradingDate: null,
    now: START + 10 * DAY,
    ...over,
  }
}

describe('空壳', () => {
  it('未开始时 startedAt 为 null，而不是一屏 0 —— 「没开始」与「持平」是两件事', () => {
    const summary = emptyShadowSummary('v1')
    expect(summary.startedAt).toBeNull()
    expect(summary.seasoned).toBe(false)
    // 「算不出来」的一律 null
    expect(summary.sharpe).toBeNull()
    expect(summary.annualized).toBeNull()
    expect(summary.benchmarkReturn).toBeNull()
    expect(summary.exposure).toBeNull()
    expect(summary.trades.winRate).toBeNull()
    expect(summary.entries.winRate).toBeNull()
  })
})

describe('观察期', () => {
  it('不足 90 天 → seasoned false，且报出还差多少', () => {
    const summary = summarize(base({ now: START + 89 * DAY }))
    expect(summary.calendarDays).toBe(89)
    expect(summary.seasoned).toBe(false)
    expect(summary.seasoningDays).toBe(SEASONING_DAYS)
  })

  it('满 90 天 → seasoned true', () => {
    expect(summarize(base({ now: START + 90 * DAY })).seasoned).toBe(true)
  })

  it('startedAt 为 null 时 calendarDays 是 0，不是一个由 null 算出来的巨大数字', () => {
    const summary = summarize(base({ startedAt: null, startedDate: null }))
    expect(summary.calendarDays).toBe(0)
    expect(summary.seasoned).toBe(false)
  })
})

describe('组合口径', () => {
  it('累计收益按起始资金算，含未平仓的盯市市值', () => {
    const position: ShadowPosition = {
      code: 'SH600000',
      shares: 1000,
      entryDate: '2026-01-05',
      entryPriceAdj: 10,
      entryPriceRaw: 10,
      entryCosts: 10,
      entryRegime: 'RANGE',
      entryScore: 0.7,
      entryRule: 'T1',
      peakRaw: 12,
      lastCloseAdj: 12,
      barsHeld: 5,
      engineVersion: 'v1',
    }
    const summary = summarize(
      base({
        equity: [{ date: '2026-01-12', cash: 990_000, positionValue: 12_000, equity: 1_002_000, benchmark: 4000 }],
        positions: [position],
      })
    )
    // 现金 990,000 + 持仓 1000 × 12 = 1,002,000
    expect(summary.equity).toBe(1_002_000)
    expect(summary.totalReturn).toBeCloseTo(0.002, 6)
    expect(summary.positionValue).toBe(12_000)
  })

  it('基准两端都要有值才算同期收益，只有一端时给 null', () => {
    const both = summarize(
      base({ equity: equity([['2026-01-05', 1_000_000, 4000], ['2026-01-12', 1_010_000, 4200]]) })
    )
    expect(both.benchmarkReturn).toBeCloseTo(0.05, 6)

    const tailMissing = summarize(
      base({ equity: equity([['2026-01-05', 1_000_000, 4000], ['2026-01-12', 1_010_000, null]]) })
    )
    expect(tailMissing.benchmarkReturn).toBeNull()
  })

  it('资金占用率按逐日持仓市值 ÷ 当日净值算 —— 缺它会把基准对比读反', () => {
    const summary = summarize(
      base({
        equity: [
          { date: '2026-01-05', cash: 900_000, positionValue: 100_000, equity: 1_000_000, benchmark: null },
          { date: '2026-01-06', cash: 1_000_000, positionValue: 0, equity: 1_000_000, benchmark: null },
        ],
      })
    )
    // 一天 10%、一天 0% → 均值 5%
    expect(summary.exposure).toBeCloseTo(0.05, 6)
  })

  it('只有一个净值点时夏普为 null，不是 0（0 会被读成「风险调整后不赚不亏」）', () => {
    expect(summarize(base({ equity: equity([['2026-01-05', 1_000_000, null]]) })).sharpe).toBeNull()
  })
})

describe('两个胜率口径', () => {
  it('减仓拆出的两笔算**一次**建仓 —— 这是用户口径', () => {
    const summary = summarize(
      base({
        trades: [
          trade({ id: 'a', shares: 500, pnl: -300, pnlPct: -0.03, partial: true }),
          trade({ id: 'b', shares: 500, pnl: 900, pnlPct: 0.09 }),
        ],
      })
    )
    // 逐笔：2 笔，1 赢 → 50%
    expect(summary.trades.count).toBe(2)
    expect(summary.trades.winRate).toBeCloseTo(0.5, 6)
    // 建仓级：同一 code + entryDate → 1 次，净 +600 → 100%
    expect(summary.entries.count).toBe(1)
    expect(summary.entries.winRate).toBe(1)
    expect(summary.entries.reduced).toBe(1)
  })

  it('同一标的不同建仓日算两次建仓', () => {
    const summary = summarize(
      base({
        trades: [
          trade({ id: 'a', entryDate: '2026-01-05' }),
          trade({ id: 'b', entryDate: '2026-02-05', pnl: -500 }),
        ],
      })
    )
    expect(summary.entries.count).toBe(2)
    expect(summary.entries.winRate).toBeCloseTo(0.5, 6)
  })
})

describe('交易视图', () => {
  it('展示用**不复权**价（「我买在多少」），净值口径的前复权价不出现在列表里', () => {
    const view = toTradeView(trade({ entryPrice: 8, entryPriceRaw: 10, exitPrice: 9, exitPriceRaw: 11 }), '浦发银行')
    expect(view.entryPrice).toBe(10)
    expect(view.exitPrice).toBe(11)
    expect(view.name).toBe('浦发银行')
  })
})
