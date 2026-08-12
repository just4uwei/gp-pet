/**
 * 市场状态层（docs/04 §2）。
 *
 * 这一层最容易写对判据、写错**迟滞**。所以用例分两组：
 *   - 条件表：四种状态各自的判定条件，以及「差一个条件就不成立」
 *   - 迟滞：连续 2 日同一结论才切换 —— 这是防止策略权重每天翻转的唯一机制
 */

import { describe, expect, it } from 'vitest'
import { classifyRegimes, currentRegime, rawRegimeAt } from '@core/regime'
import { DEFAULT_PARAMS } from '@core/params'
import { buildCandles } from '../../fixtures/klines'
import { makeIndicators, type IndicatorSpec } from '../../fixtures/indicators'
import type { Candle, Regime } from '@core/types'

const P = DEFAULT_PARAMS
const LEN = 10

/** 收盘价固定为 10 的 10 根 K 线 —— 判定全靠注入的指标值，与价格路径无关 */
const candles: Candle[] = buildCandles(new Array<number>(LEN).fill(10))

function rawAt(spec: IndicatorSpec, index = LEN - 1): ReturnType<typeof rawRegimeAt> {
  return rawRegimeAt(candles, makeIndicators(LEN, spec), index, P)
}

/** 上升趋势的一整套条件：ADX 过线、+DI 占优、收盘在 MA20 上、多头排列 2/3 */
const TREND_UP_SPEC: IndicatorSpec = {
  adx: 30,
  adxTrend: 24,
  adxRange: 19,
  plusDI: 30,
  minusDI: 10,
  ma: { 5: 9.5, 20: 9, 60: 8 },
}

const RANGE_SPEC: IndicatorSpec = {
  adx: 15,
  adxTrend: 24,
  adxRange: 19,
  plusDI: 20,
  minusDI: 20,
  ma: { 5: 10, 20: 10, 60: 10 },
  bbwPct: 20,
  mid: 10,
}

describe('原始判定（docs/04 §2.1）', () => {
  it('TREND_UP：四个条件同时满足', () => {
    const result = rawAt(TREND_UP_SPEC)
    expect(result.regime).toBe('TREND_UP')
    expect(result.determinate).toBe(true)
    expect(result.evidence['bullishAlignment']).toBe(3)
  })

  it('TREND_DOWN：方向相反的一整套', () => {
    const result = rawAt({
      adx: 30,
      plusDI: 10,
      minusDI: 30,
      ma: { 5: 11, 20: 12, 60: 13 },
    })
    expect(result.regime).toBe('TREND_DOWN')
  })

  it('ADX 不过线 → 不是趋势市', () => {
    expect(rawAt({ ...TREND_UP_SPEC, adx: 21 }).regime).not.toBe('TREND_UP')
  })

  it('方向相反（-DI 占优）→ 不是上升趋势', () => {
    expect(rawAt({ ...TREND_UP_SPEC, plusDI: 10, minusDI: 30 }).regime).not.toBe('TREND_UP')
  })

  it('收盘跌破 MA20 → 不是上升趋势', () => {
    expect(rawAt({ ...TREND_UP_SPEC, ma: { 5: 9.5, 20: 11, 60: 8 } }).regime).not.toBe('TREND_UP')
  })

  it('多头排列不足 2/3 → 不是上升趋势', () => {
    // MA5 < MA20 且 MA20 < MA60，只剩 close > MA5 一条
    expect(rawAt({ ...TREND_UP_SPEC, ma: { 5: 9.5, 20: 9.6, 60: 9.7 } }).regime).not.toBe('TREND_UP')
  })

  it('RANGE：ADX 低于震荡线、带宽分位收敛、贴近中轨', () => {
    expect(rawAt(RANGE_SPEC).regime).toBe('RANGE')
  })

  it('带宽分位缺失（受限模式）→ RANGE 不成立，退为 TRANSITION', () => {
    const spec = { ...RANGE_SPEC }
    delete spec.bbwPct
    expect(rawAt(spec).regime).toBe('TRANSITION')
  })

  it('离中轨太远 → RANGE 不成立', () => {
    expect(rawAt({ ...RANGE_SPEC, mid: 9 }).regime).toBe('TRANSITION')
  })

  it('突变条件优先于一切：ADX 三日变化超阈值即 TRANSITION', () => {
    const adx = new Array<number | null>(LEN).fill(30)
    adx[LEN - 4] = 20 // 三日内涨了 10
    const result = rawAt({ ...TREND_UP_SPEC, adx })
    expect(result.regime).toBe('TRANSITION')
    expect(result.evidence['shock']).toBe('ADX')
  })

  it('突变条件：带宽分位三日跳变超阈值', () => {
    const bbwPct = new Array<number | null>(LEN).fill(80)
    bbwPct[LEN - 4] = 20
    expect(rawAt({ ...TREND_UP_SPEC, bbwPct }).evidence['shock']).toBe('BBW_PCT')
  })

  it('突变条件：量比超过可疑线', () => {
    expect(rawAt({ ...TREND_UP_SPEC, volRatio: 2 }).evidence['shock']).toBe('VOLUME')
  })

  it('指标未预热 → TRANSITION 且 determinate 为 false（不该被解释成「正在转换」）', () => {
    const result = rawAt({})
    expect(result.regime).toBe('TRANSITION')
    expect(result.determinate).toBe(false)
  })

  it('K 线不存在的下标也不抛错', () => {
    expect(rawRegimeAt(candles, makeIndicators(LEN, TREND_UP_SPEC), 99, P).determinate).toBe(false)
  })
})

describe('迟滞（docs/04 §2.2）', () => {
  /**
   * 迟滞用例里把突变阈值调到极大：从震荡切到趋势，ADX 必然跨过 ≥5 点
   * （震荡线与强趋势线本来就差 5），否则每次切换都会先被判成 TRANSITION，
   * 测的就不是迟滞了。突变条件本身在上一组用例里单独验。
   */
  const NO_SHOCK = {
    ...P,
    regime: { ...P.regime, adxSlopeTrigger: 1000, bbwPctJump: 1000 },
  }

  /** 用逐根不同的指标值造出一条原始判定序列 */
  function statesFor(rawSeries: readonly Regime[]): ReturnType<typeof classifyRegimes> {
    const n = rawSeries.length
    const bars = buildCandles(new Array<number>(n).fill(10))
    const spec: IndicatorSpec = {
      adx: rawSeries.map((r) => (r === 'TREND_UP' || r === 'TREND_DOWN' ? 30 : 15)),
      adxTrend: 24,
      adxRange: 19,
      plusDI: rawSeries.map((r) => (r === 'TREND_DOWN' ? 10 : 30)),
      minusDI: rawSeries.map((r) => (r === 'TREND_DOWN' ? 30 : 10)),
      ma: {
        5: rawSeries.map((r) => (r === 'TREND_DOWN' ? 11 : r === 'RANGE' ? 10 : 9.5)),
        20: rawSeries.map((r) => (r === 'TREND_DOWN' ? 12 : r === 'RANGE' ? 10 : 9)),
        60: rawSeries.map((r) => (r === 'TREND_DOWN' ? 13 : r === 'RANGE' ? 10 : 8)),
      },
      bbwPct: rawSeries.map((r) => (r === 'RANGE' ? 20 : 50)),
      mid: 10,
    }
    return classifyRegimes(bars, makeIndicators(n, spec), NO_SHOCK)
  }

  it('原始判定序列被如实还原（用例自身的前提）', () => {
    const wanted: Regime[] = ['RANGE', 'RANGE', 'TREND_UP', 'TREND_UP']
    expect(statesFor(wanted).map((s) => s.raw)).toEqual(wanted)
  })

  it('单日异动不切换 —— 这是防止权重每天翻转的关键', () => {
    const states = statesFor(['RANGE', 'RANGE', 'RANGE', 'TREND_UP', 'RANGE'])
    expect(states.map((s) => s.regime)).toEqual(['RANGE', 'RANGE', 'RANGE', 'RANGE', 'RANGE'])
  })

  it('连续 2 日同一结论才切换', () => {
    const states = statesFor(['RANGE', 'RANGE', 'TREND_UP', 'TREND_UP', 'TREND_UP'])
    expect(states.map((s) => s.regime)).toEqual(['RANGE', 'RANGE', 'RANGE', 'TREND_UP', 'TREND_UP'])
  })

  it('heldDays 在维持期间累加，切换后归 1', () => {
    const states = statesFor(['RANGE', 'RANGE', 'RANGE', 'TREND_UP', 'TREND_UP'])
    expect(states.map((s) => s.heldDays)).toEqual([1, 2, 3, 4, 1])
  })

  it('首根直接采纳原始判定（没有可迟滞的历史）', () => {
    const states = statesFor(['TREND_UP'])
    expect(states[0]?.regime).toBe('TREND_UP')
    expect(states[0]?.heldDays).toBe(1)
  })

  it('迟滞窗口内 regime 与 raw 不等 —— 调用方据此知道自己正处在窗口里', () => {
    const states = statesFor(['RANGE', 'RANGE', 'TREND_UP'])
    const last = states[2]
    expect(last?.regime).toBe('RANGE')
    expect(last?.raw).toBe('TREND_UP')
  })

  it('hysteresisDays = 1 时立刻切换', () => {
    const n = 3
    const bars = buildCandles(new Array<number>(n).fill(10))
    const ind = makeIndicators(n, {
      adx: [15, 30, 30],
      plusDI: 30,
      minusDI: 10,
      ma: { 5: 9.5, 20: 9, 60: 8 },
      bbwPct: [20, 50, 50],
      mid: 10,
    })
    const eager = classifyRegimes(bars, ind, {
      ...NO_SHOCK,
      regime: { ...NO_SHOCK.regime, hysteresisDays: 1 },
    })
    expect(eager[1]?.regime).toBe('TREND_UP')
  })

  it('空序列时 currentRegime 给中性的 TRANSITION 而不是抛错', () => {
    expect(currentRegime([]).regime).toBe('TRANSITION')
    expect(currentRegime([]).heldDays).toBe(0)
  })
})
