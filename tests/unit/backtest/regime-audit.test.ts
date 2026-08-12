/**
 * Regime 归因审计的成因归类。
 *
 * 这里守的是一件事：**归类顺序必须与 rawRegimeAt 的 return 顺序一致**。
 * 若把「被突变条件抢先」的根算进「规则不满足」，报告就会指向错误的参数 ——
 * 而这份报告的用途正是决定「下一步该动哪个阈值」。
 */

import { describe, expect, it } from 'vitest'
import { classifyCause, emptyTally } from '@backtest/regime-audit'
import { DEFAULT_PARAMS } from '@core/params'
import type { Evidence } from '@core/types'

/** 一根「多头排列完美、ADX 远高于阈值、无任何突变」的证据 */
function trendUpEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    adx: 30,
    adxTrend: 24,
    adxRange: 19,
    plusDI: 28,
    minusDI: 12,
    close: 12,
    ma5: 11.5,
    ma20: 11,
    ma60: 10,
    bbwPct: 50,
    midDistance: 0.09,
    bullishAlignment: 3,
    bearishAlignment: 0,
    volRatio: 1.0,
    adxChange3: 1,
    bbwPctChange3: 2,
    shock: null,
    ...overrides,
  }
}

describe('classifyCause', () => {
  it('缺 ADX / MA20 / close 任一即归为「未预热」，不参与后续统计', () => {
    const tally = emptyTally()
    classifyCause(trendUpEvidence({ adx: null }), DEFAULT_PARAMS, 'TRANSITION', tally)
    classifyCause(trendUpEvidence({ ma20: null }), DEFAULT_PARAMS, 'TRANSITION', tally)
    classifyCause(trendUpEvidence({ close: null }), DEFAULT_PARAMS, 'TRANSITION', tally)
    expect(tally.cause['①未预热']).toBe(3)
    // 未预热的根不该污染 ADX 分布统计
    expect(tally.sums['adxN']).toBeUndefined()
  })

  it('突变条件优先于规则命中：趋势条件全满足，但量比超线仍归为「突变」', () => {
    const tally = emptyTally()
    // 真实的 rawRegimeAt 在这种输入下返回的 raw 就是 TRANSITION，这里如实传入
    classifyCause(trendUpEvidence({ volRatio: 2.0 }), DEFAULT_PARAMS, 'TRANSITION', tally)
    expect(tally.cause['②突变条件']).toBe(1)
    expect(tally.cause['④规则不满足']).toBeUndefined()
    expect(tally.shock['独因：量比']).toBe(1)
  })

  it('多个突变同时命中时不记「独因」—— 独因是用来定位单一责任人的', () => {
    const tally = emptyTally()
    classifyCause(trendUpEvidence({ volRatio: 2.0, adxChange3: -9 }), DEFAULT_PARAMS, 'TRANSITION', tally)
    expect(tally.cause['②突变条件']).toBe(1)
    expect(tally.shock['独因：量比']).toBeUndefined()
    expect(tally.shock['独因：ADX']).toBeUndefined()
  })

  it('命中规则的根按规则记账，不进 TRANSITION 的成因分解', () => {
    const tally = emptyTally()
    classifyCause(trendUpEvidence(), DEFAULT_PARAMS, 'TREND_UP', tally)
    expect(tally.cause['命中 TREND_UP']).toBe(1)
    expect(tally.cause['③ADX 死区']).toBeUndefined()
    expect(tally.cause['④规则不满足']).toBeUndefined()
  })

  it('ADX 落在 adxRange..adxTrend 之间 → 死区，而不是「规则不满足」', () => {
    const tally = emptyTally()
    // adxRange 19 < adx 22 < adxTrend 24：趋势与震荡都不可判
    classifyCause(trendUpEvidence({ adx: 22 }), DEFAULT_PARAMS, 'TRANSITION', tally)
    expect(tally.cause['③ADX 死区']).toBe(1)
    expect(tally.cause['④规则不满足']).toBeUndefined()
    expect(tally.adxBand['死区 adxRange..adxTrend']).toBe(1)
  })

  it('ADX 够了但方向条件不配合 → 「规则不满足」，并记下只差哪一个条件', () => {
    const tally = emptyTally()
    // ADX 30 > adxTrend，多头排列满分，唯独 +DI < -DI
    classifyCause(
      trendUpEvidence({ plusDI: 12, minusDI: 28, bearishAlignment: 0 }),
      DEFAULT_PARAMS,
      'TRANSITION',
      tally
    )
    expect(tally.cause['④规则不满足']).toBe(1)
    expect(tally.nearMiss['TREND_UP · 只差「+DI > -DI」']).toBe(1)
    expect(tally.failed['TREND_UP · +DI > -DI']).toBe(1)
  })

  it('受限模式（bbwPct 为 null）单独计数：这些根 RANGE 不可能成立', () => {
    const tally = emptyTally()
    classifyCause(trendUpEvidence({ adx: 15, bbwPct: null }), DEFAULT_PARAMS, 'TRANSITION', tally)
    expect(tally.bbwNull).toBe(1)
    expect(tally.failed['RANGE · BBW 分位 < 30']).toBe(1)
  })
})
