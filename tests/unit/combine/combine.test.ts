/**
 * 组合层（docs/04 §4）。
 *
 * 这一层的算术很短，但**每一处都能悄悄错**：权重表按 regime 取错一行、
 * 投票数把两个方向混在一起、盘中折价忘了乘、冲突带只在「都触发」时才判。
 * 所以用例逐条盯住 §4.2 的公式，而不是只测「能不能出信号」。
 */

import { describe, expect, it } from 'vitest'
import { combineSignals, type CombineInput } from '@core/combine'
import { DEFAULT_PARAMS } from '@core/params'
import type { Direction, MultiTfAdjustment, Regime, StrategyKind, SubSignal } from '@core/types'

const P = DEFAULT_PARAMS

function sub(
  id: string,
  direction: Direction,
  score: number,
  weight: number,
  strategy: StrategyKind = 'TREND'
): SubSignal {
  return { id, strategy, direction, score, weight, evidence: {} }
}

function adjust(direction: Direction, delta: number): MultiTfAdjustment {
  return { id: 'M2_WEEK_ADX_CONFIRM', direction, delta, evidence: {} }
}

function combine(overrides: Partial<CombineInput> = {}): ReturnType<typeof combineSignals> {
  return combineSignals({
    code: 'SH600000',
    date: '2026-08-11',
    regime: 'TREND_UP',
    subSignals: [],
    adjustments: [],
    stage: 'CONFIRMED',
    sufficiencyPenalty: 1,
    params: P,
    ...overrides,
  })
}

/** 一组「趋势策略满分」的子信号：权重和为 1，故 Σ(score×weight) = 1 */
const FULL_TREND: SubSignal[] = [
  sub('T1_MA_CROSS', 'BUY', 1, 0.2),
  sub('T2_MACD_ZERO_CROSS', 'BUY', 1, 0.25),
  sub('T3_BREAKOUT', 'BUY', 1, 0.25),
  sub('T4_ALIGNMENT', 'BUY', 1, 0.15),
  sub('T5_PULLBACK_HOLD', 'BUY', 1, 0.15),
]

const FULL_MEAN_REVERSION: SubSignal[] = [
  sub('R1_RSI_BAND', 'BUY', 1, 0.3, 'MEAN_REVERSION'),
  sub('R2_REVERT_TO_MID', 'BUY', 1, 0.3, 'MEAN_REVERSION'),
  sub('R3_SQUEEZE', 'BUY', 1, 0.2, 'MEAN_REVERSION'),
  sub('R4_MID_REVERSION', 'BUY', 1, 0.2, 'MEAN_REVERSION'),
]

describe('动态权重（docs/04 §4.1）', () => {
  const cases: { regime: Regime; trend: number; meanReversion: number }[] = [
    { regime: 'TREND_UP', trend: 0.7, meanReversion: 0.3 },
    { regime: 'TREND_DOWN', trend: 0.7, meanReversion: 0.3 },
    { regime: 'RANGE', trend: 0.3, meanReversion: 0.7 },
    { regime: 'TRANSITION', trend: 0.5, meanReversion: 0.5 },
  ]

  for (const { regime, trend } of cases) {
    it(`${regime}：趋势策略满分时得分等于该状态的趋势权重 ${trend}`, () => {
      const result = combine({ regime, subSignals: FULL_TREND })
      expect(result.breakdown.BUY.raw).toBeCloseTo(trend, 10)
    })
  }

  it('TREND_DOWN 下均值回归的 BUY 再乘 0.5 —— 下跌趋势里抢反弹是接飞刀', () => {
    const down = combine({ regime: 'TREND_DOWN', subSignals: FULL_MEAN_REVERSION })
    const up = combine({ regime: 'TREND_UP', subSignals: FULL_MEAN_REVERSION })
    expect(down.breakdown.BUY.raw).toBeCloseTo(0.3 * 0.5, 10)
    expect(up.breakdown.BUY.raw).toBeCloseTo(0.3, 10)
  })

  it('TREND_DOWN 下均值回归的 SELL 不打折（只有买入方向被抑制）', () => {
    const sells = FULL_MEAN_REVERSION.map((s) => ({ ...s, direction: 'SELL' as Direction }))
    const result = combine({ regime: 'TREND_DOWN', subSignals: sells })
    expect(result.breakdown.SELL.raw).toBeCloseTo(0.3, 10)
  })

  it('两个策略同时满分 → 得分为两个权重之和（上限 1）', () => {
    const result = combine({
      regime: 'TRANSITION',
      subSignals: [...FULL_TREND, ...FULL_MEAN_REVERSION],
    })
    expect(result.breakdown.BUY.raw).toBeCloseTo(1, 10)
  })
})

describe('投票与触发（docs/04 §4.2）', () => {
  it('票数只数本方向、且只数强度 ≥ 0.5 的子信号', () => {
    const result = combine({
      subSignals: [
        sub('T1_MA_CROSS', 'BUY', 0.9, 0.2),
        sub('T2_MACD_ZERO_CROSS', 'BUY', 0.4, 0.25),
        sub('T3_BREAKOUT', 'SELL', 0.9, 0.25),
      ],
    })
    expect(result.breakdown.BUY.votes).toBe(1)
    expect(result.breakdown.SELL.votes).toBe(1)
  })

  it('得分达标但票数不足 → NONE，且原因是 NOT_ENOUGH_VOTES', () => {
    // 单条满分子信号：0.7 × 1.0 = 0.7 ≥ 0.6，但只有 1 票
    const result = combine({ subSignals: [sub('T1_MA_CROSS', 'BUY', 1, 1)] })
    expect(result.breakdown.BUY.final).toBeGreaterThanOrEqual(P.combine.scoreThreshold)
    expect(result.signal.direction).toBe('NONE')
    expect(result.reason).toBe('NOT_ENOUGH_VOTES')
  })

  it('票数够但得分不足 → NONE，原因是 BELOW_THRESHOLD', () => {
    const result = combine({
      subSignals: [
        sub('T1_MA_CROSS', 'BUY', 0.5, 0.2),
        sub('T2_MACD_ZERO_CROSS', 'BUY', 0.5, 0.25),
        sub('T3_BREAKOUT', 'BUY', 0.5, 0.25),
      ],
    })
    expect(result.breakdown.BUY.votes).toBe(3)
    expect(result.signal.direction).toBe('NONE')
    expect(result.reason).toBe('BELOW_THRESHOLD')
  })

  it('得分与票数都达标 → 触发', () => {
    const result = combine({ subSignals: FULL_TREND })
    expect(result.signal.direction).toBe('BUY')
    expect(result.reason).toBe('TRIGGERED')
    expect(result.signal.votes).toBe(5)
  })

  it('三档灵敏度：同一组子信号在保守档不触发、在灵敏档触发', () => {
    const subs = [
      sub('T1_MA_CROSS', 'BUY', 1, 0.2),
      sub('T2_MACD_ZERO_CROSS', 'BUY', 1, 0.25),
      sub('T3_BREAKOUT', 'BUY', 1, 0.25),
    ]
    const balanced = combine({ subSignals: subs })
    const conservative = combine({
      subSignals: subs,
      params: { ...P, combine: { ...P.combine, scoreThreshold: 0.72, voteThreshold: 4 } },
    })
    expect(balanced.signal.direction).toBe('BUY')
    expect(conservative.signal.direction).toBe('NONE')
  })
})

describe('方向裁决与冲突', () => {
  const buys = [
    sub('T1_MA_CROSS', 'BUY', 1, 0.2),
    sub('T2_MACD_ZERO_CROSS', 'BUY', 1, 0.25),
    sub('T3_BREAKOUT', 'BUY', 1, 0.25),
    sub('T4_ALIGNMENT', 'BUY', 1, 0.15),
  ]
  const sells = [
    sub('R1_RSI_BAND', 'SELL', 1, 0.3, 'MEAN_REVERSION'),
    sub('R2_REVERT_TO_MID', 'SELL', 1, 0.3, 'MEAN_REVERSION'),
    sub('R3_SQUEEZE', 'SELL', 1, 0.2, 'MEAN_REVERSION'),
    sub('R4_MID_REVERSION', 'SELL', 1, 0.2, 'MEAN_REVERSION'),
  ]

  it('两个方向都触发且得分接近 → 判为矛盾，不产出信号', () => {
    // TRANSITION 下两边权重都是 0.5：BUY = 0.5×0.85 = 0.425… 用调整项抬到都过线
    const result = combine({
      regime: 'TRANSITION',
      subSignals: [...buys, ...sells],
      adjustments: [adjust('BUY', 0.2), adjust('SELL', 0.2)],
    })
    expect(result.breakdown.BUY.triggered).toBe(true)
    expect(result.breakdown.SELL.triggered).toBe(true)
    expect(result.signal.direction).toBe('NONE')
    expect(result.reason).toBe('CONFLICT')
  })

  it('两个方向都触发但差距够大 → 取得分较高者', () => {
    const result = combine({
      regime: 'TRANSITION',
      subSignals: [...buys, ...sells],
      adjustments: [adjust('BUY', 0.5), adjust('SELL', 0.2)],
    })
    expect(result.signal.direction).toBe('BUY')
    expect(result.reason).toBe('TRIGGERED')
  })

  it('只有一边票数够、但两边得分都过线且接近 → 仍判为矛盾（文档留白处的补全）', () => {
    const result = combine({
      regime: 'TRANSITION',
      subSignals: [
        ...buys,
        // 卖方只有两条，票数不够 3，但得分被调整项抬过阈值
        sub('R1_RSI_BAND', 'SELL', 1, 0.3, 'MEAN_REVERSION'),
        sub('R2_REVERT_TO_MID', 'SELL', 1, 0.3, 'MEAN_REVERSION'),
      ],
      adjustments: [adjust('BUY', 0.2), adjust('SELL', 0.32)],
    })
    expect(result.breakdown.SELL.triggered).toBe(false)
    expect(result.breakdown.SELL.final).toBeGreaterThanOrEqual(P.combine.scoreThreshold)
    expect(result.signal.direction).toBe('NONE')
    expect(result.reason).toBe('CONFLICT')
  })

  it('对侧得分远低时不算矛盾', () => {
    const result = combine({
      subSignals: [...buys, sub('R1_RSI_BAND', 'SELL', 0.6, 0.3, 'MEAN_REVERSION')],
    })
    expect(result.signal.direction).toBe('BUY')
  })
})

describe('折价、调整项与夹紧', () => {
  it('盘中信号乘 0.9 折价（docs/04 §6）', () => {
    const day = combine({ subSignals: FULL_TREND, stage: 'CONFIRMED' })
    const intraday = combine({ subSignals: FULL_TREND, stage: 'PROVISIONAL' })
    expect(intraday.breakdown.BUY.final).toBeCloseTo(
      day.breakdown.BUY.final * P.combine.provisionalDiscount,
      10
    )
    expect(intraday.signal.stage).toBe('PROVISIONAL')
  })

  it('数据不足折价直接乘在 final 上', () => {
    const penalized = combine({ subSignals: FULL_TREND, sufficiencyPenalty: 0.8 })
    expect(penalized.breakdown.BUY.final).toBeCloseTo(0.7 * 0.8, 10)
    expect(penalized.signal.sufficiencyPenalty).toBe(0.8)
  })

  it('调整项按方向累加，负调整会压低得分', () => {
    const boosted = combine({ subSignals: FULL_TREND, adjustments: [adjust('BUY', 0.1)] })
    const punished = combine({ subSignals: FULL_TREND, adjustments: [adjust('BUY', -0.15)] })
    expect(boosted.breakdown.BUY.adjusted).toBeCloseTo(0.8, 10)
    expect(punished.breakdown.BUY.adjusted).toBeCloseTo(0.55, 10)
  })

  it('调整项加到对侧不影响本方向', () => {
    const result = combine({ subSignals: FULL_TREND, adjustments: [adjust('SELL', 0.3)] })
    expect(result.breakdown.BUY.adjusted).toBeCloseTo(0.7, 10)
    expect(result.breakdown.SELL.adjusted).toBeCloseTo(0.3, 10)
  })

  it('final 被夹到 0..1', () => {
    const over = combine({ subSignals: FULL_TREND, adjustments: [adjust('BUY', 5)] })
    const under = combine({ subSignals: FULL_TREND, adjustments: [adjust('BUY', -5)] })
    expect(over.breakdown.BUY.final).toBe(1)
    expect(under.breakdown.BUY.final).toBe(0)
  })
})

describe('输出形状', () => {
  it('矛盾与未触发时子信号仍全量保留 —— 否则「为什么没提醒」无从解释', () => {
    const result = combine({ subSignals: [sub('T1_MA_CROSS', 'BUY', 0.5, 0.2)] })
    expect(result.signal.direction).toBe('NONE')
    expect(result.signal.subSignals).toHaveLength(1)
  })

  it('两个方向的得分都进 scoreByDirection', () => {
    const result = combine({
      subSignals: [sub('T1_MA_CROSS', 'BUY', 1, 0.2), sub('R1_RSI_BAND', 'SELL', 1, 0.3, 'MEAN_REVERSION')],
    })
    expect(result.signal.scoreByDirection.BUY).toBeGreaterThan(0)
    expect(result.signal.scoreByDirection.SELL).toBeGreaterThan(0)
  })

  it('一条子信号都没有时给出 0 分的 NONE，不抛错', () => {
    const result = combine()
    expect(result.signal.direction).toBe('NONE')
    expect(result.signal.score).toBe(0)
    expect(result.signal.votes).toBe(0)
  })
})
