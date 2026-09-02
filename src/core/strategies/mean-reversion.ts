/**
 * 均值回归策略 R1–R4（docs/04 §3.2）。
 *
 * | ID | BUY 条件 | SELL 条件 | 权重 |
 * |---|---|---|---|
 * | `R1_RSI_BAND`       | RSI < rsiOversold 且 low ≤ LOWER | RSI > rsiOverbought 且 high ≥ UPPER | 0.30 |
 * | `R2_REVERT_TO_MID`  | 近 N 日曾 close<LOWER，今日**上穿** MID 且 HIST 在改善 | 近 N 日曾 close>UPPER，今日**下穿** MID 且 HIST 在走弱 | 0.30 |
 * | `R3_SQUEEZE`        | BBW_PCT < squeezeBbwPct 且 low ≤ LOWER | BBW_PCT < squeezeBbwPct 且 high ≥ UPPER | 0.20 |
 * | `R4_MID_REVERSION`  | RANGE 状态下 close 低于 MID 超过 midReversionStd×STD | RANGE 状态下 close 高于 MID 超过 midReversionStd×STD | 0.20 |
 *
 * ⚠ R2 的写法在 2026-08-12 改过一次（docs/04 §3.2）。旧写法是「已在中轨另一侧 **且** HIST 过零翻转」，
 * 实测在 39 只 × 61534 根上只触发 90 次（0.15%），且对它唯一的参数 `revertLookback`
 * 取 2/3/5 逐位惰性。根因不是阈值而是**时间常数不匹配**：HIST 过零 = DIF 上穿 DEA，
 * 在一次轨道外之后中位数要等 35 根以上，而 `revertLookback` 只有 2–5 根，两者凑不到一起。
 * 改法见 `pnpm audit:subsignals` 的输出与 M2 §5.11。改后触发 213 次（0.35%），
 * `revertLookback` 变成活参数（3 → 213、5 → 592、11 → 1807）。
 *
 * ⚠ **R2 靠自己凑不够票，这不是它没用。** 同一轮共现测量：213 次触发里 185 次（87%）
 * 是孤立的 —— R2 要求价格回到 MID 附近，而 R1/R3 要求当根触外轨、R4 要求偏离 MID
 * ≥ `midReversionStd × STD`，**几何上互斥**（那 13% 的例外全是 R3，因为 R3 用最高/最低价
 * 而非收盘价，长影线可以两头都占）。而 `combine.voteThreshold.meanReversion = 2` 要两票。
 * 所以 R2 目前只能给得分一点微调。**要动的是票数线（`combine` 块，待标定），不是再改 R2 的条件，
 * 更不是删掉它** —— 均值回归已经被误判过两次死刑（M2 §5.9/§5.10）。
 *
 * ⚠ 均值回归在下跌趋势里是**接飞刀**。这一层不做方向过滤（子信号只描述「条件成立了」），
 * 抑制发生在组合层：`TREND_DOWN` 下均值回归的 BUY 得分再乘 0.5（docs/04 §4.1）。
 * 把它放在组合层而不是这里，是为了让「信号成立但被降权」在 evidence 里看得见。
 */

import { at, crossDown, crossUp, existsWithin } from '../indicators/series'
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

/**
 * ⚠ **设计常量，不是待标定参数** —— 与 `TREND_WEIGHTS` 同一条（2026-09-02 拍板，计划 §4.5b 选 B）。
 * 空洞的唯一出处是 `main/settings/params-view.ts` 的 `PARAM_GAPS`。
 */
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
  // 「回归中轨」是**上穿/下穿中轨那一刻**，不是「已经在中轨另一侧」这个状态 ——
  // 后者约一半的交易日都成立，当触发条件用等于没有条件（docs/04 §3.2 的改写说明）。
  const closes = ctx.candles.map((candle) => candle.closeAdj)
  const crossedMidUp = crossUp(closes, ind.boll.mid, ctx.index)
  const crossedMidDown = crossDown(closes, ind.boll.mid, ctx.index)

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
  // 动量确认：柱体朝有利方向走。这里**不要求柱体翻转过零**——
  // 过零是 DIF 上穿 DEA，那是慢事件（实测中位数在轨道外之后 35 根以上），
  // 与「近几根内曾在轨道外」的时间常数差一个量级，两者永远凑不到一起（docs/04 §3.2）。
  const histImproving = hist !== null && histPrev !== null && hist > histPrev
  const histWeakening = hist !== null && histPrev !== null && hist < histPrev
  const r2Evidence = {
    close,
    mid,
    upper,
    lower,
    hist,
    histPrev,
    wasBelowLower,
    wasAboveUpper,
    crossedMidUp,
    crossedMidDown,
  }

  if (wasBelowLower && crossedMidUp && histImproving) {
    drafts.push({
      id: 'R2_REVERT_TO_MID',
      direction: 'BUY',
      score: strength(std === null || close === null || mid === null ? null : (close - mid) / std, 1),
      weight: MEAN_REVERSION_WEIGHTS.R2_REVERT_TO_MID,
      evidence: { ...r2Evidence, turn: 'POSITIVE' },
    })
  }
  if (wasAboveUpper && crossedMidDown && histWeakening) {
    drafts.push({
      id: 'R2_REVERT_TO_MID',
      direction: 'SELL',
      score: strength(std === null || close === null || mid === null ? null : (mid - close) / std, 1),
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
