/**
 * 均值回归策略 R1–R4 的条件表（docs/04 §3.2）。
 *
 * 同 trend.test.ts：断言 ID 集合与方向，每条规则配一个反例。
 *
 * 这一层有一条产品层面的关键约定要一并守住：**均值回归的买入信号在这里不做方向过滤**，
 * 「下跌趋势里别接飞刀」的抑制放在组合层（TREND_DOWN 下 BUY 得分 ×0.5）。
 * 所以本文件不该出现「TREND_DOWN 时 R1 不产出」这样的断言 —— 那是组合层的事。
 */

import { describe, expect, it } from 'vitest'
import { MEAN_REVERSION_WEIGHTS, meanReversionSignals } from '@core/strategies/mean-reversion'
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

describe('R1 RSI 极值 + 触轨', () => {
  const oversold: IndicatorSpec = { rsi: 18, rsiOversold: 25, rsiOverbought: 75, lower: 9.5, upper: 10.5, mid: 10 }
  const touchLower: Record<number, BarOverride> = { [LAST]: { low: 9.4, close: 9.6, high: 9.7 } }

  it('BUY：RSI 低于超卖线且最低价触及下轨', () => {
    expect(ids(meanReversionSignals(ctx(oversold, touchLower)))).toContain('R1_RSI_BAND:BUY')
  })

  it('BUY 反例：RSI 未到超卖线', () => {
    expect(ids(meanReversionSignals(ctx({ ...oversold, rsi: 30 }, touchLower)))).not.toContain('R1_RSI_BAND:BUY')
  })

  it('BUY 反例：没触到下轨 —— 只看 RSI 会在下跌中途反复触发', () => {
    expect(ids(meanReversionSignals(ctx(oversold)))).not.toContain('R1_RSI_BAND:BUY')
  })

  it('SELL：RSI 高于超买线且最高价触及上轨', () => {
    const spec: IndicatorSpec = { rsi: 82, rsiOverbought: 75, rsiOversold: 25, upper: 10.5, lower: 9.5, mid: 10 }
    const touchUpper: Record<number, BarOverride> = { [LAST]: { high: 10.6, close: 10.4, low: 10.3 } }
    expect(ids(meanReversionSignals(ctx(spec, touchUpper)))).toContain('R1_RSI_BAND:SELL')
  })

  it('超出阈值越深分数越高', () => {
    const mild = meanReversionSignals(ctx({ ...oversold, rsi: 24 }, touchLower))
    const deep = meanReversionSignals(ctx({ ...oversold, rsi: 5 }, touchLower))
    expect(deep[0]?.score ?? 0).toBeGreaterThan(mild[0]?.score ?? 0)
  })
})

describe('R2 回归中轨', () => {
  const spec: IndicatorSpec = {
    mid: 10,
    upper: 10.6,
    lower: 9.6,
    hist: [...new Array<number>(LAST).fill(-0.2), 0.3],
  }
  // 近 3 日曾收在下轨之下，当日收在中轨之上
  const overrides: Record<number, BarOverride> = {
    [LAST - 2]: { close: 9.4 },
    [LAST]: { close: 10.2, high: 10.3, low: 9.9 },
  }

  it('BUY：近 3 日曾破下轨 + 收回中轨上 + 柱子转正', () => {
    expect(ids(meanReversionSignals(ctx(spec, overrides)))).toContain('R2_REVERT_TO_MID:BUY')
  })

  it('BUY 反例：柱子没有转正（前一根已经是正的，不算「转」）', () => {
    const stillPositive = { ...spec, hist: [...new Array<number>(LAST).fill(0.2), 0.3] }
    expect(ids(meanReversionSignals(ctx(stillPositive, overrides)))).not.toContain('R2_REVERT_TO_MID:BUY')
  })

  it('BUY 反例：回溯窗口之外破的下轨（第 3 根，超出 3 日窗口）', () => {
    const tooOld = { [LAST - 4]: { close: 9.4 }, [LAST]: { close: 10.2, high: 10.3, low: 9.9 } }
    expect(ids(meanReversionSignals(ctx(spec, tooOld)))).not.toContain('R2_REVERT_TO_MID:BUY')
  })

  it('SELL：近 3 日曾越上轨 + 跌回中轨下 + 柱子转负', () => {
    const sellSpec: IndicatorSpec = {
      mid: 10,
      upper: 10.4,
      lower: 9.6,
      hist: [...new Array<number>(LAST).fill(0.2), -0.3],
    }
    const sellBars: Record<number, BarOverride> = {
      [LAST - 2]: { close: 10.6 },
      [LAST]: { close: 9.8, high: 10.1, low: 9.7 },
    }
    expect(ids(meanReversionSignals(ctx(sellSpec, sellBars)))).toContain('R2_REVERT_TO_MID:SELL')
  })
})

describe('R3 极度压缩 + 触轨', () => {
  const spec: IndicatorSpec = { bbwPct: 5, lower: 9.5, upper: 10.5, mid: 10 }

  it('BUY：带宽分位低于压缩线且触及下轨', () => {
    const bars = { [LAST]: { low: 9.4, close: 9.6, high: 9.8 } }
    expect(ids(meanReversionSignals(ctx(spec, bars)))).toContain('R3_SQUEEZE:BUY')
  })

  it('SELL：同样的压缩条件 + 触及上轨', () => {
    const bars = { [LAST]: { high: 10.6, close: 10.4, low: 10.2 } }
    expect(ids(meanReversionSignals(ctx(spec, bars)))).toContain('R3_SQUEEZE:SELL')
  })

  it('反例：带宽未压缩', () => {
    const bars = { [LAST]: { low: 9.4, close: 9.6, high: 9.8 } }
    expect(ids(meanReversionSignals(ctx({ ...spec, bbwPct: 40 }, bars)))).not.toContain('R3_SQUEEZE:BUY')
  })

  it('受限模式（分位为 null）→ 不成立', () => {
    const withoutPct = { ...spec }
    delete withoutPct.bbwPct
    const bars = { [LAST]: { low: 9.4, close: 9.6, high: 9.8 } }
    expect(ids(meanReversionSignals(ctx(withoutPct, bars)))).not.toContain('R3_SQUEEZE:BUY')
  })
})

describe('R4 中轨超调（仅震荡市）', () => {
  // STD 由 (upper - mid)/k 反算：mid=10, upper=10.4, k=2 → STD=0.2 → 1.5σ = 0.3
  const spec: IndicatorSpec = { mid: 10, upper: 10.4, lower: 9.6 }

  it('BUY：RANGE 状态下收盘低于中轨 1.5 个标准差', () => {
    const bars = { [LAST]: { close: 9.6, high: 9.8, low: 9.5 } }
    expect(ids(meanReversionSignals(ctx(spec, bars, 'RANGE')))).toContain('R4_MID_REVERSION:BUY')
  })

  it('SELL：RANGE 状态下收盘高于中轨 1.5 个标准差', () => {
    const bars = { [LAST]: { close: 10.4, high: 10.5, low: 10.2 } }
    expect(ids(meanReversionSignals(ctx(spec, bars, 'RANGE')))).toContain('R4_MID_REVERSION:SELL')
  })

  it('反例：偏离不足 1.5σ', () => {
    const bars = { [LAST]: { close: 9.85, high: 9.9, low: 9.8 } }
    expect(ids(meanReversionSignals(ctx(spec, bars, 'RANGE')))).not.toContain('R4_MID_REVERSION:BUY')
  })

  it('反例：非震荡市 —— 趋势里的深度偏离不是超调，是趋势本身', () => {
    const bars = { [LAST]: { close: 9.6, high: 9.8, low: 9.5 } }
    expect(ids(meanReversionSignals(ctx(spec, bars, 'TREND_DOWN')))).not.toContain('R4_MID_REVERSION:BUY')
  })
})

describe('权重与输出形状', () => {
  it('策略内权重和为 1', () => {
    const total = Object.values(MEAN_REVERSION_WEIGHTS).reduce((sum, w) => sum + w, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('全部子信号带 MEAN_REVERSION 标记', () => {
    const bars = { [LAST]: { low: 9.4, close: 9.6, high: 9.8 } }
    const signals = meanReversionSignals(
      ctx({ rsi: 10, rsiOversold: 25, lower: 9.5, upper: 10.5, mid: 10, bbwPct: 5 }, bars)
    )
    expect(signals.length).toBeGreaterThan(0)
    for (const signal of signals) expect(signal.strategy).toBe('MEAN_REVERSION')
  })

  it('指标全为 null 时一条都不产出', () => {
    expect(meanReversionSignals(ctx({}))).toEqual([])
  })
})
