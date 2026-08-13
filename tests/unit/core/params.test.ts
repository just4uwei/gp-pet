import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAMS,
  ENGINE_VERSION,
  SENSITIVITY_PRESETS,
  engineVersionOf,
  withSensitivity,
} from '@core/params'

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
    for (const line of Object.values(voteThreshold)) {
      expect(Number.isInteger(line)).toBe(true)
      expect(line).toBeGreaterThan(0)
    }
  })

  it('票数线不得超过该策略的子信号个数 —— 否则那个策略在算术上永远无法独立触发', () => {
    // 趋势 T1–T5 共 5 条，均值回归 R1–R4 共 4 条（docs/04 §3.1/§3.2）。
    // 2026-08-12 之前两者共用一条「≥ 3 票」，对只有 4 条规则的均值回归系统性不利，
    // 实测里它在出厂参数下一次都没独立出手过（M2 §5.7）。这条用例钉住的是上界，
    // 不是「3 和 2 这两个数是对的」—— 具体取值仍待标定（ADR-0003）。
    const { voteThreshold } = DEFAULT_PARAMS.combine
    expect(voteThreshold.trend).toBeLessThanOrEqual(5)
    expect(voteThreshold.meanReversion).toBeLessThanOrEqual(4)
  })

  // 这里曾有两条关于 `weights` 表的不变式（每行和为 1、趋势市与震荡市取向相反）。
  // 权重表在 2026-08-12 随动态权重一起删除（两轮实测都看不出效果，M2 偏差报告 §5.5–§5.8），
  // 两条用例也就没有了断言对象。**不要在没有新机制的情况下把它们加回来。**

  it('下跌趋势里的买入折价落在 0..1 —— 它是抑制项，不能变成加成', () => {
    const { downtrendBuyPenalty } = DEFAULT_PARAMS.combine
    expect(downtrendBuyPenalty).toBeGreaterThan(0)
    expect(downtrendBuyPenalty).toBeLessThanOrEqual(1)
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

/**
 * 三档灵敏度（M4 接线 `AppSettings.sensitivity` 之后，主进程与回测共用这张表）。
 *
 * 同一条纪律：**不断言「0.60 是对的」**，只断言三档之间的关系与换档的机制后果。
 */
describe('SENSITIVITY_PRESETS', () => {
  it('均衡档恰好等于出厂 combine —— 否则「出厂档位」这个说法在 UI 上是假的', () => {
    expect(SENSITIVITY_PRESETS.BALANCED.scoreThreshold).toBe(DEFAULT_PARAMS.combine.scoreThreshold)
    expect(SENSITIVITY_PRESETS.BALANCED.voteThreshold).toEqual({
      trend: DEFAULT_PARAMS.combine.voteThreshold.trend,
      meanReversion: DEFAULT_PARAMS.combine.voteThreshold.meanReversion,
    })
  })

  it('得分线与票数线随档位单调收紧', () => {
    const { SENSITIVE, BALANCED, CONSERVATIVE } = SENSITIVITY_PRESETS
    expect(SENSITIVE.scoreThreshold).toBeLessThan(BALANCED.scoreThreshold)
    expect(BALANCED.scoreThreshold).toBeLessThan(CONSERVATIVE.scoreThreshold)
    expect(SENSITIVE.voteThreshold.trend).toBeLessThan(BALANCED.voteThreshold.trend)
    expect(BALANCED.voteThreshold.trend).toBeLessThan(CONSERVATIVE.voteThreshold.trend)
    expect(BALANCED.voteThreshold.meanReversion).toBeLessThanOrEqual(
      CONSERVATIVE.voteThreshold.meanReversion
    )
  })

  it('票数线不超过各策略的子信号数（趋势 5 条、均值回归 4 条）', () => {
    for (const preset of Object.values(SENSITIVITY_PRESETS)) {
      expect(preset.voteThreshold.trend).toBeGreaterThan(0)
      expect(preset.voteThreshold.trend).toBeLessThanOrEqual(5)
      expect(preset.voteThreshold.meanReversion).toBeGreaterThan(0)
      expect(preset.voteThreshold.meanReversion).toBeLessThanOrEqual(4)
    }
  })
})

describe('withSensitivity', () => {
  it('只动 combine 的两条线，其余整体不变', () => {
    const conservative = withSensitivity('CONSERVATIVE')
    expect(conservative.combine.scoreThreshold).toBe(SENSITIVITY_PRESETS.CONSERVATIVE.scoreThreshold)
    // 「换灵敏度怎么把止损也改了」必须无从发生
    expect(conservative.risk).toEqual(DEFAULT_PARAMS.risk)
    expect(conservative.regime).toEqual(DEFAULT_PARAMS.regime)
    expect(conservative.strategy).toEqual(DEFAULT_PARAMS.strategy)
    expect(conservative.macd).toEqual(DEFAULT_PARAMS.macd)
    // combine 块里没被预设覆盖的两个数也要留着
    expect(conservative.combine.conflictBand).toBe(DEFAULT_PARAMS.combine.conflictBand)
    expect(conservative.combine.downtrendBuyPenalty).toBe(DEFAULT_PARAMS.combine.downtrendBuyPenalty)
  })

  it('均衡档与出厂参数逐位相同 —— 默认档不该悄悄换掉引擎版本', () => {
    expect(engineVersionOf(withSensitivity('BALANCED'))).toBe(engineVersionOf(DEFAULT_PARAMS))
  })

  it('换档会改变引擎版本 —— 指标缓存据此失效、影子运行据此暂停', () => {
    const balanced = engineVersionOf(withSensitivity('BALANCED'))
    expect(engineVersionOf(withSensitivity('SENSITIVE'))).not.toBe(balanced)
    expect(engineVersionOf(withSensitivity('CONSERVATIVE'))).not.toBe(balanced)
  })

  it('不改写传入的基准参数集（纯函数）', () => {
    const before = JSON.stringify(DEFAULT_PARAMS)
    withSensitivity('SENSITIVE')
    expect(JSON.stringify(DEFAULT_PARAMS)).toBe(before)
  })
})
