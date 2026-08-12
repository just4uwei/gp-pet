/**
 * 布林带与带宽分位（docs/04 §1.4）。
 *
 * ```
 * MID   = SMA(20)
 * STD   = 总体标准差(close[i-19..i])      ← 除以 n，非 n-1，与国内平台一致
 * UPPER = MID + k·STD ;  LOWER = MID - k·STD
 * BBW   = (UPPER - LOWER) / MID × 100
 * BBW_PCT[i] = BBW[i] 在 BBW[i-249..i] 中的百分位排名 (0..100)
 * ```
 *
 * 带宽分位是「变盘前夜」判据的全部依据，也是本项目对日线根数要求最高的指标：
 * 20 根算首个 BBW，再要 250 个 BBW 样本才有首个分位值 → 第 269 根才有第一个有效值。
 * （docs/04 §1.4 写作「20 + 250 = 270 根」，那是把当根重复计了一次；本实现按窗口严格取
 *  bbwLookback 个样本，差 1 根，不影响任何判定。见 docs/notes/M2-偏差报告.md）
 */

import type { BollResult, Series } from '../types'
import { at, nulls, populationStdev, rollingPercentile, sma } from './series'

export interface BollParams {
  period: number
  k: number
  bbwLookback: number
}

export function boll(closes: readonly number[], params: BollParams): BollResult {
  const { period, k, bbwLookback } = params
  const n = closes.length
  if (period <= 0) {
    return { mid: nulls(n), upper: nulls(n), lower: nulls(n), bbw: nulls(n), bbwPct: nulls(n) }
  }

  const mid = sma(closes, period)
  const upper: Series = nulls(n)
  const lower: Series = nulls(n)
  const bbw: Series = nulls(n)

  for (let i = period - 1; i < n; i++) {
    const middle = at(mid, i)
    if (middle === null) continue
    const window = closes.slice(i - period + 1, i + 1)
    const std = populationStdev(window)
    const up = middle + k * std
    const low = middle - k * std
    upper[i] = up
    lower[i] = low
    // MID > 0 才有带宽可言。价格序列恒为正，但 0 除法的后果（Infinity 一路传到得分）
    // 太难排查，这里显式拦一次
    if (middle > 0) bbw[i] = ((up - low) / middle) * 100
  }

  return { mid, upper, lower, bbw, bbwPct: rollingPercentile(bbw, bbwLookback) }
}
