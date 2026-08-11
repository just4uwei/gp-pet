/**
 * 临时当日 K 线（docs/04 §6）。
 *
 * 这里守的是一条界线：**拼不出来就不要拼**。少一根真实数据只是信号晚一天，
 * 多一根编出来的数据会让指标算出根本不存在的穿越。
 */

import { describe, expect, it } from 'vitest'
import { adjustmentFactor, provisionalCandle, withProvisional } from '@core/candle'
import type { Candle, Snapshot, TradeDate } from '@core/types'

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    code: 'SH600000',
    at: 1_754_900_000_000,
    last: 10.5,
    open: 10.1,
    high: 10.6,
    low: 10.0,
    preClose: 10.2,
    volume: 3_000_000,
    amount: 31_000_000,
    limitUp: 11.22,
    limitDown: 9.18,
    suspended: false,
    ...over,
  }
}

/** 造一根内部一致的 K 线；factor 为前复权因子 */
function candle(date: TradeDate, close: number, factor = 1): Candle {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    openAdj: close * factor,
    highAdj: close * factor,
    lowAdj: close * factor,
    closeAdj: close * factor,
    volume: 1_000_000,
    amount: close * 1_000_000,
  }
}

describe('adjustmentFactor', () => {
  it('由上一根反算 closeAdj / close', () => {
    expect(adjustmentFactor(candle('2026-08-10', 10, 0.8))).toBeCloseTo(0.8, 10)
  })

  it('没有上一根、或上一根价格非正 → 1，不返回 0 或 NaN', () => {
    expect(adjustmentFactor(null)).toBe(1)
    expect(adjustmentFactor(undefined)).toBe(1)
    expect(adjustmentFactor({ close: 0, closeAdj: 0 })).toBe(1)
    expect(adjustmentFactor({ close: 10, closeAdj: 0 })).toBe(1)
  })
})

describe('provisionalCandle', () => {
  it('快照直接映射为当日线，并沿用上一根的复权系数', () => {
    const prev = candle('2026-08-10', 10, 0.5)
    const bar = provisionalCandle(snapshot(), '2026-08-11', prev)
    expect(bar).toMatchObject({
      date: '2026-08-11',
      open: 10.1,
      high: 10.6,
      low: 10.0,
      close: 10.5,
      volume: 3_000_000,
      amount: 31_000_000,
      provisional: true,
    })
    expect(bar?.closeAdj).toBeCloseTo(5.25, 10)
    expect(bar?.openAdj).toBeCloseTo(5.05, 10)
  })

  it('停牌不拼 —— 交易所当天也没有这根', () => {
    expect(provisionalCandle(snapshot({ suspended: true }), '2026-08-11')).toBeNull()
  })

  it('最新价为 0（竞价前部分源如此）不拼，否则会伪造成跌停', () => {
    expect(provisionalCandle(snapshot({ last: 0 }), '2026-08-11')).toBeNull()
    expect(provisionalCandle(snapshot({ last: Number.NaN }), '2026-08-11')).toBeNull()
  })

  it('当日收盘线已入库时不拼 —— 真实收盘线不该被临时线覆盖', () => {
    const closed = candle('2026-08-11', 10.4)
    expect(provisionalCandle(snapshot(), '2026-08-11', closed)).toBeNull()
    // 更晚的历史（数据源错位）同样拒绝
    expect(provisionalCandle(snapshot(), '2026-08-11', candle('2026-08-12', 10.4))).toBeNull()
  })

  it('最新价越出源给的 high/low 时取包络，绝不产出 close 越界的非法 K 线', () => {
    const bar = provisionalCandle(snapshot({ last: 11.0, high: 10.6, low: 10.0 }), '2026-08-11')
    expect(bar?.high).toBe(11.0)
    const down = provisionalCandle(snapshot({ last: 9.5, high: 10.6, low: 10.0 }), '2026-08-11')
    expect(down?.low).toBe(9.5)
    expect(down?.high).toBe(10.6)
  })

  it('缺开盘价时退到最新价，而不是 0', () => {
    const bar = provisionalCandle(snapshot({ open: 0, high: 0, low: 0, last: 10.5 }), '2026-08-11')
    expect(bar).toMatchObject({ open: 10.5, high: 10.5, low: 10.5, close: 10.5 })
  })

  it('零成交量保留为 0（未开盘/无成交是事实），成交额缺失不冒充', () => {
    const bar = provisionalCandle(snapshot({ volume: 0, amount: 0 }), '2026-08-11')
    expect(bar?.volume).toBe(0)
    expect(bar?.amount).toBe(0)
    expect(provisionalCandle(snapshot({ amount: Number.NaN }), '2026-08-11')?.amount).toBeNull()
  })
})

describe('withProvisional', () => {
  const history = [candle('2026-08-07', 10, 0.5), candle('2026-08-10', 10.2, 0.5)]

  it('接在尾部，且不改动传入的历史数组', () => {
    const { candles, provisional } = withProvisional(history, snapshot(), '2026-08-11')
    expect(provisional).toBe(true)
    expect(candles).toHaveLength(3)
    expect(candles[2]?.provisional).toBe(true)
    expect(candles[2]?.closeAdj).toBeCloseTo(5.25, 10)
    expect(history).toHaveLength(2)
  })

  it('没有快照、或拼不出来时原样返回历史', () => {
    expect(withProvisional(history, null, '2026-08-11')).toMatchObject({ provisional: false })
    expect(withProvisional(history, snapshot({ suspended: true }), '2026-08-11').candles).toHaveLength(2)
  })

  it('历史为空也能只靠快照给出一根', () => {
    const { candles } = withProvisional([], snapshot(), '2026-08-11')
    expect(candles).toHaveLength(1)
    // 没有上一根 → 系数 1，前复权等于原价
    expect(candles[0]?.closeAdj).toBe(10.5)
  })
})
