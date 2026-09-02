/**
 * 趋势跟踪策略 T1–T5（docs/04 §3.1）。
 *
 * | ID | BUY 条件 | SELL 条件 | 权重 |
 * |---|---|---|---|
 * | `T1_MA_CROSS`        | crossUp(MA5,MA20) 且 ADX > adxRange | crossDown(MA5,MA20) | 0.20 |
 * | `T2_MACD_ZERO_CROSS` | crossUp(DIF,DEA) 且 DIF>0 且 HIST 连续 2 日放大 | crossDown(DIF,DEA) 且 DIF<0 | 0.25 |
 * | `T3_BREAKOUT`        | close>UPPER 且 BBW_PCT 上升 且 量比≥1.2 | close<LOWER 且 同上 | 0.25 |
 * | `T4_ALIGNMENT`       | MA5>MA20>MA60 且 close>MA20 且 ADX>adxTrend | 反向排列且 close<MA20 | 0.15 |
 * | `T5_PULLBACK_HOLD`   | 近 5 日曾触 UPPER，今日回踩 MID 未跌破，DIF>0 | 近 5 日曾触 LOWER，今日反弹至 MID 未站上，DIF<0 | 0.15 |
 *
 * 权重和为 1（组合层按「策略权重 × Σ(子分×子权重)」聚合，见 docs/04 §4.2），
 * 由 tests/unit/strategies 断言 —— 改权重时忘了配平会让整个策略的得分上限漂移。
 *
 * 注意 SELL 侧普遍比 BUY 侧宽松（T1/T4 不要求 ADX 确认）：这是文档的原意，
 * 也符合「离场宁可早」的常识，不是漏抄。
 */

import { at, crossDown, crossUp, existsWithin, risingFor } from '../indicators/series'
import type { SubSignal } from '../types'
import {
  bandStdev,
  closeAt,
  finalize,
  highAt,
  lowAt,
  strength,
  value,
  ma,
  type StrategyContext,
  type SubSignalDraft,
} from './context'

/**
 * ⚠ **这五个数是设计常量，不是待标定参数** —— 2026-09-02 用户拍板（计划 §4.5b 选 B）。
 *
 * 它们不在 `EngineParams` 里 ⇒ 不在那 62 个叶子参数里 ⇒ **标定网格在结构上扫不到**
 * （八张网格 82 组候选一次都没动过它们）。依据是 M2 §5.35：「排序方向没有可测的增量」。
 * **空洞写在 `main/settings/params-view.ts` 的 `PARAM_GAPS` 里（唯一出处），
 * 设置页那张表下面会显示它** —— 别在这里再写一份解释，两处会漂移。
 */
export const TREND_WEIGHTS = {
  T1_MA_CROSS: 0.2,
  T2_MACD_ZERO_CROSS: 0.25,
  T3_BREAKOUT: 0.25,
  T4_ALIGNMENT: 0.15,
  T5_PULLBACK_HOLD: 0.15,
} as const

export function trendSignals(ctx: StrategyContext): SubSignal[] {
  const drafts: SubSignalDraft[] = []
  const { ind } = ctx
  const length = ctx.candles.length
  const maSeries = (period: number): (number | null)[] =>
    ind.ma[period] ?? new Array<number | null>(length).fill(null)

  const close = closeAt(ctx)
  const ma5 = ma(ctx, 5)
  const ma20 = ma(ctx, 20)
  const ma60 = ma(ctx, 60)
  const adx = value(ind.dmi.adx, ctx)
  const adxTrend = value(ind.thresholds.adxTrend, ctx)
  const adxRange = value(ind.thresholds.adxRange, ctx)
  const dif = value(ind.macd.dif, ctx)
  const hist = value(ind.macd.hist, ctx)
  const histPrev = value(ind.macd.hist, ctx, 1)
  const upper = value(ind.boll.upper, ctx)
  const lower = value(ind.boll.lower, ctx)
  const mid = value(ind.boll.mid, ctx)
  const bbwPct = value(ind.boll.bbwPct, ctx)
  const volRatio = value(ind.volRatio, ctx)

  // ── T1 均线交叉 ────────────────────────────────────────────────────
  const ma5Series = maSeries(5)
  const ma20Series = maSeries(20)
  const goldenCross = crossUp(ma5Series, ma20Series, ctx.index)
  const deadCross = crossDown(ma5Series, ma20Series, ctx.index)
  // 交叉当日两线几乎重合，用「交叉幅度」打分毫无分辨力 —— 改用 ADX 超出震荡线的幅度：
  // 同样的金叉，趋势越明确越值钱
  const t1Evidence = { ma5, ma20, adx, adxTrend, adxRange }

  if (goldenCross && adx !== null && adxRange !== null && adx > adxRange) {
    drafts.push({
      id: 'T1_MA_CROSS',
      direction: 'BUY',
      score: strength(adx - adxRange, adxTrend === null ? 8 : Math.max(1, adxTrend - adxRange)),
      weight: TREND_WEIGHTS.T1_MA_CROSS,
      evidence: { ...t1Evidence, cross: 'GOLDEN' },
    })
  }
  if (deadCross) {
    drafts.push({
      id: 'T1_MA_CROSS',
      direction: 'SELL',
      score:
        adx === null || adxRange === null
          ? 0.5
          : strength(adx - adxRange, adxTrend === null ? 8 : Math.max(1, adxTrend - adxRange)),
      weight: TREND_WEIGHTS.T1_MA_CROSS,
      evidence: { ...t1Evidence, cross: 'DEAD' },
    })
  }

  // ── T2 MACD 零轴上/下金叉死叉 ───────────────────────────────────────
  const difCrossUp = crossUp(ind.macd.dif, ind.macd.dea, ctx.index)
  const difCrossDown = crossDown(ind.macd.dif, ind.macd.dea, ctx.index)
  const histExpanding = risingFor(ind.macd.hist, ctx.index, 2)
  const t2Evidence = { dif, dea: value(ind.macd.dea, ctx), hist, histPrev }

  if (difCrossUp && dif !== null && dif > 0 && histExpanding) {
    drafts.push({
      id: 'T2_MACD_ZERO_CROSS',
      direction: 'BUY',
      score: histGrowthScore(hist, histPrev),
      weight: TREND_WEIGHTS.T2_MACD_ZERO_CROSS,
      evidence: { ...t2Evidence, cross: 'GOLDEN', histExpanding },
    })
  }
  if (difCrossDown && dif !== null && dif < 0) {
    drafts.push({
      id: 'T2_MACD_ZERO_CROSS',
      direction: 'SELL',
      score: histGrowthScore(hist === null ? null : -hist, histPrev === null ? null : -histPrev),
      weight: TREND_WEIGHTS.T2_MACD_ZERO_CROSS,
      evidence: { ...t2Evidence, cross: 'DEAD' },
    })
  }

  // ── T3 轨道突破 ────────────────────────────────────────────────────
  // BBW_PCT 上升是必需项 → 受限模式（不足 270 根）下 T3 自然不成立，
  // 这正是 docs/04 §1.10 要求的「跳过依赖 BBW 分位的规则」，不需要额外开关
  const bbwRising = risingFor(ind.boll.bbwPct, ctx.index, 1)
  const volumeConfirmed = volRatio !== null && volRatio >= ctx.params.volume.breakoutRatio
  const t3Evidence = { close, upper, lower, bbwPct, bbwRising, volRatio }

  // **`TREND_UP` 里不给 BUY 票**（2026-08-15，docs/04 §3.1a 有完整论证）。
  //
  // 一句话理由：在已经被判定为上升趋势的状态里，「又创了新高 + 带宽扩张」不提供新信息 ——
  // 「在涨」是判定前提，`T4_ALIGNMENT` 几乎必然同时成立（实测 396/396 = 100%，
  // 在这个状态下已退化成常量），而带宽扩张在趋势中段是延续、在末端是加速赶顶，
  // 日线上分不开。于是 T3 这一票投给的恰恰是最危险的时刻。
  //
  // 实测：TREND_UP 的 396 次建仓里 **365 次（92.2%）恰好 3 票**，正好卡在票数线上，
  // 所以这一票是不是有信息，直接决定那批信号存不存在。
  //
  // 三条边界，改之前想清楚：
  //   ① 只动 BUY —— 跌破下轨 + 带宽扩张在任何状态下都是风险扩大，上面的推理对 SELL 不成立；
  //   ② 只动 TREND_UP —— RANGE/TRANSITION 里突破是**状态转换**信号，那是它本来的用途；
  //   ③ **不引入任何数值** —— 这是结构条件不是阈值，所以不产生新的 GUESS 参数。
  //      （被否掉的另一个方案「趋势持续 N 根后不买」的 N 只能从绩效数据里读，是循环论证。）
  const breakoutInformative = ctx.regime !== 'TREND_UP'
  if (close !== null && upper !== null && close > upper && bbwRising && volumeConfirmed && breakoutInformative) {
    drafts.push({
      id: 'T3_BREAKOUT',
      direction: 'BUY',
      score: breakoutScore(ctx, close - upper, mid === null ? null : Math.abs(upper - mid), volRatio),
      weight: TREND_WEIGHTS.T3_BREAKOUT,
      evidence: { ...t3Evidence, side: 'UPPER' },
    })
  }
  if (close !== null && lower !== null && close < lower && bbwRising && volumeConfirmed) {
    drafts.push({
      id: 'T3_BREAKOUT',
      direction: 'SELL',
      score: breakoutScore(ctx, lower - close, mid === null ? null : Math.abs(lower - mid), volRatio),
      weight: TREND_WEIGHTS.T3_BREAKOUT,
      evidence: { ...t3Evidence, side: 'LOWER' },
    })
  }

  // ── T4 多头/空头排列 ────────────────────────────────────────────────
  const bullAligned = ma5 !== null && ma20 !== null && ma60 !== null && ma5 > ma20 && ma20 > ma60
  const bearAligned = ma5 !== null && ma20 !== null && ma60 !== null && ma5 < ma20 && ma20 < ma60
  const t4Evidence = { ma5, ma20, ma60, close, adx, adxTrend }

  if (bullAligned && close !== null && ma20 !== null && close > ma20 && adx !== null && adxTrend !== null && adx > adxTrend) {
    drafts.push({
      id: 'T4_ALIGNMENT',
      direction: 'BUY',
      score: strength(adx - adxTrend, Math.max(1, adxTrend * 0.5)),
      weight: TREND_WEIGHTS.T4_ALIGNMENT,
      evidence: { ...t4Evidence, alignment: 'BULL' },
    })
  }
  if (bearAligned && close !== null && ma20 !== null && close < ma20) {
    drafts.push({
      id: 'T4_ALIGNMENT',
      direction: 'SELL',
      score:
        adx === null || adxTrend === null ? 0.5 : strength(adx - adxTrend, Math.max(1, adxTrend * 0.5)),
      weight: TREND_WEIGHTS.T4_ALIGNMENT,
      evidence: { ...t4Evidence, alignment: 'BEAR' },
    })
  }

  // ── T5 回踩不破 ────────────────────────────────────────────────────
  const window = ctx.params.strategy.pullbackLookback
  const touchedUpper = existsWithin(ctx.index, window, (j) => {
    const high = highAt(ctx, j)
    const up = at(ind.boll.upper, j)
    return high !== null && up !== null && high >= up
  })
  const touchedLower = existsWithin(ctx.index, window, (j) => {
    const low = lowAt(ctx, j)
    const down = at(ind.boll.lower, j)
    return low !== null && down !== null && low <= down
  })
  const low = lowAt(ctx, ctx.index)
  const high = highAt(ctx, ctx.index)
  const std = bandStdev(ctx)
  const t5Evidence = { close, mid, upper, lower, dif, touchedUpper, touchedLower, low, high }

  // 「回踩 MID 未跌破」= 最低价触到中轨，收盘仍在中轨之上
  if (touchedUpper && close !== null && mid !== null && low !== null && low <= mid && close > mid && dif !== null && dif > 0) {
    drafts.push({
      id: 'T5_PULLBACK_HOLD',
      direction: 'BUY',
      score: strength(std === null ? null : (close - mid) / std, 1),
      weight: TREND_WEIGHTS.T5_PULLBACK_HOLD,
      evidence: { ...t5Evidence, hold: 'ABOVE_MID' },
    })
  }
  if (touchedLower && close !== null && mid !== null && high !== null && high >= mid && close < mid && dif !== null && dif < 0) {
    drafts.push({
      id: 'T5_PULLBACK_HOLD',
      direction: 'SELL',
      score: strength(std === null ? null : (mid - close) / std, 1),
      weight: TREND_WEIGHTS.T5_PULLBACK_HOLD,
      evidence: { ...t5Evidence, hold: 'BELOW_MID' },
    })
  }

  return finalize('TREND', drafts)
}

/**
 * docs/04 §3.1 的 T2 打分式：`clamp(0.5 + 0.5 × min(HIST[i]/HIST[i-1] - 1, 1), 0.5, 1)`。
 *
 * 文档没说 `HIST[i-1] ≤ 0` 怎么办，而金叉当日这**几乎必然**成立（柱子刚由负转正），
 * 直接套公式会得到负比值甚至除零。此时改用固定的 0.6：
 * 「确实放大了，但放大幅度无法用比值度量」—— 比 0.5（勉强成立）高一点，
 * 又不至于凭一个无意义的比值给出满分。
 */
function histGrowthScore(hist: number | null, histPrev: number | null): number {
  if (hist === null || histPrev === null) return 0.5
  if (histPrev <= 0) return hist > 0 ? 0.6 : 0.5
  return strength(hist / histPrev - 1, 1)
}

/**
 * 突破打分：一半看越轨幅度（以带宽半宽为尺，从而与标的自身波动率无关），
 * 一半看放量倍数超出确认线多少。
 *
 * `distance` = 收盘越出轨道的绝对值；`halfWidth` = 轨道到中轨的距离。
 * 越出半个半宽 + 放量到确认线的 1.5 倍 → 满分。
 */
function breakoutScore(
  ctx: StrategyContext,
  distance: number,
  halfWidth: number | null,
  volRatio: number | null
): number {
  const extent = halfWidth === null || halfWidth <= 0 ? 0 : distance / halfWidth
  const breakoutRatio = ctx.params.volume.breakoutRatio
  const volExcess = volRatio === null ? 0 : (volRatio - breakoutRatio) / Math.max(0.1, breakoutRatio)
  const extentPart = Math.min(1, Math.max(0, extent) / 0.5)
  const volPart = Math.min(1, Math.max(0, volExcess) / 0.5)
  return 0.5 + 0.25 * extentPart + 0.25 * volPart
}
