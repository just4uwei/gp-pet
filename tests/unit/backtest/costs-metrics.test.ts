/**
 * 交易成本与绩效指标（docs/07 §2.2）。
 *
 * 成本这一层最容易「差不多就行」，但它直接决定回测结论：来回一趟约 0.3% 的摩擦，
 * 对一个持仓几天的策略是决定性的。所以每一项费用都单独验一次。
 */

import { describe, expect, it } from 'vitest'
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
  informationRatio,
  maxDrawdown,
  mean,
  returnsOf,
  sampleStdev,
  sharpeRatio,
  summarizeTrades,
  type EquityPoint,
} from '@backtest/metrics'

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

  it('没有亏损交易时盈亏比给 null 而不是 Infinity', () => {
    expect(summarizeTrades([{ pnl: 100, pnlPct: 0.01, holdingBars: 1, costs: 1 }]).profitFactor).toBeNull()
  })

  it('没有交易时各项为 null，不是 0', () => {
    const stats = summarizeTrades([])
    expect(stats.winRate).toBeNull()
    expect(stats.avgPnlPct).toBeNull()
    expect(stats.count).toBe(0)
  })
})
