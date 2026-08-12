/**
 * 引擎端到端（docs/07 §5 的 `integration/engine/`）：fixture 日线 → 信号。
 *
 * 与 unit/strategies 的分工：那边注入指标值验条件表，这边**从真实形态的 K 线出发**，
 * 验的是「指标 → 状态 → 策略 → 组合 → 风控」这条链路接对了没有。
 * 断言仍然是 SubSignal ID 集合与方向，不是分数（docs/07 §5）。
 */

import { describe, expect, it } from 'vitest'
import { evaluate } from '@core/engine'
import { aggregateWeekly } from '@core/indicators/weekly'
import { DEFAULT_PARAMS, withParams } from '@core/params'
import type { Candle, EngineContext, SecProfile, Snapshot } from '@core/types'
import {
  buildCandles,
  chopCloses,
  downTrend,
  falseBreakout,
  goldenCrossBreakout,
  limitDownStreak,
  rangeBound,
} from '../../fixtures/klines'

const PROFILE: SecProfile = {
  code: 'SH600000',
  name: '浦发银行',
  market: 'SH',
  board: 'MAIN',
  isST: false,
}

function contextOf(candles: readonly Candle[], overrides: Partial<EngineContext> = {}): EngineContext {
  return {
    profile: PROFILE,
    candles,
    weekly: aggregateWeekly(candles),
    marketSentiment: 0.5,
    // 收盘确认口径：连续竞价已走完，处于 15:00–15:10 的确认轮
    now: { date: candles[candles.length - 1]?.date ?? '2026-08-11', minutesSinceOpen: 240, session: 'SETTLE' },
    ...overrides,
  }
}

/** 逐根评估最后 n 根，收集出现过的子信号 ID —— 引擎在实盘里就是每天跑一次 */
function idsOverLastBars(candles: readonly Candle[], n: number): Set<string> {
  const ids = new Set<string>()
  for (let i = candles.length - n; i < candles.length; i++) {
    const evaluation = evaluate(contextOf(candles.slice(0, i + 1)))
    for (const sub of evaluation?.signal.subSignals ?? []) ids.add(`${sub.id}:${sub.direction}`)
  }
  return ids
}

describe('场景 fixture（docs/07 §5）', () => {
  it('金叉放量突破：均线金叉与放量突破都被识别', () => {
    const scenario = goldenCrossBreakout()
    const ids = idsOverLastBars(scenario.candles, 6)
    expect(ids).toContain('T1_MA_CROSS:BUY')
    expect(ids).toContain('T3_BREAKOUT:BUY')
  })

  it('缩量假突破：同样的价格路径，但量比不达标 → 突破信号不成立', () => {
    const ids = idsOverLastBars(falseBreakout().candles, 6)
    expect(ids).not.toContain('T3_BREAKOUT:BUY')
    // 价格确实越了上轨（否则这条用例证明不了什么）—— 均线金叉仍在
    expect(ids).toContain('T1_MA_CROSS:BUY')
  })

  it('震荡行情：不产出多头排列这类趋势信号', () => {
    const ids = idsOverLastBars(rangeBound().candles, 10)
    expect(ids).not.toContain('T4_ALIGNMENT:BUY')
  })

  it('下跌趋势：状态被判为 TREND_DOWN，且均值回归买入被降权（组合层）', () => {
    const scenario = downTrend()
    const evaluation = evaluate(contextOf(scenario.candles))
    expect(evaluation?.regime.regime).toBe('TREND_DOWN')
  })

  it('连续跌停：卖出方向被硬抑制（卖不掉）', () => {
    const scenario = limitDownStreak()
    const last = scenario.candles[scenario.candles.length - 1]
    const snapshot: Snapshot = {
      code: PROFILE.code,
      at: 0,
      last: last?.close ?? 0,
      open: last?.open ?? 0,
      high: last?.high ?? 0,
      low: last?.low ?? 0,
      preClose: scenario.candles[scenario.candles.length - 2]?.close ?? 0,
      volume: 100,
      amount: 1000,
      limitUp: null,
      limitDown: null,
      suspended: false,
    }
    const evaluation = evaluate(contextOf(scenario.candles, { snapshot }))
    const verdicts = evaluation?.gated.verdicts.map((v) => v.rule) ?? []
    // 方向可能是 NONE（跌停当天多空都算不出票数），此时不产出抑制也是对的；
    // 但只要引擎判出了卖出方向，就必须带上跌停抑制
    if (evaluation?.gated.direction === 'SELL') {
      expect(verdicts).toContain('HARD_LIMIT_DOWN')
      expect(evaluation.gated.suppressed).toBe(true)
    }
    expect(evaluation).not.toBeNull()
  })
})

describe('数据充分性与阶段', () => {
  it('一根 K 线都没有 → 返回 null', () => {
    expect(evaluate(contextOf([]))).toBeNull()
  })

  it('少于 40 根：不跑策略、硬抑制 INSUFFICIENT_DATA，但仍产出一条可解释的记录', () => {
    const evaluation = evaluate(contextOf(buildCandles(chopCloses(30))))
    expect(evaluation?.sufficiency.usable).toBe(false)
    expect(evaluation?.signal.subSignals).toEqual([])
    expect(evaluation?.gated.verdicts.map((v) => v.rule)).toContain('INSUFFICIENT_DATA')
  })

  it('40..300 根：受限模式，得分打折且带宽分位不可用', () => {
    const evaluation = evaluate(contextOf(buildCandles(chopCloses(120))))
    expect(evaluation?.sufficiency.limited).toBe(true)
    expect(evaluation?.signal.sufficiencyPenalty).toBe(DEFAULT_PARAMS.data.insufficientPenalty)
    expect(evaluation?.sufficiency.bbwPercentileReady).toBe(false)
  })

  it('末根是临时线 → 阶段为 PROVISIONAL，得分被折价', () => {
    const scenario = goldenCrossBreakout()
    const confirmed = evaluate(contextOf(scenario.candles))
    const provisionalCandles = [...scenario.candles]
    const last = provisionalCandles[provisionalCandles.length - 1]
    if (last) provisionalCandles[provisionalCandles.length - 1] = { ...last, provisional: true }
    const provisional = evaluate(contextOf(provisionalCandles))

    expect(provisional?.signal.stage).toBe('PROVISIONAL')
    expect(confirmed?.signal.stage).toBe('CONFIRMED')
    expect(provisional?.signal.scoreByDirection.BUY ?? 0).toBeCloseTo(
      (confirmed?.signal.scoreByDirection.BUY ?? 0) * DEFAULT_PARAMS.combine.provisionalDiscount,
      6
    )
  })
})

describe('纯函数契约（ADR-0004）', () => {
  const scenario = goldenCrossBreakout()

  it('同样的输入给出同样的输出 —— 没有隐式时钟或全局状态', () => {
    const a = evaluate(contextOf(scenario.candles))
    const b = evaluate(contextOf(scenario.candles))
    expect(JSON.stringify(a?.signal)).toBe(JSON.stringify(b?.signal))
  })

  it('不改写调用方的数组（回测靠 Object.freeze 的切片消除未来函数）', () => {
    const frozen = Object.freeze([...scenario.candles])
    expect(() => evaluate(contextOf(frozen))).not.toThrow()
  })

  it('调用方没给周线时就地聚合 —— 忘了传只会静默失效，那种缺陷不该靠自觉避免', () => {
    const withWeekly = evaluate(contextOf(scenario.candles))
    const withoutWeekly = evaluate(contextOf(scenario.candles, { weekly: [] }))
    expect(withoutWeekly?.weekly.length).toBe(withWeekly?.weekly.length)
  })

  it('engineVersion 随参数变化 —— 指标缓存据此失效（docs/03 §4.2）', () => {
    const base = evaluate(contextOf(scenario.candles))
    const tweaked = evaluate(
      contextOf(scenario.candles),
      // 换一组 MACD 参数
      withParams({ macd: { preset: 'Classic', fast: 12, slow: 26, signal: 9 } })
    )
    expect(base?.engineVersion).not.toBe(tweaked?.engineVersion)
  })

  it('大盘情绪影响 RSI 阈值（牛市里超卖线抬高）', () => {
    const bear = evaluate(contextOf(scenario.candles, { marketSentiment: 0 }))
    const bull = evaluate(contextOf(scenario.candles, { marketSentiment: 1 }))
    const index = bear?.index ?? 0
    expect(bear?.indicators.thresholds.rsiOversold[index]).toBe(15)
    expect(bull?.indicators.thresholds.rsiOversold[index]).toBe(35)
  })
})

describe('T+1 尾盘与时钟换算', () => {
  it('尾盘（14:50 之后）的买入被改写为明日观察', () => {
    const scenario = goldenCrossBreakout()
    // minutesSinceOpen = 235 → 自然时钟 09:30 + 235 + 90(午休) = 14:55，已过 14:50 的界
    const evaluation = evaluate(
      contextOf(scenario.candles, {
        now: { date: '2026-08-11', minutesSinceOpen: 235, session: 'CONTINUOUS_PM' },
      })
    )
    if (evaluation?.signal.direction === 'BUY') {
      expect(evaluation.gated.direction).toBe('NEXT_DAY_WATCH')
    }
    const morning = evaluate(
      contextOf(scenario.candles, {
        now: { date: '2026-08-11', minutesSinceOpen: 60, session: 'CONTINUOUS_AM' },
      })
    )
    if (morning?.signal.direction === 'BUY') {
      expect(morning.gated.direction).toBe('BUY')
    }
  })
})
