/**
 * 趋势策略 T1–T5 的条件表（docs/04 §3.1）。
 *
 * 断言的是 **SubSignal.id 集合与方向**，不是具体分数 —— 分数会随参数标定变化，
 * 断言它会让测试变成噪音（docs/07 §5）。分数只在「确实落在 0..1」这个层面被检查。
 *
 * 每条规则都配一个「差一个条件就不成立」的反例：漏掉某个确认项是这一层最常见的实现错误，
 * 而漏掉之后信号只会**变多**，在真实行情里表现为「提醒变吵了」，很难倒推回具体某一行代码。
 */

import { describe, expect, it } from 'vitest'
import { TREND_WEIGHTS, trendSignals } from '@core/strategies/trend'
import { DEFAULT_PARAMS } from '@core/params'
import type { StrategyContext } from '@core/strategies/context'
import type { Regime, SubSignal } from '@core/types'
import { buildCandles, type BarOverride } from '../../fixtures/klines'
import { FULL_SUFFICIENCY, makeIndicators, type IndicatorSpec } from '../../fixtures/indicators'

const P = DEFAULT_PARAMS
const LEN = 8
const LAST = LEN - 1

function ctx(
  spec: IndicatorSpec,
  overrides: Record<number, BarOverride> = {},
  regime: Regime = 'TRANSITION'
): StrategyContext {
  return {
    candles: buildCandles(new Array<number>(LEN).fill(10), { overrides }),
    ind: makeIndicators(LEN, spec),
    index: LAST,
    regime,
    params: P,
    sufficiency: { ...FULL_SUFFICIENCY },
  }
}

function ids(signals: readonly SubSignal[]): string[] {
  return signals.map((s) => `${s.id}:${s.direction}`)
}

describe('T1 均线交叉', () => {
  const crossing: IndicatorSpec = {
    ma: { 5: [...new Array<number>(LAST).fill(9), 11], 20: 10 },
    adx: 25,
    adxRange: 19,
    adxTrend: 24,
  }

  it('BUY：MA5 上穿 MA20 且 ADX 高于震荡线', () => {
    expect(ids(trendSignals(ctx(crossing)))).toContain('T1_MA_CROSS:BUY')
  })

  it('BUY 反例：ADX 未过震荡线 —— 震荡市里的金叉不算数', () => {
    expect(ids(trendSignals(ctx({ ...crossing, adx: 15 })))).not.toContain('T1_MA_CROSS:BUY')
  })

  it('SELL：死叉即可，**不要求** ADX 确认（离场宁可早）', () => {
    const spec: IndicatorSpec = {
      ma: { 5: [...new Array<number>(LAST).fill(11), 9], 20: 10 },
      adx: 5,
      adxRange: 19,
    }
    expect(ids(trendSignals(ctx(spec)))).toContain('T1_MA_CROSS:SELL')
  })

  it('未发生穿越时两个方向都不产出', () => {
    const spec: IndicatorSpec = { ma: { 5: 11, 20: 10 }, adx: 25 }
    expect(ids(trendSignals(ctx(spec))).filter((id) => id.startsWith('T1'))).toEqual([])
  })
})

describe('T2 MACD 零轴交叉', () => {
  const golden: IndicatorSpec = {
    dif: [...new Array<number>(LAST).fill(0.1), 0.4],
    dea: 0.2,
    // 连续 2 日放大：hist[i] > hist[i-1] > hist[i-2]
    hist: [...new Array<number>(LEN - 3).fill(-0.3), -0.2, -0.1, 0.4],
  }

  it('BUY：零轴上金叉且柱子连续 2 日放大', () => {
    expect(ids(trendSignals(ctx(golden)))).toContain('T2_MACD_ZERO_CROSS:BUY')
  })

  it('BUY 反例：DIF 在零轴下 —— 零轴上下的金叉含义完全不同', () => {
    const spec = { ...golden, dif: [...new Array<number>(LAST).fill(-0.4), -0.1], dea: -0.2 }
    expect(ids(trendSignals(ctx(spec)))).not.toContain('T2_MACD_ZERO_CROSS:BUY')
  })

  it('BUY 反例：柱子没有连续放大', () => {
    const spec = { ...golden, hist: [...new Array<number>(LEN - 3).fill(0.5), 0.4, 0.3, 0.35] }
    expect(ids(trendSignals(ctx(spec)))).not.toContain('T2_MACD_ZERO_CROSS:BUY')
  })

  it('SELL：零轴下死叉', () => {
    const spec: IndicatorSpec = {
      dif: [...new Array<number>(LAST).fill(-0.1), -0.4],
      dea: -0.2,
      hist: [...new Array<number>(LAST).fill(0.2), -0.4],
    }
    expect(ids(trendSignals(ctx(spec)))).toContain('T2_MACD_ZERO_CROSS:SELL')
  })

  it('柱子前值 ≤ 0 时用固定分而不是无意义的比值（金叉当日几乎必然如此）', () => {
    const signal = trendSignals(ctx(golden)).find((s) => s.id === 'T2_MACD_ZERO_CROSS')
    expect(signal?.score).toBeGreaterThanOrEqual(0.5)
    expect(signal?.score).toBeLessThanOrEqual(1)
  })
})

describe('T3 轨道突破', () => {
  const breakout: IndicatorSpec = {
    upper: 10.5,
    mid: 10,
    lower: 9.5,
    bbwPct: [...new Array<number>(LAST).fill(40), 55],
    volRatio: 1.5,
  }
  const above: Record<number, BarOverride> = { [LAST]: { close: 11, high: 11.1, low: 10.4 } }

  it('BUY：收盘越上轨 + 带宽扩张 + 放量', () => {
    expect(ids(trendSignals(ctx(breakout, above)))).toContain('T3_BREAKOUT:BUY')
  })

  it('BUY 反例：缩量 —— 假突破的典型形态', () => {
    expect(ids(trendSignals(ctx({ ...breakout, volRatio: 0.9 }, above)))).not.toContain('T3_BREAKOUT:BUY')
  })

  it('BUY 反例：带宽未扩张', () => {
    const spec = { ...breakout, bbwPct: [...new Array<number>(LAST).fill(55), 40] }
    expect(ids(trendSignals(ctx(spec, above)))).not.toContain('T3_BREAKOUT:BUY')
  })

  it('受限模式（带宽分位为 null）→ T3 自然失效，无需额外开关', () => {
    const spec = { ...breakout }
    delete spec.bbwPct
    expect(ids(trendSignals(ctx(spec, above)))).not.toContain('T3_BREAKOUT:BUY')
  })

  it('SELL：收盘跌破下轨且同样要求带宽扩张与放量', () => {
    const below: Record<number, BarOverride> = { [LAST]: { close: 9, high: 9.6, low: 8.9 } }
    expect(ids(trendSignals(ctx(breakout, below)))).toContain('T3_BREAKOUT:SELL')
  })

  it('突破越深、放量越大，分数越高', () => {
    const shallow = trendSignals(ctx({ ...breakout, volRatio: 1.2 }, { [LAST]: { close: 10.55 } }))
    const deep = trendSignals(ctx({ ...breakout, volRatio: 3 }, { [LAST]: { close: 12 } }))
    const shallowScore = shallow.find((s) => s.id === 'T3_BREAKOUT')?.score ?? 0
    const deepScore = deep.find((s) => s.id === 'T3_BREAKOUT')?.score ?? 0
    expect(deepScore).toBeGreaterThan(shallowScore)
    expect(deepScore).toBeLessThanOrEqual(1)
  })
})

describe('T4 均线排列', () => {
  const bull: IndicatorSpec = { ma: { 5: 10.5, 20: 10, 60: 9.5 }, adx: 30, adxTrend: 24 }

  it('BUY：多头排列 + 收盘在 MA20 上 + ADX 过强趋势线', () => {
    // 收盘 10 > MA20 10？需要严格大于，这里把 MA20 压到 9.8
    const spec = { ...bull, ma: { 5: 9.9, 20: 9.8, 60: 9.5 } }
    expect(ids(trendSignals(ctx(spec)))).toContain('T4_ALIGNMENT:BUY')
  })

  it('BUY 反例：ADX 未过强趋势线', () => {
    const spec = { ...bull, ma: { 5: 9.9, 20: 9.8, 60: 9.5 }, adx: 20 }
    expect(ids(trendSignals(ctx(spec)))).not.toContain('T4_ALIGNMENT:BUY')
  })

  it('SELL：空头排列 + 收盘在 MA20 下，同样不要求 ADX', () => {
    const spec: IndicatorSpec = { ma: { 5: 10.1, 20: 10.2, 60: 10.3 }, adx: 5, adxTrend: 24 }
    expect(ids(trendSignals(ctx(spec)))).toContain('T4_ALIGNMENT:SELL')
  })

  it('缺 MA60 时排列判定不成立（而不是当作满足）', () => {
    const spec: IndicatorSpec = { ma: { 5: 9.9, 20: 9.8 }, adx: 30, adxTrend: 24 }
    expect(ids(trendSignals(ctx(spec))).filter((id) => id.startsWith('T4'))).toEqual([])
  })
})

describe('T5 回踩不破', () => {
  const spec: IndicatorSpec = { upper: 10.5, mid: 9.9, lower: 9.3, dif: 0.2 }
  // 近 5 日曾触上轨（第 4 根的最高价到过上轨），当日最低触中轨、收盘仍在中轨上
  const overrides: Record<number, BarOverride> = {
    4: { high: 10.6 },
    [LAST]: { close: 10, low: 9.8, high: 10.1 },
  }

  it('BUY：近 5 日触过上轨 + 回踩中轨未破 + DIF > 0', () => {
    expect(ids(trendSignals(ctx(spec, overrides)))).toContain('T5_PULLBACK_HOLD:BUY')
  })

  it('BUY 反例：跌破中轨', () => {
    const broken = { ...overrides, [LAST]: { close: 9.5, low: 9.4, high: 10 } }
    expect(ids(trendSignals(ctx(spec, broken)))).not.toContain('T5_PULLBACK_HOLD:BUY')
  })

  it('BUY 反例：没有回踩到中轨（全天都在上面）', () => {
    const noTouch = { ...overrides, [LAST]: { close: 10.2, low: 10.1, high: 10.3 } }
    expect(ids(trendSignals(ctx(spec, noTouch)))).not.toContain('T5_PULLBACK_HOLD:BUY')
  })

  it('BUY 反例：DIF 转负', () => {
    expect(ids(trendSignals(ctx({ ...spec, dif: -0.2 }, overrides)))).not.toContain('T5_PULLBACK_HOLD:BUY')
  })

  it('SELL：近 5 日触过下轨 + 反弹到中轨未站上 + DIF < 0', () => {
    const sellSpec: IndicatorSpec = { upper: 10.7, mid: 10.1, lower: 9.5, dif: -0.2 }
    const sellBars: Record<number, BarOverride> = {
      4: { low: 9.4 },
      [LAST]: { close: 10, high: 10.2, low: 9.9 },
    }
    expect(ids(trendSignals(ctx(sellSpec, sellBars)))).toContain('T5_PULLBACK_HOLD:SELL')
  })
})

describe('权重与输出形状', () => {
  it('策略内权重和为 1 —— 否则得分上限会漂移（docs/04 §4.2）', () => {
    const total = Object.values(TREND_WEIGHTS).reduce((sum, w) => sum + w, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('全部子信号带 TREND 标记，分数落在 0..1', () => {
    const signals = trendSignals(
      ctx(
        {
          ma: { 5: [...new Array<number>(LAST).fill(9), 11], 20: 10, 60: 8 },
          adx: 30,
          adxRange: 19,
          adxTrend: 24,
        },
        {}
      )
    )
    expect(signals.length).toBeGreaterThan(0)
    for (const signal of signals) {
      expect(signal.strategy).toBe('TREND')
      expect(signal.score).toBeGreaterThanOrEqual(0)
      expect(signal.score).toBeLessThanOrEqual(1)
      expect(Object.keys(signal.evidence).length).toBeGreaterThan(0)
    }
  })

  it('指标全为 null（预热期）时一条都不产出', () => {
    expect(trendSignals(ctx({}))).toEqual([])
  })
})
