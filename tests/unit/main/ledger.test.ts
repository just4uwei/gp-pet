import { describe, expect, it } from 'vitest'
import { applyTrade, isTradeError, replayTrades } from '@main/trades/ledger'
import { DEFAULT_COSTS, buyFees, sellFees } from '../../../src/backtest/costs'

/**
 * 成交记账（007_trade_log.sql）。
 *
 * 这一层错了的症状是**盈亏数字对不上**，而用户没有第二个数可以校对 ——
 * 他只能两个都不信。所以口径的每一条都要有用例钉着。
 */
describe('applyTrade', () => {
  const ok = (outcome: ReturnType<typeof applyTrade>) => {
    if (isTradeError(outcome)) throw new Error(`不该报错：${outcome.error}`)
    return outcome
  }

  it('首次买入：成本 = 成交额 + 手续费，摊到每股上', () => {
    const out = ok(applyTrade(null, { side: 'BUY', price: 10, shares: 1000 }))
    const fee = buyFees(10 * 1000, DEFAULT_COSTS)
    expect(out.fee).toBeCloseTo(fee, 2)
    expect(out.position?.shares).toBe(1000)
    expect(out.position?.cost).toBeCloseTo((10 * 1000 + fee) / 1000, 4)
    // 买入没有已实现盈亏 —— **null 不是 0**（约束 4）
    expect(out.realized).toBeNull()
  })

  it('加仓按加权平均摊薄，不是覆盖成上一次的价', () => {
    const first = ok(applyTrade(null, { side: 'BUY', price: 10, shares: 1000 }))
    const second = ok(applyTrade(first.position, { side: 'BUY', price: 12, shares: 1000 }))
    expect(second.position?.shares).toBe(2000)
    // 成本落在 10 与 12 之间，且因为含费略高于 11
    expect(second.position?.cost).toBeGreaterThan(11)
    expect(second.position?.cost).toBeLessThan(11.1)
  })

  it('卖出只减股数，**成本价一个字不动**', () => {
    const held = { shares: 2000, cost: 11 }
    const out = ok(applyTrade(held, { side: 'SELL', price: 13, shares: 1000 }))
    expect(out.position?.shares).toBe(1000)
    expect(out.position?.cost).toBe(11)
  })

  it('卖出结转已实现盈亏，含手续费', () => {
    const held = { shares: 2000, cost: 11 }
    const out = ok(applyTrade(held, { side: 'SELL', price: 13, shares: 1000 }))
    const fee = sellFees(13 * 1000, DEFAULT_COSTS)
    expect(out.fee).toBeCloseTo(fee, 2)
    expect(out.realized).toBeCloseTo((13 - 11) * 1000 - fee, 2)
  })

  it('卖光返回 null，调用方据此删掉持仓行', () => {
    const out = ok(applyTrade({ shares: 1000, cost: 11 }, { side: 'SELL', price: 13, shares: 1000 }))
    expect(out.position).toBeNull()
    // 但这一笔的已实现盈亏还在 —— 那正是「清仓之后还答得上赚了多少」的来源
    expect(out.realized).not.toBeNull()
  })

  it('超卖被拒绝：这个软件不接券商、不支持融券，负持仓会一路传到风控层', () => {
    const out = applyTrade({ shares: 500, cost: 11 }, { side: 'SELL', price: 13, shares: 1000 })
    expect(isTradeError(out)).toBe(true)
  })

  it('没有持仓时卖出被拒绝', () => {
    expect(isTradeError(applyTrade(null, { side: 'SELL', price: 13, shares: 100 }))).toBe(true)
  })

  it('价格或股数非法一律拒绝，不做「猜一个」的兜底', () => {
    expect(isTradeError(applyTrade(null, { side: 'BUY', price: 0, shares: 100 }))).toBe(true)
    expect(isTradeError(applyTrade(null, { side: 'BUY', price: 10, shares: 0 }))).toBe(true)
    expect(isTradeError(applyTrade(null, { side: 'BUY', price: Number.NaN, shares: 100 }))).toBe(true)
  })

  it('**不套滑点**：用户填的就是真实成交价', () => {
    // buyFill/sellFill 是给回测的（模拟「不知道会成交在哪」）。
    // 这里套一层滑点等于凭空把用户的成交价改坏 0.1%，然后一路进成本、进止损线
    const out = ok(applyTrade(null, { side: 'BUY', price: 10, shares: 100_000 }))
    const fee = buyFees(10 * 100_000, DEFAULT_COSTS)
    // 成交额恰好是 10 × 100000，一分钱滑点都没有
    expect(out.position!.cost * 100_000 - fee).toBeCloseTo(10 * 100_000, 2)
  })
})

describe('replayTrades', () => {
  it('期初建仓的 price 直接当成本，**不再收一次费**', () => {
    // 那个 price 就是当初已经含费的成本价（或者用户自己估的），再收一次是重复计费
    const position = replayTrades([{ side: 'OPENING', price: 11, shares: 1000 }])
    expect(position).toEqual({ shares: 1000, cost: 11 })
  })

  it('重放的结果与逐笔累加一致 —— 删一笔之后就是靠它重建持仓', () => {
    const trades = [
      { side: 'OPENING' as const, price: 10, shares: 1000 },
      { side: 'BUY' as const, price: 12, shares: 1000 },
      { side: 'SELL' as const, price: 13, shares: 500 },
    ]
    const replayed = replayTrades(trades)

    let step: { shares: number; cost: number } | null = { shares: 1000, cost: 10 }
    for (const trade of trades.slice(1)) {
      if (trade.side === 'OPENING') continue
      const out = applyTrade(step, { side: trade.side, price: trade.price, shares: trade.shares })
      if (isTradeError(out)) throw new Error(out.error)
      step = out.position
    }
    expect(replayed).toEqual(step)
  })

  it('全部卖光时重放出 null', () => {
    expect(
      replayTrades([
        { side: 'OPENING', price: 10, shares: 1000 },
        { side: 'SELL', price: 11, shares: 1000 },
      ])
    ).toBeNull()
  })

  it('算不通的一笔被跳过，不让整条链失败', () => {
    // 历史数据里可能有超卖（早期版本、手改过的库）。半路抛错会让用户的持仓凭空消失，
    // 那比少算一笔糟得多
    const position = replayTrades([
      { side: 'OPENING', price: 10, shares: 1000 },
      { side: 'SELL', price: 11, shares: 5000 },
      { side: 'BUY', price: 12, shares: 500 },
    ])
    expect(position?.shares).toBe(1500)
  })
})
