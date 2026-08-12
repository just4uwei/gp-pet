/**
 * 均值回归策略 R1–R4（docs/04 §3.2）。
 *
 * | ID | BUY 条件 | SELL 条件 | 权重 |
 * |---|---|---|---|
 * | `R1_RSI_BAND`       | RSI < rsiOversold 且 low ≤ LOWER | RSI > rsiOverbought 且 high ≥ UPPER | 0.30 |
 * | `R2_REVERT_TO_MID`  | 近 3 日曾 close<LOWER，今日 close>MID 且 HIST 转正 | 近 3 日曾 close>UPPER，今日 close<MID 且 HIST 转负 | 0.30 |
 * | `R3_SQUEEZE`        | BBW_PCT < 10 且 low ≤ LOWER | BBW_PCT < 10 且 high ≥ UPPER | 0.20 |
 * | `R4_MID_REVERSION`  | RANGE 状态下 close 低于 MID 超过 1.5×STD | RANGE 状态下 close 高于 MID 超过 1.5×STD | 0.20 |
 *
 * ⚠ 均值回归在下跌趋势里是**接飞刀**。这一层不做方向过滤（子信号只描述「条件成立了」），
 * 抑制发生在组合层：`TREND_DOWN` 下均值回归的 BUY 得分再乘 0.5（docs/04 §4.1）。
 * 把它放在组合层而不是这里，是为了让「信号成立但被降权」在 evidence 里看得见。
 */

import { at, existsWithin } from '../indicators/series'
import type { SubSignal } from '../types'
import {
  bandStdev,
  closeAt,
  finalize,
  highAt,
  lowAt,
  strength,
  value,
  type StrategyContext,
  type SubSignalDraft,
} from './context'

export const MEAN_REVERSION_WEIGHTS = {
  R1_RSI_BAND: 0.3,
  R2_REVERT_TO_MID: 0.3,
  R3_SQUEEZE: 0.2,
  R4_MID_REVERSION: 0.2,
} as const

export function meanReversionSignals(ctx: StrategyContext): SubSignal[] {
  const drafts: SubSignalDraft[] = []
  const { ind } = ctx

  const close = closeAt(ctx)
  const low = lowAt(ctx, ctx.index)
  const high = highAt(ctx, ctx.index)
  const rsi = value(ind.rsi, ctx)
  const overbought = value(ind.thresholds.rsiOverbought, ctx)
  const oversold = value(ind.thresholds.rsiOversold, ctx)
  const upper = value(ind.boll.upper, ctx)
  const lower = value(ind.boll.lower, ctx)
  const mid = value(ind.boll.mid, ctx)
  const bbwPct = value(ind.boll.bbwPct, ctx)
  const hist = value(ind.macd.hist, ctx)
  const histPrev = value(ind.macd.hist, ctx, 1)
  const std = bandStdev(ctx)

  // ── R1 RSI 极值 + 触轨 ─────────────────────────────────────────────
  const r1Evidence = { rsi, rsiOverbought: overbought, rsiOversold: oversold, low, high, upper, lower }

  if (rsi !== null && oversold !== null && rsi < oversold && low !== null && lower !== null && low <= lower) {
    drafts.push({
      id: 'R1_RSI_BAND',
      direction: 'BUY',
      // 超出阈值 10 个点算「深度超卖」，给满分
      score: strength(oversold - rsi, 10),
      weight: MEAN_REVERSION_WEIGHTS.R1_RSI_BAND,
      evidence: { ...r1Evidence, side: 'OVERSOLD' },
    })
  }
  if (rsi !== null && overbought !== null && rsi > overbought && high !== null && upper !== null && high >= upper) {
    drafts.push({
      id: 'R1_RSI_BAND',
      direction: 'SELL',
      score: strength(rsi - overbought, 10),
      weight: MEAN_REVERSION_WEIGHTS.R1_RSI_BAND,
      evidence: { ...r1Evidence, side: 'OVERBOUGHT' },
    })
  }

  // ── R2 回归中轨 ────────────────────────────────────────────────────
  const window = ctx.params.strategy.revertLookback
  const wasBelowLower = existsWithin(ctx.index, window, (j) => {
    const c = ctx.candles[j]?.closeAdj ?? null
    const down = at(ind.boll.lower, j)
    return c !== null && down !== null && c < down
  })
  const wasAboveUpper = existsWithin(ctx.index, window, (j) => {
    const c = ctx.candles[j]?.closeAdj ?? null
    const up = at(ind.boll.upper, j)
    return c !== null && up !== null && c > up
  })
  // 「HIST 转正」只认相邻两根之间那一次翻转，与穿越判定同一口径（docs/04 §1.9）
  const histTurnedPositive = hist !== null && histPrev !== null && hist > 0 && histPrev <= 0
  const histTurnedNegative = hist !== null && histPrev !== null && hist < 0 && histPrev >= 0
  const r2Evidence = { close, mid, upper, lower, hist, histPrev, wasBelowLower, wasAboveUpper }

  if (wasBelowLower && close !== null && mid !== null && close > mid && histTurnedPositive) {
    drafts.push({
      id: 'R2_REVERT_TO_MID',
      direction: 'BUY',
      score: strength(std === null ? null : (close - mid) / std, 1),
      weight: MEAN_REVERSION_WEIGHTS.R2_REVERT_TO_MID,
      evidence: { ...r2Evidence, turn: 'POSITIVE' },
    })
  }
  if (wasAboveUpper && close !== null && mid !== null && close < mid && histTurnedNegative) {
    drafts.push({
      id: 'R2_REVERT_TO_MID',
      direction: 'SELL',
      score: strength(std === null ? null : (mid - close) / std, 1),
      weight: MEAN_REVERSION_WEIGHTS.R2_REVERT_TO_MID,
      evidence: { ...r2Evidence, turn: 'NEGATIVE' },
    })
  }

  // ── R3 极度压缩 + 触轨 ─────────────────────────────────────────────
  // bbwPct 为 null（受限模式）时 R3 不成立 —— 与 T3 同理
  const squeeze = bbwPct !== null && bbwPct < ctx.params.strategy.squeezeBbwPct
  const r3Evidence = { bbwPct, low, high, upper, lower }

  if (squeeze && low !== null && lower !== null && low <= lower) {
    drafts.push({
      id: 'R3_SQUEEZE',
      direction: 'BUY',
      score: strength(
        bbwPct === null ? null : ctx.params.strategy.squeezeBbwPct - bbwPct,
        ctx.params.strategy.squeezeBbwPct
      ),
      weight: MEAN_REVERSION_WEIGHTS.R3_SQUEEZE,
      evidence: { ...r3Evidence, side: 'LOWER' },
    })
  }
  if (squeeze && high !== null && upper !== null && high >= upper) {
    drafts.push({
      id: 'R3_SQUEEZE',
      direction: 'SELL',
      score: strength(
        bbwPct === null ? null : ctx.params.strategy.squeezeBbwPct - bbwPct,
        ctx.params.strategy.squeezeBbwPct
      ),
      weight: MEAN_REVERSION_WEIGHTS.R3_SQUEEZE,
      evidence: { ...r3Evidence, side: 'UPPER' },
    })
  }

  // ── R4 中轨超调（仅震荡市） ─────────────────────────────────────────
  const multiple = ctx.params.strategy.midReversionStd
  const deviation = close !== null && mid !== null && std !== null && std > 0 ? (close - mid) / std : null
  const r4Evidence = { close, mid, std, deviationInStd: deviation, regime: ctx.regime }

  if (ctx.regime === 'RANGE' && deviation !== null && deviation <= -multiple) {
    drafts.push({
      id: 'R4_MID_REVERSION',
      direction: 'BUY',
      score: strength(-deviation - multiple, 1),
      weight: MEAN_REVERSION_WEIGHTS.R4_MID_REVERSION,
      evidence: { ...r4Evidence, side: 'BELOW_MID' },
    })
  }
  if (ctx.regime === 'RANGE' && deviation !== null && deviation >= multiple) {
    drafts.push({
      id: 'R4_MID_REVERSION',
      direction: 'SELL',
      score: strength(deviation - multiple, 1),
      weight: MEAN_REVERSION_WEIGHTS.R4_MID_REVERSION,
      evidence: { ...r4Evidence, side: 'ABOVE_MID' },
    })
  }

  return finalize('MEAN_REVERSION', drafts)
}
