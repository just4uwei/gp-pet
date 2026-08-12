/**
 * 引擎门面：`EngineContext` → 五层贯通的一次评估（docs/04 §0 的分层图）。
 *
 * ```
 * Candle[] ──▶ ① 指标层 ──▶ ② 市场状态 ──▶ ③ 策略层 ──▶ ④ 组合层 ──▶ ⑤ 风控层
 * ```
 *
 * 这是 `src/main` 与 `src/backtest` **唯一**的入口 —— 两条路径共用它，
 * 是「回测与实盘同源」这条架构保证的落点（ADR-0004）。任何一方绕过它自己拼指标，
 * 「盘中提醒」与「回测结论」就会悄悄分叉，而这种分叉极难在结果里看出来。
 *
 * 纯函数：不读时钟、不做 IO。「现在几点」「今天是不是交易日」「大盘情绪多少」
 * 全部由调用方作为 `EngineContext` 传入。回测只需传 `candles[0..i]` 的切片，
 * 未来函数由架构消除，而不是靠实现者自觉。
 */

import { computeIndicators, computeWeeklyIndicators, type WeeklyIndicators } from './indicators'
import { aggregateWeekly } from './indicators/weekly'
import { assessSufficiency, type DataSufficiency } from './indicators/sufficiency'
import { classifyRegimes, currentRegime } from './regime'
import { combineSignals, type CombineResult } from './combine'
import { gateSignal } from './risk'
import { runStrategies } from './strategies'
import { CONTINUOUS_MINUTES } from './session'
import { DEFAULT_PARAMS, engineVersionOf, type EngineParams } from './params'
import type {
  Candle,
  CombinedSignal,
  EngineContext,
  GatedSignal,
  IndicatorSet,
  RegimeState,
  SecCode,
  SignalStage,
  TradeDate,
} from './types'

export interface Evaluation {
  code: SecCode
  /** 被判定那根 K 线的日期。盘中即今日（临时线），收盘后即当日收盘线 */
  date: TradeDate
  /** 被判定那根的下标，一般是最后一根 */
  index: number
  /**
   * 被判定的那根 K 线本身（引用，不是拷贝）。
   * 上层要用它的**不复权**价做展示、持仓成本与峰值更新 —— 指标用前复权，展示用原价，
   * 两套价格不能混（docs/03 §2.3）。
   */
  candle: Candle
  indicators: IndicatorSet
  weekly: WeeklyIndicators
  regime: RegimeState
  sufficiency: DataSufficiency
  combine: CombineResult
  signal: CombinedSignal
  gated: GatedSignal
  /** 算法版本 + 参数指纹。落库时一并写入，参数一变缓存即失效（docs/03 §4.2） */
  engineVersion: string
}

/**
 * 跑一次完整评估。
 *
 * 返回 null 只有一种情况：**一根 K 线都没有**。数据不足（< 40 根）不返回 null ——
 * 那时仍要产出一条带 `INSUFFICIENT_DATA` 抑制原因的记录，
 * 否则面板上「这只股票为什么从来不出信号」无从回答。
 */
export function evaluate(ctx: EngineContext, params: EngineParams = DEFAULT_PARAMS): Evaluation | null {
  const candles = ctx.candles
  const index = candles.length - 1
  const last = candles[index]
  if (!last) return null

  const stage: SignalStage = last.provisional === true ? 'PROVISIONAL' : 'CONFIRMED'
  const indicators = computeIndicators(candles, params, {
    sentiment: ctx.marketSentiment,
    intradayProgress: ctx.now.minutesSinceOpen / CONTINUOUS_MINUTES,
  })

  // 周线优先用调用方给的（主进程已聚合并缓存）；没给就地聚合 ——
  // 契约上它是必填，但「忘了传」的后果是多周期共振静默失效，那种缺陷不该靠自觉避免
  const weeklyCandles = ctx.weekly.length > 0 ? ctx.weekly : aggregateWeekly(candles)
  const weekly = computeWeeklyIndicators(weeklyCandles, params)

  const sufficiency = assessSufficiency(candles.length, indicators.boll.bbwPct, index, params.data)
  const regime = currentRegime(classifyRegimes(candles, indicators, params))

  const strategyCtx = {
    candles,
    ind: indicators,
    index,
    regime: regime.regime,
    params,
    sufficiency,
  }

  // 数据不足以产出任何信号时不跑策略：40 根以下的 ADX / BOLL 是噪音，
  // 让它们产出子信号再由风控抑制，会在提醒日志里留下一堆「差点就提醒了」的假象
  const strategies = sufficiency.usable
    ? runStrategies(strategyCtx, weekly)
    : { subSignals: [], adjustments: [] }

  const combine = combineSignals({
    code: ctx.profile.code,
    date: last.date,
    regime: regime.regime,
    subSignals: strategies.subSignals,
    adjustments: strategies.adjustments,
    stage,
    sufficiencyPenalty: sufficiency.penalty,
    params,
  })

  const gated = gateSignal({
    signal: combine.signal,
    profile: ctx.profile,
    candles,
    ind: indicators,
    index,
    sufficiency,
    snapshot: ctx.snapshot,
    position: ctx.position,
    industryShare: ctx.industryShare,
    now: {
      minuteOfDay: minuteOfDayFrom(ctx),
      session: ctx.now.session,
      atMs: ctx.now.atMs,
    },
    params,
  })

  return {
    code: ctx.profile.code,
    date: last.date,
    index,
    candle: last,
    indicators,
    weekly,
    regime,
    sufficiency,
    combine,
    signal: combine.signal,
    gated,
    engineVersion: engineVersionOf(params),
  }
}

/**
 * `minutesSinceOpen`（已完成的连续竞价分钟数）换算回「当天第几分钟」。
 *
 * 风控的 T+1 尾盘判定用的是**含午休的自然时钟**（09:30 起算 320 分钟 = 14:50），
 * 与量比归一化的口径不同（session.ts 已就此写了一段说明）。这里做一次显式换算，
 * 而不是让调用方多传一个字段 —— 多一个字段就多一处可以传错的地方。
 */
function minuteOfDayFrom(ctx: EngineContext): number {
  const elapsed = Math.max(0, Math.min(CONTINUOUS_MINUTES, ctx.now.minutesSinceOpen))
  const morning = 120
  // 上午 120 分钟走完之后，自然时钟要补上 90 分钟午休（11:30 → 13:00）
  const wallClock = elapsed <= morning ? elapsed : elapsed + 90
  return 9 * 60 + 30 + wallClock
}

export { engineVersionOf, paramsFingerprint } from './params'
export type { EngineParams } from './params'
