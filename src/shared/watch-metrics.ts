/**
 * 观察点指标的中文标签。**主进程与渲染层共用这一份。**
 *
 * 搬到 shared 是因为它已经有过两份（`main/watch/metrics.ts` 与
 * `renderer/panel/WatchPoints.tsx` 各一张一模一样的表），而第三个用到它的地方
 * 一出现，「两处对不上」就只是时间问题 —— 症状是同一个观察点在提醒文案里叫
 * 「布林中轨」、在列表里叫 `bollMid`，用户会以为那是两个不同的东西。
 *
 * **白名单仍然留在 `main/watch/metrics.ts`**：那是「本地算不算得出来」的判据，
 * 要与 `snapshotOfIndicators()` 的键名成对，渲染层不该有发言权。
 * 这里只管「叫什么名字」。
 */

/** 价格是特例：它不来自指标快照，而是**不复权**现价（见 main/watch/evaluate.ts 的取值口径） */
export const PRICE_METRIC = 'PRICE'

/** 缺省时回落到键名本身 —— 漏一个不该让界面显示空白 */
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
