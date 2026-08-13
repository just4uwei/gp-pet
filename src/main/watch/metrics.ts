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

/** 价格是特例：它不来自指标快照，而是**不复权**现价（见 evaluate.ts 的取值口径） */
export const PRICE_METRIC = 'PRICE'

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

/** 给界面用的中文标签。缺省时回落到键名本身 —— 漏一个不该让界面显示空白 */
export const METRIC_LABELS: Record<string, string> = {
  PRICE: '价格',
  ma5: 'MA5',
  ma10: 'MA10',
  ma20: 'MA20',
  ma60: 'MA60',
  ma120: 'MA120',
  dif: 'MACD DIF',
  dea: 'MACD DEA',
  hist: 'MACD 柱',
  bollUpper: '布林上轨',
  bollMid: '布林中轨',
  bollLower: '布林下轨',
  bbwPct: '带宽分位',
  adx: 'ADX',
  plusDI: '+DI',
  minusDI: '−DI',
  atr: 'ATR',
  rsi: 'RSI',
  volRatio: '量比',
}

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric
}
