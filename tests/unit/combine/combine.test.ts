/**
 * 组合层（docs/04 §4）。
 *
 * 这一层的算术很短，但**每一处都能悄悄错**：折价乘错策略、投票数把两个方向混在一起、
 * 盘中折价忘了乘、冲突带只在「都触发」时才判。
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

/**
 * 两个策略等权（docs/04 §4.1）—— **2026-08-12 删掉动态权重后的形态**。
 *
 * 这一组用例原本盯的是「按市场状态切换策略权重」那张表。表被删了，但删除本身需要被钉住：
 * 除了下跌趋势里的均值回归买入折价（那是方向级抑制，另有其事），
 * **市场状态不得再影响任何一个方向的得分**。谁要是把状态相关的系数偷偷加回来，
 * 第一条用例就会红。判据见 [M2 偏差报告 §5.5–§5.8]。
 */
describe('策略等权与状态无关性（docs/04 §4.1）', () => {
  const REGIMES: Regime[] = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION']

  it('同一组子信号在四个状态下得分完全相同（唯一例外是下跌趋势的均值回归买入）', () => {
    for (const subs of [FULL_TREND, FULL_MEAN_REVERSION]) {
      const scores = REGIMES.filter(
        (regime) => !(regime === 'TREND_DOWN' && subs === FULL_MEAN_REVERSION)
      ).map((regime) => combine({ regime, subSignals: subs }).breakdown.BUY.raw)
      for (const score of scores) expect(score).toBeCloseTo(1, 10)
    }
  })

  it('TREND_DOWN 下均值回归的 BUY 乘 downtrendBuyPenalty —— 下跌趋势里抢反弹是接飞刀', () => {
    const down = combine({ regime: 'TREND_DOWN', subSignals: FULL_MEAN_REVERSION })
    expect(down.breakdown.BUY.raw).toBeCloseTo(P.combine.downtrendBuyPenalty, 10)
    expect(down.breakdown.BUY.triggered).toBe(false)
  })

  it('TREND_DOWN 下均值回归的 SELL 不打折（只有买入方向被抑制）', () => {
    const sells = FULL_MEAN_REVERSION.map((s) => ({ ...s, direction: 'SELL' as Direction }))
    const result = combine({ regime: 'TREND_DOWN', subSignals: sells })
    expect(result.breakdown.SELL.raw).toBeCloseTo(1, 10)
  })

  it('折价只作用于均值回归那一项 —— 它是「别接飞刀」，不是「下跌趋势里什么都不可信」', () => {
    const result = combine({ regime: 'TREND_DOWN', subSignals: FULL_TREND })
    expect(result.breakdown.BUY.raw).toBeCloseTo(1, 10)
  })

  it('两个策略同向共振 → 和超过 1，夹到 1（多周期惩罚项因此仍咬得动）', () => {
    const both = [...FULL_TREND, ...FULL_MEAN_REVERSION]
    // 未夹紧的和是 1 + 1 = 2.0
    expect(combine({ subSignals: both }).breakdown.BUY.raw).toBeCloseTo(1, 10)
    expect(
      combine({ subSignals: both, adjustments: [adjust('BUY', -0.15)] }).breakdown.BUY.final
    ).toBeCloseTo(0.85, 10)
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

  // 三条满分子信号的得分是 1.0，连保守档的 0.72 也过得去 —— 这里卡住它的是 4 票的一致性要求。
  // 解耦前是得分先撞上 0.70 的上限，两个门槛哪个先咬人变了，所以留一条用例记住现在的分工。
  it('三档灵敏度：同一组子信号在保守档不触发（差在票数）、在均衡档触发', () => {
    const subs = [
      sub('T1_MA_CROSS', 'BUY', 1, 0.2),
      sub('T2_MACD_ZERO_CROSS', 'BUY', 1, 0.25),
      sub('T3_BREAKOUT', 'BUY', 1, 0.25),
    ]
    const balanced = combine({ subSignals: subs })
    const conservative = combine({
      subSignals: subs,
      params: {
        ...P,
        combine: {
          ...P.combine,
          scoreThreshold: 0.72,
          voteThreshold: { trend: 4, meanReversion: 3 },
        },
      },
    })
    expect(balanced.signal.direction).toBe('BUY')
    expect(conservative.signal.direction).toBe('NONE')
    expect(conservative.reason).toBe('NOT_ENOUGH_VOTES')
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

  // 这一组刻意避开满分：解耦后单策略满分就是 1.0，两边都顶到夹紧线的话 gap 恒为 0，
  // 用例会因为「都是 1.0」而通过，测不出裁决逻辑。所以强度取 0.7/0.8 这类中间值。
  const at = (subs: readonly SubSignal[], score: number): SubSignal[] =>
    subs.map((s) => ({ ...s, score }))

  it('两个方向都触发且得分接近 → 判为矛盾，不产出信号', () => {
    // TRANSITION 下两边可信度都是 1.0，得分即各自的平均强度
    const result = combine({
      regime: 'TRANSITION',
      subSignals: [...at(buys, 0.7), ...at(sells, 0.75)],
    })
    expect(result.breakdown.BUY.final).toBeCloseTo(0.7, 10)
    expect(result.breakdown.SELL.final).toBeCloseTo(0.75, 10)
    expect(result.breakdown.BUY.triggered).toBe(true)
    expect(result.breakdown.SELL.triggered).toBe(true)
    expect(result.signal.direction).toBe('NONE')
    expect(result.reason).toBe('CONFLICT')
  })

  it('两个方向都触发但差距够大 → 取得分较高者', () => {
    const result = combine({
      regime: 'TRANSITION',
      subSignals: [...at(buys, 0.95), ...at(sells, 0.7)],
    })
    expect(result.signal.direction).toBe('BUY')
    expect(result.reason).toBe('TRIGGERED')
  })

  it('只有一边票数够、但两边得分都过线且接近 → 仍判为矛盾（文档留白处的补全）', () => {
    const result = combine({
      regime: 'TRANSITION',
      subSignals: [
        ...at(buys, 0.7),
        // 卖方只有两条趋势子信号，差一票够不到趋势的 3 票线，但平均强度过了阈值。
        // 注意不能用两条均值回归来造这个场景 —— 它的线是 2 票，那样就真触发了。
        sub('T1_MA_CROSS', 'SELL', 0.65, 0.5),
        sub('T2_MACD_ZERO_CROSS', 'SELL', 0.65, 0.5),
      ],
    })
    expect(result.breakdown.SELL.votes).toBe(2)
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
    expect(penalized.breakdown.BUY.final).toBeCloseTo(1 * 0.8, 10)
    expect(penalized.signal.sufficiencyPenalty).toBe(0.8)
  })

  it('调整项按方向累加，负调整会压低得分', () => {
    // 用 0.6 强度而非满分：满分已顶到夹紧线，正向调整看不出累加
    const partial = FULL_TREND.map((s) => ({ ...s, score: 0.6 }))
    const boosted = combine({ subSignals: partial, adjustments: [adjust('BUY', 0.1)] })
    const punished = combine({ subSignals: partial, adjustments: [adjust('BUY', -0.15)] })
    expect(boosted.breakdown.BUY.adjusted).toBeCloseTo(0.7, 10)
    expect(punished.breakdown.BUY.adjusted).toBeCloseTo(0.45, 10)
  })

  it('调整项加到对侧不影响本方向', () => {
    const result = combine({ subSignals: FULL_TREND, adjustments: [adjust('SELL', 0.3)] })
    expect(result.breakdown.BUY.adjusted).toBeCloseTo(1, 10)
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

/**
 * 得分与阈值的可达性 —— 2026-08-12 的 regime 归因审计挖出来的坑，别再掉进去一次。
 *
 * **当时的写法**：`raw = w_trend × trendPart + w_meanRev × meanRevPart`，两个 part 都是
 * 「已成立子信号的加权平均」（0..1），于是单策略得分的上限恰好等于该策略的权重 ——
 * `TRANSITION` 两边都是 0.50 < 出厂阈值 0.60，而 `TRANSITION` 占 66.6% 的判定根，
 * 三分之二的时间里单策略信号在算术上无法触发；保守档 0.72 更是高于所有状态的上限。
 * 权重表与阈值取自来源文档的不同段落，从未相互校对（ADR-0003 的典型场景）。
 *
 * 权重表后来整张删掉了（实测无效），坑也就自然填了。但**填坑的是删除，不是设计**，
 * 所以这条不变量要单独钉着：**任何 ≤1 的阈值，在任何市场状态下都必须够得着**。
 * 将来若有人引入新的状态相关系数（那需要单独标定，见 params.ts 的说明），
 * 这条用例是第一道防线 —— 它变红时该复核 docs/04 §4.1/§4.2 与 [M2 §5.5–§5.8]，
 * 而不是改断言让它变绿。
 */
describe('得分可达性（三档灵敏度都必须够得着）', () => {
  const REGIMES: Regime[] = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION']

  it('出厂档 0.60/3：四个状态下满分趋势信号都触发', () => {
    for (const regime of REGIMES) {
      const result = combine({ regime, subSignals: FULL_TREND })
      expect(result.breakdown.BUY.triggered, regime).toBe(true)
      expect(result.signal.direction, regime).toBe('BUY')
    }
  })

  it('保守档 0.72/4：四个状态下满分趋势信号仍都触发', () => {
    const conservative = {
      ...P,
      combine: {
        ...P.combine,
        scoreThreshold: 0.72,
        voteThreshold: { trend: 4, meanReversion: 3 },
      },
    }
    for (const regime of REGIMES) {
      const result = combine({ regime, subSignals: FULL_TREND, params: conservative })
      expect(result.breakdown.BUY.final, regime).toBeCloseTo(1, 10)
      expect(result.breakdown.BUY.triggered, regime).toBe(true)
    }
  })

  it('均值回归同样够得着（下跌趋势的买入除外，那是有意压的）', () => {
    for (const regime of REGIMES) {
      const result = combine({ regime, subSignals: FULL_MEAN_REVERSION })
      expect(result.breakdown.BUY.triggered, regime).toBe(regime !== 'TREND_DOWN')
    }
  })

  it('票数线按策略分开：均值回归的 2 票线不因它只有 4 个子信号而被趋势的 3 票线绑架', () => {
    // R1 + R2 满分：得分 (1×0.3 + 1×0.3) / 0.6 = 1.0，均值回归 2 票 = 它自己的线
    const two = [
      sub('R1_RSI_BAND', 'BUY', 1, 0.3, 'MEAN_REVERSION'),
      sub('R2_REVERT_TO_MID', 'BUY', 1, 0.3, 'MEAN_REVERSION'),
    ]
    expect(combine({ subSignals: two }).signal.direction).toBe('BUY')

    // 同样两票，但换成趋势策略 → 差一票，不触发。这正是 2026-08-12 之前
    // 均值回归在出厂参数下一次都没独立出手的原因（M2 §5.7）
    const twoTrend = [sub('T1_MA_CROSS', 'BUY', 1, 0.5), sub('T2_MACD_ZERO_CROSS', 'BUY', 1, 0.5)]
    const trendResult = combine({ subSignals: twoTrend })
    expect(trendResult.signal.direction).toBe('NONE')
    expect(trendResult.reason).toBe('NOT_ENOUGH_VOTES')
  })

  it('两边的票**不相加**：趋势 2 票 + 均值回归 1 票不冒充「3 条规则互相印证」', () => {
    const mixed = [
      sub('T1_MA_CROSS', 'BUY', 1, 0.5),
      sub('T2_MACD_ZERO_CROSS', 'BUY', 1, 0.5),
      sub('R3_SQUEEZE', 'BUY', 1, 1, 'MEAN_REVERSION'),
    ]
    const result = combine({ subSignals: mixed })
    expect(result.breakdown.BUY.votes).toBe(3) // 展示口径仍是总票数
    expect(result.breakdown.BUY.votesByStrategy).toEqual({ trend: 2, meanReversion: 1 })
    expect(result.breakdown.BUY.triggered).toBe(false)
    expect(result.reason).toBe('NOT_ENOUGH_VOTES')
  })

  it('分工：得分管强度、票数管一致性 —— 一条满分子信号得分够但票不够', () => {
    const lonely = combine({ subSignals: [sub('T1_MA_CROSS', 'BUY', 1, 1)] })
    expect(lonely.breakdown.BUY.final).toBeCloseTo(1, 10)
    expect(lonely.breakdown.BUY.votes).toBe(1)
    expect(lonely.signal.direction).toBe('NONE')
    expect(lonely.reason).toBe('NOT_ENOUGH_VOTES')
  })
})
