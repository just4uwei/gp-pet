/**
 * 指标层的边界与属性测试（docs/07 §2.1 的第二、三类）。
 *
 * 边界清单直接照 docs/04 §7 的第 2 条：
 * 全平（STD=0、BBW 除零）、单调上涨（RSI=100、avgLoss=0）、含涨跌停、长度不足、含缺口。
 *
 * 属性清单照第 3 条：RSI ∈ [0,100]、ADX ∈ [0,100]、UPPER > MID > LOWER（STD>0 时）。
 */

import { describe, expect, it } from 'vitest'
import {
  adxThresholds,
  aggregateWeekly,
  assessSufficiency,
  boll,
  computeIndicators,
  computeWeeklyIndicators,
  dmi,
  macd,
  maOf,
  marketSentiment,
  movingAverages,
  rawCloses,
  rsi,
  rsiThresholds,
  volumeMetrics,
} from '@core/indicators'
import { adjustedPrices } from '@core/indicators/prices'
import { DEFAULT_PARAMS } from '@core/params'
import { buildCandles, chopCloses, rampCloses } from '../../fixtures/klines'
import type { Candle } from '@core/types'

const P = DEFAULT_PARAMS

function flatCandles(n: number, price = 10): Candle[] {
  return buildCandles(new Array<number>(n).fill(price), {
    overrides: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [i, { open: price, high: price, low: price, close: price }])
    ),
  })
}

describe('movingAverages / maOf', () => {
  it('周期去重升序，非正周期被忽略', () => {
    const ma = movingAverages([1, 2, 3], [2, 2, -1, 0, 3])
    expect(Object.keys(ma)).toEqual(['2', '3'])
  })

  it('未配置的周期取到全 null 序列，而不是 undefined', () => {
    const ma = movingAverages([1, 2, 3], [2])
    expect(maOf(ma, 60, 3)).toEqual([null, null, null])
    expect(maOf(ma, 2, 3)[2]).toBeCloseTo(2.5, 10)
  })
})

describe('MACD', () => {
  it('DIF 从两条 EMA 都有值处开始 —— 不用快线单独有值的那段', () => {
    const closes = rampCloses(40, 10, 0.01)
    const result = macd(closes, { fast: 12, slow: 17, signal: 9 })
    expect(result.dif[15]).toBeNull()
    expect(result.dif[16]).not.toBeNull()
    // DEA 再等 signal-1 根
    expect(result.dea[23]).toBeNull()
    expect(result.dea[24]).not.toBeNull()
  })

  it('HIST 恒等于 2×(DIF−DEA)，且与 DIF−DEA 同号（口径差不影响判定）', () => {
    const result = macd(rampCloses(60, 10, 0.01), { fast: 12, slow: 17, signal: 9 })
    for (let i = 0; i < 60; i++) {
      const dif = result.dif[i]
      const dea = result.dea[i]
      const hist = result.hist[i]
      if (dif === null || dea === null || dif === undefined || dea === undefined) {
        expect(hist ?? null).toBeNull()
        continue
      }
      expect(hist).toBeCloseTo(2 * (dif - dea), 10)
    }
  })

  it('周期非正时三条序列都是 null', () => {
    const result = macd([1, 2, 3], { fast: 0, slow: 17, signal: 9 })
    expect(result.dif).toEqual([null, null, null])
    expect(result.hist).toEqual([null, null, null])
  })
})

describe('BOLL', () => {
  it('属性：STD > 0 时 UPPER > MID > LOWER', () => {
    const result = boll(chopCloses(60), P.boll)
    for (let i = 19; i < 60; i++) {
      const [up, mid, low] = [result.upper[i], result.mid[i], result.lower[i]]
      expect(up).not.toBeNull()
      expect(up ?? 0).toBeGreaterThan(mid ?? 0)
      expect(mid ?? 0).toBeGreaterThan(low ?? 0)
    }
  })

  it('全平序列：STD=0 → 三轨重合、BBW=0，不产出 NaN/Infinity', () => {
    const result = boll(new Array<number>(40).fill(10), P.boll)
    expect(result.upper[30]).toBeCloseTo(10, 10)
    expect(result.lower[30]).toBeCloseTo(10, 10)
    expect(result.bbw[30]).toBe(0)
    expect(Number.isFinite(result.bbw[30] ?? Number.NaN)).toBe(true)
  })

  it('带宽分位在第 269 根才有首个有效值（20 + 250 − 1）', () => {
    const result = boll(chopCloses(300), P.boll)
    expect(result.bbwPct[267]).toBeNull()
    expect(result.bbwPct[268]).not.toBeNull()
  })

  it('周期非正时整组为 null', () => {
    const result = boll([1, 2, 3], { period: 0, k: 2, bbwLookback: 250 })
    expect(result.mid).toEqual([null, null, null])
    expect(result.bbwPct).toEqual([null, null, null])
  })
})

describe('DMI / ADX / ATR', () => {
  const prices = adjustedPrices(buildCandles(chopCloses(80)))

  it('预热长度：ATR 首值在下标 14，ADX 首值在下标 27（第 28 根，docs/04 §1.5）', () => {
    const result = dmi(prices, 14)
    // TR 从下标 1 才有（首根没有前收），凑够 14 个要到下标 14
    expect(result.atr[13]).toBeNull()
    expect(result.atr[14]).not.toBeNull()
    // DX 从下标 14 才有，再 Wilder 预热 14 个 → 下标 27
    expect(result.adx[26]).toBeNull()
    expect(result.adx[27]).not.toBeNull()
  })

  it('属性：ADX 与 DI 都落在 0..100', () => {
    const result = dmi(adjustedPrices(buildCandles(rampCloses(120, 10, 0.01))), 14)
    for (let i = 0; i < 120; i++) {
      for (const series of [result.adx, result.plusDI, result.minusDI]) {
        const value = series[i]
        if (value === null || value === undefined) continue
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(100)
      }
    }
  })

  it('ATR 是均值口径（Wilder 和 / 周期），不是和式', () => {
    // 全平序列的 TR 恒为 0 → ATR 为 0；这里用固定振幅验证量级
    const candles = buildCandles(new Array<number>(40).fill(10), {
      overrides: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [i, { open: 10, high: 11, low: 9, close: 10 }])
      ),
    })
    const result = dmi(adjustedPrices(candles), 14)
    // 每根 TR = max(2, 1, 1) = 2 → ATR 应为 2，而和式会是 28
    expect(result.atr[30]).toBeCloseTo(2, 6)
  })

  it('完全无波动：DI 与 ADX 判为 0（无方向），不是 null 也不是 NaN', () => {
    const result = dmi(adjustedPrices(flatCandles(40)), 14)
    expect(result.plusDI[30]).toBe(0)
    expect(result.minusDI[30]).toBe(0)
    expect(result.adx[30]).toBe(0)
    expect(result.atr[30]).toBe(0)
  })

  it('周期非正或空序列不抛错', () => {
    expect(dmi(prices, 0).adx.every((v) => v === null)).toBe(true)
    expect(dmi(adjustedPrices([]), 14).adx).toEqual([])
  })
})

describe('RSI', () => {
  it('单调上涨 → avgLoss = 0 → RSI = 100（不是 NaN）', () => {
    const out = rsi(rampCloses(30, 10, 0.01), 14)
    expect(out[20]).toBe(100)
  })

  it('单调下跌 → RSI = 0', () => {
    const out = rsi(rampCloses(30, 10, -0.01), 14)
    expect(out[20]).toBe(0)
  })

  it('完全横盘 → 50（不偏多也不偏空）', () => {
    const out = rsi(new Array<number>(30).fill(10), 14)
    expect(out[20]).toBe(50)
  })

  it('属性：任何序列上都落在 0..100', () => {
    const out = rsi(chopCloses(120), 14)
    for (const value of out) {
      if (value === null) continue
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    }
  })

  it('周期非正时整条为 null', () => {
    expect(rsi([1, 2, 3], 0)).toEqual([null, null, null])
  })
})

describe('量能与盘中归一化（docs/04 §1.7）', () => {
  const volumes = [...new Array<number>(20).fill(1_000_000), 500_000]
  // SMA(20) 含当根（docs/04 §1.7 的 VOL_MA20 就是 SMA），故均量是 (19×100万 + 50万)/20
  const expectedMa = (19 * 1_000_000 + 500_000) / 20
  const expectedRatio = 500_000 / expectedMa

  it('收盘口径：量比 = 当日量 / 20 日均量（均量含当根）', () => {
    const result = volumeMetrics(volumes, { maPeriod: 20 })
    expect(result.volMa[20]).toBeCloseTo(expectedMa, 6)
    expect(result.volRatio[20]).toBeCloseTo(expectedRatio, 6)
  })

  it('盘中口径：按已完成交易时间占比归一化 —— 半天的量要放大一倍再比', () => {
    const result = volumeMetrics(volumes, { maPeriod: 20 }, {
      lastIsProvisional: true,
      intradayProgress: 0.5,
    })
    expect(result.volRatio[20]).toBeCloseTo(expectedRatio * 2, 6)
    // 这条才是这段代码存在的理由：不归一化的话上午永远显示「缩量」
    expect(result.volRatio[20] ?? 0).toBeGreaterThan(1)
  })

  it('开盘前（progress = 0）给 null，而不是 Infinity', () => {
    const result = volumeMetrics(volumes, { maPeriod: 20 }, {
      lastIsProvisional: true,
      intradayProgress: 0,
    })
    expect(result.volRatio[20]).toBeNull()
  })

  it('历史根不受盘中归一化影响；缺省 progress 视为整日', () => {
    const result = volumeMetrics(volumes, { maPeriod: 20 }, { lastIsProvisional: true })
    expect(result.volRatio[20]).toBeCloseTo(expectedRatio, 6)
  })

  it('均量为 0（全程零成交）时给 null', () => {
    const result = volumeMetrics(new Array<number>(25).fill(0), { maPeriod: 20 })
    expect(result.volRatio[24]).toBeNull()
  })

  it('周期非正时整组为 null', () => {
    expect(volumeMetrics([1, 2], { maPeriod: 0 }).volMa).toEqual([null, null])
  })
})

describe('动态阈值', () => {
  it('ADX 阈值随波动率分位在 base..max 之间移动，震荡线低 rangeGap', () => {
    const candles = buildCandles(chopCloses(300))
    const prices = adjustedPrices(candles)
    const result = dmi(prices, 14)
    const thresholds = adxThresholds(result.atr, prices.close, P.adx, P.boll.bbwLookback)
    for (let i = 0; i < 300; i++) {
      const trend = thresholds.adxTrend[i]
      if (trend === null || trend === undefined) continue
      expect(trend).toBeGreaterThanOrEqual(P.adx.baseThreshold)
      expect(trend).toBeLessThanOrEqual(P.adx.maxThreshold)
      expect(thresholds.adxRange[i]).toBeCloseTo(trend - P.adx.rangeGap, 10)
    }
  })

  it('分位未预热时退到基准线（而不是让阈值为 null 使趋势判定全部失效）', () => {
    const candles = buildCandles(chopCloses(60))
    const prices = adjustedPrices(candles)
    const result = dmi(prices, 14)
    const thresholds = adxThresholds(result.atr, prices.close, P.adx, P.boll.bbwLookback)
    expect(thresholds.volPct[50]).toBeNull()
    expect(thresholds.adxTrend[50]).toBe(P.adx.baseThreshold)
  })

  it('RSI 阈值随情绪单调抬升，牛熊两端与 docs/04 §1.6 的表一致', () => {
    const bear = rsiThresholds(3, 0, P.rsi)
    const neutral = rsiThresholds(3, 0.5, P.rsi)
    const bull = rsiThresholds(3, 1, P.rsi)
    expect(bear.rsiOverbought[0]).toBe(65)
    expect(bear.rsiOversold[0]).toBe(15)
    expect(neutral.rsiOverbought[0]).toBe(75)
    expect(neutral.rsiOversold[0]).toBe(25)
    expect(bull.rsiOverbought[0]).toBe(85)
    expect(bull.rsiOversold[0]).toBe(35)
  })

  it('情绪值越界被夹紧；长度非正不抛错', () => {
    expect(rsiThresholds(1, 5, P.rsi).rsiOverbought[0]).toBe(85)
    expect(rsiThresholds(1, -5, P.rsi).rsiOversold[0]).toBe(15)
    expect(rsiThresholds(-1, 0.5, P.rsi).rsiOverbought).toEqual([])
  })

  it('市场情绪：单调上涨的基准 → 分位接近 1；数据不足给中性 0.5', () => {
    expect(marketSentiment(rampCloses(300, 3000, 0.002))).toBeGreaterThan(0.9)
    expect(marketSentiment([1, 2, 3])).toBe(0.5)
    expect(marketSentiment(new Array<number>(300).fill(0))).toBe(0.5)
  })
})

describe('周线聚合（docs/04 §1.8）', () => {
  it('按自然周分组：开取周首、收取周末、高低取极值、量求和', () => {
    // 2023-01-02 是周一，前 5 根构成一整周
    const candles = buildCandles([10, 11, 9, 12, 11.5, 12.5], { volume: 1000 })
    const weekly = aggregateWeekly(candles)
    expect(weekly).toHaveLength(2)
    const first = weekly[0]
    expect(first?.open).toBeCloseTo(candles[0]?.open ?? 0, 10)
    expect(first?.close).toBeCloseTo(11.5, 10)
    expect(first?.high).toBeCloseTo(Math.max(...candles.slice(0, 5).map((c) => c.high)), 10)
    expect(first?.low).toBeCloseTo(Math.min(...candles.slice(0, 5).map((c) => c.low)), 10)
    expect(first?.volume).toBe(5000)
    // 周线 K 的日期取该周最后一个交易日
    expect(first?.date).toBe(candles[4]?.date)
  })

  it('任一日缺成交额 → 整周为 null（补 0 会让周成交额看起来正常却偏小）', () => {
    const candles = buildCandles([10, 11, 12], { overrides: { 1: { amount: null } } })
    expect(aggregateWeekly(candles)[0]?.amount).toBeNull()
  })

  it('末周未走完 → 最后一根周线是 provisional', () => {
    // 3 根（周一到周三）→ 本周显然没结束
    expect(aggregateWeekly(buildCandles([10, 11, 12])).at(-1)?.provisional).toBe(true)
    // 完整一周（周一到周五，且末根不是临时线）→ 不标 provisional
    expect(aggregateWeekly(buildCandles([10, 11, 12, 13, 14])).at(-1)?.provisional).toBeUndefined()
  })

  it('日线末根是临时线时，周线末根也是临时的', () => {
    const candles = buildCandles([10, 11, 12, 13, 14], { overrides: { 4: { provisional: true } } })
    expect(aggregateWeekly(candles).at(-1)?.provisional).toBe(true)
  })

  it('任一日有缺口标记则整周带 hasGap；空输入不抛错', () => {
    const candles = buildCandles([10, 11, 12], { overrides: { 1: { hasGap: true } } })
    expect(aggregateWeekly(candles)[0]?.hasGap).toBe(true)
    expect(aggregateWeekly([])).toEqual([])
  })

  it('周线指标只算 MACD 与 ADX', () => {
    const weekly = aggregateWeekly(buildCandles(chopCloses(300)))
    const indicators = computeWeeklyIndicators(weekly, P)
    expect(indicators.length).toBe(weekly.length)
    expect(indicators.dif.length).toBe(weekly.length)
    expect(indicators.adx.length).toBe(weekly.length)
  })
})

describe('数据充分性（docs/04 §1.10）', () => {
  it('少于 minBars 不产出信号', () => {
    const result = assessSufficiency(30, [null], 0, P.data)
    expect(result.usable).toBe(false)
    expect(result.note).toContain('30')
  })

  it('介于 minBars 与 fullBars：受限模式 + 折价', () => {
    const result = assessSufficiency(100, [null], 0, P.data)
    expect(result.usable).toBe(true)
    expect(result.limited).toBe(true)
    expect(result.penalty).toBe(P.data.insufficientPenalty)
    expect(result.bbwPercentileReady).toBe(false)
  })

  it('根数够但带宽分位还没预热出来 → 仍是受限模式', () => {
    const result = assessSufficiency(400, [null], 0, P.data)
    expect(result.limited).toBe(true)
    expect(result.penalty).toBe(P.data.insufficientPenalty)
  })

  it('根数够且分位可用 → 无折价、无提示', () => {
    const result = assessSufficiency(400, [50], 0, P.data)
    expect(result.limited).toBe(false)
    expect(result.penalty).toBe(1)
    expect(result.note).toBeNull()
  })
})

describe('computeIndicators 整体', () => {
  it('每条序列都与输入等长', () => {
    const candles = buildCandles(chopCloses(300))
    const ind = computeIndicators(candles, P, { sentiment: 0.5 })
    const lengths = [
      ind.macd.dif,
      ind.macd.dea,
      ind.macd.hist,
      ind.boll.mid,
      ind.boll.bbwPct,
      ind.dmi.adx,
      ind.rsi,
      ind.volMa,
      ind.volRatio,
      ind.thresholds.adxTrend,
      ind.thresholds.rsiOverbought,
      ind.thresholds.volPct,
      ...Object.values(ind.ma),
    ]
    for (const series of lengths) expect(series).toHaveLength(300)
  })

  it('末根是临时线时，量比按传入的时间占比归一化', () => {
    const closes = chopCloses(40)
    const candles = buildCandles(closes, {
      volume: (i) => (i === 39 ? 500_000 : 1_000_000),
      overrides: { 39: { provisional: true } },
    })
    const half = computeIndicators(candles, P, { sentiment: 0.5, intradayProgress: 0.5 })
    const whole = computeIndicators(candles, P, { sentiment: 0.5, intradayProgress: 1 })
    expect(half.volRatio[39] ?? 0).toBeCloseTo(2 * (whole.volRatio[39] ?? 0), 6)
  })

  it('rawCloses 取不复权价，指标取前复权价 —— 两者不能混（docs/03 §2.3）', () => {
    const candles = buildCandles([10, 11, 12], { factor: 0.5 })
    expect(rawCloses(candles)).toEqual([10, 11, 12])
    expect(adjustedPrices(candles).close).toEqual([5, 5.5, 6])
  })

  it('空序列不抛错', () => {
    const ind = computeIndicators([], P, { sentiment: 0.5 })
    expect(ind.rsi).toEqual([])
    expect(adjustedPrices([]).close).toEqual([])
  })
})
