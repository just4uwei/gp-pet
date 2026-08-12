/**
 * 周线聚合（docs/04 §1.8）。
 *
 * 周线由日线**本地聚合**，不单独取数 —— 多一路取数就多一份口径不一致的风险，
 * 而且免费源的周线复权口径与日线未必相同。
 *
 * 按自然周（ISO 周一起）分组：`open` 取周首、`close` 取周末、`high/low` 取极值、
 * `volume` 求和。周线 K 的日期取该周**最后一个交易日**，与行情软件一致。
 */

import { weekStart, weekdayOf } from '../date'
import type { Candle } from '../types'

/**
 * 最后一根周线的 provisional 判定：
 *   - 日线最后一根是临时线 → 本周显然没走完
 *   - 日线最后一根不是周五 → 本周还没走完
 *
 * 后者在「周五休市（节假日调休）」时会把一根已完成的周线误判为临时。
 * 这是刻意的保守：误判为临时只会让周线信号最高降到 L2，
 * 反过来（把没走完的周线当定稿）会产出一个第二天就消失的「周线金叉」。
 */
function lastWeekIsProvisional(candles: readonly Candle[]): boolean {
  const last = candles[candles.length - 1]
  if (!last) return false
  if (last.provisional === true) return true
  return (weekdayOf(last.date) ?? 5) < 5
}

export function aggregateWeekly(candles: readonly Candle[]): Candle[] {
  const out: Candle[] = []
  let currentKey: string | null = null

  for (const candle of candles) {
    const key = weekStart(candle.date)
    const bar = out[out.length - 1]

    if (key !== currentKey || !bar) {
      currentKey = key
      out.push({
        date: candle.date,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        openAdj: candle.openAdj,
        highAdj: candle.highAdj,
        lowAdj: candle.lowAdj,
        closeAdj: candle.closeAdj,
        volume: candle.volume,
        amount: candle.amount,
        ...(candle.hasGap === true ? { hasGap: true } : {}),
      })
      continue
    }

    bar.date = candle.date
    bar.high = Math.max(bar.high, candle.high)
    bar.low = Math.min(bar.low, candle.low)
    bar.close = candle.close
    bar.highAdj = Math.max(bar.highAdj, candle.highAdj)
    bar.lowAdj = Math.min(bar.lowAdj, candle.lowAdj)
    bar.closeAdj = candle.closeAdj
    bar.volume += candle.volume
    // 任一日缺成交额 → 整周为 null。补 0 会让周成交额小于实际值，而那看起来完全正常
    bar.amount = bar.amount === null || candle.amount === null ? null : bar.amount + candle.amount
    if (candle.hasGap === true) bar.hasGap = true
  }

  const last = out[out.length - 1]
  if (last && lastWeekIsProvisional(candles)) last.provisional = true
  return out
}
