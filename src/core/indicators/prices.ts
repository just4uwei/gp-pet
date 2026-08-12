/**
 * 从 K 线里抽出指标要用的价格序列。
 *
 * 只此一处决定「指标读哪套价格」：一律**前复权**（`*Adj`）。
 * 除权日的价格跳空会伪造出金叉死叉（CLAUDE.md「容易踩的坑」第一条），
 * 而这类错误在指标输出里看不出来 —— 所以取价必须收口，不允许各指标自己 `c.close`。
 */

import type { Candle } from '../types'

export interface PriceSeries {
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  /** 股。成交量不复权（复权只作用于价格） */
  volume: number[]
}

/** 前复权序列 —— 指标的唯一输入 */
export function adjustedPrices(candles: readonly Candle[]): PriceSeries {
  const n = candles.length
  const series: PriceSeries = {
    open: new Array<number>(n).fill(0),
    high: new Array<number>(n).fill(0),
    low: new Array<number>(n).fill(0),
    close: new Array<number>(n).fill(0),
    volume: new Array<number>(n).fill(0),
  }
  for (let i = 0; i < n; i++) {
    const candle = candles[i]
    if (!candle) continue
    series.open[i] = candle.openAdj
    series.high[i] = candle.highAdj
    series.low[i] = candle.lowAdj
    series.close[i] = candle.closeAdj
    series.volume[i] = candle.volume
  }
  return series
}

/** 不复权收盘序列 —— 展示、成本与止损用（docs/03 §2.3），不给指标用 */
export function rawCloses(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.close)
}
