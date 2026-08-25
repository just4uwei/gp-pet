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

/**
 * 一个观察点最多挂几个条件（2026-08-25，组合条件）。
 *
 * 3 够表达「价格 + 指标 + 量能」，而且模型那边也需要一个上限 —— 不设上限它会灌出
 * 一串永远不会同时成立的条件，而那样的观察点看起来完全正常，用户会一直等它。
 */
export const MAX_WATCH_CONDITIONS = 3

/**
 * 条件的最小形状。**刻意不 import `@shared/ipc-types` 的 `WatchCondition`**，
 * 而是结构化取值（与 `watch-mark.ts` 的 `MarkableHit` 同一手法）：
 * 这一份被主进程、渲染层、纯函数判定三处共用，少一条 import 就少一条循环依赖的可能。
 */
export interface ConditionLike {
  metric: string
  op: 'LTE' | 'GTE'
  threshold: number
}

/** 组合条件之间的连接词。**只有「且」** —— 「或」写成两个各自命中的观察点 */
export const CONDITION_JOINER = ' 且 '

/** 单条：`价格 跌破 8.20` */
export function conditionText(condition: ConditionLike): string {
  return `${metricLabel(condition.metric)} ${condition.op === 'LTE' ? '跌破' : '升破'} ${condition.threshold}`
}

/**
 * 整组：`价格 跌破 8.20 且 RSI 跌破 30`。
 *
 * 提醒文案 / 观察点列表 / 日报「仍在盯」/ 移除确认框**四处共用这一个函数** ——
 * 各写一份的症状是同一个观察点在四个地方读起来像四件事（`METRIC_LABELS` 搬来 shared
 * 就是因为这个，日报那处此前甚至直接打印裸键名 `bollMid`）。
 */
export function conditionsText(conditions: readonly ConditionLike[]): string {
  return conditions.map(conditionText).join(CONDITION_JOINER)
}

/**
 * 命中时各条件的实际值：`价格 8.50 · RSI 28.5`。
 *
 * 值缺失时那一项整个略过，**不写 0 也不写「-」** —— 组合条件下每条都必须成立才命中，
 * 所以正常路径上每条都有值；缺了说明是旧行或坏数据，含糊地少说一项好过编一个数。
 */
export function hitValuesText(
  conditions: readonly ConditionLike[],
  values: readonly number[] | undefined
): string {
  if (values === undefined) return ''
  const parts: string[] = []
  conditions.forEach((condition, i) => {
    const value = values[i]
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    parts.push(`${metricLabel(condition.metric)} ${value}`)
  })
  return parts.join(' · ')
}

/**
 * 找出**可证明永不同时成立**的条件对（同一 metric 上 `≤ a` 与 `≥ b` 且 `b > a`）。
 *
 * 判据与 metric 白名单同源：一个永远不会命中的观察点**看起来完全正常**，
 * 用户会一直等它，而到期那天它还会留下一条「没兑现」——那是个假结论。
 *
 * 只认这一种。取等（`≤ 9 且 ≥ 9`）是可满足的（恰好等于 9），不算矛盾；
 * 跨 metric 的矛盾（`价格 ≥ 10 且 MA20 ≤ 1`）判不了，也不该在这里猜。
 * 返回的是有问题的那些条件下标，供界面点名。
 */
export function impossibleConditions(conditions: readonly ConditionLike[]): number[] {
  const bad = new Set<number>()
  for (let i = 0; i < conditions.length; i += 1) {
    for (let j = i + 1; j < conditions.length; j += 1) {
      const a = conditions[i]
      const b = conditions[j]
      if (a === undefined || b === undefined) continue
      if (a.metric !== b.metric || a.op === b.op) continue
      const upper = a.op === 'LTE' ? a : b // 上限：value ≤ threshold
      const lower = a.op === 'LTE' ? b : a // 下限：value ≥ threshold
      if (lower.threshold > upper.threshold) {
        bad.add(i)
        bad.add(j)
      }
    }
  }
  return [...bad].sort((x, y) => x - y)
}
