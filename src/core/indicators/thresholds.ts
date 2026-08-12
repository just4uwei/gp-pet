/**
 * 动态阈值（docs/04 §1.5、§1.6）。
 *
 * ADX 阈值随本标的自身波动率走：
 * ```
 * volPct = ATR/close 在过去 250 日中的百分位 (0..1)
 * adxTrend = clamp(base + volScale × volPct, base, max)
 * adxRange = adxTrend - rangeGap
 * ```
 * 高波动标的需要更高的 ADX 才算「有趋势」—— 否则波动本身就会把 ADX 顶上去。
 *
 * RSI 阈值随**大盘情绪**走。原文此处自相矛盾（说「牛市降低超买阈值至 85」，而 85 高于
 * 默认 70，实为上调），按其真实意图重定义为单调、连续、无矛盾的形式：
 * ```
 * rsiOverbought = obBase + sentimentScale × s     s=0 熊 → 65   s=1 牛 → 85
 * rsiOversold   = osBase + sentimentScale × s     s=0 熊 → 15   s=1 牛 → 35
 * ```
 * 牛市里超卖线抬高 = 浅回调即视为买点；熊市里超买线压低 = 小反弹即视为卖点。
 */

import type { Series } from '../types'
import { at, clamp, nulls, rollingPercentile } from './series'

export interface AdxThresholdParams {
  baseThreshold: number
  volScale: number
  maxThreshold: number
  rangeGap: number
}

export interface AdxThresholds {
  adxTrend: Series
  adxRange: Series
  /** ATR/close 的 250 日分位 0..1，落进 evidence 便于解释「为什么今天的门槛是 24」 */
  volPct: Series
}

export function adxThresholds(
  atr: Series,
  closes: readonly number[],
  params: AdxThresholdParams,
  lookback: number
): AdxThresholds {
  const n = closes.length
  const ratio: Series = nulls(n)
  for (let i = 0; i < n; i++) {
    const a = at(atr, i)
    const close = at(closes, i)
    if (a === null || close === null || close <= 0) continue
    ratio[i] = a / close
  }

  const percentile = rollingPercentile(ratio, lookback)
  const adxTrend: Series = nulls(n)
  const adxRange: Series = nulls(n)
  const volPct: Series = nulls(n)

  for (let i = 0; i < n; i++) {
    const pct = at(percentile, i)
    // 分位还没预热出来（不足 250 根）时退到基准线，而不是让阈值为 null 使全部趋势判定失效。
    // 受限模式下这是有意的保守选择：门槛取最低值 base，方向判定仍由 +DI/-DI 把关
    const scaled = pct === null ? 0 : pct / 100
    const trend = clamp(
      params.baseThreshold + params.volScale * scaled,
      params.baseThreshold,
      params.maxThreshold
    )
    adxTrend[i] = trend
    adxRange[i] = trend - params.rangeGap
    if (pct !== null) volPct[i] = scaled
  }

  return { adxTrend, adxRange, volPct }
}

export interface RsiThresholdParams {
  obBase: number
  osBase: number
  sentimentScale: number
}

export interface RsiThresholds {
  rsiOverbought: Series
  rsiOversold: Series
}

/**
 * ⚠ 情绪值是**当期**标量（由基准指数近 20 日收益的 250 日分位算出，见 marketSentiment）。
 * 这里把它铺满整条序列只是为了让 `IndicatorSet` 的形状统一 ——
 * **历史位置上的阈值不代表当时的真实阈值，只有最后一根有意义**。
 * 回测里每根 K 线各自调用一次引擎，那时的「最后一根」才是被判定的那根，因此不受影响。
 */
export function rsiThresholds(
  length: number,
  sentiment: number,
  params: RsiThresholdParams
): RsiThresholds {
  const s = clamp(sentiment, 0, 1)
  const overbought = params.obBase + params.sentimentScale * s
  const oversold = params.osBase + params.sentimentScale * s
  return {
    rsiOverbought: new Array<number | null>(Math.max(0, length)).fill(overbought),
    rsiOversold: new Array<number | null>(Math.max(0, length)).fill(oversold),
  }
}

/**
 * 市场情绪指数 s ∈ [0,1]：基准指数近 `window` 日收益率在过去 `lookback` 个同类样本中的分位。
 *
 * 放在 core 而不是 main：它是 RSI 阈值的输入，回测必须能用同一套算法从基准指数序列复现它，
 * 否则「盘中提醒」与「回测结论」用的是两条不同的阈值曲线。
 *
 * 基准日线不足时返回 0.5（中性）而不是 0 —— 0 意味着「确定处于熊市」，
 * 那是一个由缺数据编出来的结论。
 */
export function marketSentiment(
  benchmarkCloses: readonly number[],
  window = 20,
  lookback = 250
): number {
  const n = benchmarkCloses.length
  if (n < window + 1) return 0.5

  const returns: number[] = []
  for (let i = window; i < n; i++) {
    const now = at(benchmarkCloses, i)
    const before = at(benchmarkCloses, i - window)
    if (now === null || before === null || before <= 0) continue
    returns.push(now / before - 1)
  }

  const current = returns[returns.length - 1]
  if (current === undefined) return 0.5
  const samples = returns.slice(Math.max(0, returns.length - lookback))
  let leq = 0
  for (const sample of samples) {
    if (sample <= current) leq++
  }
  return samples.length === 0 ? 0.5 : leq / samples.length
}
