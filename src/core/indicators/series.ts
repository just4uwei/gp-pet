/**
 * 序列原语（docs/04 §1.1、§1.9）。
 *
 * 全部函数遵守同一套约定，指标层的其余文件不再重复说明：
 *   - 返回与输入**等长**的序列，预热期不足处为 `null`，绝不用 0 冒充（CLAUDE.md 第 4 条）
 *   - 输入序列中途出现 `null`（数据缺失）时**重新预热**，而不是跳过它继续递推
 *     —— EMA/Wilder 是有状态的，跨过一个空洞继续递推等于悄悄用错了历史
 *   - 越界索引与 `null` 一律等价，由 `at()` 统一收口
 */

import type { Series } from '../types'

/** 浮点比较容差（docs/04 §1.1） */
export const EPS = 1e-9

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return value < min ? min : value > max ? max : value
}

export function approxEqual(a: number, b: number, eps = EPS): boolean {
  return Math.abs(a - b) <= eps
}

/**
 * 取序列元素。越界、`undefined`、非有限值一律归为 `null`。
 *
 * 存在的理由：`noUncheckedIndexedAccess` 下每处下标访问都得处理 `undefined`，
 * 而指标代码里下标访问极多。收口到一个函数比散落 200 个 `?? null` 更不容易漏。
 */
export function at(series: Series | readonly number[], i: number): number | null {
  if (i < 0 || i >= series.length) return null
  const value = series[i]
  return value === null || value === undefined || !Number.isFinite(value) ? null : value
}

/** 长度为 n 的全 null 序列。所有指标的出发点。 */
export function nulls(n: number): Series {
  return new Array<number | null>(Math.max(0, n)).fill(null)
}

/** SMA(n)：窗口内出现任一 null 即为 null（docs/04 §1.2） */
export function sma(values: Series | readonly number[], period: number): Series {
  const out = nulls(values.length)
  if (period <= 0) return out
  let sum = 0
  let missing = 0
  for (let i = 0; i < values.length; i++) {
    const value = at(values, i)
    if (value === null) missing++
    else sum += value
    if (i >= period) {
      const dropped = at(values, i - period)
      if (dropped === null) missing--
      else sum -= dropped
    }
    if (i >= period - 1 && missing === 0) out[i] = sum / period
  }
  return out
}

/**
 * EMA(n)，种子为首个 n 个有效值的 SMA（docs/04 §1.2）。
 * MACD 的 DEA 是「EMA 套在 DIF 上」，而 DIF 前段是 null —— 所以种子必须按**有效值**计数，
 * 不能按下标计数。
 */
export function ema(values: Series | readonly number[], period: number): Series {
  const out = nulls(values.length)
  if (period <= 0) return out
  const alpha = 2 / (period + 1)
  let prev: number | null = null
  let seedSum = 0
  let seedCount = 0

  for (let i = 0; i < values.length; i++) {
    const value = at(values, i)
    if (value === null) {
      prev = null
      seedSum = 0
      seedCount = 0
      continue
    }
    if (prev === null) {
      seedSum += value
      seedCount++
      if (seedCount === period) {
        prev = seedSum / period
        out[i] = prev
      }
      continue
    }
    prev = alpha * value + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

/**
 * Wilder 平滑的**和式**：`W[i] = W[i-1] - W[i-1]/n + x[i]`，种子 = 首个 n 个有效值之和（docs/04 §1.5）。
 *
 * 不在这里除 n：ADX 的 `+DI = 100 × W(+DM)/W(TR)` 是两个和式相除，n 会自己约掉；
 * RSI 需要均值，由调用方除。提前除会引入一次多余的浮点误差。
 */
export function wilderSum(values: Series | readonly number[], period: number): Series {
  const out = nulls(values.length)
  if (period <= 0) return out
  let prev: number | null = null
  let seedSum = 0
  let seedCount = 0

  for (let i = 0; i < values.length; i++) {
    const value = at(values, i)
    if (value === null) {
      prev = null
      seedSum = 0
      seedCount = 0
      continue
    }
    if (prev === null) {
      seedSum += value
      seedCount++
      if (seedCount === period) {
        prev = seedSum
        out[i] = prev
      }
      continue
    }
    prev = prev - prev / period + value
    out[i] = prev
  }
  return out
}

/** 总体标准差（除 n，与国内平台一致 —— docs/04 §1.4） */
export function populationStdev(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  const mean = sum / values.length
  let variance = 0
  for (const v of values) variance += (v - mean) ** 2
  return Math.sqrt(variance / values.length)
}

/**
 * 金叉：`a[i-1] <= b[i-1] && a[i] > b[i]`，任一侧为 null 则 false（docs/04 §1.9）。
 * 相等侧带 EPS 容差，「今日刚好相等、明日再上穿」不会被浮点噪音吃掉。
 */
export function crossUp(a: Series, b: Series, i: number): boolean {
  const a0 = at(a, i - 1)
  const b0 = at(b, i - 1)
  const a1 = at(a, i)
  const b1 = at(b, i)
  if (a0 === null || b0 === null || a1 === null || b1 === null) return false
  return a0 - b0 <= EPS && a1 - b1 > EPS
}

export function crossDown(a: Series, b: Series, i: number): boolean {
  const a0 = at(a, i - 1)
  const b0 = at(b, i - 1)
  const a1 = at(a, i)
  const b1 = at(b, i)
  if (a0 === null || b0 === null || a1 === null || b1 === null) return false
  return b0 - a0 <= EPS && b1 - a1 > EPS
}

/** 百分位排名：小于等于 value 的样本占比 × 100（docs/04 §1.4） */
export function percentileRank(samples: readonly number[], value: number): number {
  if (samples.length === 0) return 0
  let leq = 0
  for (const sample of samples) {
    if (sample <= value + EPS) leq++
  }
  return (leq / samples.length) * 100
}

/**
 * 滚动百分位：`out[i]` = `series[i]` 在 `series[i-lookback+1..i]` 中的排名 0..100。
 * 窗口内**任一** null 即为 null —— 拿残缺窗口算分位会让「历史极值」凭空缩小。
 */
export function rollingPercentile(series: Series, lookback: number): Series {
  const out = nulls(series.length)
  if (lookback <= 0) return out
  for (let i = lookback - 1; i < series.length; i++) {
    const current = at(series, i)
    if (current === null) continue
    const window: number[] = []
    let complete = true
    for (let j = i - lookback + 1; j <= i; j++) {
      const value = at(series, j)
      if (value === null) {
        complete = false
        break
      }
      window.push(value)
    }
    if (complete) out[i] = percentileRank(window, current)
  }
  return out
}

/** 连续 days 步严格上升（`series[i] > series[i-1] > …`）。任一处为 null 则 false。 */
export function risingFor(series: Series, i: number, days: number): boolean {
  if (days <= 0) return false
  for (let k = 0; k < days; k++) {
    const now = at(series, i - k)
    const prev = at(series, i - k - 1)
    if (now === null || prev === null || now - prev <= EPS) return false
  }
  return true
}

/** 与 risingFor 对称的下降版本。 */
export function fallingFor(series: Series, i: number, days: number): boolean {
  if (days <= 0) return false
  for (let k = 0; k < days; k++) {
    const now = at(series, i - k)
    const prev = at(series, i - k - 1)
    if (now === null || prev === null || prev - now <= EPS) return false
  }
  return true
}

/**
 * 最近 window 根内（含当根）是否存在满足 predicate 的位置。
 * 「近 5 日曾触上轨」这类条件用它 —— 注意这与 §1.9 禁止的「N 日内曾金叉」不同：
 * 那条禁的是把**穿越**模糊化，这里是策略明确要求的回溯窗口（T5 / R2）。
 */
export function existsWithin(
  i: number,
  window: number,
  predicate: (index: number) => boolean
): boolean {
  for (let j = i; j > i - window && j >= 0; j--) {
    if (predicate(j)) return true
  }
  return false
}

/** 变化量 `series[i] - series[i-span]`；任一侧 null 则 null。 */
export function changeOver(series: Series, i: number, span: number): number | null {
  const now = at(series, i)
  const before = at(series, i - span)
  if (now === null || before === null) return null
  return now - before
}
