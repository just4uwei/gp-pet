/**
 * 多周期共振 M1–M3（docs/04 §3.3）。
 *
 * 它们不产出信号，只产出**调整项**（可为负）。因此断言的是 id、方向与 delta 符号 ——
 * delta 的具体大小是待标定参数（params.multiTf），断言它等于 0.1 会让标定后测试全红。
 */

import { describe, expect, it } from 'vitest'
import { multiTfAdjustments } from '@core/strategies/multi-tf'
import { DEFAULT_PARAMS } from '@core/params'
import type { WeeklyIndicators } from '@core/indicators'
import type { StrategyContext } from '@core/strategies/context'
import { buildCandles, type BarOverride } from '../../fixtures/klines'
import { FULL_SUFFICIENCY, makeIndicators, series, type IndicatorSpec } from '../../fixtures/indicators'

const P = DEFAULT_PARAMS
const LEN = 8
const LAST = LEN - 1

function ctx(spec: IndicatorSpec, overrides: Record<number, BarOverride> = {}): StrategyContext {
  return {
    candles: buildCandles(new Array<number>(LEN).fill(10), { overrides }),
    ind: makeIndicators(LEN, spec),
    index: LAST,
    regime: 'TRANSITION',
    params: P,
    sufficiency: { ...FULL_SUFFICIENCY },
  }
}

/** 周线：6 根，最后一根附近发生金叉 / 死叉 */
function weekly(options: {
  cross?: 'GOLDEN' | 'DEAD' | 'NONE'
  crossAt?: number
  adx?: number | null
}): WeeklyIndicators {
  const n = 6
  const { cross = 'NONE', crossAt = n - 1, adx = 30 } = options
  const dif: (number | null)[] = new Array<number | null>(n).fill(0)
  const dea: (number | null)[] = new Array<number | null>(n).fill(0)
  for (let i = 0; i < n; i++) {
    dea[i] = 1
    dif[i] = cross === 'GOLDEN' ? (i >= crossAt ? 2 : 0) : cross === 'DEAD' ? (i >= crossAt ? 0 : 2) : 0
  }
  return {
    dif: series(n, dif),
    dea: series(n, dea),
    hist: series(n, 0),
    adx: series(n, adx),
    length: n,
  }
}

describe('M1 周线拐头 + 日线未过热', () => {
  it('BUY：周线近 3 周内金叉且日线 RSI 低于阈值', () => {
    const result = multiTfAdjustments(ctx({ rsi: 40 }), weekly({ cross: 'GOLDEN', crossAt: 4 }))
    const m1 = result.find((a) => a.id === 'M1_WEEK_MACD_DAY_RSI')
    expect(m1?.direction).toBe('BUY')
    expect(m1?.delta ?? 0).toBeGreaterThan(0)
  })

  it('BUY 反例：日线 RSI 已经很高 —— 周线拐头但日线追高，不给加成', () => {
    const result = multiTfAdjustments(ctx({ rsi: 60 }), weekly({ cross: 'GOLDEN', crossAt: 4 }))
    expect(result.some((a) => a.id === 'M1_WEEK_MACD_DAY_RSI')).toBe(false)
  })

  it('BUY 反例：金叉发生在 3 周之前', () => {
    const result = multiTfAdjustments(ctx({ rsi: 40 }), weekly({ cross: 'GOLDEN', crossAt: 1 }))
    expect(result.some((a) => a.id === 'M1_WEEK_MACD_DAY_RSI')).toBe(false)
  })

  it('SELL：周线死叉 + 日线 RSI 偏高', () => {
    const result = multiTfAdjustments(ctx({ rsi: 60 }), weekly({ cross: 'DEAD', crossAt: 4 }))
    expect(result.find((a) => a.id === 'M1_WEEK_MACD_DAY_RSI')?.direction).toBe('SELL')
  })
})

describe('M2 / M3 周线趋势与突破', () => {
  const breakoutUp: IndicatorSpec = { upper: 10.5, lower: 9.5, mid: 10 }
  const aboveBand: Record<number, BarOverride> = { [LAST]: { close: 11, high: 11.2, low: 10.4 } }
  const belowBand: Record<number, BarOverride> = { [LAST]: { close: 9, high: 9.6, low: 8.8 } }

  it('M2：日线突破 + 周线 ADX 够强 → 该方向加成', () => {
    const result = multiTfAdjustments(ctx(breakoutUp, aboveBand), weekly({ adx: 30 }))
    const m2 = result.find((a) => a.id === 'M2_WEEK_ADX_CONFIRM')
    expect(m2?.direction).toBe('BUY')
    expect(m2?.delta ?? 0).toBeGreaterThan(0)
  })

  it('M2：向下突破时加成也跟着方向走', () => {
    const result = multiTfAdjustments(ctx(breakoutUp, belowBand), weekly({ adx: 30 }))
    expect(result.find((a) => a.id === 'M2_WEEK_ADX_CONFIRM')?.direction).toBe('SELL')
  })

  it('M3：向上突破但周线毫无趋势 → **惩罚**（delta 为负）', () => {
    const result = multiTfAdjustments(ctx(breakoutUp, aboveBand), weekly({ adx: 15 }))
    const m3 = result.find((a) => a.id === 'M3_FALSE_BREAKOUT')
    expect(m3?.direction).toBe('BUY')
    expect(m3?.delta ?? 0).toBeLessThan(0)
  })

  it('M3 不对向下突破对称惩罚（文档如此：跌破下轨照样可能是下跌起点）', () => {
    const result = multiTfAdjustments(ctx(breakoutUp, belowBand), weekly({ adx: 15 }))
    expect(result.some((a) => a.id === 'M3_FALSE_BREAKOUT')).toBe(false)
  })

  it('没有突破时 M2/M3 都不出现', () => {
    const result = multiTfAdjustments(ctx(breakoutUp), weekly({ adx: 30 }))
    expect(result.filter((a) => a.id !== 'M1_WEEK_MACD_DAY_RSI')).toEqual([])
  })

  it('周线 ADX 缺失（周线不足 28 根）时两条都不成立', () => {
    const result = multiTfAdjustments(ctx(breakoutUp, aboveBand), weekly({ adx: null }))
    expect(result).toEqual([])
  })

  it('周线为空时直接返回空数组，不抛错', () => {
    const empty: WeeklyIndicators = { dif: [], dea: [], hist: [], adx: [], length: 0 }
    expect(multiTfAdjustments(ctx(breakoutUp, aboveBand), empty)).toEqual([])
  })
})
