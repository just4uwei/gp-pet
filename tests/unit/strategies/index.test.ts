/**
 * 策略层门面：消融开关（`params.enabledStrategies`）。
 *
 * 这不是「可标定参数」的测试，而是**测量工具**的测试：M2 决策点 2 要回答
 * 「均值回归到底贡献了几笔交易」，而组合层的票数不分策略 —— 把权重调成 0 只关掉得分，
 * 票仍然照投。所以关掉一个策略必须真的让它一个子信号都不产出，
 * 否则消融跑出来的数字答的是另一个问题（见 params.ts `enabledStrategies` 的说明）。
 *
 * 这些用例变红时要查的是「关掉之后是不是还有残留贡献」，不是断言写错了。
 */

import { describe, expect, it } from 'vitest'
import { runStrategies } from '@core/strategies'
import { DEFAULT_PARAMS, withParams } from '@core/params'
import type { WeeklyIndicators } from '@core/indicators'
import type { StrategyContext } from '@core/strategies/context'
import type { EngineParams } from '@core/params'
import { buildCandles, type BarOverride } from '../../fixtures/klines'
import { FULL_SUFFICIENCY, makeIndicators, type IndicatorSpec } from '../../fixtures/indicators'

const LEN = 8
const LAST = LEN - 1

/** 同时满足 T1（MA5 上穿 MA20 且 ADX 过震荡线）与 R1（RSI 超卖且触下轨）的一根 */
const BOTH_FIRE: IndicatorSpec = {
  ma: { 5: [...new Array<number>(LAST).fill(9), 11], 20: 10 },
  adx: 25,
  adxRange: 19,
  adxTrend: 24,
  rsi: 18,
  rsiOversold: 25,
  rsiOverbought: 75,
  upper: 10.5,
  mid: 10,
  lower: 9.5,
}
const TOUCH_LOWER: Record<number, BarOverride> = { [LAST]: { low: 9.4, close: 9.6, high: 9.7 } }

const EMPTY_WEEKLY: WeeklyIndicators = { dif: [], dea: [], hist: [], adx: [], length: 0 }

function ctx(params: EngineParams = DEFAULT_PARAMS): StrategyContext {
  return {
    candles: buildCandles(new Array<number>(LEN).fill(10), { overrides: TOUCH_LOWER }),
    ind: makeIndicators(LEN, BOTH_FIRE),
    index: LAST,
    regime: 'TRANSITION',
    params,
    sufficiency: { ...FULL_SUFFICIENCY },
  }
}

function strategiesOf(params?: EngineParams): string[] {
  return [...new Set(runStrategies(ctx(params), EMPTY_WEEKLY).subSignals.map((s) => s.strategy))].sort()
}

describe('策略消融开关', () => {
  it('出厂形态：两个策略都产出子信号（否则后面三条用例什么都没证明）', () => {
    expect(strategiesOf()).toEqual(['MEAN_REVERSION', 'TREND'])
  })

  it('关掉均值回归 → 只剩趋势的子信号', () => {
    const params = withParams({ enabledStrategies: { trend: true, meanReversion: false } })
    expect(strategiesOf(params)).toEqual(['TREND'])
  })

  it('关掉趋势 → 只剩均值回归的子信号', () => {
    const params = withParams({ enabledStrategies: { trend: false, meanReversion: true } })
    expect(strategiesOf(params)).toEqual(['MEAN_REVERSION'])
  })

  it('两个都关 → 一个子信号都没有（票数也就无从谈起）', () => {
    const params = withParams({ enabledStrategies: { trend: false, meanReversion: false } })
    expect(runStrategies(ctx(params), EMPTY_WEEKLY).subSignals).toEqual([])
  })

  it('多周期调整项不受消融影响 —— 它不属于这两个策略中的任何一个', () => {
    const off = withParams({ enabledStrategies: { trend: false, meanReversion: false } })
    const on = runStrategies(ctx(), EMPTY_WEEKLY).adjustments
    expect(runStrategies(ctx(off), EMPTY_WEEKLY).adjustments).toEqual(on)
  })
})
