/**
 * 均线（docs/04 §1.2）。EMA 只服务于 MACD 内部，均线判定一律用 SMA。
 *
 * 原文建议用 LLT（二阶 IIR 低延迟趋势线）替代均线，**首版不做** —— 它引入两个未标定参数
 * 且原文未给公式，留作 P2（docs/08）。
 */

import type { Series } from '../types'
import { sma } from './series'

/** period → SMA 序列。periods 去重并升序，保证同一份参数下 key 集合稳定。 */
export function movingAverages(
  closes: readonly number[],
  periods: readonly number[]
): Record<number, Series> {
  const out: Record<number, Series> = {}
  for (const period of [...new Set(periods)].sort((a, b) => a - b)) {
    if (period > 0) out[period] = sma(closes, period)
  }
  return out
}

/**
 * 取某周期的均线；参数里没配这个周期时返回全 null 而不是 undefined。
 *
 * 存在的理由：`ma` 是 `Record<number, Series>`，在 `noUncheckedIndexedAccess` 下每次取用
 * 都要处理 undefined。策略层对「没配 MA60」的正确反应是「该条件不成立」，
 * 与「MA60 还在预热」完全一致 —— 归成同一种表示，策略层就不必分两路处理。
 */
export function maOf(ma: Record<number, Series>, period: number, length: number): Series {
  return ma[period] ?? new Array<number | null>(length).fill(null)
}
