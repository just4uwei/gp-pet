import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, ENGINE_VERSION } from '@core/params'

/**
 * 这些用例断言的是**参数之间的内在一致性**，不是「这些数值是对的」。
 *
 * 按 ADR-0003，params.ts 里每个数字都来自需求文档的网络转述，未经本项目回测验证。
 * 所以这里不允许出现「MACD 应当是 12/17/9」这类断言 —— 那会把猜测固化成事实，
 * 也会让 M2 标定完成后的替换变成「改测试来迁就新值」的橡皮图章。
 *
 * 能断言的只有那些**换成任何一组标定结果都仍须成立**的关系：
 * 快线短于慢线、超卖低于超买、权重和为 1。这些若被破坏，说明改参数的人手滑了，
 * 而不是标定出了新结论。
 */

describe('DEFAULT_PARAMS · 结构不变式', () => {
  it('MA 周期严格递增且均为正整数', () => {
    const periods = DEFAULT_PARAMS.ma.periods
    expect(periods.length).toBeGreaterThan(0)
    for (const p of periods) {
      expect(Number.isInteger(p)).toBe(true)
      expect(p).toBeGreaterThan(0)
    }
    expect([...periods]).toEqual([...periods].sort((a, b) => a - b))
    expect(new Set(periods).size).toBe(periods.length)
  })

  it('MACD 快线必须短于慢线', () => {
    const { fast, slow, signal } = DEFAULT_PARAMS.macd
    expect(fast).toBeLessThan(slow)
    expect(signal).toBeGreaterThan(0)
  })

  it('BOLL 的 bbw 分位回看窗口足够长 —— 否则分位数没有统计意义（docs/04 §1.4）', () => {
    expect(DEFAULT_PARAMS.boll.period).toBeGreaterThan(1)
    expect(DEFAULT_PARAMS.boll.k).toBeGreaterThan(0)
    expect(DEFAULT_PARAMS.boll.bbwLookback).toBeGreaterThanOrEqual(DEFAULT_PARAMS.boll.period * 10)
  })

  it('ADX 动态阈值的上下界不能倒挂', () => {
    const { baseThreshold, maxThreshold, rangeGap, volScale } = DEFAULT_PARAMS.adx
    expect(baseThreshold).toBeLessThan(maxThreshold)
    expect(rangeGap).toBeGreaterThan(0)
    expect(baseThreshold - rangeGap).toBeGreaterThan(0)
    expect(volScale).toBeGreaterThan(0)
  })

  it('RSI 超卖阈值必须低于超买阈值，且动态调整后不会越界', () => {
    const { obBase, osBase, sentimentScale } = DEFAULT_PARAMS.rsi
    expect(osBase).toBeLessThan(obBase)
    // 情绪值 s ∈ [0,1]，两端取值后仍须落在 0..100 且不倒挂
    expect(osBase + sentimentScale).toBeLessThan(obBase + sentimentScale)
    expect(osBase).toBeGreaterThan(0)
    expect(obBase + sentimentScale).toBeLessThan(100)
  })

  it('量能阈值分列 1 两侧：放量 > 1 > 缩量', () => {
    const { breakoutRatio, shrinkRatio, suspiciousRatio } = DEFAULT_PARAMS.volume
    expect(shrinkRatio).toBeLessThan(1)
    expect(breakoutRatio).toBeGreaterThan(1)
    expect(suspiciousRatio).toBeGreaterThan(breakoutRatio)
  })

  it('组合层阈值落在 0..1 开区间', () => {
    const { scoreThreshold, conflictBand, provisionalDiscount, voteThreshold } =
      DEFAULT_PARAMS.combine
    expect(scoreThreshold).toBeGreaterThan(0)
    expect(scoreThreshold).toBeLessThan(1)
    expect(conflictBand).toBeGreaterThan(0)
    expect(conflictBand).toBeLessThan(1)
    // 盘中信号必须被折价，否则临时 K 线的抖动会和收盘确认信号等价（docs/04 §6）
    expect(provisionalDiscount).toBeGreaterThan(0)
    expect(provisionalDiscount).toBeLessThan(1)
    expect(Number.isInteger(voteThreshold)).toBe(true)
    expect(voteThreshold).toBeGreaterThan(0)
  })

  it('每个市场状态下的策略权重和为 1', () => {
    for (const [regime, weights] of Object.entries(DEFAULT_PARAMS.weights)) {
      expect(weights.trend + weights.meanReversion, `${regime} 权重和`).toBeCloseTo(1, 10)
      expect(weights.trend).toBeGreaterThanOrEqual(0)
      expect(weights.meanReversion).toBeGreaterThanOrEqual(0)
    }
  })

  it('趋势市与震荡市的权重取向相反 —— 否则动态权重切换没有意义', () => {
    const { TREND_UP, RANGE } = DEFAULT_PARAMS.weights
    expect(TREND_UP.trend).toBeGreaterThan(TREND_UP.meanReversion)
    expect(RANGE.meanReversion).toBeGreaterThan(RANGE.trend)
  })

  it('风控比例均在 0..1 之间，且盈利保护的回吐线低于触发线', () => {
    const risk = DEFAULT_PARAMS.risk
    const ratios = [
      risk.stopLossPct,
      risk.drawdownReducePct,
      risk.profitProtectTrigger,
      risk.profitProtectFallback,
      risk.trailingStopPct,
      risk.industryConcentrationCap,
    ]
    for (const r of ratios) {
      expect(r).toBeGreaterThan(0)
      expect(r).toBeLessThan(1)
    }
    expect(risk.profitProtectFallback).toBeLessThan(risk.profitProtectTrigger)
    expect(risk.newListingMinBars).toBeGreaterThan(0)
  })

  it('数据充分性：最小预热长度小于全量长度，折价系数小于 1', () => {
    const { minBars, fullBars, insufficientPenalty, staleSnapshotMs } = DEFAULT_PARAMS.data
    expect(minBars).toBeLessThan(fullBars)
    expect(insufficientPenalty).toBeGreaterThan(0)
    expect(insufficientPenalty).toBeLessThan(1)
    expect(staleSnapshotMs).toBeGreaterThan(0)
  })
})

describe('ENGINE_VERSION', () => {
  it('是可比较的版本串', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  })

  it('在参数完成标定前保留 unvalidated 标记（ADR-0003）', () => {
    // M2 的标定流程产出出厂默认值后，这条用例应连同后缀一起删除，
    // 并在 CHANGELOG 记录标定依据 —— 删它是一个需要有意识做出的动作。
    expect(ENGINE_VERSION).toContain('-unvalidated')
  })
})
