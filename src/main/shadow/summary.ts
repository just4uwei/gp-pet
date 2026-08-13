/**
 * 影子运行的绩效汇总（docs/07 §2.3）—— 纯函数，输入是账本，不碰数据库。
 *
 * ## 三条克制，都是刻意的
 *
 * 1. **满 3 个月前不做任何正面宣称。** `seasoned` 为 false 时 UI 只能并列数字，
 *    不许出现「跑赢」「有效」「胜率不错」。docs/07 §2.3 与 ADR-0003 都写了这条：
 *    一条两周的净值曲线什么都不能证明，但它长得很像证据。
 * 2. **胜率给两个口径，都标明。** 一行 `trade` 是**一次卖出**，回撤减仓会把一次建仓
 *    拆成两三行 —— 实测逐笔与建仓级能差 16 个百分点（M2 §5.18）。用户体验到的是
 *    建仓级（「我按提醒买了一次，最后赚没赚」），所以那一档是主口径，但两个都摆出来。
 * 3. **超额收益必须和资金占用率一起给。** 基准是满仓的，信号策略绝大多数时间空仓；
 *    回测里实测平均占用只有 4.15%，只看超额会把方向读反（M2 §5.13）。
 *    这里的 `exposure` 是从**逐日**净值曲线上直接算的，比回测那个按建仓价的近似更准。
 *
 * 缺数据一律给 null，不用 0 顶替 —— `sharpe: 0` 会被读成「风险调整后不赚不亏」，
 * 而真相是「样本还不够算这个数」（约束 4 的同一条纪律）。
 */

import {
  BARS_PER_YEAR,
  annualizedReturn,
  groupPositions,
  maxDrawdown,
  mean,
  returnsOf,
  sharpeRatio,
  summarizeTrades,
  type EquityPoint,
} from '../../backtest/metrics'
import type { ShadowTradeView, ShadowSummary } from '@shared/ipc-types'
import type { ShadowEquityPoint } from '../storage/repositories/shadow'
import type { ShadowOrder, ShadowPosition, ShadowTrade } from './portfolio'

/** 影子运行「成熟」所需的自然日数。docs/07 §2.3：满 3 个月前不对绩效做正面宣称 */
export const SEASONING_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

export interface SummaryInput {
  startedAt: number | null
  startedDate: string | null
  startCapital: number
  equity: readonly ShadowEquityPoint[]
  trades: readonly ShadowTrade[]
  positions: readonly ShadowPosition[]
  orders: readonly ShadowOrder[]
  skippedNoCash: number
  limitBlocked: number
  engineVersion: string
  /** 账本里记的引擎版本与当前不一致时传它 —— 推进已暂停 */
  stalledEngineVersion: string | null
  /** 墙上时间，由调用方传入（不读时钟） */
  now: number
}

/**
 * 把账本折成面板要的那一屏。
 *
 * `equity` 为空（还没有任何交易日）时返回 `startedAt: null` 的空壳，
 * **不返回 `totalReturn: 0`** —— 「还没开始」和「持平」是两件事。
 */
export function summarize(input: SummaryInput): ShadowSummary {
  const points: EquityPoint[] = input.equity.map((row) => ({
    date: row.date,
    equity: row.equity,
    benchmark: row.benchmark,
  }))

  const bars = points.length
  const last = input.equity[input.equity.length - 1]
  const positionValue = input.positions.reduce((sum, p) => sum + p.shares * p.lastCloseAdj, 0)
  const cash = last?.cash ?? input.startCapital
  const equity = bars > 0 ? cash + positionValue : input.startCapital

  const totalReturn = input.startCapital > 0 ? equity / input.startCapital - 1 : 0
  const drawdown = maxDrawdown(points)
  const strategyReturns = returnsOf(points, 'equity')

  // 基准归一化到影子运行起点。中途缺值的行会被 returnsOf 跳过（它跳 null），
  // 但首尾比值要求两端都有 —— 缺就给 null，别拿最近一个有值的日子冒充「同期」
  const firstBenchmark = input.equity.find((row) => row.benchmark !== null)?.benchmark ?? null
  const lastBenchmark = last?.benchmark ?? null
  const benchmarkReturn =
    firstBenchmark !== null && lastBenchmark !== null && firstBenchmark > 0
      ? lastBenchmark / firstBenchmark - 1
      : null

  // 逐日资金占用率：持仓市值 ÷ 当日净值的均值。这是精确值而不是回测里那个按建仓价的近似
  const exposure =
    bars > 0
      ? mean(input.equity.filter((row) => row.equity > 0).map((row) => row.positionValue / row.equity))
      : null

  const tradeStats = summarizeTrades(
    input.trades.map((t) => ({
      pnl: t.pnl,
      pnlPct: t.pnlPct,
      holdingBars: t.holdingBars,
      costs: t.costs,
      entryPrice: t.entryPrice,
      shares: t.shares,
    }))
  )
  const positionStats = groupPositions(
    input.trades.map((t) => ({
      code: t.code,
      entryDate: t.entryDate,
      entryPrice: t.entryPrice,
      shares: t.shares,
      pnl: t.pnl,
      partial: t.partial,
    }))
  )

  const calendarDays =
    input.startedAt === null ? 0 : Math.max(0, Math.floor((input.now - input.startedAt) / DAY_MS))

  return {
    startedAt: input.startedAt,
    startedDate: input.startedDate,
    bars,
    calendarDays,
    seasoned: calendarDays >= SEASONING_DAYS,
    seasoningDays: SEASONING_DAYS,
    startCapital: input.startCapital,
    cash,
    positionValue,
    equity,
    totalReturn,
    annualized: annualizedReturn(totalReturn, bars),
    maxDrawdown: drawdown.maxDrawdown,
    sharpe: sharpeRatio(strategyReturns),
    benchmarkReturn,
    exposure,
    barsPerYear: BARS_PER_YEAR,
    trades: {
      count: tradeStats.count,
      winRate: tradeStats.winRate,
      profitFactor: tradeStats.profitFactor,
      weightedPnlPct: tradeStats.weightedPnlPct,
      avgHoldingBars: tradeStats.avgHoldingBars,
      totalPnl: tradeStats.totalPnl,
      totalCosts: tradeStats.totalCosts,
    },
    entries: {
      count: positionStats.count,
      wins: positionStats.wins,
      winRate: positionStats.winRate,
      avgPnl: positionStats.avgPnl,
      avgReturn: positionStats.avgReturn,
      payoffRatio: positionStats.payoffRatio,
      reduced: positionStats.reduced,
    },
    open: input.positions.map((p) => ({
      code: p.code,
      shares: p.shares,
      entryDate: p.entryDate,
      entryPrice: p.entryPriceRaw,
      lastPrice: p.lastCloseAdj,
      // 浮动盈亏按**前复权**算（与净值同口径）；展示的建仓价是不复权真实成交价。
      // 两个口径混在一行里看着别扭，但换成同一套会让「净值」与「我买在多少」之一变成假的
      unrealized: (p.lastCloseAdj - p.entryPriceAdj) * p.shares,
      barsHeld: p.barsHeld,
    })),
    pendingOrders: input.orders.length,
    skippedNoCash: input.skippedNoCash,
    limitBlocked: input.limitBlocked,
    engineVersion: input.engineVersion,
    stalledEngineVersion: input.stalledEngineVersion,
  }
}

/**
 * 数据层还没起来时的空壳。
 *
 * `startedAt: null` 是关键 —— 面板据此显示「尚未开始」，而**不是**一屏 0。
 * 一屏 0 会被读成「跑了但什么都没赚到」，那是另一个结论。
 */
export function emptyShadowSummary(engineVersion: string): ShadowSummary {
  return {
    startedAt: null,
    startedDate: null,
    bars: 0,
    calendarDays: 0,
    seasoned: false,
    seasoningDays: SEASONING_DAYS,
    startCapital: 0,
    cash: 0,
    positionValue: 0,
    equity: 0,
    totalReturn: 0,
    annualized: null,
    maxDrawdown: 0,
    sharpe: null,
    benchmarkReturn: null,
    exposure: null,
    barsPerYear: BARS_PER_YEAR,
    trades: {
      count: 0,
      winRate: null,
      profitFactor: null,
      weightedPnlPct: null,
      avgHoldingBars: null,
      totalPnl: 0,
      totalCosts: 0,
    },
    entries: { count: 0, wins: 0, winRate: null, avgPnl: null, avgReturn: null, payoffRatio: null, reduced: 0 },
    open: [],
    pendingOrders: 0,
    skippedNoCash: 0,
    limitBlocked: 0,
    engineVersion,
    stalledEngineVersion: null,
  }
}

/** 面板「最近的模拟交易」列表用的一行 */
export function toTradeView(trade: ShadowTrade, name: string): ShadowTradeView {
  return {
    id: trade.id,
    code: trade.code,
    name,
    entryDate: trade.entryDate,
    exitDate: trade.exitDate,
    entryPrice: trade.entryPriceRaw,
    exitPrice: trade.exitPriceRaw,
    shares: trade.shares,
    pnl: trade.pnl,
    pnlPct: trade.pnlPct,
    holdingBars: trade.holdingBars,
    regimeAtEntry: trade.regimeAtEntry,
    exitRule: trade.exitRule,
    partial: trade.partial,
  }
}
