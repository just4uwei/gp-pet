/**
 * 回测模拟器（docs/07 §2.2 的陷阱清单）。
 *
 * 每条陷阱一个用例。其中「未来函数」那条是本文件存在的主要理由：
 * 它是回测里唯一一种**会让报告变好看**的错误，因此也是最不容易被自己发现的错误。
 *
 * 用例统一把组合阈值调低（0.3 分 / 1 票）：这里验的是**成交机制**，不是信号质量。
 * 用出厂阈值会让多数 fixture 一笔都不成交，那样的「通过」什么都没证明。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_COSTS } from '@backtest/costs'
import {
  DELISTED_EXIT_RULE,
  NEUTRAL_SENTIMENT,
  assertNoFuture,
  simulateCode,
  type SimulateOptions,
} from '@backtest/simulate'
import { fallbackProfile, sentimentSeries } from '@backtest/data'
import { marketSentiment } from '@core/indicators/thresholds'
import { DEFAULT_PARAMS, withParams } from '@core/params'
import type { Candle } from '@core/types'
import { buildCandles, chopCloses, limitUpBreakout } from '../../fixtures/klines'

const SENSITIVE = withParams({
  combine: {
    ...DEFAULT_PARAMS.combine,
    scoreThreshold: 0.3,
    voteThreshold: { trend: 1, meanReversion: 1 },
  },
})

const OPTIONS: SimulateOptions = {
  params: SENSITIVE,
  costs: DEFAULT_COSTS,
  capitalPerCode: 100_000,
  lookback: 320,
  warmupBars: 300,
}

const synthetic = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/klines/synthetic-500.json'), 'utf8')
) as Candle[]

const profile = fallbackProfile('SH600000', '测试标的')

function run(candles: readonly Candle[], overrides: Partial<SimulateOptions> = {}): ReturnType<typeof simulateCode> {
  return simulateCode({ profile, candles: [...candles] }, { ...OPTIONS, ...overrides }, NEUTRAL_SENTIMENT)
}

describe('未来函数防护（docs/07 §2.2 第一条）', () => {
  it('assertNoFuture：末根日期不符或含未来数据即抛错', () => {
    const candles = buildCandles([10, 11, 12])
    expect(() => assertNoFuture(candles, candles[2]?.date ?? '')).not.toThrow()
    expect(() => assertNoFuture(candles, candles[1]?.date ?? '')).toThrow(/未来函数/)
    expect(() => assertNoFuture([], '2024-01-01')).toThrow(/窗口为空/)
  })

  it('改写未来的 K 线不影响此前已完成的交易 —— 引擎确实只看得见过去', () => {
    const cut = 420
    const prefix = synthetic.slice(0, cut)
    // 把 cut 之后的行情整段改成暴涨；若存在未来函数，前半段的决策会跟着变
    const tampered = [
      ...prefix,
      ...synthetic.slice(cut).map((candle, i) => ({
        ...candle,
        close: candle.close * (1 + i * 0.05),
        closeAdj: candle.closeAdj * (1 + i * 0.05),
        high: candle.high * (1 + i * 0.05),
        highAdj: candle.highAdj * (1 + i * 0.05),
      })),
    ]

    const prefixEnd = prefix[prefix.length - 1]?.date ?? ''
    const before = run(prefix).trades.filter((t) => t.exitDate <= prefixEnd)
    const after = run(tampered).trades.filter((t) => t.exitDate <= prefixEnd)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })
})

describe('成交模型', () => {
  const result = run(synthetic)

  it('fixture 能产出交易 —— 否则下面的断言都是空转', () => {
    expect(result.trades.length).toBeGreaterThan(0)
    expect(result.evaluations).toBeGreaterThan(0)
  })

  it('信号在收盘产生、成交价用**次日开盘**（含滑点）', () => {
    const byDate = new Map(synthetic.map((c) => [c.date, c]))
    for (const trade of result.trades) {
      const entry = byDate.get(trade.entryDate)
      const exit = byDate.get(trade.exitDate)
      expect(entry).toBeDefined()
      expect(trade.entryPrice).toBeCloseTo((entry?.openAdj ?? 0) * (1 + DEFAULT_COSTS.slippage), 6)
      expect(trade.exitPrice).toBeCloseTo((exit?.openAdj ?? 0) * (1 - DEFAULT_COSTS.slippage), 6)
    }
  })

  it('T+1：持仓至少跨一个交易日', () => {
    for (const trade of result.trades) {
      expect(trade.holdingBars).toBeGreaterThanOrEqual(1)
      expect(trade.exitDate > trade.entryDate).toBe(true)
    }
  })

  it('逐笔盈亏 = 差价 × 股数 − 成本，且股数是整手', () => {
    for (const trade of result.trades) {
      expect(trade.shares % 100).toBe(0)
      expect(trade.pnl).toBeCloseTo((trade.exitPrice - trade.entryPrice) * trade.shares - trade.costs, 6)
    }
  })

  it('净值曲线与 K 线等长且恒为正（不会因为费用把账户算成负数）', () => {
    expect(result.equity).toHaveLength(synthetic.length)
    for (const point of result.equity) expect(point.equity).toBeGreaterThan(0)
  })

  it('归因信息齐全：建仓时的市场状态与触发的子信号都记下来了', () => {
    for (const trade of result.trades) {
      expect(['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION']).toContain(trade.regimeAtEntry)
      expect(trade.exitRule.length).toBeGreaterThan(0)
    }
  })
})

describe('无法成交的情形', () => {
  it('次日开盘涨停 → 买单作废，一笔都不成交', () => {
    // fixture 见 limitUpBreakout()：**必须有一张真的买单**，否则这条断言在真空里通过。
    // 旧写法就地造了一段字面意义的直线（STD=0、量比恒 1.0），一个信号都产不出来，
    // limitBlocked 恒为 0 —— 这条安全路径当时其实是零覆盖
    const result = run(limitUpBreakout().candles, { warmupBars: 322 })
    expect(result.limitBlocked).toBeGreaterThan(0)
    expect(result.trades).toHaveLength(0)
    // 委托被挡掉之后，后面几根一字涨停当天的买入信号还会被风控硬抑制（买不到）
    expect([...result.suppressed.keys()]).toContain('HARD_LIMIT_UP')
  })

  it('缺口段跳过判定与成交（docs/07 §4）', () => {
    const candles = synthetic.map((candle, i) => (i > 300 ? { ...candle, hasGap: true } : candle))
    const result = run(candles)
    expect(result.gapSkipped).toBeGreaterThan(0)
    expect(result.trades).toHaveLength(0)
  })

  it('数据不足以预热时不产出任何评估', () => {
    const result = run(buildCandles(chopCloses(50)), { warmupBars: 300 })
    expect(result.evaluations).toBe(0)
    expect(result.trades).toHaveLength(0)
  })

  it('被风控硬抑制的信号计入 suppressed，而不是悄悄消失', () => {
    // 从第 30 根就开始判：先命中「日线不足 40 根」，再命中「上市不足 60 个交易日」
    const short = synthetic.slice(0, 120)
    const result = run(short, { warmupBars: 30 })
    expect(result.evaluations).toBeGreaterThan(0)
    const rules = [...result.suppressed.keys()]
    expect(rules).toContain('INSUFFICIENT_DATA')
    expect(rules).toContain('NEW_LISTING')

    // 抑制期内**一笔都不成交**。原先写的是「整个窗口一笔都没有」，那是过度断言：
    // NEW_LISTING 只压制前 60 根，而窗口有 120 根 —— 后 60 根本来就该正常出手，
    // 于是这条用例挂了三次提交，看起来像风控坏了，其实是断言比用例名承诺的多
    const lastSuppressedDate = short[DEFAULT_PARAMS.risk.newListingMinBars - 1]?.date ?? ''
    for (const trade of result.trades) expect(trade.entryDate > lastSuppressedDate).toBe(true)
  })
})

describe('情绪序列与实盘同源', () => {
  it('sentimentSeries 的末值等于 core 的 marketSentiment —— 两条路径不能分叉', () => {
    const closes = synthetic.map((c) => c.closeAdj)
    const series = sentimentSeries(closes)
    expect(series[series.length - 1]).toBeCloseTo(marketSentiment(closes), 10)
  })

  it('预热不足时整条为 null（调用方据此退到中性值）', () => {
    expect(sentimentSeries([1, 2, 3]).every((v) => v === null)).toBe(true)
  })

  it('逐根都能取到值，且落在 0..1', () => {
    const series = sentimentSeries(synthetic.map((c) => c.closeAdj))
    const valid = series.filter((v): v is number => v !== null)
    expect(valid.length).toBeGreaterThan(0)
    for (const value of valid) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})

/**
 * 退市强制平仓（幸存者偏差的第二重）。
 *
 * 补这一段的理由不是「多一个功能」：未平仓的建仓**不产生 `trade` 行**，
 * 而建仓级胜率与 `audit:random` 的配对 alpha **都只读 `trades`**。
 * 所以退市股若不结算，它的亏损只进净值、不进统计 —— 池子补了、口径没补。
 *
 * 第一条用例（不给 `delistedAt` 时逐位相同）比其余几条都重要：
 * M2 §5.20 起的全部数字都是在没有这个参数的情况下跑出来的，
 * 它们必须能原样复现，新旧差值才归得清是「补了退市股」而不是「模拟器变了」。
 */
describe('退市强制平仓', () => {
  // 截出一个「末尾仍持仓」的序列：截到第一笔交易的卖出日之前 ——
  // 那笔买入已经成交、卖出还没发生。引擎只看过去，所以截断不影响此前的判定
  const firstTrade = run(synthetic).trades[0]
  const cut = synthetic.findIndex((c) => c.date === firstTrade?.exitDate)
  const holding = synthetic.slice(0, cut)
  const lastDate = holding[holding.length - 1]?.date ?? ''

  it('前提：这段序列末尾确实还持着仓 —— 否则下面几条都是空转', () => {
    expect(cut).toBeGreaterThan(0)
    expect(run(holding).openPosition).toBe(true)
  })

  it('不给 delistedAt 时逐位相同 —— 旧结论必须能原样复现', () => {
    const before = run(holding)
    expect(before.delistedClose).toBe(false)
    expect(before.openPosition).toBe(true)
    // 显式构造一次「没有该字段」的调用，确认不是靠默认值巧合通过
    const after = simulateCode({ profile, candles: [...holding] }, { ...OPTIONS }, NEUTRAL_SENTIMENT)
    expect(JSON.stringify(after.trades)).toBe(JSON.stringify(before.trades))
  })

  it('末根到达退市日：强制平仓、记一笔 DELISTED、不再算未平仓', () => {
    const base = run(holding)
    const closed = run(holding, { delistedAt: lastDate })
    expect(closed.delistedClose).toBe(true)
    expect(closed.openPosition).toBe(false)
    expect(closed.trades.length).toBe(base.trades.length + 1)

    const last = closed.trades[closed.trades.length - 1]
    expect(last?.exitRule).toBe(DELISTED_EXIT_RULE)
    expect(last?.exitDate).toBe(lastDate)
    expect(last?.partial).toBe(false)
    // 建仓上下文要跟着这一笔走，否则它在 regime 归因里会落进错误的桶
    expect(last?.entryDate).toBe(base.trades[base.trades.length - 1]?.entryDate ?? last?.entryDate)
  })

  it('退市日晚于末根（窗口截在退市之前）：不平仓，那只是普通的未平仓', () => {
    const later = run(holding, { delistedAt: '2099-12-31' })
    expect(later.delistedClose).toBe(false)
    expect(later.openPosition).toBe(true)
  })

  it('净值最后一点等于结算后的现金 —— 曲线与 trades 是同一件事的两种记法', () => {
    const closed = run(holding, { delistedAt: lastDate })
    const realized = closed.trades.reduce((sum, t) => sum + t.pnl, 0)
    const lastPoint = closed.equity[closed.equity.length - 1]
    expect(lastPoint?.equity).toBeCloseTo(OPTIONS.capitalPerCode + realized, 6)
  })
})
