/**
 * RSI，Wilder 平滑（docs/04 §1.6）。
 *
 * ```
 * gain[i] = max(close[i]-close[i-1], 0) ;  loss[i] = max(close[i-1]-close[i], 0)
 * avgGain = Wilder(gain,14)/14 ;           avgLoss = Wilder(loss,14)/14
 * RSI     = 100 - 100/(1 + avgGain/avgLoss)     avgLoss = 0 → RSI = 100
 * ```
 *
 * 单调上涨段 `avgLoss = 0` 是必然会遇到的边界（连板股），必须给出 100 而不是 NaN；
 * 对称地 `avgGain = 0` 给 0。两者同时为 0（完全横盘）给 50 —— 「不偏多也不偏空」。
 */

import type { Series } from '../types'
import { at, nulls, wilderSum } from './series'

export function rsi(closes: readonly number[], period: number): Series {
  const n = closes.length
  if (period <= 0) return nulls(n)

  const gains: Series = nulls(n)
  const losses: Series = nulls(n)
  for (let i = 1; i < n; i++) {
    const now = at(closes, i)
    const prev = at(closes, i - 1)
    if (now === null || prev === null) continue
    const change = now - prev
    gains[i] = change > 0 ? change : 0
    losses[i] = change < 0 ? -change : 0
  }

  const gainSum = wilderSum(gains, period)
  const lossSum = wilderSum(losses, period)
  const out = nulls(n)

  for (let i = 0; i < n; i++) {
    const g = at(gainSum, i)
    const l = at(lossSum, i)
    if (g === null || l === null) continue
    if (l === 0 && g === 0) {
      out[i] = 50
      continue
    }
    if (l === 0) {
      out[i] = 100
      continue
    }
    out[i] = 100 - 100 / (1 + g / l)
  }

  return out
}
