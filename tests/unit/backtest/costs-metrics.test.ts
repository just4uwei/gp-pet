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
  alignedReturns,
  annualizedReturn,
  averageExposure,
  bartlettLongRunCovariance,
  betaOf,
  sharpeDiffHac,
  sharpeRatioHac,
  informationRatio,
  maxDrawdown,
  ratioExcessReturn,
  sameRiskPassive,
  mean,
  returnsOf,
  riskFreeAdjustedSharpe,
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

  it('beta：按 Cov/Var 算，基准无波动或样本不足给 null（0 会被读成「与大盘无关」）', () => {
    // 策略日收益恰好是基准的一半 ⇒ beta = 0.5，与幅度无关
    const benchmark = [0.02, -0.01, 0.03, -0.02]
    expect(betaOf(benchmark.map((r) => r * 0.5), benchmark)).toBeCloseTo(0.5, 10)
    expect(betaOf(benchmark, benchmark)).toBeCloseTo(1, 10)
    // 空仓策略：日收益恒 0 ⇒ beta 恰好 0（这是真的「与大盘无关」，不是算不出）
    expect(betaOf([0, 0, 0, 0], benchmark)).toBe(0)
    // 基准无波动 / 样本不足 ⇒ 算不出，给 null
    expect(betaOf([0.01, -0.02, 0.03], [0.01, 0.01, 0.01])).toBeNull()
    expect(betaOf([0.01], [0.02])).toBeNull()
    expect(betaOf([0.01, 0.02], [])).toBeNull()
  })

  it('除法版超额：与减法版在大基准涨幅上差得很远，基准本金全损时给 null', () => {
    // 单指数 2005–2017 那组真实数字（M2 §5.41 ④）：减法 −277.56%、除法 −69.10%
    const ratio = ratioExcessReturn(0.2414, 3.017)
    expect(ratio).not.toBeNull()
    expect(ratio!).toBeCloseTo(-0.691, 3)
    expect(0.2414 - 3.017).toBeCloseTo(-2.7756, 4)
    expect(ratioExcessReturn(0.05, null)).toBeNull()
    expect(ratioExcessReturn(0.05, -1)).toBeNull()
  })

  /**
   * **同风险参照（GH1）** —— 三条各守一件事，别合并：
   * ① σ 匹配的权重真的按 `σ_p/σ_m` 算；
   * ② 参照是**每日恒定权重**的复利，**不是**线性近似 `w × R_m`（实测两者能差 16.81pp，
   *    且符号由基准方向决定 —— 这是 M2 §5.52 里 P5 被证伪的那一条）；
   * ③ 基准缺失/配对不足给 null，不用 0 冒充（0 会被读成「与被动持有打平」）。
   */
  it('GH1：权重按 σ 匹配、参照走恒定权重复利而非线性近似', () => {
    // 策略日收益恰好是基准的一半 ⇒ σ_p/σ_m = 0.5，而参照就是「一半基准 + 一半现金」
    const benchmarkRets = [0.03, -0.02, 0.04, -0.01, 0.02]
    let bench = 1
    const benchLevels = [1, ...benchmarkRets.map((r) => (bench *= 1 + r))]
    let strat = 100
    const stratLevels = [100, ...benchmarkRets.map((r) => (strat *= 1 + r * 0.5))]
    const result = sameRiskPassive(equity(stratLevels, benchLevels))
    expect(result).not.toBeNull()
    expect(result!.weight).toBeCloseTo(0.5, 10)
    // 策略与参照在这个构造下逐日相同 ⇒ GH1 恰好 0（这是真的「打平」，不是算不出）
    expect(result!.gh1).toBeCloseTo(0, 12)
    // ② 恒定权重复利 ≠ 线性近似：基准整段是负的，两者必然不等
    const down = [0.05, -0.10, -0.08, 0.02, -0.06]
    let d = 1
    const downLevels = [1, ...down.map((r) => (d *= 1 + r))]
    let s2 = 100
    const s2Levels = [100, ...down.map((r) => (s2 *= 1 + r * 0.5))]
    const onDown = sameRiskPassive(equity(s2Levels, downLevels))
    const linear = 0.5 * ((downLevels[downLevels.length - 1] ?? 1) - 1)
    expect(onDown).not.toBeNull()
    expect(onDown!.referenceReturn).not.toBeCloseTo(linear, 4)
  })

  it('GH1：基准缺失或配对不足给 null（0 会被读成「与被动持有打平」）', () => {
    expect(sameRiskPassive(equity([100, 110, 121]))).toBeNull()
    expect(sameRiskPassive(equity([100, 110], [1, 1.1]))).toBeNull()
    // 基准无波动 ⇒ σ_m = 0 ⇒ 权重除零，算不出
    expect(sameRiskPassive(equity([100, 110, 121], [1, 1, 1]))).toBeNull()
  })

  /**
   * **严格配对**（`alignedReturns`）—— 这条守的是一个不报错的错。
   *
   * 旧写法是 `returnsOf(points,'equity')` 与 `returnsOf(points,'benchmark')` 各算一遍，
   * 而它们各自会跳过自己缺值的那些期 ⇒ 基准列一有空洞，两个数组的**下标就错位**，
   * 于是信息比率与 beta 拿「策略第 100 天 vs 基准第 103 天」在配对，且一个字都不报。
   * 回测 fixture 里基准零空洞所以从没踩到，但**影子的基准列真的会缺**（真机 2/2 行 null）。
   */
  it('严格配对：基准列有空洞时两侧同步丢那一期，下标不许错位', () => {
    const points = equity([100, 110, 121, 133.1, 146.41], [1, 1.1, null as unknown as number, 1.331, 1.4641])
    // 中间那一行基准缺失 ⇒ 它前后两期都不能算（prev 或 now 缺一端都不行）
    const { strategy, benchmark } = alignedReturns(points)
    expect(strategy).toHaveLength(2)
    expect(benchmark).toHaveLength(2)
    strategy.forEach((r, i) => expect(r).toBeCloseTo(benchmark[i] ?? -1, 10))
    // 对照：各算一遍会得到 4 和 2，长度都对不上，按下标配对就是错位
    expect(returnsOf(points, 'equity')).toHaveLength(4)
    expect(returnsOf(points, 'benchmark')).toHaveLength(2)
  })

  it('严格配对：整列缺基准时给两个空数组（下游据此给 null，不是 0）', () => {
    const { strategy, benchmark } = alignedReturns(equity([100, 110, 121]))
    expect(strategy).toEqual([])
    expect(benchmark).toEqual([])
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
  /**
   * 无风险利率调整后的夏普（2026-08-21）。盯的是「不许罚两次」这一条：
   * 这套策略常年空仓、现金在账本里不计息，所以 rf 只能对**持仓那部分**收。
   */
  describe('riskFreeAdjustedSharpe', () => {
    /** 带逐日持仓市值的净值曲线 */
    const withPositions = (
      values: readonly number[],
      positions: readonly number[]
    ): EquityPoint[] =>
      values.map((value, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, '0')}` as TradeDate,
        equity: value,
        benchmark: null,
        positionValue: positions[i] ?? 0,
      }))

    it('rf = 0 时与 sharpeRatio 逐位相同 —— 老口径不许被这次改动碰到', () => {
      const points = withPositions([100, 101, 100.5, 102], [0, 50, 50, 80])
      expect(riskFreeAdjustedSharpe(points, 0)).toBe(sharpeRatio(returnsOf(points, 'equity')))
    })

    it('全程空仓时 rf 一分钱都不收：占用为 0 ⇒ 与 rf = 0 相同', () => {
      // 这一条就是「不许罚两次」的最纯形式：没投出去的钱不承担机会成本
      const idle = withPositions([100, 100.5, 100.2, 101], [0, 0, 0, 0])
      expect(riskFreeAdjustedSharpe(idle, 0.02)).toBe(riskFreeAdjustedSharpe(idle, 0))
    })

    it('满仓时等于「整体减 rf」—— 两种口径只在低占用下分叉', () => {
      const full = withPositions([100, 101, 100.5, 102], [100, 101, 100.5, 102])
      const naive = returnsOf(full, 'equity').map((r) => r - 0.02 / BARS_PER_YEAR)
      expect(riskFreeAdjustedSharpe(full, 0.02)).toBeCloseTo(sharpeRatio(naive) ?? 0, 12)
    })

    it('低占用下比「整体减 rf」高得多，且仍低于 rf = 0', () => {
      const values = [100, 100.4, 100.2, 100.9]
      const light = withPositions(values, [3.5, 3.5, 3.5, 3.5])
      const adjusted = riskFreeAdjustedSharpe(light, 0.02) ?? 0
      const naive =
        sharpeRatio(returnsOf(light, 'equity').map((r) => r - 0.02 / BARS_PER_YEAR)) ?? 0
      const plain = riskFreeAdjustedSharpe(light, 0) ?? 0
      expect(adjusted).toBeGreaterThan(naive)
      expect(adjusted).toBeLessThan(plain)
    })

    it('缺 positionValue 时给 null，绝不退回「按满仓收」—— 那正是要防的双罚', () => {
      const noPositions: EquityPoint[] = [100, 101, 102].map((value, i) => ({
        date: `2024-01-0${i + 1}` as TradeDate,
        equity: value,
        benchmark: null,
      }))
      expect(riskFreeAdjustedSharpe(noPositions, 0.02)).toBeNull()
      // 但 rf = 0 时该项恒为 0，不需要占用 ⇒ 照样能算
      expect(riskFreeAdjustedSharpe(noPositions, 0)).not.toBeNull()
    })
  })

  /**
   * 夏普方差的自相关修正（Lo 2002，2026-08-21，M2 §5.50）。
   *
   * 这一组的第一条是**唯一的正确性保证**：`lag = 0` 时 `V_GMM` 必须逐位退回
   * `1 − γ₃·SR + ((γ₄−1)/4)·SR²`（Mertens/Christie 的闭式，`scripts/verify/stats.ts`
   * 里那个已经被 PSR/DSR/MinTRL 三处用着的函数）。这里刻意**不 import** 那个函数、
   * 而是就地把闭式再写一遍 —— 两边同一个实现的话，这条自检就退化成 `x === x`。
   */
  describe('sharpeRatioHac（Lo 2002 的 V_GMM）', () => {
    /** 就地算总体中心矩下的闭式，不复用被测代码的任何一行 */
    const closedForm = (xs: readonly number[]): number => {
      const n = xs.length
      const m = xs.reduce((s, v) => s + v, 0) / n
      const cm = (k: number): number => xs.reduce((s, v) => s + (v - m) ** k, 0) / n
      const sr = m / Math.sqrt(cm(2))
      const skew = cm(3) / cm(2) ** 1.5
      const kurt = cm(4) / cm(2) ** 2
      return 1 - skew * sr + ((kurt - 1) / 4) * sr * sr
    }

    const series = [0.012, -0.004, 0.031, -0.019, 0.007, 0.022, -0.011, 0.005, 0.017, -0.026]

    it('lag = 0 时逐位等于 Mertens/Christie 的闭式', () => {
      const got = sharpeRatioHac(series, 0)
      expect(got).not.toBeNull()
      expect(got!.varTerm).toBeCloseTo(closedForm(series), 12)
      expect(got!.varTermIid).toBeCloseTo(closedForm(series), 12)
      expect(got!.varianceInflation).toBeCloseTo(1, 12)
    })

    it('正自相关把方差抬上去，负自相关压下来 —— VIF 的方向不许反', () => {
      // 段块式：连续同号 ⇒ 正自相关
      const persistent = [0.01, 0.012, 0.011, 0.013, -0.01, -0.012, -0.011, -0.013, 0.01, 0.012, 0.011, 0.013]
      // 逐期交替 ⇒ 负自相关
      const alternating = [0.01, -0.01, 0.011, -0.011, 0.012, -0.012, 0.01, -0.01, 0.011, -0.011, 0.012, -0.012]
      expect(sharpeRatioHac(persistent, 3)!.varianceInflation).toBeGreaterThan(1)
      expect(sharpeRatioHac(alternating, 3)!.varianceInflation).toBeLessThan(1)
    })

    it('滞后阶被 T−1 夹住，且 lag 为负按 0 处理', () => {
      expect(sharpeRatioHac(series, 999)!.lag).toBe(series.length - 1)
      expect(sharpeRatioHac(series, -5)!.lag).toBe(0)
    })

    it('标准误 = √(varTerm / T)，样本不足或零波动给 null', () => {
      const got = sharpeRatioHac(series, 2)!
      expect(got.standardError).toBeCloseTo(Math.sqrt(got.varTerm / series.length), 12)
      expect(sharpeRatioHac([0.01], 0)).toBeNull()
      expect(sharpeRatioHac([0.01, 0.01, 0.01], 0)).toBeNull()
    })

    /**
     * 交叉项 `S₁₂` 必须对称化（`γ_k^ab + γ_k^ba`）：只取一边，矩阵就不对称，
     * 二次型可能变负 —— 症状是一个「负方差」。
     */
    it('bartlettLongRunCovariance 对两个参数对称', () => {
      const a = [1, 2, 3, 4, 5, 4, 3, 2]
      const b = [2, 1, 4, 3, 6, 3, 4, 1]
      expect(bartlettLongRunCovariance(a, b, 3)).toBeCloseTo(
        bartlettLongRunCovariance(b, a, 3) ?? NaN,
        12
      )
    })

    it('bartlettLongRunCovariance 在 lag = 0 上就是总体方差（除 T）', () => {
      const a = [1, 2, 3, 4, 5]
      const m = 3
      const want = a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length
      expect(bartlettLongRunCovariance(a, a, 0)).toBeCloseTo(want, 12)
      expect(bartlettLongRunCovariance([1], [1], 0)).toBeNull()
    })
  })

  /**
   * **两条相关曲线的夏普之差**（Jobson & Korkie 1981 → Memmel 2003 →
   * **Ledoit & Wolf 2008**，M2 §5.60）。
   *
   * 第一条是这里的正确性保证：`lag = 0` 时，实现必须等于**就地另写一遍**的
   * `∇f′Ψ̂∇f · T/(T−4) / T` —— 那份就地实现**不碰** `bartlettLongRunCovariance`，
   * 直接用 `y_t` 的样本协方差（`lag = 0` 时两者本就该相等），所以它是一条独立路径
   * 而不是 `x === x`。
   *
   * ⚠ **代数恒等式那一条不在这里**（在 `scripts/verify/sharpe-diff.ts` 的自检 ①）：
   * 「`∇f′Ψ∇f` = Memmel 闭式 `2 − 2ρ + ½SR_a² + ½SR_b² − ρ²·SR_a·SR_b`」
   * 是 **`Ψ` 取解析形式时**的恒等式，随手写的十几个数**样本高阶矩不满足二元正态**
   * ⇒ 拿它去比会差几个百分点，而那正是「看起来像通过了」的那一档。
   * 那条自检还顺带证伪了网上流传的两种写法（差 0.03–0.12% 与 11 倍）。
   */
  describe('sharpeDiffHac（Jobson–Korkie → Memmel → Ledoit–Wolf 2008）', () => {
    const a = [0.012, -0.004, 0.031, -0.019, 0.007, 0.022, -0.011, 0.005, 0.017, -0.026, 0.009, -0.003]
    const b = [0.009, -0.002, 0.026, -0.014, 0.004, 0.019, -0.013, 0.002, 0.021, -0.022, 0.006, 0.001]

    /** 就地组装 LW Eq. (2)/(4)/(5)，不复用被测代码的任何一行 */
    const byHand = (xs: readonly number[], ys: readonly number[]): number => {
      const T = xs.length
      const avg = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / T
      const muA = avg(xs)
      const muB = avg(ys)
      const gA = avg(xs.map((v) => v * v))
      const gB = avg(ys.map((v) => v * v))
      const vA = gA - muA * muA
      const vB = gB - muB * muB
      const grad = [gA / vA ** 1.5, -gB / vB ** 1.5, -muA / 2 / vA ** 1.5, muB / 2 / vB ** 1.5]
      const y = [
        xs.map((v) => v - muA),
        ys.map((v) => v - muB),
        xs.map((v) => v * v - gA),
        ys.map((v) => v * v - gB),
      ]
      let q = 0
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          let s = 0
          for (let t = 0; t < T; t++) s += (y[i]?.[t] ?? 0) * (y[j]?.[t] ?? 0)
          q += (grad[i] ?? 0) * (grad[j] ?? 0) * (s / T)
        }
      }
      return (q * T) / (T - 4) / T // = SE²
    }

    it('lag = 0 时等于就地组装的 ∇f′Ψ∇f（含 LW 的 T/(T−4) 修正）', () => {
      const got = sharpeDiffHac(a, b, 0)
      expect(got).not.toBeNull()
      expect(got!.standardError ** 2).toBeCloseTo(byHand(a, b), 14)
      expect(got!.standardErrorIid).toBeCloseTo(got!.standardError, 14)
    })

    it('Δ 与 z 反号、SE 与 ρ 不变 —— 换个次序问同一个问题', () => {
      const ab = sharpeDiffHac(a, b, 2)!
      const ba = sharpeDiffHac(b, a, 2)!
      expect(ba.delta).toBeCloseTo(-ab.delta, 14)
      expect(ba.z).toBeCloseTo(-ab.z, 12)
      expect(ba.standardError).toBeCloseTo(ab.standardError, 14)
      expect(ba.rho).toBeCloseTo(ab.rho, 14)
      expect(ba.pValue).toBeCloseTo(ab.pValue, 12)
    })

    /**
     * 这一条钉的是这个函数**存在的理由**：朴素合成 SE（两条单腿平方相加）
     * 隐含 `Cov = 0`，两条腿越相关它越偏大 ⇒ 会把测得出的差别判成测不出，
     * 方向**不保守**。实测非崩盘段那对是 3.48 倍（M2 §5.60）。
     */
    it('正相关让真实 SE 小于朴素合成，负相关让它更大 —— 朴素口径对两边都是瞎的', () => {
      const tight = sharpeDiffHac(a, b, 0)!
      expect(tight.rho).toBeGreaterThan(0.9)
      expect(tight.naiveRatio).toBeGreaterThan(2)
      /*
        镜像第二条腿（`b' = 2μ_b − b`）：均值与方差一字不改、`ρ` **精确翻号**。
        ⇒ 同一对边际分布下，只有相关方向变了，而真实 SE 必须朝相反方向走。
        （倒序**不行** —— 这两条序列倒过来仍高度相关，第一版就是这么红的。）
      */
      const muB = b.reduce((s, v) => s + v, 0) / b.length
      const mirrored = sharpeDiffHac(a, b.map((v) => 2 * muB - v), 0)!
      expect(mirrored.rho).toBeCloseTo(-tight.rho, 12)
      expect(mirrored.naiveRatio).toBeLessThan(1)
      expect(mirrored.standardError).toBeGreaterThan(tight.standardError)
    })

    it('样本不足或零波动给 null；滞后阶被 T−1 夹住、负数按 0 处理', () => {
      expect(sharpeDiffHac([0.01, 0.02], [0.01, 0.02], 0)).toBeNull()
      expect(sharpeDiffHac(a, a.map(() => 0.01), 0)).toBeNull()
      expect(sharpeDiffHac(a, b, 999)!.lag).toBe(a.length - 1)
      expect(sharpeDiffHac(a, b, -3)!.lag).toBe(0)
    })
  })

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

/*
  场内基金的费率（2026-08-17）。

  `core/code.ts` 早就认得 ETF 板块，而 costs.ts 此前无条件收印花税 + 过户费 ——
  后果有两层：回测里 ETF 被多扣 0.1%/卖出（实测 12 只 ETF 池训练窗口带税 +1.63%、
  免税 +2.14%，**差 0.51pp**），实盘记账里那 15 只行业 ETF 的成本价与已实现盈亏一起偏高。
*/
describe('场内基金免印花税与过户费', () => {
  const amount = 100_000

  it('ETF 卖出只收佣金', () => {
    const commission = Math.max(DEFAULT_COSTS.minCommission, amount * DEFAULT_COSTS.commissionRate)
    expect(sellFees(amount, DEFAULT_COSTS, 'ETF')).toBeCloseTo(commission, 10)
  })

  it('ETF 买入不收过户费', () => {
    const commission = Math.max(DEFAULT_COSTS.minCommission, amount * DEFAULT_COSTS.commissionRate)
    expect(buyFees(amount, DEFAULT_COSTS, 'ETF')).toBeCloseTo(commission, 10)
  })

  it('股票照旧收满 —— 差额恰好是印花税', () => {
    const stock = sellFees(amount, DEFAULT_COSTS, 'MAIN')
    const fund = sellFees(amount, DEFAULT_COSTS, 'ETF')
    expect(stock - fund).toBeCloseTo(
      amount * DEFAULT_COSTS.stampTaxRate + amount * DEFAULT_COSTS.transferFeeRate,
      10
    )
  })

  it('不传 board 时按股票收满 —— 缺省往「多收」那边掰是刻意的', () => {
    expect(sellFees(amount, DEFAULT_COSTS)).toBeCloseTo(sellFees(amount, DEFAULT_COSTS, 'MAIN'), 10)
  })

  it('创业板/科创板/北交所都是股票，不沾这个豁免', () => {
    for (const board of ['GEM', 'STAR', 'BSE'] as const) {
      expect(sellFees(amount, DEFAULT_COSTS, board)).toBeCloseTo(
        sellFees(amount, DEFAULT_COSTS, 'MAIN'),
        10
      )
    }
  })
})
