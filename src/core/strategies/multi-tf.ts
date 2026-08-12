/**
 * 多周期共振 M1–M3（docs/04 §3.3）。
 *
 * | ID | 条件 | 作用 |
 * |---|---|---|
 * | `M1_WEEK_MACD_DAY_RSI` | 周线近 3 周内金叉 且 日线 RSI < 45 | BUY +0.10 |
 * |                        | 周线近 3 周内死叉 且 日线 RSI > 55 | SELL +0.10 |
 * | `M2_WEEK_ADX_CONFIRM`  | 日线突破轨道 且 周线 ADX > 25 | 该方向 +0.10 |
 * | `M3_FALSE_BREAKOUT`    | 日线突破上轨 且 周线 ADX < 20 | BUY **−0.15** |
 *
 * 多周期**不单独产出信号**，只作为组合得分的调整项（可为负）。
 *
 * 「近 3 周内金叉」是文档明确要求的回溯窗口，与 §1.9 禁止的「N 日内曾金叉」不矛盾：
 * 后者禁的是把日线穿越模糊化导致同一次交叉反复触发；这里周线一周才动一格，
 * 3 周窗口是为了让「周线刚拐头」在日线上有几天的有效期 —— 去重仍由提醒层负责。
 */

import { crossDown, crossUp, existsWithin, at } from '../indicators/series'
import type { WeeklyIndicators } from '../indicators'
import type { MultiTfAdjustment } from '../types'
import { trackBreakout, value, type StrategyContext } from './context'

export function multiTfAdjustments(
  ctx: StrategyContext,
  weekly: WeeklyIndicators
): MultiTfAdjustment[] {
  const out: MultiTfAdjustment[] = []
  const params = ctx.params.multiTf
  const lastWeek = weekly.length - 1
  if (lastWeek < 0) return out

  const rsi = value(ctx.ind.rsi, ctx)
  const weekAdx = at(weekly.adx, lastWeek)
  const breakout = trackBreakout(ctx)

  const weekGolden = existsWithin(lastWeek, params.weekCrossLookback, (j) =>
    crossUp(weekly.dif, weekly.dea, j)
  )
  const weekDead = existsWithin(lastWeek, params.weekCrossLookback, (j) =>
    crossDown(weekly.dif, weekly.dea, j)
  )

  const base = {
    weekAdx,
    weekDif: at(weekly.dif, lastWeek),
    weekDea: at(weekly.dea, lastWeek),
    weekBars: weekly.length,
    dayRsi: rsi,
  }

  // ── M1 周线拐头 + 日线未过热 ────────────────────────────────────────
  if (weekGolden && rsi !== null && rsi < params.dayRsiBuyMax) {
    out.push({
      id: 'M1_WEEK_MACD_DAY_RSI',
      direction: 'BUY',
      delta: params.resonanceDelta,
      evidence: { ...base, weekCross: 'GOLDEN' },
    })
  }
  if (weekDead && rsi !== null && rsi > params.dayRsiSellMin) {
    out.push({
      id: 'M1_WEEK_MACD_DAY_RSI',
      direction: 'SELL',
      delta: params.resonanceDelta,
      evidence: { ...base, weekCross: 'DEAD' },
    })
  }

  // ── M2 周线趋势确认日线突破 ─────────────────────────────────────────
  if (breakout !== null && weekAdx !== null && weekAdx > params.weekAdxConfirm) {
    out.push({
      id: 'M2_WEEK_ADX_CONFIRM',
      direction: breakout,
      delta: params.resonanceDelta,
      evidence: { ...base, breakout },
    })
  }

  // ── M3 假突破惩罚 ──────────────────────────────────────────────────
  // 只惩罚向上突破：周线毫无趋势时的上轨突破多半是一日游。
  // 向下突破不给对称惩罚 —— 文档如此，且「跌破下轨但周线没趋势」照样可能是下跌起点
  if (breakout === 'BUY' && weekAdx !== null && weekAdx < params.weekAdxWeak) {
    out.push({
      id: 'M3_FALSE_BREAKOUT',
      direction: 'BUY',
      delta: params.falseBreakoutDelta,
      evidence: { ...base, breakout },
    })
  }

  return out
}
