/**
 * 成交量与量比（docs/04 §1.7）。
 *
 * ```
 * VOL_MA20 = SMA(volume, 20)
 * 量比 ratio = volume[i] / VOL_MA20[i]
 * 盘中 ratio = 当日累计成交量 / (VOL_MA20 × 已完成交易时间占比)
 * ```
 *
 * **盘中必须做时间归一化**，否则 10:00 的半日成交量去比 20 日全天均量，结论永远是「缩量」，
 * 放量突破类信号（T3 / R1 的确认项）在整个上午都不可能触发 —— 这是最容易漏、
 * 又最难从结果反推出来的一个错。
 */

import type { Series } from '../types'
import { at, nulls, sma } from './series'

export interface VolumeParams {
  maPeriod: number
}

export interface VolumeOptions {
  /**
   * 已完成的连续竞价时间占比 0..1（`session.ts` 的 `tradingProgress`）。
   * 只作用于**最后一根且为临时线**的那根 —— 历史收盘线不需要归一化。
   * 未提供或最后一根不是临时线时，最后一根按整日处理。
   */
  intradayProgress?: number
  /** 最后一根是不是临时线（`Candle.provisional`） */
  lastIsProvisional?: boolean
}

export interface VolumeResult {
  volMa: Series
  volRatio: Series
}

export function volumeMetrics(
  volumes: readonly number[],
  params: VolumeParams,
  options: VolumeOptions = {}
): VolumeResult {
  const n = volumes.length
  if (params.maPeriod <= 0) return { volMa: nulls(n), volRatio: nulls(n) }

  const volMa = sma(volumes, params.maPeriod)
  const volRatio = nulls(n)
  const lastIndex = n - 1

  for (let i = 0; i < n; i++) {
    const average = at(volMa, i)
    const volume = at(volumes, i)
    if (average === null || volume === null || average <= 0) continue

    const intraday = i === lastIndex && options.lastIsProvisional === true
    if (!intraday) {
      volRatio[i] = volume / average
      continue
    }

    const progress = options.intradayProgress ?? 1
    // 开盘前（progress = 0）除下去是 Infinity。此时「今天量大不大」根本无从判断，
    // 给 null 让依赖它的条件不成立，比给一个巨大的假量比安全
    if (progress <= 0) continue
    volRatio[i] = volume / (average * Math.min(1, progress))
  }

  return { volMa, volRatio }
}
