/**
 * 指标层门面（docs/04 §1）：`Candle[]` → `IndicatorSet`。
 *
 * 一次算全序列而不是只算最后一根，理由有两条：
 *   1. 策略层要回溯（「近 5 日曾触上轨」「HIST 连续 2 日放大」），只有末值不够
 *   2. 回测里每根 K 线都会被当作「最后一根」评一次，同一套代码复用才谈得上「同源」
 *
 * 全部输入取**前复权**（见 prices.ts）。
 */

import type { Candle, IndicatorSet, Series } from '../types'
import type { EngineParams } from '../params'
import { boll } from './boll'
import { dmi } from './dmi'
import { movingAverages } from './ma'
import { macd } from './macd'
import { adjustedPrices } from './prices'
import { rsi } from './rsi'
import { adxThresholds, rsiThresholds } from './thresholds'
import { volumeMetrics } from './volume'

export interface IndicatorOptions {
  /** 市场情绪 0..1（见 thresholds.ts 的 marketSentiment），决定 RSI 动态阈值 */
  sentiment: number
  /** 已完成的连续竞价时间占比 0..1，只在最后一根是临时线时生效（docs/04 §1.7） */
  intradayProgress?: number
}

export function computeIndicators(
  candles: readonly Candle[],
  params: EngineParams,
  options: IndicatorOptions
): IndicatorSet {
  const prices = adjustedPrices(candles)
  const n = candles.length
  const lastIsProvisional = candles[n - 1]?.provisional === true

  const ma = movingAverages(prices.close, params.ma.periods)
  const macdResult = macd(prices.close, params.macd)
  const bollResult = boll(prices.close, params.boll)
  const dmiResult = dmi(prices, params.adx.period)
  const rsiResult = rsi(prices.close, params.rsi.period)

  const volume = volumeMetrics(prices.volume, params.volume, {
    lastIsProvisional,
    ...(options.intradayProgress === undefined ? {} : { intradayProgress: options.intradayProgress }),
  })

  // 波动率分位与带宽分位共用 boll.bbwLookback 的回看长度：两者都是「250 日历史分位」，
  // 分开配只会多一个没人会去标定的参数
  const adx = adxThresholds(dmiResult.atr, prices.close, params.adx, params.boll.bbwLookback)
  const rsiBands = rsiThresholds(n, options.sentiment, params.rsi)

  return {
    ma,
    macd: macdResult,
    boll: bollResult,
    dmi: dmiResult,
    rsi: rsiResult,
    volMa: volume.volMa,
    volRatio: volume.volRatio,
    thresholds: {
      adxTrend: adx.adxTrend,
      adxRange: adx.adxRange,
      rsiOverbought: rsiBands.rsiOverbought,
      rsiOversold: rsiBands.rsiOversold,
      volPct: adx.volPct,
    },
  }
}

/** 周线指标：只用到 MACD 与 ADX（docs/04 §1.8 / §3.3），不必算全套 */
export interface WeeklyIndicators {
  dif: Series
  dea: Series
  hist: Series
  adx: Series
  length: number
}

export function computeWeeklyIndicators(
  weekly: readonly Candle[],
  params: EngineParams
): WeeklyIndicators {
  const prices = adjustedPrices(weekly)
  const macdResult = macd(prices.close, params.macd)
  const dmiResult = dmi(prices, params.adx.period)
  return {
    dif: macdResult.dif,
    dea: macdResult.dea,
    hist: macdResult.hist,
    adx: dmiResult.adx,
    length: weekly.length,
  }
}

export { boll } from './boll'
export { dmi } from './dmi'
export { maOf, movingAverages } from './ma'
export { macd } from './macd'
export { adjustedPrices, rawCloses } from './prices'
export { rsi } from './rsi'
export { assessSufficiency } from './sufficiency'
export type { DataSufficiency } from './sufficiency'
export { adxThresholds, marketSentiment, rsiThresholds } from './thresholds'
export { volumeMetrics } from './volume'
export { aggregateWeekly } from './weekly'
export * from './series'
export type { BollParams } from './boll'
export type { MacdParams } from './macd'
export type { PriceSeries } from './prices'
export type { VolumeOptions, VolumeParams, VolumeResult } from './volume'
export type { AdxThresholdParams, AdxThresholds, RsiThresholdParams, RsiThresholds } from './thresholds'
