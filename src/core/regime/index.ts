/**
 * 市场状态层（docs/04 §2）。
 *
 * | 状态 | 判定条件（同时满足） |
 * |---|---|
 * | `TREND_UP`   | ADX > adxTrend 且 +DI > -DI 且 close > MA20 且 多头排列得分 ≥ 2/3 |
 * | `TREND_DOWN` | ADX > adxTrend 且 -DI > +DI 且 close < MA20 且 空头排列得分 ≥ 2/3 |
 * | `RANGE`      | ADX < adxRange 且 BBW_PCT < 30 且 \|close-MID\|/MID < 0.03 |
 * | `TRANSITION` | 以上都不满足，或命中任一突变条件 |
 *
 * **迟滞是这一层的重点**：Regime 必须连续 `hysteresisDays` 个交易日给出同一结论才切换。
 * 震荡市里 ADX 在阈值附近反复穿越是常态，没有迟滞会导致策略权重每天翻转
 * —— 那比任何单一策略都糟。
 *
 * 整条序列一次算完（而不是「读上次状态 + 增量推进」），是为了让盘中重算不污染历史：
 * 盘中最后一根是临时线，若把它的结论持久化下来，收盘后就再也分不清
 * 「状态是真的切了」还是「上午那次抖动被记成了历史」。
 */

import { maOf } from '../indicators/ma'
import { at, changeOver } from '../indicators/series'
import type { EngineParams } from '../params'
import type { Candle, Evidence, IndicatorSet, Regime, RegimeState } from '../types'

/** 多头排列得分 = [MA5>MA20, MA20>MA60, close>MA5] 中为真的个数（docs/04 §2.1） */
function alignmentScore(
  close: number,
  ma5: number | null,
  ma20: number | null,
  ma60: number | null,
  bullish: boolean
): number {
  const tests: boolean[] = [
    ma5 !== null && ma20 !== null && (bullish ? ma5 > ma20 : ma5 < ma20),
    ma20 !== null && ma60 !== null && (bullish ? ma20 > ma60 : ma20 < ma60),
    ma5 !== null && (bullish ? close > ma5 : close < ma5),
  ]
  return tests.filter(Boolean).length
}

export interface RawRegime {
  regime: Regime
  /** 指标尚未预热完 → 判定无依据。此时一律 TRANSITION，且不该被解释成「正在转换」 */
  determinate: boolean
  evidence: Evidence
}

/**
 * 单根 K 线上的原始判定，不含迟滞。
 *
 * ⚠ 突变条件里「ADX 3 日变化 > 5」原文未说是否取绝对值，但括注为「趋势快速形成**或瓦解**」
 * —— 瓦解就是下降。因此按绝对值处理，与 BBW_PCT 那条（原文明确写了绝对值）保持一致。
 */
export function rawRegimeAt(
  candles: readonly Candle[],
  ind: IndicatorSet,
  index: number,
  params: EngineParams
): RawRegime {
  const candle = candles[index]
  const close = candle?.closeAdj ?? null
  const adx = at(ind.dmi.adx, index)
  const adxTrend = at(ind.thresholds.adxTrend, index)
  const adxRange = at(ind.thresholds.adxRange, index)
  const plusDI = at(ind.dmi.plusDI, index)
  const minusDI = at(ind.dmi.minusDI, index)
  const ma5 = at(maOf(ind.ma, 5, candles.length), index)
  const ma20 = at(maOf(ind.ma, 20, candles.length), index)
  const ma60 = at(maOf(ind.ma, 60, candles.length), index)
  const bbwPct = at(ind.boll.bbwPct, index)
  const mid = at(ind.boll.mid, index)
  const volRatio = at(ind.volRatio, index)

  const midDistance = mid !== null && mid > 0 && close !== null ? Math.abs(close - mid) / mid : null
  const bullish = close === null ? 0 : alignmentScore(close, ma5, ma20, ma60, true)
  const bearish = close === null ? 0 : alignmentScore(close, ma5, ma20, ma60, false)

  const adxJump = changeOver(ind.dmi.adx, index, params.regime.adxSlopeWindow)
  const bbwJump = changeOver(ind.boll.bbwPct, index, params.regime.adxSlopeWindow)
  const adxShock = adxJump !== null && Math.abs(adxJump) > params.regime.adxSlopeTrigger
  const bbwShock = bbwJump !== null && Math.abs(bbwJump) > params.regime.bbwPctJump
  const volShock = volRatio !== null && volRatio > params.volume.suspiciousRatio

  const evidence: Evidence = {
    adx,
    adxTrend,
    adxRange,
    plusDI,
    minusDI,
    close,
    ma5,
    ma20,
    ma60,
    bbwPct,
    midDistance,
    bullishAlignment: bullish,
    bearishAlignment: bearish,
    volRatio,
    adxChange3: adxJump,
    bbwPctChange3: bbwJump,
    shock: adxShock ? 'ADX' : bbwShock ? 'BBW_PCT' : volShock ? 'VOLUME' : null,
  }

  // 预热未完成：给 TRANSITION 但标记 determinate = false。
  // 受限模式下 bbwPct 恒为 null —— 那只让 RANGE 无法成立，不该让整个判定作废，
  // 所以 bbwPct 不进这里的必需项
  if (close === null || adx === null || adxTrend === null || adxRange === null || ma20 === null) {
    return { regime: 'TRANSITION', determinate: false, evidence }
  }

  if (adxShock || bbwShock || volShock) return { regime: 'TRANSITION', determinate: true, evidence }

  if (
    adx > adxTrend &&
    plusDI !== null &&
    minusDI !== null &&
    plusDI > minusDI &&
    close > ma20 &&
    bullish >= 2
  ) {
    return { regime: 'TREND_UP', determinate: true, evidence }
  }

  if (
    adx > adxTrend &&
    plusDI !== null &&
    minusDI !== null &&
    minusDI > plusDI &&
    close < ma20 &&
    bearish >= 2
  ) {
    return { regime: 'TREND_DOWN', determinate: true, evidence }
  }

  if (
    adx < adxRange &&
    bbwPct !== null &&
    bbwPct < params.regime.rangeBbwPct &&
    midDistance !== null &&
    midDistance < params.regime.rangeMidBand
  ) {
    return { regime: 'RANGE', determinate: true, evidence }
  }

  return { regime: 'TRANSITION', determinate: true, evidence }
}

/**
 * 逐根算出带迟滞的状态序列。返回数组与输入等长，`[i]` 是「截至第 i 根」的状态。
 *
 * 迟滞规则：原始判定与当前状态不同时，需要连续 `hysteresisDays` 根给出**同一个**新结论
 * 才切换；否则维持原状态并继续累计 heldDays。
 */
export function classifyRegimes(
  candles: readonly Candle[],
  ind: IndicatorSet,
  params: EngineParams
): RegimeState[] {
  const need = Math.max(1, params.regime.hysteresisDays)
  const out: RegimeState[] = []
  let held: Regime | null = null
  let heldDays = 0
  let previousRaw: Regime | null = null
  let rawStreak = 0

  for (let i = 0; i < candles.length; i++) {
    const raw = rawRegimeAt(candles, ind, i, params)
    rawStreak = raw.regime === previousRaw ? rawStreak + 1 : 1
    previousRaw = raw.regime

    if (held === null) {
      held = raw.regime
      heldDays = 1
    } else if (raw.regime === held) {
      heldDays += 1
    } else if (rawStreak >= need) {
      held = raw.regime
      heldDays = 1
    } else {
      heldDays += 1
    }

    out.push({ regime: held, raw: raw.regime, heldDays, evidence: raw.evidence })
  }

  return out
}

/** 截至最后一根的状态。序列为空时给一个中性的 TRANSITION，而不是抛错。 */
export function currentRegime(states: readonly RegimeState[]): RegimeState {
  const last = states[states.length - 1]
  return last ?? { regime: 'TRANSITION', raw: 'TRANSITION', heldDays: 0, evidence: {} }
}
