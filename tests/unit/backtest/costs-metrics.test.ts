/**
 * 交易成本与绩效指标（docs/07 §2.2）。
 *
 * 成本这一层最容易「差不多就行」，但它直接决定回测结论：来回一趟约 0.3% 的摩擦，
 * 对一个持仓几天的策略是决定性的。所以每一项费用都单独验一次。
 */

import { describe, expect, it } from 'vitest'
import type { TradeDate } from '@core/types'
import {
  DEFAULT_COSTS,
  LOT_SIZE,
  buyFees,
  buyFill,
  lotsAffordable,
  sellFees,
  sellFill,
} from '@backtest/costs'
import {
  BARS_PER_YEAR,
  annualizedReturn,
  averageExposure,
  informationRatio,
  maxDrawdown,
  mean,
  returnsOf,
  sampleStdev,
  sharpeRatio,
  summarizeTrades,
  groupPositions,
  type EquityPoint,
} from '@backtest/metrics'

/**
 * 建仓级归并（`groupPositions`）—— 「胜率」的用户口径。
 *
 * 逐行胜率回答「每一次卖出动作赚不赚」，建仓级回答「我按提醒买了一次，最后赚没赚」。
 * 实测出厂参数下前者 33.16%、后者 49.3%，差 16 个百分点 —— 拿前者对用户说「胜率」
 * 是低估，拿它当标定目标则会把优化方向带偏（M2 §5.18）。
 */
describe('建仓级归并', () => {
  const row = (
    code: string,
    entryDate: string,
    pnl: number,
    partial = false,
    shares = 1000
  ): { code: string; entryDate: TradeDate; entryPrice: number; shares: number; pnl: number; partial: boolean } => ({
    code,
    entryDate: entryDate as TradeDate,
    entryPrice: 10,
    shares,
    pnl,
    partial,
  })

  it('同标的同建仓日的多行合成一次建仓，按合计盈亏判胜负', () => {
    // 一次建仓：先减仓亏 500，再清仓赚 900 → 合计 +400，算**赢**
    const stats = groupPositions([
      row('SH600000', '2024-01-02', -500, true, 500),
      row('SH600000', '2024-01-02', 900, false, 500),
    ])
    expect(stats.count).toBe(1)
    expect(stats.wins).toBe(1)
    expect(stats.winRate).toBe(1)
    expect(stats.reduced).toBe(1)
    expect(stats.avgPnl).toBe(400)
  })

  it('同标的不同建仓日算两次建仓', () => {
    const stats = groupPositions([row('SH600000', '2024-01-02', 100), row('SH600000', '2024-03-05', -200)])
    expect(stats.count).toBe(2)
    expect(stats.winRate).toBeCloseTo(0.5, 10)
  })

  it('逐行胜率与建仓级胜率可以差很多 —— 这正是要分开算的原因', () => {
    // 三次建仓，每次都是「减仓亏一点 + 清仓赚回来」：逐行 3 赢 3 亏 = 50%，建仓级 100%
    const rows = ['2024-01-02', '2024-02-02', '2024-03-02'].flatMap((date) => [
      row('SH600000', date, -100, true, 500),
      row('SH600000', date, 300, false, 500),
    ])
    expect(groupPositions(rows).winRate).toBe(1)
    expect(summarizeTrades(rows.map((r) => ({ ...r, pnlPct: r.pnl / 5000, holdingBars: 3, costs: 0 }))).winRate)
      .toBeCloseTo(0.5, 10)
  })

  it('平仓盈亏恰好为 0 算亏（不算赢）—— 扣掉成本后没赚就是没赚', () => {
    expect(groupPositions([row('SH600000', '2024-01-02', 0)]).winRate).toBe(0)
  })

  it('没有交易时各项为 null，不是 0', () => {
    const stats = groupPositions([])
    expect(stats.count).toBe(0)
    expect(stats.winRate).toBeNull()
    expect(stats.avgPnl).toBeNull()
    expect(stats.payoffRatio).toBeNull()
  })

  it('没有亏损建仓时盈亏比给 null 而不是 Infinity', () => {
    expect(groupPositions([row('SH600000', '2024-01-02', 100)]).payoffRatio).toBeNull()
  })
})

describe('成本模型', () => {
  it('滑点一律朝不利方向：买贵、卖便宜', () => {
    expect(buyFill(10, DEFAULT_COSTS)).toBeCloseTo(10.01, 10)
    expect(sellFill(10, DEFAULT_COSTS)).toBeCloseTo(9.99, 10)
  })

  it('买入费 = 佣金 + 过户费；卖出另加印花税', () => {
    const amount = 100_000
    const commission = amount * DEFAULT_COSTS.commissionRate
    const transfer = amount * DEFAULT_COSTS.transferFeeRate
    expect(buyFees(amount, DEFAULT_COSTS)).toBeCloseTo(commission + transfer, 10)
    expect(sellFees(amount, DEFAULT_COSTS)).toBeCloseTo(
      commission + transfer + amount * DEFAULT_COSTS.stampTaxRate,
      10
    )
  })

  it('小额交易走最低佣金 5 元', () => {
    // 1000 元 × 万 2.5 = 0.25 元 → 应被抬到 5 元
    expect(buyFees(1000, DEFAULT_COSTS)).toBeGreaterThanOrEqual(5)
  })

  it('按整手买入，且费用也要放得下', () => {
    const shares = lotsAffordable(10_000, 10, DEFAULT_COSTS)
    expect(shares % LOT_SIZE).toBe(0)
    expect(shares * 10 + buyFees(shares * 10, DEFAULT_COSTS)).toBeLessThanOrEqual(10_000)
  })

  it('钱不够一手时买 0 手，不产生负持仓', () => {
    expect(lotsAffordable(100, 10, DEFAULT_COSTS)).toBe(0)
    expect(lotsAffordable(0, 10, DEFAULT_COSTS)).toBe(0)
    expect(lotsAffordable(10_000, 0, DEFAULT_COSTS)).toBe(0)
  })
})

describe('绩效指标', () => {
  const equity = (values: readonly number[], benchmark?: readonly number[]): EquityPoint[] =>
    values.map((value, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      equity: value,
      benchmark: benchmark?.[i] ?? null,
    }))

  it('最大回撤：峰谷幅度、持续与收复', () => {
    const result = maxDrawdown(equity([100, 120, 90, 95, 130]))
    expect(result.maxDrawdown).toBeCloseTo(0.25, 10)
    expect(result.peakDate).toBe('2024-01-02')
    expect(result.troughDate).toBe('2024-01-03')
    expect(result.durationBars).toBe(1)
    expect(result.recoveryBars).toBe(2)
  })

  it('未收复的回撤 recoveryBars 为 null，而不是 0', () => {
    expect(maxDrawdown(equity([100, 80])).recoveryBars).toBeNull()
  })

  it('单调上涨没有回撤；空序列不抛错', () => {
    expect(maxDrawdown(equity([100, 110, 120])).maxDrawdown).toBe(0)
    expect(maxDrawdown([]).maxDrawdown).toBe(0)
  })

  it('逐期收益率跳过缺基准的点，不用 0 冒充', () => {
    const points = equity([100, 110, 121], [1, 1.1, 1.21])
    expect(returnsOf(points)).toHaveLength(2)
    expect(returnsOf(equity([100, 110]), 'benchmark')).toEqual([])
  })

  it('年化：一年期的翻倍就是 100%', () => {
    expect(annualizedReturn(1, BARS_PER_YEAR)).toBeCloseTo(1, 6)
    expect(annualizedReturn(0.1, 0)).toBeNull()
  })

  it('本金亏光时给 -1 而不是 NaN', () => {
    expect(annualizedReturn(-1.2, BARS_PER_YEAR)).toBe(-1)
  })

  it('夏普：样本不足或零波动给 null（0 会被读成「无风险调整收益」）', () => {
    expect(sharpeRatio([0.01])).toBeNull()
    expect(sharpeRatio([0.01, 0.01, 0.01])).toBeNull()
    expect(sharpeRatio([0.02, -0.01, 0.03, 0.01])).not.toBeNull()
  })

  it('信息比率：超额恒定（零跟踪误差）给 null；有波动才算得出', () => {
    expect(informationRatio([0.02, 0.02], [0.01, 0.01])).toBeNull()
    expect(informationRatio([0.02, -0.01, 0.03], [0.01, 0.0, 0.02])).not.toBeNull()
    expect(informationRatio([0.01], [0.01])).toBeNull()
  })

  it('均值与样本标准差（除 n-1）', () => {
    expect(mean([1, 2, 3])).toBe(2)
    expect(mean([])).toBe(0)
    expect(sampleStdev([2, 4])).toBeCloseTo(Math.SQRT2, 10)
    expect(sampleStdev([5])).toBe(0)
  })

  it('逐笔统计：胜率、盈亏比、平均持仓', () => {
    const stats = summarizeTrades([
      { pnl: 200, pnlPct: 0.02, holdingBars: 4, costs: 10 },
      { pnl: -100, pnlPct: -0.01, holdingBars: 2, costs: 10 },
      { pnl: 400, pnlPct: 0.04, holdingBars: 6, costs: 10 },
    ])
    expect(stats.count).toBe(3)
    expect(stats.wins).toBe(2)
    expect(stats.winRate).toBeCloseTo(2 / 3, 10)
    expect(stats.profitFactor).toBeCloseTo(300 / 100, 10)
    expect(stats.avgHoldingBars).toBeCloseTo(4, 10)
    expect(stats.totalPnl).toBe(500)
    expect(stats.totalCosts).toBe(30)
  })

  /**
   * 这一条是 2026-08-13 的回归：报告里四种市况的「平均」都打出 −1.2% ~ −1.6%，
   * 而净盈亏是 +231,154 元。**两个数都没算错**，错的是把未加权的逐行百分比
   * 当成「平均一笔赚多少」读 —— 回撤减仓把一次建仓拆成大小不同的两行，
   * 未加权平均于是把半仓那一行和满仓那一行等同看待。
   * 下面这三行就是那个形状的最小复现：加权是 +1%，未加权是 −1%。
   */
  it('未加权 avgPnlPct 的符号可以与净盈亏相反 —— 所以另给一个按仓位加权的', () => {
    const stats = summarizeTrades([
      // 满仓赚 3%：+3000 元
      { pnl: 3000, pnlPct: 0.03, holdingBars: 5, costs: 10, entryPrice: 10, shares: 10_000 },
      // 减仓后的小仓位各亏 5%：合计 −1000 元
      { pnl: -500, pnlPct: -0.05, holdingBars: 2, costs: 5, entryPrice: 10, shares: 1000 },
      { pnl: -500, pnlPct: -0.05, holdingBars: 2, costs: 5, entryPrice: 10, shares: 1000 },
    ])
    expect(stats.totalPnl).toBe(2000)
    // 未加权：(3 − 5 − 5) / 3 = −2.33%，与赚钱的事实相反
    expect(stats.avgPnlPct).toBeLessThan(0)
    // 加权：2000 / 120000 = +1.67%
    expect(stats.weightedPnlPct).toBeCloseTo(2000 / 120_000, 10)
  })

  it('缺仓位字段时 weightedPnlPct 为 null，不用未加权的值冒充', () => {
    expect(summarizeTrades([{ pnl: 1, pnlPct: 0.01, holdingBars: 1, costs: 0 }]).weightedPnlPct).toBeNull()
  })

  it('没有亏损交易时盈亏比给 null 而不是 Infinity', () => {
    expect(summarizeTrades([{ pnl: 100, pnlPct: 0.01, holdingBars: 1, costs: 1 }]).profitFactor).toBeNull()
  })

  it('没有交易时各项为 null，不是 0', () => {
    const stats = summarizeTrades([])
    expect(stats.winRate).toBeNull()
    expect(stats.avgPnlPct).toBeNull()
    expect(stats.count).toBe(0)
  })

  /**
   * 平均资金占用率存在的意义是让「超额收益」可读：基准满仓、策略多数时间空仓。
   * 实测出厂参数下这个数只有 4.15%，而超额是 −8.17pp —— 两个数必须一起看（M2 §5.13）。
   */
  describe('平均资金占用率', () => {
    it('满仓一整段 = 1', () => {
      expect(averageExposure([{ entryPrice: 10, shares: 1000, holdingBars: 100 }], 10000, 100)).toBeCloseTo(1, 10)
    })

    it('半仓一半时间 = 0.25', () => {
      expect(averageExposure([{ entryPrice: 10, shares: 500, holdingBars: 50 }], 10000, 100)).toBeCloseTo(0.25, 10)
    })

    it('多笔交易累加（部分止盈拆出的每条各按自己的份额与天数计）', () => {
      const trades = [
        { entryPrice: 10, shares: 400, holdingBars: 50 },
        { entryPrice: 10, shares: 600, holdingBars: 25 },
      ]
      expect(averageExposure(trades, 10000, 100)).toBeCloseTo((400 * 50 + 600 * 25) / 100000, 10)
    })

    it('没有交易 = 0（空仓是事实，不是缺数据）', () => {
      expect(averageExposure([], 10000, 100)).toBe(0)
    })

    it('资金或交易日为 0 时给 null，不是 0', () => {
      expect(averageExposure([], 0, 100)).toBeNull()
      expect(averageExposure([], 10000, 0)).toBeNull()
    })
  })
})
