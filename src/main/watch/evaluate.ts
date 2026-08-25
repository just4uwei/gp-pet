/**
 * 观察点判定（P2 续）。**纯模块**：不读时钟、不碰 IO、不 import Electron。
 *
 * 判定是一次纯比较 —— **触发时刻不涉及模型**。模型只在「建议一个数」那一步出现过，
 * 而那一步后面站着一个人（用户确认）。这是这个功能能与「AI 只读、不回流」共存的原因。
 *
 * ## 两处会静默出错的取值口径
 *
 * 1. **`PRICE` 必须用不复权价。** 指标算在前复权价上，但用户说「跌破 8.20」时说的是
 *    他在券商 App 里看到的那个数。拿前复权价去比，除权那天会凭空命中或凭空不命中，
 *    而症状是「明明没跌到就提醒我了」—— 用户只会认为软件算错了。
 *    与「持仓成本用不复权」（docs/03 §2.3）是同一个坑。
 *
 * 2. **`null` 指标一律跳过，绝不当 0**（约束 4）。未预热的 `rsi` 是 null；
 *    当 0 会让所有 `rsi <= 30` 的观察点在预热期**全部命中**，
 *    而那是一批完全虚假的提醒。
 *
 * ## 组合条件（2026-08-25）
 *
 * 一个观察点可以挂 1–3 个条件，**同一轮全部成立**才算命中 —— 不做「a 先成立
 * 记下来、b 后成立才触发」的闩锁（那是另一个功能，且要引入隐藏状态）。
 * 于是上面第 2 条在 AND 下有个更严的读法：**任何一条取不到值，整点就不命中**。
 * 把「取不到」当成立会让组合条件比单条件更容易误报，方向恰恰是反的。
 */

import type { SecCode } from '@core/types'
import type { WatchCondition } from '@shared/ipc-types'
import type { WatchPointRow } from '../storage/repositories/watch'
import type { SignalOutcome } from '../engine/signals'
import { snapshotOfIndicators } from '../engine/signals'
import { PRICE_METRIC } from './metrics'

/** 报价投影。与 alerts/candidates.ts 的 `QuoteView` 同形（那边也只要这两项） */
export interface WatchQuote {
  last: number
  changePct: number
}

export interface WatchHit {
  point: WatchPointRow
  /**
   * 命中时各条件的实际值 —— 落库并显示，回答「到底到了多少」。
   * **与 `point.conditions` 同序同长**（组合条件下每条都成立才会构造出 WatchHit）
   */
  values: number[]
  /** 命中时的名称与现价，供提醒文案用 */
  name: string
  price: number
  changePct: number
}

export interface EvaluateInput {
  points: readonly WatchPointRow[]
  outcomes: readonly SignalOutcome[]
  quotes?: ReadonlyMap<SecCode, WatchQuote>
  /** 本轮时刻（墙上时间），由调用方传入 */
  at: number
}

export interface EvaluateResult {
  hits: WatchHit[]
  /** 到期未命中 —— 这本身就是「没兑现」这个结论，要落库并显示 */
  expired: WatchPointRow[]
}

/** 取一个观察点要比较的当期值。取不到（无数据 / 指标未预热）返回 null */
export function metricValue(
  metric: string,
  outcome: SignalOutcome,
  quote: WatchQuote | undefined
): number | null {
  if (metric === PRICE_METRIC) {
    // 不复权：quote.last 是实时不复权价；退回 candle.close 也是不复权字段
    const price = quote?.last ?? outcome.evaluation.candle.close
    return Number.isFinite(price) ? price : null
  }
  const snapshot = snapshotOfIndicators(outcome.evaluation.indicators, outcome.evaluation.index)
  const raw = snapshot[metric]
  // null（未预热）与 undefined（不认识的键）都当「取不到」，**不是 0**
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/** 比较。边界取等 —— 用户说「跌破 8.20」，正好 8.20 应当算到了 */
export function matches(op: WatchCondition['op'], value: number, threshold: number): boolean {
  return op === 'LTE' ? value <= threshold : value >= threshold
}

/**
 * 一个观察点这一轮成不成立。**全部条件同时成立**才返回各条件的实际值，
 * 否则返回 null（含「有一条取不到值」——那绝不算成立，见文件头）。
 */
export function conditionValues(
  point: WatchPointRow,
  outcome: SignalOutcome,
  quote: WatchQuote | undefined
): number[] | null {
  const values: number[] = []
  for (const condition of point.conditions) {
    const value = metricValue(condition.metric, outcome, quote)
    if (value === null) return null
    if (!matches(condition.op, value, condition.threshold)) return null
    values.push(value)
  }
  // 条件为空的行（理论上进不来，repo 至少给一条）当作不成立：
  // 一个没有条件的观察点「恒成立」是最糟的失败方向
  return values.length === 0 ? null : values
}

/**
 * 跑一轮。
 *
 * **命中优先于过期**：同一轮里既到期又命中时算命中 —— 那一刻条件确实成立了，
 * 报成「没兑现」是错的。
 *
 * 拿不到该标的本轮评估结果时（不在自选、当轮没跑到）**什么都不做**：
 * 既不命中也不过期。过期判定也要等有数据 —— 否则一只停牌股的观察点会在
 * 到期那天被判「没兑现」，而实际上根本没机会兑现。
 */
export function evaluateWatchPoints(input: EvaluateInput): EvaluateResult {
  const { points, outcomes, quotes, at } = input
  const byCode = new Map<SecCode, SignalOutcome>()
  for (const outcome of outcomes) byCode.set(outcome.evaluation.code, outcome)

  const hits: WatchHit[] = []
  const expired: WatchPointRow[] = []

  for (const point of points) {
    if (point.status !== 'ACTIVE') continue
    const outcome = byCode.get(point.code)
    if (outcome === undefined) continue

    const quote = quotes?.get(point.code)
    const values = conditionValues(point, outcome, quote)

    if (values !== null) {
      hits.push({
        point,
        values,
        name: outcome.name,
        price: quote?.last ?? outcome.evaluation.candle.close,
        changePct: quote?.changePct ?? 0,
      })
      continue
    }

    // 没命中才谈过期
    if (at >= point.expiresAt) expired.push(point)
  }

  return { hits, expired }
}
