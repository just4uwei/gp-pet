/**
 * 黄金用例（docs/07 §2.1 第一层验证）。
 *
 * 期望值来自 `scripts/verify/reference.mjs` 的**独立参照实现**，不是从生产代码抄的。
 * 两套实现风格相反（增量递推 vs 每格重算窗口），因此这条用例真正在验的是
 * 「同一份公式被实现了两次，结果一致」。
 *
 * 失败时的处理顺序：
 *   1. 先看是不是 params.ts 改了而黄金值没重跑（下面第一条用例会直接告诉你）
 *   2. 再看是不是参照实现与文档的口径分歧（那要改 docs/04 或 reference.mjs，不是改断言）
 *   3. 最后才怀疑生产实现 —— 但也别直接改断言来迁就，那会让基线失去意义
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeIndicators } from '@core/indicators'
import { at } from '@core/indicators/series'
import { DEFAULT_PARAMS } from '@core/params'
import type { Candle, Series } from '@core/types'

const ROOT = process.cwd()
const golden = JSON.parse(
  readFileSync(join(ROOT, 'tests/fixtures/golden/indicators.json'), 'utf8')
) as {
  bars: number
  tolerance: number
  params: {
    ma: { periods: number[] }
    macd: { fast: number; slow: number; signal: number }
    boll: { period: number; k: number; bbwLookback: number }
    adx: { period: number; baseThreshold: number; volScale: number; maxThreshold: number; rangeGap: number }
    rsi: { period: number }
    volume: { maPeriod: number }
  }
  sampleIndices: number[]
  indicators: Record<string, Record<string, number | null>>
}

const candles = JSON.parse(
  readFileSync(join(ROOT, 'tests/fixtures/klines/synthetic-500.json'), 'utf8')
) as Candle[]

// 情绪值不进黄金用例：RSI 的两条阈值是「当期标量铺满」，与 K 线无关（见 thresholds.ts）
const indicators = computeIndicators(candles, DEFAULT_PARAMS, { sentiment: 0.5 })

function seriesOf(key: string): Series {
  switch (key) {
    case 'macd.dif':
      return indicators.macd.dif
    case 'macd.dea':
      return indicators.macd.dea
    case 'macd.hist':
      return indicators.macd.hist
    case 'boll.mid':
      return indicators.boll.mid
    case 'boll.upper':
      return indicators.boll.upper
    case 'boll.lower':
      return indicators.boll.lower
    case 'boll.bbw':
      return indicators.boll.bbw
    case 'boll.bbwPct':
      return indicators.boll.bbwPct
    case 'dmi.adx':
      return indicators.dmi.adx
    case 'dmi.plusDI':
      return indicators.dmi.plusDI
    case 'dmi.minusDI':
      return indicators.dmi.minusDI
    case 'dmi.atr':
      return indicators.dmi.atr
    case 'rsi':
      return indicators.rsi
    case 'volMa':
      return indicators.volMa
    case 'volRatio':
      return indicators.volRatio
    case 'thresholds.adxTrend':
      return indicators.thresholds.adxTrend
    case 'thresholds.adxRange':
      return indicators.thresholds.adxRange
    case 'thresholds.volPct':
      return indicators.thresholds.volPct
    default: {
      const period = /^ma(\d+)$/.exec(key)?.[1]
      if (period) return indicators.ma[Number(period)] ?? []
      throw new Error(`黄金用例里出现了未知序列：${key}`)
    }
  }
}

describe('黄金用例 · 参数一致性', () => {
  it('黄金值是用当前的 DEFAULT_PARAMS 算出来的', () => {
    // 这条先跑：参数变了却没重跑 pnpm verify:indicators 时，
    // 报错信息应当是「参数不一致」，而不是几十行数值差
    expect([...DEFAULT_PARAMS.ma.periods]).toEqual(golden.params.ma.periods)
    expect(DEFAULT_PARAMS.macd.fast).toBe(golden.params.macd.fast)
    expect(DEFAULT_PARAMS.macd.slow).toBe(golden.params.macd.slow)
    expect(DEFAULT_PARAMS.macd.signal).toBe(golden.params.macd.signal)
    expect(DEFAULT_PARAMS.boll.period).toBe(golden.params.boll.period)
    expect(DEFAULT_PARAMS.boll.k).toBe(golden.params.boll.k)
    expect(DEFAULT_PARAMS.boll.bbwLookback).toBe(golden.params.boll.bbwLookback)
    expect(DEFAULT_PARAMS.adx.period).toBe(golden.params.adx.period)
    expect(DEFAULT_PARAMS.adx.baseThreshold).toBe(golden.params.adx.baseThreshold)
    expect(DEFAULT_PARAMS.adx.volScale).toBe(golden.params.adx.volScale)
    expect(DEFAULT_PARAMS.adx.maxThreshold).toBe(golden.params.adx.maxThreshold)
    expect(DEFAULT_PARAMS.adx.rangeGap).toBe(golden.params.adx.rangeGap)
    expect(DEFAULT_PARAMS.rsi.period).toBe(golden.params.rsi.period)
    expect(DEFAULT_PARAMS.volume.maPeriod).toBe(golden.params.volume.maPeriod)
  })

  it('fixture 长度与黄金用例声明一致', () => {
    expect(candles.length).toBe(golden.bars)
  })
})

describe('黄金用例 · 逐指标比对', () => {
  for (const key of Object.keys(golden.indicators)) {
    it(`${key} 与独立参照实现一致（相对误差 < ${golden.tolerance}）`, () => {
      const series = seriesOf(key)
      const expected = golden.indicators[key] ?? {}
      let compared = 0
      for (const [rawIndex, value] of Object.entries(expected)) {
        const index = Number(rawIndex)
        const actual = at(series, index)
        if (value === null) {
          expect(actual, `${key}[${index}] 应为 null（预热期）`).toBeNull()
          continue
        }
        expect(actual, `${key}[${index}] 不应为 null`).not.toBeNull()
        const denominator = Math.max(1e-12, Math.abs(value))
        expect(
          Math.abs((actual ?? 0) - value) / denominator,
          `${key}[${index}] 期望 ${value}，实际 ${actual}`
        ).toBeLessThan(golden.tolerance)
        compared++
      }
      // 全是 null 的序列（比如 fixture 只有 500 根时的 ma120 前段）不该被当作「通过」
      expect(compared, `${key} 没有任何非 null 值参与比对`).toBeGreaterThan(0)
    })
  }
})
