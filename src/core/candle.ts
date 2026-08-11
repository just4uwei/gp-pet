/**
 * 由实时快照拼「临时当日 K 线」（docs/02 §4 ②、docs/04 §6）。
 *
 * 放在 core 而不是 main：盘中预警与收盘确认必须用同一套「指标输入构造」逻辑，
 * 否则「盘中成立、收盘作废」时分不清是行情真变了、还是两条路径拼 K 线的方式不同。
 * 这里只做拼接，不判断信号；provisional 标记由调用方一路带到提醒层（最高 L2）。
 */

import type { Candle, Snapshot, TradeDate } from './types'

function positive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 前复权系数，由已入库的上一根反算（`closeAdj / close`）。
 *
 * 当日这根的复权系数无法从快照得知，只能沿用上一根的 —— 除权当日会有偏差，
 * 但那一天的历史序列本来就要整体重算（见 quality.ts 的 detectAdjustmentDrift），
 * 增量回补那一轮会把它纠正过来。
 *
 * 注意：这里按**乘法**外推。腾讯的前复权是减价差（加法），对它来说这个外推有微小误差，
 * 但让当日这根与已入库序列保持连续比精确复原更重要 —— 指标看的是相邻两根的关系。
 */
export function adjustmentFactor(prev?: Pick<Candle, 'close' | 'closeAdj'> | null): number {
  if (!prev) return 1
  if (prev.close <= 0 || prev.closeAdj <= 0) return 1
  return prev.closeAdj / prev.close
}

/**
 * 拼出当日临时 K 线。返回 null 表示「今天没有可用的当日线」，此时不要往序列尾部塞东西：
 *   - 停牌：交易所当天也不会有这根，补一根零成交的假线会污染量比与 ATR
 *   - 最新价非正：集合竞价开始前部分源给 0，用它当收盘会伪造出暴跌
 *   - 上一根就是当日（收盘线已入库）：真实收盘线不该被临时线覆盖
 */
export function provisionalCandle(
  snapshot: Snapshot,
  date: TradeDate,
  prev?: Candle | null
): Candle | null {
  if (snapshot.suspended) return null
  const last = positive(snapshot.last)
  if (last === null) return null
  if (prev && prev.date >= date) return null

  const open = positive(snapshot.open) ?? last
  // 高低价用「已知极值 ∪ 开盘 ∪ 最新」取包络：部分源盘中的 high/low 更新有延迟，
  // 若最新价已经越出它们，直接照抄会得到 close 越界的非法 K 线（quality.ts 会丢弃它）
  const high = Math.max(positive(snapshot.high) ?? last, open, last)
  const low = Math.min(positive(snapshot.low) ?? last, open, last)
  const factor = adjustmentFactor(prev)

  return {
    date,
    open,
    high,
    low,
    close: last,
    openAdj: open * factor,
    highAdj: high * factor,
    lowAdj: low * factor,
    closeAdj: last * factor,
    volume: Number.isFinite(snapshot.volume) && snapshot.volume > 0 ? snapshot.volume : 0,
    amount: Number.isFinite(snapshot.amount) ? snapshot.amount : null,
    provisional: true,
  }
}

/**
 * 把临时当日线接到历史序列尾部。历史序列必须已按日期升序。
 * 拼不出来（见 provisionalCandle）时原样返回历史序列 —— 少一根真实数据，
 * 比多一根编出来的数据安全。
 */
export function withProvisional(
  history: readonly Candle[],
  snapshot: Snapshot | null | undefined,
  date: TradeDate
): { candles: Candle[]; provisional: boolean } {
  const candles = [...history]
  if (!snapshot) return { candles, provisional: false }
  const bar = provisionalCandle(snapshot, date, candles[candles.length - 1])
  if (!bar) return { candles, provisional: false }
  candles.push(bar)
  return { candles, provisional: true }
}
