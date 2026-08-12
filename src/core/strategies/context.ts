/**
 * 策略层的共同上下文与取值助手（docs/04 §3）。
 *
 * 每个策略函数都要反复问同样的几个问题（今天的收盘、MA20、上下轨、量比…），
 * 而在 `noUncheckedIndexedAccess` 下每次取用都得处理 null。收口到这里的目的：
 *   - 策略代码读起来接近文档里的条件表
 *   - 「指标还没预热出来」与「条件不成立」在策略层是同一件事，只处理一次
 */

import { maOf } from '../indicators/ma'
import { at } from '../indicators/series'
import type { DataSufficiency } from '../indicators/sufficiency'
import type { EngineParams } from '../params'
import type { Candle, Direction, Evidence, IndicatorSet, Regime, SubSignal } from '../types'

export interface StrategyContext {
  candles: readonly Candle[]
  ind: IndicatorSet
  /** 被判定的那根（一般是最后一根） */
  index: number
  regime: Regime
  params: EngineParams
  sufficiency: DataSufficiency
}

/** 被判定那根的前复权收盘 */
export function closeAt(ctx: StrategyContext, offset = 0): number | null {
  const candle = ctx.candles[ctx.index - offset]
  return candle ? candle.closeAdj : null
}

export function highAt(ctx: StrategyContext, index: number): number | null {
  return ctx.candles[index]?.highAdj ?? null
}

export function lowAt(ctx: StrategyContext, index: number): number | null {
  return ctx.candles[index]?.lowAdj ?? null
}

export function ma(ctx: StrategyContext, period: number): number | null {
  return at(maOf(ctx.ind.ma, period, ctx.candles.length), ctx.index)
}

export function value(series: (number | null)[], ctx: StrategyContext, offset = 0): number | null {
  return at(series, ctx.index - offset)
}

/** 布林带标准差：由上轨与中轨反算，避免再算一遍窗口标准差 */
export function bandStdev(ctx: StrategyContext): number | null {
  const upper = value(ctx.ind.boll.upper, ctx)
  const mid = value(ctx.ind.boll.mid, ctx)
  if (upper === null || mid === null || ctx.params.boll.k <= 0) return null
  return (upper - mid) / ctx.params.boll.k
}

/**
 * 「日线突破轨道」—— T3 与多周期共振（M2/M3）共用的判据。
 * 只看收盘越轨，不含量能与带宽条件（那些是 T3 自己的确认项）。
 */
export function trackBreakout(ctx: StrategyContext): Direction | null {
  const close = closeAt(ctx)
  const upper = value(ctx.ind.boll.upper, ctx)
  const lower = value(ctx.ind.boll.lower, ctx)
  if (close === null) return null
  if (upper !== null && close > upper) return 'BUY'
  if (lower !== null && close < lower) return 'SELL'
  return null
}

export interface SubSignalDraft {
  id: string
  direction: Direction
  score: number
  weight: number
  evidence: Evidence
}

/** 把草稿补上 strategy 字段。分数一律夹到 0..1 —— 打分函数写错不该让组合层拿到 1.4 分 */
export function finalize(
  strategy: SubSignal['strategy'],
  drafts: readonly SubSignalDraft[]
): SubSignal[] {
  return drafts.map((draft) => ({
    id: draft.id,
    strategy,
    direction: draft.direction,
    score: Math.min(1, Math.max(0, draft.score)),
    weight: draft.weight,
    evidence: draft.evidence,
  }))
}

/**
 * 打分的通用形状：基准 0.5 + 超出部分线性递增到 1。
 *
 * 为什么统一成一个函数：docs/04 §3.1 只给了 T2 一个打分示例，其余留给实现。
 * 若每个子信号各写一套曲线，标定时没人说得清「T3 的 0.8 分和 T1 的 0.8 分是不是一回事」。
 * 统一成「0.5 = 刚好满足条件，1.0 = 满足到 `span` 倍」后，跨子信号的分数至少是同一把尺子。
 */
export function strength(excess: number | null, span: number): number {
  if (excess === null || !Number.isFinite(excess) || span <= 0) return 0.5
  const ratio = Math.max(0, excess) / span
  return 0.5 + 0.5 * Math.min(1, ratio)
}
