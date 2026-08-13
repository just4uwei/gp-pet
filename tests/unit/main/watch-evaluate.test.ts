/**
 * 观察点判定（src/main/watch/evaluate.ts）。
 *
 * 这一层的错误全是**静默**的 —— 判错了不会报错，只会在某个下午凭空弹一条提醒
 * 或者该弹的时候一声不响。所以下面四条比其他用例更严：
 *
 *   1. **`PRICE` 用不复权价**。用前复权价会让除权那天凭空命中，
 *      而用户只会认为「明明没跌到就提醒我了」是软件算错了。
 *   2. **`null` 指标不命中**（约束 4）。未预热的 rsi 是 null；当 0 会让所有
 *      `rsi <= 30` 的观察点在预热期**全部命中**。
 *   3. **边界取等**。用户说「跌破 8.20」，正好 8.20 应当算到了。
 *   4. **命中优先于过期**。同一轮里既到期又命中时算命中 —— 那一刻条件确实成立了。
 */

import { describe, expect, it } from 'vitest'
import type { Evaluation } from '@core/engine'
import type { SecCode } from '@core/types'
import type { SignalOutcome } from '@main/engine/signals'
import { evaluateWatchPoints, matches, metricValue } from '@main/watch/evaluate'
import type { WatchPointRow } from '@main/storage/repositories/watch'

const AT = 1_700_000_000_000
const CODE = 'SH600000' as SecCode

/**
 * 只造判定真正读到的字段。
 * `indicators` 会被 `snapshotOfIndicators()` 摊平，所以要给出它认识的结构。
 */
function outcome(options: { close?: number; rsi?: number | null; ma20?: number | null } = {}): SignalOutcome {
  const series = (value: number | null | undefined): (number | null)[] => [value ?? null]
  const value = {
    evaluation: {
      code: CODE,
      index: 0,
      // close 是**不复权**字段（docs/03 §2.3）
      candle: { close: options.close ?? 10 },
      indicators: {
        ma: { 20: series(options.ma20) },
        macd: { dif: series(null), dea: series(null), hist: series(null) },
        boll: { mid: series(null), upper: series(null), lower: series(null), bbw: series(null), bbwPct: series(null) },
        dmi: { adx: series(null), plusDI: series(null), minusDI: series(null), atr: series(null) },
        rsi: series(options.rsi),
        volMa: series(null),
        volRatio: series(null),
        thresholds: {
          adxTrend: series(null),
          adxRange: series(null),
          rsiOverbought: series(null),
          rsiOversold: series(null),
          volPct: series(null),
        },
      },
    } as unknown as Evaluation,
    name: '浦发银行',
    persisted: true,
    signalId: 'sig-1',
  }
  return value as unknown as SignalOutcome
}

function point(overrides: Partial<WatchPointRow> = {}): WatchPointRow {
  return {
    id: 'w1',
    code: CODE,
    signalId: 'sig-1',
    source: 'AI_SUGGESTED',
    metric: 'PRICE',
    op: 'LTE',
    threshold: 9,
    meaning: 'INVALIDATE',
    engineVersion: '0.2.6-unvalidated',
    createdAt: AT - 86_400_000,
    expiresAt: AT + 86_400_000,
    status: 'ACTIVE',
    ...overrides,
  }
}

describe('matches', () => {
  it('边界取等 —— 「跌破 8.20」时正好 8.20 算到了', () => {
    expect(matches('LTE', 8.2, 8.2)).toBe(true)
    expect(matches('GTE', 8.2, 8.2)).toBe(true)
  })

  it('方向不能反', () => {
    expect(matches('LTE', 8.3, 8.2)).toBe(false)
    expect(matches('GTE', 8.1, 8.2)).toBe(false)
  })
})

describe('metricValue', () => {
  it('PRICE 优先用实时报价（不复权），拿不到才退回 K 线收盘价', () => {
    const withQuote = metricValue('PRICE', outcome({ close: 10 }), { last: 9.5, changePct: -1 })
    expect(withQuote).toBe(9.5)
    expect(metricValue('PRICE', outcome({ close: 10 }), undefined)).toBe(10)
  })

  it('指标按键取快照值', () => {
    expect(metricValue('rsi', outcome({ rsi: 28.5 }), undefined)).toBe(28.5)
    expect(metricValue('ma20', outcome({ ma20: 9.87 }), undefined)).toBe(9.87)
  })

  it('**null 指标返回 null，不是 0**（约束 4）', () => {
    expect(metricValue('rsi', outcome({ rsi: null }), undefined)).toBeNull()
    expect(metricValue('adx', outcome(), undefined)).toBeNull()
  })

  it('不认识的键当「取不到」而不是崩', () => {
    expect(metricValue('资金流入强度', outcome(), undefined)).toBeNull()
  })
})

describe('evaluateWatchPoints', () => {
  it('价格跌到阈值 → 命中，并带上当时的值', () => {
    const { hits, expired } = evaluateWatchPoints({
      points: [point({ metric: 'PRICE', op: 'LTE', threshold: 9 })],
      outcomes: [outcome({ close: 8.8 })],
      at: AT,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.value).toBe(8.8)
    expect(hits[0]?.name).toBe('浦发银行')
    expect(expired).toHaveLength(0)
  })

  it('实时报价比 K 线新：报价已跌破就算命中，即使收盘价还没到', () => {
    const quotes = new Map([[CODE, { last: 8.5, changePct: -3 }]])
    const { hits } = evaluateWatchPoints({
      points: [point({ threshold: 9 })],
      outcomes: [outcome({ close: 10 })],
      quotes,
      at: AT,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.value).toBe(8.5)
  })

  it('**未预热的指标绝不命中** —— 否则 rsi<=30 的观察点会在预热期全部误报', () => {
    const { hits, expired } = evaluateWatchPoints({
      points: [point({ metric: 'rsi', op: 'LTE', threshold: 30 })],
      outcomes: [outcome({ rsi: null })],
      at: AT,
    })
    expect(hits).toHaveLength(0)
    // 取不到值不等于「没兑现」，只要还没到期就继续盯
    expect(expired).toHaveLength(0)
  })

  it('到期未命中 → 记为过期（这本身就是「没兑现」这个结论）', () => {
    const { hits, expired } = evaluateWatchPoints({
      points: [point({ threshold: 5, expiresAt: AT - 1 })],
      outcomes: [outcome({ close: 10 })],
      at: AT,
    })
    expect(hits).toHaveLength(0)
    expect(expired).toHaveLength(1)
  })

  it('同一轮既到期又命中 → **算命中**，那一刻条件确实成立了', () => {
    const { hits, expired } = evaluateWatchPoints({
      points: [point({ threshold: 9, expiresAt: AT - 1 })],
      outcomes: [outcome({ close: 8.5 })],
      at: AT,
    })
    expect(hits).toHaveLength(1)
    expect(expired).toHaveLength(0)
  })

  it('拿不到该标的本轮评估时什么都不做 —— 停牌股不该在到期那天被判「没兑现」', () => {
    const { hits, expired } = evaluateWatchPoints({
      points: [point({ code: 'SZ000001' as SecCode, expiresAt: AT - 1 })],
      outcomes: [outcome()],
      at: AT,
    })
    expect(hits).toHaveLength(0)
    expect(expired).toHaveLength(0)
  })

  it('非 ACTIVE 的一律跳过 —— 已命中的不会被重复记', () => {
    const { hits } = evaluateWatchPoints({
      points: [point({ status: 'HIT', threshold: 9 }), point({ status: 'CANCELED', threshold: 9 })],
      outcomes: [outcome({ close: 8 })],
      at: AT,
    })
    expect(hits).toHaveLength(0)
  })

  it('GTE 方向：升破阈值才命中', () => {
    const base = { outcomes: [outcome({ close: 11 })], at: AT }
    expect(
      evaluateWatchPoints({ ...base, points: [point({ op: 'GTE', threshold: 10.5 })] }).hits
    ).toHaveLength(1)
    expect(
      evaluateWatchPoints({ ...base, points: [point({ op: 'GTE', threshold: 11.5 })] }).hits
    ).toHaveLength(0)
  })
})
