/**
 * 绩效指标（docs/07 §2.2 的「输出指标」清单）。
 *
 * 相对 src/core 的克制在这里同样适用：**不算无从验证的东西**。
 * 无风险利率没有可靠的本地来源，所以夏普按 rf = 0 计算并在报告里注明；
 * 基准缺失时超额收益与信息比率一律给 null，不用 0 冒充。
 */

import type { TradeDate } from '../core/types'

/** A 股一年约 243 个交易日 */
export const BARS_PER_YEAR = 243

export interface EquityPoint {
  date: TradeDate
  equity: number
  /** 基准指数归一化到同一起点的净值；缺基准时为 null */
  benchmark: number | null
}

export interface DrawdownResult {
  /** 0..1 的正数 */
  maxDrawdown: number
  peakDate: TradeDate | null
  troughDate: TradeDate | null
  /** 从峰值到谷底的交易日数 */
  durationBars: number
  /** 谷底到重回峰值的交易日数；截至回测结束仍未收复时为 null */
  recoveryBars: number | null
}

export function maxDrawdown(points: readonly EquityPoint[]): DrawdownResult {
  let peak = -Infinity
  let peakDate: TradeDate | null = null
  let peakIndex = -1
  let worst = 0
  let troughDate: TradeDate | null = null
  let troughIndex = -1
  let bestPeakDate: TradeDate | null = null
  let bestPeakIndex = -1

  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    if (!point) continue
    if (point.equity > peak) {
      peak = point.equity
      peakDate = point.date
      peakIndex = i
    }
    if (peak > 0) {
      const drawdown = (peak - point.equity) / peak
      if (drawdown > worst) {
        worst = drawdown
        troughDate = point.date
        troughIndex = i
        bestPeakDate = peakDate
        bestPeakIndex = peakIndex
      }
    }
  }

  let recoveryBars: number | null = null
  if (troughIndex >= 0 && bestPeakIndex >= 0) {
    const target = points[bestPeakIndex]?.equity ?? 0
    for (let i = troughIndex + 1; i < points.length; i++) {
      if ((points[i]?.equity ?? 0) >= target) {
        recoveryBars = i - troughIndex
        break
      }
    }
  }

  return {
    maxDrawdown: worst,
    peakDate: bestPeakDate,
    troughDate,
    durationBars: troughIndex >= 0 && bestPeakIndex >= 0 ? troughIndex - bestPeakIndex : 0,
    recoveryBars,
  }
}

/** 逐期简单收益率 */
export function returnsOf(points: readonly EquityPoint[], key: 'equity' | 'benchmark' = 'equity'): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]?.[key]
    const now = points[i]?.[key]
    if (prev === null || prev === undefined || now === null || now === undefined || prev <= 0) continue
    out.push(now / prev - 1)
  }
  return out
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** 样本标准差（除 n-1）—— 这里是统计推断而非「与行情软件对齐」，用无偏估计 */
export function sampleStdev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function annualizedReturn(totalReturn: number, bars: number): number | null {
  if (bars <= 0) return null
  const years = bars / BARS_PER_YEAR
  if (years <= 0) return null
  const growth = 1 + totalReturn
  // 亏到本金归零后无法按几何方式年化，直接给 -1（全损），不产出 NaN
  if (growth <= 0) return -1
  return growth ** (1 / years) - 1
}

/** 夏普比率，rf = 0。样本少于 2 期时给 null 而不是 0 —— 0 会被读成「无风险调整收益」 */
export function sharpeRatio(returns: readonly number[]): number | null {
  const sd = sampleStdev(returns)
  if (returns.length < 2 || sd === 0) return null
  return (mean(returns) / sd) * Math.sqrt(BARS_PER_YEAR)
}

/** 信息比率：超额收益的年化均值 / 年化跟踪误差 */
export function informationRatio(
  strategy: readonly number[],
  benchmark: readonly number[]
): number | null {
  const n = Math.min(strategy.length, benchmark.length)
  if (n < 2) return null
  const excess: number[] = []
  for (let i = 0; i < n; i++) {
    excess.push((strategy[i] ?? 0) - (benchmark[i] ?? 0))
  }
  const sd = sampleStdev(excess)
  if (sd === 0) return null
  return (mean(excess) / sd) * Math.sqrt(BARS_PER_YEAR)
}

export interface TradeStats {
  count: number
  wins: number
  losses: number
  /** 0..1 —— 报告里称「胜率」是可以的（那是回测事实），但 UI 上的置信度**不得**这么叫 */
  winRate: number | null
  /** 平均盈利 / 平均亏损，均为绝对值；无亏损交易时为 null（不是 Infinity） */
  profitFactor: number | null
  avgPnlPct: number | null
  avgHoldingBars: number | null
  totalPnl: number
  totalCosts: number
}

export interface TradeLike {
  pnl: number
  pnlPct: number
  holdingBars: number
  costs: number
}

export function summarizeTrades(trades: readonly TradeLike[]): TradeStats {
  if (trades.length === 0) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      profitFactor: null,
      avgPnlPct: null,
      avgHoldingBars: null,
      totalPnl: 0,
      totalCosts: 0,
    }
  }

  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl < 0)
  const avgWin = wins.length > 0 ? mean(wins.map((t) => t.pnl)) : 0
  const avgLoss = losses.length > 0 ? Math.abs(mean(losses.map((t) => t.pnl))) : 0

  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / trades.length,
    profitFactor: avgLoss > 0 ? avgWin / avgLoss : null,
    avgPnlPct: mean(trades.map((t) => t.pnlPct)),
    avgHoldingBars: mean(trades.map((t) => t.holdingBars)),
    totalPnl: trades.reduce((sum, t) => sum + t.pnl, 0),
    totalCosts: trades.reduce((sum, t) => sum + t.costs, 0),
  }
}
