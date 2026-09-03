import { describe, expect, it } from 'vitest'
import {
  applyTrade,
  isTradeError,
  netCostOf,
  replayLedger,
  replayTrades,
  resolveDecision,
  t1SellNotice,
} from '@main/trades/ledger'
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
    const out = ok(applyTrade(null, { side: 'BUY', price: 10, shares: 1000, board: 'MAIN' }))
    const fee = buyFees(10 * 1000, DEFAULT_COSTS)
    expect(out.fee).toBeCloseTo(fee, 2)
    expect(out.position?.shares).toBe(1000)
    expect(out.position?.cost).toBeCloseTo((10 * 1000 + fee) / 1000, 4)
    // 买入没有已实现盈亏 —— **null 不是 0**（约束 4）
    expect(out.realized).toBeNull()
  })

  it('加仓按加权平均摊薄，不是覆盖成上一次的价', () => {
    const first = ok(applyTrade(null, { side: 'BUY', price: 10, shares: 1000, board: 'MAIN' }))
    const second = ok(applyTrade(first.position, { side: 'BUY', price: 12, shares: 1000, board: 'MAIN' }))
    expect(second.position?.shares).toBe(2000)
    // 成本落在 10 与 12 之间，且因为含费略高于 11
    expect(second.position?.cost).toBeGreaterThan(11)
    expect(second.position?.cost).toBeLessThan(11.1)
  })

  it('卖出只减股数，**成本价一个字不动**', () => {
    const held = { shares: 2000, cost: 11 }
    const out = ok(applyTrade(held, { side: 'SELL', price: 13, shares: 1000, board: 'MAIN' }))
    expect(out.position?.shares).toBe(1000)
    expect(out.position?.cost).toBe(11)
  })

  it('卖出结转已实现盈亏，含手续费', () => {
    const held = { shares: 2000, cost: 11 }
    const out = ok(applyTrade(held, { side: 'SELL', price: 13, shares: 1000, board: 'MAIN' }))
    const fee = sellFees(13 * 1000, DEFAULT_COSTS)
    expect(out.fee).toBeCloseTo(fee, 2)
    expect(out.realized).toBeCloseTo((13 - 11) * 1000 - fee, 2)
  })

  it('卖光返回 null，调用方据此删掉持仓行', () => {
    const out = ok(applyTrade({ shares: 1000, cost: 11 }, { side: 'SELL', price: 13, shares: 1000, board: 'MAIN' }))
    expect(out.position).toBeNull()
    // 但这一笔的已实现盈亏还在 —— 那正是「清仓之后还答得上赚了多少」的来源
    expect(out.realized).not.toBeNull()
  })

  it('超卖被拒绝：这个软件不接券商、不支持融券，负持仓会一路传到风控层', () => {
    const out = applyTrade({ shares: 500, cost: 11 }, { side: 'SELL', price: 13, shares: 1000, board: 'MAIN' })
    expect(isTradeError(out)).toBe(true)
  })

  it('没有持仓时卖出被拒绝', () => {
    expect(isTradeError(applyTrade(null, { side: 'SELL', price: 13, shares: 100, board: 'MAIN' }))).toBe(true)
  })

  it('价格或股数非法一律拒绝，不做「猜一个」的兜底', () => {
    expect(isTradeError(applyTrade(null, { side: 'BUY', price: 0, shares: 100, board: 'MAIN' }))).toBe(true)
    expect(isTradeError(applyTrade(null, { side: 'BUY', price: 10, shares: 0, board: 'MAIN' }))).toBe(true)
    expect(isTradeError(applyTrade(null, { side: 'BUY', price: Number.NaN, shares: 100, board: 'MAIN' }))).toBe(true)
  })

  it('**不套滑点**：用户填的就是真实成交价', () => {
    // buyFill/sellFill 是给回测的（模拟「不知道会成交在哪」）。
    // 这里套一层滑点等于凭空把用户的成交价改坏 0.1%，然后一路进成本、进止损线
    const out = ok(applyTrade(null, { side: 'BUY', price: 10, shares: 100_000, board: 'MAIN' }))
    const fee = buyFees(10 * 100_000, DEFAULT_COSTS)
    // 成交额恰好是 10 × 100000，一分钱滑点都没有
    expect(out.position!.cost * 100_000 - fee).toBeCloseTo(10 * 100_000, 2)
  })
})

/*
  现金分红（017，2026-09-03 用户拍板「扣减摊薄成本」）。

  判据是这张账的价格口径：成本与展示价都是**不复权**的（docs/03 §2.3），
  而除权那天价格自己会掉下来。成本不跟着掉 ⇒ 界面显示一段假浮亏，
  止损缓冲被凭空吃掉。
*/
describe('applyTrade · 现金分红', () => {
  const ok = (outcome: ReturnType<typeof applyTrade>) => {
    if (isTradeError(outcome)) throw new Error(`不该报错：${outcome.error}`)
    return outcome
  }

  it('按每股派现扣减摊薄成本，股数一个不变', () => {
    const out = ok(
      applyTrade({ shares: 1000, cost: 10 }, { side: 'DIVIDEND', price: 0.3, shares: 1000, board: 'MAIN' })
    )
    expect(out.position).toEqual({ shares: 1000, cost: 9.7 })
    // **不计入已实现盈亏**：那笔钱要等卖出时才结转，两处都算会数两遍
    expect(out.realized).toBeNull()
    // 不是成交 ⇒ 没有佣金也没有税
    expect(out.fee).toBe(0)
    expect(out.peakScale).toBe(1)
  })

  it('分红股数与持股数不一致时，按**持股数**摊 —— 那笔钱是事实，摊法只有一种算得对', () => {
    // 用户按公告的股数填了 2000，而现在只持有 1000 股 ⇒ 到账 600 摊到 1000 股上
    const out = ok(
      applyTrade({ shares: 1000, cost: 10 }, { side: 'DIVIDEND', price: 0.3, shares: 2000, board: 'MAIN' })
    )
    expect(out.position?.cost).toBeCloseTo(10 - 600 / 1000, 4)
  })

  it('累计分红超过成本时成本夹在 0，**超出部分进 realized**（不丢、不让成本变负）', () => {
    const out = ok(
      applyTrade({ shares: 1000, cost: 0.2 }, { side: 'DIVIDEND', price: 0.3, shares: 1000, board: 'MAIN' })
    )
    // 负成本会让浮亏百分比与止损线一起失去意义
    expect(out.position).toEqual({ shares: 1000, cost: 0 })
    // 丢掉等于凭空少一笔钱：(0.3 − 0.2) × 1000
    expect(out.realized).toBeCloseTo(100, 2)
  })

  it('没有持仓时分红被拒绝 —— 无从摊到成本上', () => {
    expect(
      isTradeError(applyTrade(null, { side: 'DIVIDEND', price: 0.3, shares: 1000, board: 'MAIN' }))
    ).toBe(true)
  })

  it('每股派现必须是正数', () => {
    expect(
      isTradeError(
        applyTrade({ shares: 1000, cost: 10 }, { side: 'DIVIDEND', price: 0, shares: 1000, board: 'MAIN' })
      )
    ).toBe(true)
  })
})

/*
  送股 / 转增（017）。

  `peakScale` 是这一组用例的重点：不缩放 `position.peak_price` 的后果**不是**
  「多一条提醒」，而是移动止损与回撤减仓立刻读出一个假回撤（10 送 10 就是 −50%）
  并天天触发 —— 与 009 头注释里 `acceptLoss` 不重设 peak 的那个失效形状一模一样。
*/
describe('applyTrade · 送股 / 转增', () => {
  const ok = (outcome: ReturnType<typeof applyTrade>) => {
    if (isTradeError(outcome)) throw new Error(`不该报错：${outcome.error}`)
    return outcome
  }

  it('10 送 10：股数翻倍、成本减半、**总成本恒定**', () => {
    const out = ok(
      applyTrade({ shares: 1000, cost: 10 }, { side: 'SPLIT', price: 0, shares: 1000, board: 'MAIN' })
    )
    expect(out.position).toEqual({ shares: 2000, cost: 5 })
    expect(out.position!.cost * out.position!.shares).toBeCloseTo(10 * 1000, 2)
    expect(out.fee).toBe(0)
    expect(out.realized).toBeNull()
  })

  it('peakScale = 持股数 / 送转后股数 —— 调用方据此缩放回撤参考点', () => {
    const out = ok(
      applyTrade({ shares: 1000, cost: 10 }, { side: 'SPLIT', price: 0, shares: 300, board: 'MAIN' })
    )
    expect(out.peakScale).toBeCloseTo(1000 / 1300, 6)
  })

  it('送股的 price 允许是 0 —— **你一分钱没付，0 是事实**（不是拿假值冒充）', () => {
    // 对照：其余四种 side 的 price <= 0 一律拒绝
    expect(isTradeError(applyTrade({ shares: 100, cost: 10 }, { side: 'SPLIT', price: 0, shares: 100, board: 'MAIN' }))).toBe(false)
    expect(isTradeError(applyTrade({ shares: 100, cost: 10 }, { side: 'SELL', price: 0, shares: 100, board: 'MAIN' }))).toBe(true)
  })

  it('没有持仓时送转被拒绝', () => {
    expect(isTradeError(applyTrade(null, { side: 'SPLIT', price: 0, shares: 100, board: 'MAIN' }))).toBe(true)
  })
})

/*
  建仓（`OPENING`，017 起可以由用户自己录，且价可选含不含费）。

  **缺省按「已含费」** —— 缺这个键的只有 017 之前落库的行，而它们全部取自
  `position.cost`（按定义就是含费的摊薄成本）。反过来把缺省定成「不含」，
  升级那一刻全库的期初成本会被凭空补一笔费用。
*/
describe('applyTrade · 建仓', () => {
  const ok = (outcome: ReturnType<typeof applyTrade>) => {
    if (isTradeError(outcome)) throw new Error(`不该报错：${outcome.error}`)
    return outcome
  }

  it('缺省（老行）按「价已含费」：price 直接是成本，fee 落 0', () => {
    const out = ok(applyTrade(null, { side: 'OPENING', price: 11, shares: 1000, board: 'MAIN' }))
    expect(out.position).toEqual({ shares: 1000, cost: 11 })
    // 这个 0 是「不知道」，不是「没有」（007 头注释）
    expect(out.fee).toBe(0)
  })

  it('feeIncluded: false 时按费率补算一笔并摊进成本', () => {
    const out = ok(
      applyTrade(null, { side: 'OPENING', price: 11, shares: 1000, board: 'MAIN', feeIncluded: false })
    )
    const fee = buyFees(11 * 1000, DEFAULT_COSTS)
    expect(out.fee).toBeCloseTo(fee, 2)
    expect(out.position?.cost).toBeCloseTo((11 * 1000 + fee) / 1000, 4)
    // 含费的那一档成本更低 —— 差的正好是那笔费用
    expect(out.position!.cost).toBeGreaterThan(11)
  })

  it('建仓**重设**整个持仓，不叠加 —— 它是账本的起点', () => {
    const out = ok(
      applyTrade({ shares: 5000, cost: 99 }, { side: 'OPENING', price: 11, shares: 1000, board: 'MAIN' })
    )
    expect(out.position).toEqual({ shares: 1000, cost: 11 })
  })
})

describe('replayTrades', () => {
  it('期初建仓的 price 直接当成本，**不再收一次费**', () => {
    // 那个 price 就是当初已经含费的成本价（或者用户自己估的），再收一次是重复计费
    const position = replayTrades([{ side: 'OPENING', price: 11, shares: 1000 }], 'MAIN')
    expect(position).toEqual({ shares: 1000, cost: 11 })
  })

  it('重放的结果与逐笔累加一致 —— 删一笔之后就是靠它重建持仓', () => {
    const trades = [
      { side: 'OPENING' as const, price: 10, shares: 1000 },
      { side: 'BUY' as const, price: 12, shares: 1000 },
      { side: 'SELL' as const, price: 13, shares: 500 },
    ]
    const replayed = replayTrades(trades, 'MAIN')

    let step: { shares: number; cost: number } | null = { shares: 1000, cost: 10 }
    for (const trade of trades.slice(1)) {
      if (trade.side === 'OPENING') continue
      const out = applyTrade(step, { side: trade.side, price: trade.price, shares: trade.shares, board: 'MAIN' })
      if (isTradeError(out)) throw new Error(out.error)
      step = out.position
    }
    expect(replayed).toEqual(step)
  })

  it('全部卖光时重放出 null', () => {
    expect(
      replayTrades(
        [
          { side: 'OPENING', price: 10, shares: 1000 },
          { side: 'SELL', price: 11, shares: 1000 },
        ],
        'MAIN'
      )
    ).toBeNull()
  })

  it('算不通的一笔被跳过，不让整条链失败', () => {
    // 历史数据里可能有超卖（早期版本、手改过的库）。半路抛错会让用户的持仓凭空消失，
    // 那比少算一笔糟得多
    const position = replayTrades(
      [
        { side: 'OPENING', price: 10, shares: 1000 },
        { side: 'SELL', price: 11, shares: 5000 },
        { side: 'BUY', price: 12, shares: 500 },
      ],
      'MAIN'
    )
    expect(position?.shares).toBe(1500)
  })
})

/*
  `replayLedger`（017）：重放不只给持仓，还给**逐行的派生列**。

  这一组用例钉住的是本次一起修掉的一个旧缺陷：`realized` 是插入时算好存下的、
  重放不改写 ⇒ 删掉第一笔买入之后，后面那些卖出的已实现盈亏仍按旧成本算，
  `sumRealized` 给出一个错的数，**而没有任何东西会报警**。
*/
describe('replayLedger', () => {
  const CHEAP: typeof DEFAULT_COSTS = { ...DEFAULT_COSTS, commissionRate: 0.0001 }

  it('默认沿用**行上存着的** fee —— 删一笔不相干的流水，不该把历史费用按今天的费率改一遍', () => {
    const rows = [
      { id: 'a', side: 'BUY' as const, price: 10, shares: 1000, fee: 30 },
      { id: 'b', side: 'BUY' as const, price: 12, shares: 1000, fee: 40 },
    ]
    const result = replayLedger(rows, 'MAIN', DEFAULT_COSTS)
    expect(result.rows.map((row) => row.fee)).toEqual([30, 40])
    // 成本里含的是那两笔存着的费用，不是按 DEFAULT_COSTS 重算的
    expect(result.position?.cost).toBeCloseTo((10 * 1000 + 30 + 12 * 1000 + 40) / 2000, 4)
  })

  /**
   * ⚠ 回归（2026-09-03 真机抓到）：**新录的那一笔手续费恒为 0**。
   *
   * 机制：调用方要先把行落库才能重放，而落库那一刻它的费用**还没算出来**
   * （要等重放）⇒ 先落一个 0 占位。而重放默认「沿用库里存着的费用」
   * ⇒ 那个 0 被当成事实，一路摊进成本。
   * 账面上只表现为「费 0.00」这一个不起眼的数字，没有任何东西会报警。
   *
   * 用户的真实账本里因此有两笔零费用的流水（一笔建仓 7.5 万、一笔买入 3.7 万，
   * 少算了 29.23 元）。
   */
  it('**点名的那几行照样重算** —— 新录/刚改的一笔落库时费用还没算出来，落的是 0 占位', () => {
    const rows = [
      { id: 'old', side: 'BUY' as const, price: 10, shares: 1000, fee: 30 },
      // 这一行模拟「刚 insert 的占位」：fee 是 0，但它不是事实
      { id: 'fresh', side: 'BUY' as const, price: 10, shares: 10_000, fee: 0 },
    ]
    const naive = replayLedger(rows, 'MAIN', DEFAULT_COSTS)
    expect(naive.rows[1]?.fee).toBe(0) // ← 不点名就是这个下场

    const fixed = replayLedger(rows, 'MAIN', DEFAULT_COSTS, { refeeIds: new Set(['fresh']) })
    expect(fixed.rows[1]?.fee).toBeCloseTo(buyFees(100_000, DEFAULT_COSTS), 2)
    // 旧那一笔仍然沿用库里存着的 30，不被顺手改掉
    expect(fixed.rows[0]?.fee).toBe(30)
    /*
      而且费用要**真的摊进成本** —— 只改报出去的那个数会让
      「成本 × 股数 − 成交额 ≠ fee」，一个当场对不上的账。
      容差按 `round4` 给：成本保留 4 位 ⇒ 11000 股上最多差 11000 × 5e-5 = 0.55 元。
    */
    const fee = fixed.rows[0]!.fee + fixed.rows[1]!.fee
    expect(Math.abs(fixed.position!.cost * 11_000 - 110_000 - fee)).toBeLessThan(0.55)
  })

  it('refee 时按传进来的费率重算每一笔', () => {
    const rows = [{ id: 'a', side: 'BUY' as const, price: 10, shares: 1000, fee: 999 }]
    const result = replayLedger(rows, 'MAIN', CHEAP, { refee: true })
    expect(result.rows[0]?.fee).toBeCloseTo(buyFees(10_000, CHEAP), 2)
    expect(result.rows[0]?.fee).not.toBe(999)
  })

  it('refee **跳过「价已含费」的建仓** —— 那个 price 就是摊薄成本，补一笔费用等于凭空改掉它', () => {
    const included = replayLedger(
      [{ id: 'a', side: 'OPENING', price: 11, shares: 1000, fee: 0, feeIncluded: true }],
      'MAIN',
      CHEAP,
      { refee: true }
    )
    expect(included.rows[0]?.fee).toBe(0)
    expect(included.position).toEqual({ shares: 1000, cost: 11 })

    // 对照：明确「不含费」的那种照样重算
    const bare = replayLedger(
      [{ id: 'a', side: 'OPENING', price: 11, shares: 1000, fee: 0, feeIncluded: false }],
      'MAIN',
      CHEAP,
      { refee: true }
    )
    expect(bare.rows[0]?.fee).toBeCloseTo(buyFees(11_000, CHEAP), 2)
  })

  it('**realized 逐行重算**：删掉第一笔买入之后，后面那笔卖出的已实现盈亏跟着变', () => {
    const before = replayLedger(
      [
        { id: 'buy1', side: 'BUY', price: 10, shares: 1000, fee: 5 },
        { id: 'buy2', side: 'BUY', price: 20, shares: 1000, fee: 5 },
        { id: 'sell', side: 'SELL', price: 30, shares: 1000, fee: 5 },
      ],
      'MAIN',
      DEFAULT_COSTS
    )
    // 成本 = (10000 + 5 + 20000 + 5) / 2000 = 15.005 ⇒ 卖 1000 股赚 (30 − 15.005) × 1000 − 5
    expect(before.rows.at(-1)?.realized).toBeCloseTo((30 - 15.005) * 1000 - 5, 2)

    const after = replayLedger(
      [
        { id: 'buy2', side: 'BUY', price: 20, shares: 1000, fee: 5 },
        { id: 'sell', side: 'SELL', price: 30, shares: 1000, fee: 5 },
      ],
      'MAIN',
      DEFAULT_COSTS
    )
    expect(after.rows.at(-1)?.realized).toBeCloseTo((30 - 20.005) * 1000 - 5, 2)
  })

  it('买入不给 realized —— **null 不是 0**（约束 4）', () => {
    const result = replayLedger([{ id: 'a', side: 'BUY', price: 10, shares: 100, fee: 5 }], 'MAIN')
    expect(result.rows[0]?.realized).toBeNull()
  })

  it('跳过的行**列名报出来**，调用方据此判「这一笔录不进去」', () => {
    const result = replayLedger(
      [
        { id: 'open', side: 'OPENING', price: 10, shares: 1000 },
        { id: 'bad', side: 'SELL', price: 11, shares: 5000 },
      ],
      'MAIN'
    )
    expect(result.skipped.map((row) => row.id)).toEqual(['bad'])
    expect(result.skipped[0]?.reason).toContain('超过持有')
  })

  it('peakScale 是全部送转的累积 —— 连着两次 10 送 10 就是 1/4', () => {
    const result = replayLedger(
      [
        { id: 'open', side: 'OPENING', price: 10, shares: 1000 },
        { id: 's1', side: 'SPLIT', price: 0, shares: 1000 },
        { id: 's2', side: 'SPLIT', price: 0, shares: 2000 },
      ],
      'MAIN'
    )
    expect(result.peakScale).toBeCloseTo(0.25, 6)
    expect(result.position).toEqual({ shares: 4000, cost: 2.5 })
  })
})

/*
  ETF 的记账（2026-08-17）。`TradeInput.board` 是必填的，理由在 ledger.ts 那段注释里：
  回测的缺省「按股票收满」是安全方向，但记账靠缺省会让 ETF 的成本价与已实现盈亏系统性偏高，
  而这张账存在的意义就是「实盘盈亏与影子绩效可比」。
*/
describe('场内基金的记账', () => {
  const ok = (outcome: ReturnType<typeof applyTrade>) => {
    if (isTradeError(outcome)) throw new Error(outcome.error)
    return outcome
  }

  it('ETF 买入的费用低于同额个股，成本价因此更低', () => {
    const etf = ok(applyTrade(null, { side: 'BUY', price: 10, shares: 10_000, board: 'ETF' }))
    const stock = ok(applyTrade(null, { side: 'BUY', price: 10, shares: 10_000, board: 'MAIN' }))
    expect(etf.fee).toBeLessThan(stock.fee)
    expect(etf.position?.cost).toBeLessThan(stock.position?.cost ?? 0)
  })

  it('ETF 卖出省下的正是印花税 + 过户费', () => {
    const held = { shares: 10_000, cost: 10 }
    const etf = ok(applyTrade(held, { side: 'SELL', price: 11, shares: 10_000, board: 'ETF' }))
    const stock = ok(applyTrade(held, { side: 'SELL', price: 11, shares: 10_000, board: 'MAIN' }))
    const amount = 11 * 10_000
    expect(stock.fee - etf.fee).toBeCloseTo(
      amount * DEFAULT_COSTS.stampTaxRate + amount * DEFAULT_COSTS.transferFeeRate,
      1
    )
    // 少收的费直接进已实现盈亏
    expect((etf.realized ?? 0) - (stock.realized ?? 0)).toBeCloseTo(stock.fee - etf.fee, 1)
  })
})

/**
 * T+1 提示（2026-08-19）。
 *
 * **它是提示不是拒绝** —— 这一点必须有用例钉着：跨境 / 债券 / 黄金 ETF 与可转债
 * 确实是 T+0，硬拒会把合法成交挡在外面，而用户只会觉得软件坏了。
 * 所以这个函数与 `applyTrade` 完全分开，它的返回值也不进 `TradeOutcome.error`。
 */
describe('t1SellNotice', () => {
  const held = { heldShares: 1000, sameDayBuyShares: 400 }

  it('卖出没超过可卖股数 → 不提示', () => {
    expect(t1SellNotice({ side: 'SELL', shares: 600, ...held })).toBeNull()
  })

  it('卖出超过可卖股数 → 提示并给出那天最多能卖多少', () => {
    const notice = t1SellNotice({ side: 'SELL', shares: 601, ...held })
    expect(notice).toContain('400 股')
    expect(notice).toContain('最多卖 600 股')
    expect(notice).toContain('T+1')
    // T+0 品种的出口要写在同一句里 —— 不然用户会以为这是个错误
    expect(notice).toContain('可转债')
  })

  it('全仓都是当日买入 → 那天一股都卖不了', () => {
    expect(t1SellNotice({ side: 'SELL', shares: 1, heldShares: 1000, sameDayBuyShares: 1000 })).toContain(
      '最多卖 0 股'
    )
  })

  it('买入方向永不提示', () => {
    expect(t1SellNotice({ side: 'BUY', shares: 10_000, ...held })).toBeNull()
  })

  it('那天没买过 → 不提示（补录上周那笔卖出不该被打扰）', () => {
    expect(t1SellNotice({ side: 'SELL', shares: 1000, heldShares: 1000, sameDayBuyShares: 0 })).toBeNull()
  })

  it('没有持仓 → 不提示（那是 applyTrade 的 error 管的事，别两处都说）', () => {
    expect(t1SellNotice({ side: 'SELL', shares: 100, heldShares: 0, sameDayBuyShares: 100 })).toBeNull()
  })

  it('提示与 applyTrade 互不影响：同一笔照样算得出账', () => {
    const outcome = applyTrade({ shares: 1000, cost: 10 }, { side: 'SELL', price: 11, shares: 1000, board: 'MAIN' })
    expect(isTradeError(outcome)).toBe(false)
    expect(t1SellNotice({ side: 'SELL', shares: 1000, ...held })).not.toBeNull()
  })
})

/**
 * 「照哪条提醒做的」那个关联的判据（016）。
 *
 * 这一组钉的全是同一件事：**关联要么是真的，要么就没有** ——
 * 一个挂错的或半成的关联比没有关联更坏，因为 IS 分解会把它当事实用。
 */
describe('resolveDecision', () => {
  const signal = { code: 'SH600000', createdAt: 1_700_000_000_000, priceAt: 12.34 }

  it('没选 = 合法，不是错误', () => {
    expect(resolveDecision({ signalId: undefined, code: 'SH600000', signal: null })).toEqual({
      decision: null,
    })
    // 表单清空之后送过来的是空串，与 undefined 同义
    expect(resolveDecision({ signalId: '', code: 'SH600000', signal: null })).toEqual({
      decision: null,
    })
  })

  it('选了但库里没有 ⇒ 报错，**不许静默落 NULL**', () => {
    const out = resolveDecision({ signalId: 'sig-1', code: 'SH600000', signal: null })
    expect('error' in out).toBe(true)
  })

  it('选了别的票的提醒 ⇒ 报错', () => {
    const out = resolveDecision({ signalId: 'sig-1', code: 'SZ000001', signal })
    expect('error' in out).toBe(true)
  })

  it('快照取库里的 createdAt / priceAt —— 调用方送什么都不采信', () => {
    const out = resolveDecision({ signalId: 'sig-1', code: 'SH600000', signal })
    expect(out).toEqual({ decision: { at: 1_700_000_000_000, price: 12.34 } })
  })
})

/**
 * 净成本（`netCostOf`，017）= 净投入 ÷ 现持股数。
 *
 * 它与 `LedgerPosition.cost` 是**两个数**：后者是加权平均成本（卖出不改成本），
 * 净成本把已实现盈亏折回成本里。真机实测同一只票 12.067 vs 12.903 ——
 * 而**券商持仓页上那个「成本价」多半是净成本**，所以两个必须并排显示。
 *
 * ⚠ 止损一律用 `cost`：净成本会随已实现亏损**往上跳**，每做亏一笔 T 止损线就抬一格。
 */
describe('netCostOf', () => {
  it('只买不卖时 = 加权平均成本（含费）', () => {
    const rows = [{ side: 'BUY' as const, price: 10, shares: 1000, fee: 30 }]
    expect(netCostOf(rows, 1000)).toBeCloseTo((10_000 + 30) / 1000, 4)
  })

  it('做亏一笔 T 之后**高于**加权平均成本 —— 那笔亏损被折回成本里', () => {
    const rows = [
      { side: 'BUY' as const, price: 10, shares: 2000, fee: 10 },
      { side: 'BUY' as const, price: 10, shares: 1000, fee: 5 },
      { side: 'SELL' as const, price: 9, shares: 1000, fee: 15 },
    ]
    // 净投入 = 20010 + 10005 − 9000 + 15 = 21030，剩 2000 股
    expect(netCostOf(rows, 2000)).toBeCloseTo(21_030 / 2000, 4)
    // 加权平均成本只有 (20010 + 10005) / 3000 ≈ 10.005 —— 两个数差着那笔亏损
    expect(netCostOf(rows, 2000)!).toBeGreaterThan(10.005)
  })

  it('分红是拿回来的钱，从净投入里减掉', () => {
    const rows = [
      { side: 'BUY' as const, price: 10, shares: 1000, fee: 0 },
      { side: 'DIVIDEND' as const, price: 0.3, shares: 1000, fee: 0 },
    ]
    expect(netCostOf(rows, 1000)).toBeCloseTo((10_000 - 300) / 1000, 4)
  })

  it('送转不涉及现金，只摊薄 —— 净投入不变、净成本按股数摊开', () => {
    const rows = [
      { side: 'BUY' as const, price: 10, shares: 1000, fee: 0 },
      { side: 'SPLIT' as const, price: 0, shares: 1000, fee: 0 },
    ]
    expect(netCostOf(rows, 2000)).toBeCloseTo(5, 4)
  })

  it('「价已含费」的建仓：那个价本身就是净投入的一部分，fee = 0 不额外加', () => {
    const rows = [{ side: 'OPENING' as const, price: 14.75, shares: 5100, fee: 0 }]
    expect(netCostOf(rows, 5100)).toBeCloseTo(14.75, 4)
  })

  it('清仓之后返回 null —— 「还要涨到多少」这个问题不成立（**不是 0**）', () => {
    const rows = [
      { side: 'BUY' as const, price: 10, shares: 1000, fee: 0 },
      { side: 'SELL' as const, price: 11, shares: 1000, fee: 0 },
    ]
    expect(netCostOf(rows, 0)).toBeNull()
  })
})
