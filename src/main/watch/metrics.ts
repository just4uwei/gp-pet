/**
 * 观察点能盯的指标白名单（纯模块，零依赖）。
 *
 * ## 为什么要白名单
 *
 * 阈值最终来自模型的一段文本。不限定 metric，模型可以写出
 * `metric=资金流入强度` 这种本地根本算不出来的东西 —— 而它看起来完全合理，
 * 用户会确认下去，然后那个观察点**永远不会命中**，且没人知道为什么。
 * 白名单让「本地算不出来」在确认之前就被挡掉。
 *
 * 键名与 `snapshotOfIndicators()`（src/main/engine/signals.ts）**必须一致** ——
 * 判定时直接按键取值。改那边的键名要同步改这里，`watch-metrics.test.ts` 钉着这一条。
 */

// 中文标签住在 `@shared/watch-metrics`（渲染层也要用同一份，别在这里再抄一张表）。
// 白名单留在本文件：它是「本地算不算得出来」的判据，要与 snapshotOfIndicators() 的键名成对。
export { METRIC_LABELS, PRICE_METRIC, metricLabel } from '../../shared/watch-metrics'
import { PRICE_METRIC } from '../../shared/watch-metrics'

/**
 * 可盯的指标。刻意**不是**全部 25 个快照字段 ——
 * `adxTrend` / `rsiOverbought` 这些是「当期算出来的阈值」而不是观测量，
 * 盯它们没有意义（用户要盯的是 RSI 到没到线，不是线本身在哪）。
 */
export const WATCHABLE_INDICATORS = [
  'ma5',
  'ma10',
  'ma20',
  'ma60',
  'ma120',
  'dif',
  'dea',
  'hist',
  'bollUpper',
  'bollMid',
  'bollLower',
  'bbwPct',
  'adx',
  'plusDI',
  'minusDI',
  'atr',
  'rsi',
  'volRatio',
] as const

export type WatchMetric = typeof PRICE_METRIC | (typeof WATCHABLE_INDICATORS)[number]

const ALLOWED = new Set<string>([PRICE_METRIC, ...WATCHABLE_INDICATORS])

export function isWatchMetric(value: unknown): value is WatchMetric {
  return typeof value === 'string' && ALLOWED.has(value)
}

